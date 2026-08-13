import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { buildReport, removeReport, reportPath, resolveDir, writeChain, writeReport, type SessionClient } from "./report.ts"
import type { MessageWithParts, SessionInfo } from "./metrics.ts"

const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }

function step(cost: number): MessageWithParts {
  return {
    info: { role: "assistant", time: { created: 0, completed: 1_000 }, providerID: "p", modelID: "m" },
    parts: [{ type: "step-finish", cost, tokens }],
  }
}

const parent: SessionInfo = { id: "ses_parent", projectID: "prj", title: "parent", time: { created: 0, updated: 10_000 } }
const child: SessionInfo = {
  id: "ses_child",
  parentID: "ses_parent",
  projectID: "prj",
  title: "child",
  time: { created: 2_000, updated: 4_000 },
}

/** Stands in for the opencode client with a fixed two-session tree. */
function fakeClient(): SessionClient {
  const sessions: Record<string, SessionInfo> = { ses_parent: parent, ses_child: child }
  const messages: Record<string, MessageWithParts[]> = {
    ses_parent: [
      { info: { role: "user", time: { created: 0 } }, parts: [{ type: "text", text: "what time is it?" }] },
      step(1),
    ],
    ses_child: [step(2), step(3)],
  }
  const children: Record<string, SessionInfo[]> = { ses_parent: [child], ses_child: [] }

  return {
    session: {
      async get({ path }) {
        return { data: sessions[path.id] }
      },
      async messages({ path }) {
        return { data: messages[path.id] ?? [] }
      },
      async children({ path }) {
        return { data: children[path.id] ?? [] }
      },
    },
  }
}

const temporaries: string[] = []
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "session-metrics-"))
  temporaries.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("rolls descendants into the parent total without double-counting wall clock", async () => {
  const report = await buildReport(fakeClient(), "ses_parent")
  if (!report) throw new Error("expected a report")

  expect(report.self.llmSteps).toBe(1)
  expect(report.self.cost).toBe(1)
  expect(report.descendants.llmSteps).toBe(2)
  expect(report.descendants.cost).toBe(5)

  expect(report.total.llmSteps).toBe(3)
  expect(report.total.cost).toBe(6)
  expect(report.total.humanIterations).toBe(1)
  // The child ran inside the parent's 10s span, so the total keeps that span.
  expect(report.total.runtime.wallClockMs).toBe(10_000)
  expect(report.total.runtime.activeMs).toBe(3_000)

  expect(report.children).toEqual(["ses_child"])
  expect(report.parentID).toBeUndefined()
})

test("records the opening prompt, and omits it when capture is off", async () => {
  const client = fakeClient()
  expect((await buildReport(client, "ses_parent"))?.firstPrompt).toBe("what time is it?")
  expect((await buildReport(client, "ses_parent", { capturePrompt: false }))?.firstPrompt).toBeUndefined()
  expect((await buildReport(client, "ses_parent", { promptMaxChars: 4 }))?.firstPrompt).toBe("what…")
  // A subagent session is started by the parent, not typed by a human.
  expect((await buildReport(client, "ses_child"))?.firstPrompt).toBeUndefined()
})

test("a child report counts only itself", async () => {
  const report = await buildReport(fakeClient(), "ses_child")
  expect(report?.total.llmSteps).toBe(2)
  expect(report?.children).toEqual([])
  expect(report?.parentID).toBe("ses_parent")
})

test("returns undefined for an unknown session", async () => {
  expect(await buildReport(fakeClient(), "ses_missing")).toBeUndefined()
})

test("writes one file per session, named by session id, and rewrites in place", async () => {
  const dir = await scratch()
  const client = fakeClient()

  const first = await buildReport(client, "ses_parent")
  const path = await writeReport(dir, first!)
  expect(path).toBe(reportPath(dir, "ses_parent"))

  const second = await buildReport(client, "ses_parent")
  expect(await writeReport(dir, second!)).toBe(path)

  const parsed = await Bun.file(path).json()
  expect(parsed.sessionID).toBe("ses_parent")
  expect(parsed.schemaVersion).toBe(1)
  expect(parsed.total.cost).toBe(6)
})

test("writeChain rewrites the session and every ancestor", async () => {
  const dir = await scratch()
  const written = await writeChain(fakeClient(), dir, "ses_child")

  expect(written).toEqual([reportPath(dir, "ses_child"), reportPath(dir, "ses_parent")])
  // The parent file exists even though only the child went idle.
  expect(await Bun.file(reportPath(dir, "ses_parent")).exists()).toBe(true)
})

test("removeReport deletes the file and tolerates a missing one", async () => {
  const dir = await scratch()
  await writeChain(fakeClient(), dir, "ses_parent")
  await removeReport(dir, "ses_parent")
  expect(await Bun.file(reportPath(dir, "ses_parent")).exists()).toBe(false)
  await removeReport(dir, "ses_parent")
})

test("resolveDir prefers the configured value and expands ~", () => {
  expect(resolveDir("/tmp/explicit")).toBe("/tmp/explicit")
  expect(resolveDir("~/metrics").startsWith("/")).toBe(true)
  expect(resolveDir("~/metrics").endsWith("/metrics")).toBe(true)
  expect(resolveDir(undefined).endsWith(join("opencode", "metrics"))).toBe(true)
})
