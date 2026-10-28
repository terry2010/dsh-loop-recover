/** index.ts 集成测试：mock ctx + agent + llm/stream 事件流，验证剪枝落盘与续跑 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import plugin, { apply, Config } from '../src/index.ts'

/** 构造 mock ctx：捕获 ctx.on 注册的处理器 */
function makeCtx() {
  const handlers = new Map()
  return {
    handlers,
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    i18n: { language: 'zh' },
    agents: new Map(),
    get(name) { return name === 'agents' ? this.agents : undefined },
    on: (event, fn) => handlers.set(event, fn),
  }
}

/** mock agent：whenIdle 立即 resolve，followup/steer 记录调用 */
function makeAgent() {
  return {
    followups: [],
    steers: [],
    whenIdle: () => Promise.resolve(),
    followup(msg) { this.followups.push(msg) },
    steer(msg) { this.steers.push(msg) },
    inbox: { hasPending: false },
  }
}

/** 构造一段含循环的 chunk 流 */
async function* loopStream(unit = '死循环复读片段ABC', reps = 60) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (let i = 0; i < reps; i++) yield { type: 'text-delta', index: 0, text: unit }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: unit.repeat(reps) } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function defaultConfig(overrides = {}) {
  return Config(overrides)
}

test('剪枝命中：block-end 载荷不含循环段 + finish stop + followup 续跑', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16 }))

  const handler = ctx.handlers.get('llm/stream')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  const out = []
  for await (const c of handler(options, () => loopStream())) out.push(c)

  // 最后一个 block-end 的 text 不应含循环单元
  const ends = out.filter(c => c.type === 'block-end')
  assert.ok(ends.length >= 1)
  const lastText = ends.at(-1).block.text
  assert.ok(!lastText.includes('死循环复读片段ABC死循环复读片段ABC死循环复读片段ABC死循环复读片段ABC'))
  assert.equal(out.at(-1).type, 'finish')
  // followup 被调度（whenIdle 已 resolve）
  await Promise.resolve()
  assert.equal(agent.followups.length, 1)
})

test('observe 模式：命中但不剪枝，流原样透传', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'observe', minLen: 64, checkEvery: 16 }))
  const handler = ctx.handlers.get('llm/stream')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  const out = []
  for await (const c of handler(options, () => loopStream())) out.push(c)
  // 原样透传：最后一个仍是 finish，且无中途截断的 block-end（只有流的最后一个）
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(agent.followups.length, 0)
})

test('含未闭合工具调用 block 时不剪', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16 }))
  const handler = ctx.handlers.get('llm/stream')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-start', index: 1, blockType: 'tool_call' } // 未闭合的工具调用
    for (let i = 0; i < 60; i++) yield { type: 'text-delta', index: 0, text: '死循环复读片段ABC' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = []
  for await (const c of handler(options, () => stream())) out.push(c)
  // 不剪：没有额外 block-end，只透传
  assert.equal(out.filter(c => c.type === 'block-end').length, 0)
  assert.equal(agent.followups.length, 0)
})

test('非 agent-loop 请求不拦截（全量透传+不续跑）', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({}))
  const handler = ctx.handlers.get('llm/stream')
  const expected = []
  for await (const c of loopStream()) expected.push(c)
  const seen = []
  for await (const c of handler({ sessionId: 's1' }, () => loopStream())) seen.push(c)
  assert.equal(seen.length, expected.length) // 全量透传不截断
  assert.equal(agent.followups.length, 0)    // 不续跑
})

async function* normalStream() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '正常的回复内容，没有循环。' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '正常的回复内容，没有循环。' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function drain(gen) {
  for await (const _ of gen) { /* drain */ }
}

test('正常输出无救援不续跑', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16 }))
  const handler = ctx.handlers.get('llm/stream')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  await drain(handler(options, () => normalStream()))
  await Promise.resolve()
  assert.equal(agent.followups.length, 0)
})

test('连续救援达上限：第 N+1 次 inject 提示且不再 followup', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  agent.injects = []
  agent.inject = function (m) { this.injects.push(m) }
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16, maxConsecutiveRescues: 3 }))
  const handler = ctx.handlers.get('llm/stream')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  for (let i = 0; i < 4; i++) {
    await drain(handler(options, () => loopStream()))
    await Promise.resolve()
  }
  assert.equal(agent.followups.length, 3)   // 前 3 次续跑
  assert.equal(agent.injects.length, 1)      // 第 4 次 exhausted 提示
})

