/**
 * Builds and persists the per-session report file.
 *
 * One file per session, named by session ID, written as a full snapshot every
 * time. Nothing is appended, so resuming a chat converges on correct cumulative
 * totals and a crash mid-turn self-heals on the next write.
 */

import { homedir } from "os"
import { join } from "path"
import { mkdir, rename, rm, writeFile } from "fs/promises"
import { computeMetrics, emptyMetrics, merge, type MessageWithParts, type Metrics, type SessionInfo } from "./metrics.ts"

export const SCHEMA_VERSION = 1

export interface Report {
  schemaVersion: number
  sessionID: string
  parentID?: string
  projectID?: string
  title?: string
  directory?: string
  time: { created: number; updated: number }
  writtenAt: number
  /** This session's own transcript. */
  self: Metrics
  /** All descendant sessions combined (subagents, recursively). */
  descendants: Metrics
  /** `self` + `descendants`, with wall clock kept as this session's span. */
  total: Metrics
  children: string[]
  /** Totals opencode itself tracks, when the API exposes them. Lets you spot drift. */
  reported?: { cost?: number; tokens?: SessionInfo["tokens"] }
}

/** The slice of the opencode client this module needs. */
export interface SessionClient {
  session: {
    get(options: { path: { id: string } }): Promise<{ data?: unknown; error?: unknown }>
    messages(options: { path: { id: string } }): Promise<{ data?: unknown; error?: unknown }>
    children(options: { path: { id: string } }): Promise<{ data?: unknown; error?: unknown }>
  }
}

export function resolveDir(configured?: unknown): string {
  if (typeof configured === "string" && configured.length > 0) {
    return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured
  }
  const fromEnv = process.env["OPENCODE_METRICS_DIR"]
  if (fromEnv) return fromEnv
  return join(homedir(), ".local", "share", "opencode", "metrics")
}

export function reportPath(dir: string, sessionID: string): string {
  return join(dir, `${sessionID}.json`)
}

async function fetchSession(client: SessionClient, sessionID: string): Promise<SessionInfo | undefined> {
  const response = await client.session.get({ path: { id: sessionID } })
  return (response.data as SessionInfo | undefined) ?? undefined
}

async function fetchMessages(client: SessionClient, sessionID: string): Promise<MessageWithParts[]> {
  const response = await client.session.messages({ path: { id: sessionID } })
  return (response.data as MessageWithParts[] | undefined) ?? []
}

async function fetchChildren(client: SessionClient, sessionID: string): Promise<SessionInfo[]> {
  const response = await client.session.children({ path: { id: sessionID } })
  return (response.data as SessionInfo[] | undefined) ?? []
}

/**
 * Metrics for every descendant of `sessionID`, combined.
 *
 * `seen` guards against a cycle in the parent/child graph; without it a
 * malformed session tree would recurse forever.
 */
async function collectDescendants(
  client: SessionClient,
  sessionID: string,
  seen: Set<string>,
): Promise<{ metrics: Metrics; children: string[] }> {
  const children = await fetchChildren(client, sessionID)
  let metrics = emptyMetrics()

  for (const child of children) {
    if (seen.has(child.id)) continue
    seen.add(child.id)

    const messages = await fetchMessages(client, child.id)
    metrics = merge(metrics, computeMetrics(child, messages))

    const nested = await collectDescendants(client, child.id, seen)
    metrics = merge(metrics, nested.metrics)
  }

  return { metrics, children: children.map((child) => child.id) }
}

export async function buildReport(client: SessionClient, sessionID: string): Promise<Report | undefined> {
  const session = await fetchSession(client, sessionID)
  if (!session) return undefined

  const self = computeMetrics(session, await fetchMessages(client, sessionID))
  const descendants = await collectDescendants(client, sessionID, new Set([sessionID]))

  const total = merge(self, descendants.metrics)
  // A subagent runs inside its parent's span, so the rolled-up wall clock is the
  // parent's own elapsed time rather than anything summed.
  total.runtime.wallClockMs = self.runtime.wallClockMs

  return {
    schemaVersion: SCHEMA_VERSION,
    sessionID: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    title: session.title,
    directory: session.directory,
    time: session.time,
    writtenAt: Date.now(),
    self,
    descendants: descendants.metrics,
    total,
    children: descendants.children,
    reported: { cost: session.cost, tokens: session.tokens },
  }
}

export async function writeReport(dir: string, report: Report): Promise<string> {
  await mkdir(dir, { recursive: true })
  const target = reportPath(dir, report.sessionID)
  // Write-then-rename: rename is atomic within a filesystem, so a concurrent
  // reader sees either the previous snapshot or the new one, never a partial file.
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", "utf8")
  await rename(temporary, target)
  return target
}

export async function removeReport(dir: string, sessionID: string): Promise<void> {
  await rm(reportPath(dir, sessionID), { force: true })
}

/**
 * Rewrite `sessionID` and then every ancestor above it.
 *
 * The walk upward is required, not a nicety: a subagent session goes idle
 * before its parent does, so without rewriting ancestors the parent's file
 * would never pick up the child's contribution.
 */
export async function writeChain(client: SessionClient, dir: string, sessionID: string): Promise<string[]> {
  const written: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = sessionID

  while (current && !seen.has(current)) {
    seen.add(current)
    const report = await buildReport(client, current)
    if (!report) break
    written.push(await writeReport(dir, report))
    current = report.parentID
  }

  return written
}
