/**
 * opencode plugin: write per-session metrics to one JSON file per chat.
 *
 * Symlink this file into the global plugin directory to enable it everywhere:
 *
 *   mkdir -p ~/.config/opencode/plugin
 *   ln -s "$PWD/src/index.ts" ~/.config/opencode/plugin/session-metrics.ts
 *
 * The symlink must point at this file rather than the folder: plugin discovery
 * globs `plugin/*.ts` at the top level only.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { removeReport, resolveDir, writeChain, type SessionClient } from "./report.ts"

export const SessionMetricsPlugin: Plugin = async ({ client }, options) => {
  const dir = resolveDir(options?.["dir"])
  const sessions = client as unknown as SessionClient
  const build = {
    capturePrompt: options?.["capturePrompt"] !== false,
    promptMaxChars: typeof options?.["promptMaxChars"] === "number" ? options["promptMaxChars"] : undefined,
  }

  return {
    event: async ({ event }) => {
      // A hook that throws would surface as a plugin error mid-session. Metrics
      // are never worth interrupting a chat for, so every failure is swallowed
      // after being logged.
      try {
        if (event.type === "session.idle") {
          const sessionID = (event.properties as { sessionID?: string }).sessionID
          if (sessionID) await writeChain(sessions, dir, sessionID, build)
          return
        }

        if (event.type === "session.deleted") {
          // The runtime payload carries both `sessionID` and `info`, though the
          // generated SDK type currently only declares `info`.
          const properties = event.properties as { sessionID?: string; info?: { id?: string } }
          const sessionID = properties.sessionID ?? properties.info?.id
          if (sessionID) await removeReport(dir, sessionID)
        }
      } catch (error) {
        console.error("[session-metrics] failed to write metrics:", error)
      }
    },
  }
}

export default SessionMetricsPlugin