test('正常输出重置计数：循环→正常→再循环三次仍续跑', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  agent.injects = []
  agent.inject = function (m) { this.injects.push(m) }
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16, maxConsecutiveRescues: 3 }))
  const handler = ctx.handlers.get('llm/stream')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  await drain(handler(options, () => loopStream())); await Promise.resolve()
  await drain(handler(options, () => normalStream())); await Promise.resolve()
  // 重置后再连续 3 次循环都应续跑（若未重置，第 4 次就会 exhausted）
  for (let i = 0; i < 3; i++) {
    await drain(handler(options, () => loopStream())); await Promise.resolve()
  }
  assert.equal(agent.followups.length, 4)
  assert.equal(agent.injects.length, 0)
})

test('generation 竞态：whenIdle 期间来了新调用则旧续跑作废', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  let resolveIdle
  agent.whenIdle = () => new Promise(r => { resolveIdle = r })
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16 }))
  const handler = ctx.handlers.get('llm/stream')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  await drain(handler(options, () => loopStream()))  // 剪枝并排队续跑
  await drain(handler(options, () => normalStream())) // 新调用 → generation++ 作废旧续跑
  resolveIdle()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(agent.followups.length, 0)
})

test('tools/post-execute：意图级重复 → steer 纠正', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ intentEnabled: true }))
  const handler = ctx.handlers.get('tools/post-execute')
  assert.equal(typeof handler, 'function')
  const next = async () => 'ok'
  // 同一主题重复查询 3 次 → 第 3 次触发 steer
  for (let i = 0; i < 3; i++) {
    await handler({ name: 'web_search', arguments: { query: 'qwen flash 本地 部署 速度' }, agent }, {}, next)
  }
  assert.equal(agent.steers.length, 1)
})

test('tools/post-execute：非搜索工具与空查询放行', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ intentEnabled: true }))
  const handler = ctx.handlers.get('tools/post-execute')
  const next = async () => 'ok'
  await handler({ name: 'read_file', arguments: { path: 'a.ts' }, agent }, {}, next)
  await handler({ name: 'web_search', arguments: {}, agent }, {}, next)
  assert.equal(agent.steers.length, 0)
})

test('agent/request 续跑改写采样参数且递减到 0', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16, retryTemperature: 0.9, retryRequests: 2 }))
  const streamH = ctx.handlers.get('llm/stream')
  const reqH = ctx.handlers.get('agent/request')
  const options = markAgentLoopRequest({ sessionId: 's1' })
  await drain(streamH(options, () => loopStream())); await Promise.resolve()

  const next = async () => ({ model: 'm', temperature: 0.5 })
  const r1 = await reqH({ agent }, next)
  const r2 = await reqH({ agent }, next)
  const r3 = await reqH({ agent }, next)
  assert.equal(r1.temperature, 0.9)  // 前 2 次被改写
  assert.equal(r2.temperature, 0.9)
  assert.equal(r3.temperature, 0.5)  // 第 3 次恢复
})

// === SECTION: 配置行为覆盖 ===

/** reasoning 循环流（blockType/delta 均为 reasoning） */
async function* reasoningLoopStream(unit = '思考复读片段XYZ', reps = 60) {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  for (let i = 0; i < reps; i++) yield { type: 'reasoning-delta', index: 0, text: unit }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: unit.repeat(reps) } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 纯推理空转流：只有 reasoning-delta，无 text 产出 */
async function* stallStream(chars = 2000) {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(chars) }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'x'.repeat(chars) } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('cut 模式：剪枝但不续跑', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'cut', minLen: 64, checkEvery: 16 }))
  const seen = []
  for await (const c of ctx.handlers.get('llm/stream')(markAgentLoopRequest({ sessionId: 's1' }), () => loopStream())) seen.push(c)
  const end = seen.find(c => c.type === 'block-end')
  assert.ok(end && !end.block.text.includes('死循环复读片段ABC'.repeat(60))) // 剪枝发生
  assert.equal(agent.followups.length, 0) // 但不续跑
})

test('watch=text：reasoning 循环不干预', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', watch: 'text', minLen: 64, checkEvery: 16 }))
  const expected = []
  for await (const c of reasoningLoopStream()) expected.push(c)
  const seen = []
  for await (const c of ctx.handlers.get('llm/stream')(markAgentLoopRequest({ sessionId: 's1' }), () => reasoningLoopStream())) seen.push(c)
  assert.equal(seen.length, expected.length) // 全量透传
  assert.equal(agent.followups.length, 0)
})

