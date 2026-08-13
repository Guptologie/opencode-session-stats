#!/usr/bin/env bun
/**
 * One-shot backfill for chats that predate the plugin.
 *
 * The plugin only fires on `session.idle`, so sessions you already have never
 * get a file until they are used again. This walks every known session and
 * writes the same report the plugin would.
 *
 *   bun run src/backfill.ts                       # spawns a temporary server
 *   bun run src/backfill.ts --url http://…        # uses a server already running
 *   bun run src/backfill.ts --dir ./out           # override the output directory
 */

import { parseArgs } from "util"
import { buildReport, resolveDir, writeReport, type SessionClient } from "./report.ts"
import type { SessionInfo } from "./metrics.ts"

const USAGE = `usage: bun run src/backfill.ts [options]

  --url <baseUrl>      use an opencode server that is already running
  --dir <path>         output directory (default: $OPENCODE_METRICS_DIR or
                       ~/.local/share/opencode/metrics)
  --concurrency <n>    sessions processed in parallel (default: 8)
  --help               show this message`

const { values } = (() => {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        url: { type: "string" },
        dir: { type: "string" },
        concurrency: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(`\n${USAGE}`)
    process.exit(1)
  }
})()

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}

const dir = resolveDir(values.dir)
const concurrency = Math.max(1, Number(values.concurrency ?? 8) || 8)

const { createOpencodeClient, createOpencodeServer } = await import("@opencode-ai/sdk")

// Reuse a running server when one is given; otherwise spawn our own and shut it
// down at the end. Port 0 lets the OS pick a free port so this never collides
// with an opencode you already have running. Spawning needs `opencode` on PATH.
const server = values.url
  ? undefined
  : await createOpencodeServer({ port: 0, timeout: 30_000 }).catch((error) => {
      console.error(`could not start an opencode server: ${error instanceof Error ? error.message : String(error)}`)
      console.error("is `opencode` on your PATH? otherwise pass --url http://127.0.0.1:4096")
      process.exit(1)
    })
const baseUrl = values.url ?? server!.url

const client = createOpencodeClient({ baseUrl }) as unknown as SessionClient & {
  session: { list(options?: unknown): Promise<{ data?: unknown }> }
}

try {
  const listed = await client.session.list({}).catch((error) => {
    console.error(`could not reach the opencode server at ${baseUrl}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
  const sessions = (listed.data as SessionInfo[] | undefined) ?? []
  console.log(`backfilling ${sessions.length} session(s) into ${dir}`)

  let written = 0
  let skipped = 0

  // Each session is written directly rather than via writeChain: the loop
  // already visits every parent, so walking ancestors would only redo work.
  const queue = [...sessions]
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let next = queue.pop(); next; next = queue.pop()) {
        try {
          const report = await buildReport(client, next.id)
          if (!report) {
            skipped++
            continue
          }
          await writeReport(dir, report)
          written++
        } catch (error) {
          skipped++
          console.error(`  ${next.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }),
  )

  console.log(`wrote ${written} file(s)${skipped ? `, skipped ${skipped}` : ""}`)
} finally {
  server?.close()
}
