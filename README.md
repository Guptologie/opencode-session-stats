# opencode-session-stats

An [opencode](https://opencode.ai) plugin that writes per-chat metrics to one
JSON file per session, for offline analysis.

One file per session, named by session ID. Every write is a full snapshot, so
resuming a chat rewrites **the same file** with updated cumulative totals —
nothing is appended, and a crash mid-turn self-heals on the next write.

## Install

```sh
git clone git@github.com:Guptologie/opencode-session-stats.git
cd opencode-session-stats
bun install

mkdir -p ~/.config/opencode/plugin
ln -s "$PWD/src/index.ts" ~/.config/opencode/plugin/session-metrics.ts
```

Symlink the **file**, not the folder — plugin discovery globs `plugin/*.ts` at
the top level only, so a symlinked directory would leave `src/index.ts` one
level too deep to be found.

`~/.config/opencode/` is read for every project on the machine, so this collects
metrics from all your chats rather than only those started in one repo.

## Output

Default location is `~/.local/share/opencode/metrics/<sessionID>.json`. Override
with `$OPENCODE_METRICS_DIR`, or via config:

```json
{
  "plugin": [["/abs/path/to/src/index.ts", { "dir": "~/chat-metrics" }]]
}
```

```jsonc
{
  "schemaVersion": 1,
  "sessionID": "ses_…",
  "parentID": null,
  "projectID": "…",
  "title": "…",
  "directory": "/path/to/project",
  "time": { "created": 0, "updated": 0 },
  "writtenAt": 0,
  "self":        { /* this session's own transcript */ },
  "descendants": { /* all subagent sessions, recursively */ },
  "total":       { /* self + descendants */ },
  "children": ["ses_…"],
  "reported": { "cost": 0, "tokens": {} }  // opencode's own totals, for cross-checking
}
```

Each metrics block:

```jsonc
{
  "runtime": {
    "wallClockMs": 0,  // session span, including time you spent thinking
    "activeMs": 0,     // time the agent was generating, summed over LLM steps
    "toolMs": 0        // time inside tool execution (a subset of activeMs)
  },
  "humanIterations": 0,
  "llmSteps": 0,
  "summarySteps": 0,
  "toolCalls": { "total": 0, "completed": 0, "error": 0, "pending": 0, "byTool": {} },
  "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 }, "total": 0 },
  "cost": 0,
  "byModel": { "<provider>/<model>": { "steps": 0, "tokens": {}, "cost": 0 } }
}
```

## How each metric is defined

Everything is derived from data opencode already persists — the plugin adds no
instrumentation, it only reads and aggregates.

- **`humanIterations`** — user messages that carry at least one text part the
  runtime did not synthesise. A plain count of `role: "user"` rows would
  overcount: opencode also writes user-role messages for compaction summaries
  and for the "the following tool was executed by the user" notice.
- **`llmSteps`** — assistant messages, excluding summarisation calls. The
  agentic loop invokes the model once per iteration rather than using an
  SDK-side step limit, so one assistant message is exactly one step. Counting
  messages rather than `step-finish` parts also captures steps that errored or
  were interrupted before reporting usage.
- **`tokens` / `cost`** — summed from `step-finish` parts, which is how
  opencode's own projector maintains its session totals. Deliberately *not*
  summed from assistant messages: a message's `tokens` field is overwritten per
  step while only `cost` accumulates. `reported` carries opencode's own numbers
  so you can check for drift.
- **`runtime.activeMs`** — summed over steps that completed. An interrupted step
  contributes nothing, since it has no completion timestamp.
- **`runtime.wallClockMs`** in `total` — kept as the parent's own span rather
  than summed. Subagents run *inside* their parent's elapsed time, so adding
  their spans would double-count the clock. `activeMs` and `toolMs` are genuine
  additional work and do sum.

## Subagents

A parent's `total` includes every descendant session recursively, and each child
also gets its own file. Because a subagent goes idle *before* its parent, the
plugin rewrites the whole ancestor chain on every idle — otherwise a parent
would never pick up its children's contribution.

## Backfill

The plugin only fires going forward. To generate files for chats you already
have:

```sh
bun run src/backfill.ts               # spawns a temporary server (needs `opencode` on PATH)
bun run src/backfill.ts --url http://127.0.0.1:4096   # use a running server
bun run src/backfill.ts --dir ./out
```

## Analysis

Files are flat and one-per-session, so they load directly:

```sh
jq -s 'map({id: .sessionID, steps: .total.llmSteps, human: .total.humanIterations,
            tools: .total.toolCalls.total, cost: .total.cost,
            activeMin: (.total.runtime.activeMs / 60000)})' \
   ~/.local/share/opencode/metrics/*.json
```

```python
import json, glob, pandas as pd
df = pd.json_normalize([json.load(open(f)) for f in
                        glob.glob("~/.local/share/opencode/metrics/*.json")])
```

## Development

```sh
bun test        # unit tests for aggregation and report building
bun run typecheck
```

## Notes

The metric shapes are declared structurally rather than imported from
`@opencode-ai/sdk`, on purpose: the generated v1 `Session` type is currently
missing `cost`/`tokens` even though the server returns them, and a plugin should
keep working across SDK regenerations.

## License

MIT