test('watch=reasoning：reasoning 循环命中剪枝', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'cut', watch: 'reasoning', minLen: 64, checkEvery: 16 }))
  const seen = []
  for await (const c of ctx.handlers.get('llm/stream')(markAgentLoopRequest({ sessionId: 's1' }), () => reasoningLoopStream())) seen.push(c)
  const end = seen.find(c => c.type === 'block-end')
  assert.ok(end && !end.block.text.includes('思考复读片段XYZ'.repeat(60)))
})

test('watch=reasoning：text 循环不干预', async () => {
  const ctx = makeCtx()
  ctx.agents.set('s1', makeAgent())
  apply(ctx, defaultConfig({ mode: 'rescue', watch: 'reasoning', minLen: 64, checkEvery: 16 }))
  const expected = []
  for await (const c of loopStream()) expected.push(c)
  const seen = []
  for await (const c of ctx.handlers.get('llm/stream')(markAgentLoopRequest({ sessionId: 's1' }), () => loopStream())) seen.push(c)
  assert.equal(seen.length, expected.length)
})

test('stall：连续纯推理空转触发续跑提示', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  ctx.agents.set('s1', agent)
  apply(ctx, defaultConfig({ mode: 'rescue', minLen: 64, checkEvery: 16, stallCalls: 1, stallMinReasoningChars: 32 }))
  for await (const c of ctx.handlers.get('llm/stream')(markAgentLoopRequest({ sessionId: 's1' }), () => stallStream())) { /* drain */ }
  await Promise.resolve(); await Promise.resolve()
  assert.equal(agent.followups.length, 1)
})

test('debugLog 控制诊断输出', async () => {
  let warns = 0
  const ctx = makeCtx()
  ctx.logger.warn = () => { warns++ }
  apply(ctx, defaultConfig({ debugLog: false }))
  assert.equal(warns, 0) // 关闭时 apply() mounted 都不写
  const ctx2 = makeCtx()
  ctx2.logger.warn = () => { warns++ }
  apply(ctx2, defaultConfig({ debugLog: true }))
  assert.ok(warns >= 1)
})

test('language 决定剪枝标记语言', async () => {
  for (const [lang, needle] of [['en', 'removed'], ['zh', '剪除']]) {
    const ctx = makeCtx()
    ctx.agents.set('s1', makeAgent())
    apply(ctx, defaultConfig({ mode: 'cut', minLen: 64, checkEvery: 16, language: lang }))
    const seen = []
    for await (const c of ctx.handlers.get('llm/stream')(markAgentLoopRequest({ sessionId: 's1' }), () => loopStream())) seen.push(c)
    const end = seen.find(c => c.type === 'block-end')
    assert.ok(end?.block?.text?.includes(needle), `${lang} 标记应包含 "${needle}"`)
  }
})

test('keepLanguage：中文注入语言约束，关闭后无', async () => {
  const run = async (keepLanguage) => {
    const { ctx, calls } = makeCtx({ i18n: { language: 'zh' } })
    const { injects } = ctx.__probe ?? { injects: [] }
    apply(ctx, defaultConfig({ keepLanguage }))
    const stream = reasoningLoopStream()
    await consumeStream(ctx, stream)
    return ctx
  }
  const c1 = await run(true)
  const c2 = await run(false)
  const text1 = JSON.stringify(c1.__injects ?? c1.injects ?? [])
  const text2 = JSON.stringify(c2.__injects ?? c2.injects ?? [])
  assert.ok(text1.includes('请继续用中文输出') || c1.__followups?.some((f) => JSON.stringify(f).includes('请继续用中文输出')))
  assert.ok(!(c2.__followups ?? []).some((f) => JSON.stringify(f).includes('请继续用中文输出')))
})

test('marker=false：剪枝不插入标记', async () => {
  const ctx = makeCtx()
  ctx.agents.set('s1', makeAgent())
  apply(ctx, defaultConfig({ mode: 'cut', minLen: 64, checkEvery: 16, marker: false }))
  const seen = []
  for await (const c of ctx.handlers.get('llm/stream')(markAgentLoopRequest({ sessionId: 's1' }), () => loopStream())) seen.push(c)
  const end = seen.find(c => c.type === 'block-end')
  assert.ok(!end.block.text.includes('剪除') && !end.block.text.includes('removed'))
})
