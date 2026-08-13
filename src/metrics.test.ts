import { expect, test } from "bun:test"
import { computeMetrics, emptyMetrics, merge, type MessageWithParts, type SessionInfo } from "./metrics.ts"

const session: SessionInfo = {
  id: "ses_a",
  projectID: "prj_1",
  directory: "/tmp/x",
  title: "test",
  time: { created: 1_000, updated: 11_000 },
}

const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 50 } }

function assistant(over: Partial<MessageWithParts["info"]> = {}, parts: MessageWithParts["parts"] = []) {
  return {
    info: { role: "assistant" as const, time: { created: 0, completed: 1_000 }, providerID: "p", modelID: "m", ...over },
    parts,
  } as MessageWithParts
}

test("counts only non-synthetic user turns as human iterations", () => {
  const messages: MessageWithParts[] = [
    { info: { role: "user", time: { created: 0 } }, parts: [{ type: "text", synthetic: false }] },
    // The "tool was executed by the user" notice — synthetic, not a human turn.
    { info: { role: "user", time: { created: 0 } }, parts: [{ type: "text", synthetic: true }] },
    // A compaction summary row carries no plain text part at all.
    { info: { role: "user", time: { created: 0 } }, parts: [{ type: "compaction" }] },
    { info: { role: "user", time: { created: 0 } }, parts: [{ type: "text" }] },
  ]
  expect(computeMetrics(session, messages).humanIterations).toBe(2)
})

test("counts assistant messages as steps and splits out summaries", () => {
  const metrics = computeMetrics(session, [assistant(), assistant(), assistant({ summary: true })])
  expect(metrics.llmSteps).toBe(2)
  expect(metrics.summarySteps).toBe(1)
})

test("sums active time only over completed steps", () => {
  const metrics = computeMetrics(session, [
    assistant({ time: { created: 0, completed: 1_500 } }),
    assistant({ time: { created: 2_000, completed: 2_500 } }),
    assistant({ time: { created: 9_000 } }), // interrupted, no completion
  ])
  expect(metrics.runtime.activeMs).toBe(2_000)
  expect(metrics.runtime.wallClockMs).toBe(10_000)
})

test("sums usage from step-finish parts, not from message tokens", () => {
  const metrics = computeMetrics(session, [
    assistant({}, [{ type: "step-finish", cost: 0.5, tokens }]),
    assistant({}, [{ type: "step-finish", cost: 0.25, tokens }]),
  ])
  expect(metrics.cost).toBeCloseTo(0.75)
  expect(metrics.tokens.input).toBe(20)
  expect(metrics.tokens.cache.read).toBe(200)
  expect(metrics.tokens.total).toBe(334)
  expect(metrics.byModel["p/m"]).toEqual({ steps: 2, tokens: { input: 20, output: 10, reasoning: 4, cache: { read: 200, write: 100 } }, cost: 0.75 })
})

test("classifies tool calls and accumulates only settled durations", () => {
  const metrics = computeMetrics(session, [
    assistant({}, [
      { type: "tool", tool: "bash", state: { status: "completed", time: { start: 0, end: 300 } } },
      { type: "tool", tool: "bash", state: { status: "error", time: { start: 0, end: 200 } } },
      { type: "tool", tool: "read", state: { status: "running", time: { start: 0 } } },
      { type: "tool", tool: "read", state: { status: "pending" } },
    ]),
  ])
  expect(metrics.toolCalls).toEqual({
    total: 4,
    completed: 1,
    error: 1,
    pending: 2,
    byTool: { bash: 2, read: 2 },
  })
  expect(metrics.runtime.toolMs).toBe(500)
})

test("merge sums work but takes the max wall clock", () => {
  const parent = computeMetrics(session, [assistant({}, [{ type: "step-finish", cost: 1, tokens }])])
  const child = computeMetrics(
    { ...session, id: "ses_b", time: { created: 2_000, updated: 5_000 } },
    [assistant({}, [{ type: "step-finish", cost: 2, tokens }])],
  )
  const total = merge(parent, child)

  // The child ran inside the parent's span; summing spans would double-count.
  expect(total.runtime.wallClockMs).toBe(10_000)
  expect(total.runtime.activeMs).toBe(2_000)
  expect(total.llmSteps).toBe(2)
  expect(total.cost).toBe(3)
  expect(total.tokens.total).toBe(334)
  expect(total.byModel["p/m"]?.steps).toBe(2)
})

test("merging with an empty metrics value is an identity for counts", () => {
  const metrics = computeMetrics(session, [assistant({}, [{ type: "tool", tool: "bash", state: { status: "pending" } }])])
  const merged = merge(metrics, emptyMetrics())
  expect(merged.toolCalls).toEqual(metrics.toolCalls)
  expect(merged.llmSteps).toBe(metrics.llmSteps)
})
