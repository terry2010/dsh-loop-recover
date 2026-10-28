/**
 * dsh-loop-recover：检测模型死循环 → 流内剪枝（落盘无循环段）→ 自动续跑。
 *
 * 续跑/剪枝机制移植自 dsh-loop-rescue (citydirector, MIT)；
 * 检测器与意图级检测移植自 dsh-loop-detector (viego-qiin, MIT)。
 *
 * ## 为什么能「剪掉」而不只是「截断」
 *
 * agent-loop 组装 `assistant/message` 时，每个 block 的最终内容取自 `block-end`
 * 的载荷，而不是之前累计的 delta。所以在 `llm/stream` 瀑布里切断时，只要给出
 * 剪过的 `block-end`，落盘的消息（下一轮发给模型的上下文）里就不会有循环部分。
 * 原始流仍完整保存在事件的 `stream` 记录里，轨迹视图可以看到全部内容。
 *
 * ## 流程
 *
 * 1. 包装每次 agent-loop 发起的模型调用，对每个 reasoning/text block 跑三层检测器；
 * 2. 命中后：闭合所有打开的 block（循环所在 block 换成剪过的内容），以 `stop` 结束流；
 * 3. `whenIdle()` 等回合真正结束后用 `followup()` 发带纠正语的续跑消息；
 * 4. 续跑的前 N 次请求可选地改用另一组采样参数；
 * 5. 连续救援达到上限就停止续跑，留一条提示等用户处理；
 * 6. tools/post-execute 上的意图级重复（换措辞搜同题）→ steer 纠正。
 *
 * 打开的 block 里有工具调用时不切：闭合半截工具调用会让宿主执行参数不完整的调用。
 *
 * @module dsh-loop-recover
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_DETECTOR,
  resolveDetectorOptions,
  type DetectorOptions,
} from './detector.ts'
import {
  IntentTracker,
  matchesTool,
  extractQueryText,
  resolveIntentOptions,
  type IntentOptions,
} from './intent.ts'
import {
  StreamLoopDetector,
  hasUnsafeOpenBlock,
  prunedBlockText,
  newRescueState,
  decideRescue,
  settleFinishedStream,
  type OpenBlock,
  type RescueState,
} from './stream-core.ts'
import { resolveLanguage, strings } from './i18n.ts'
import { commitLoopCompaction } from './compaction.ts'

export {
  DEFAULT_DETECTOR,
  resolveDetectorOptions,
  detectRepetition,
  type DetectorOptions,
  type LoopHit,
} from './detector.ts'
export {
  StreamLoopDetector,
  hasUnsafeOpenBlock,
  prunedBlockText,
  newRescueState,
  decideRescue,
  settleFinishedStream,
} from './stream-core.ts'

export const name = 'loop-recover'

/** agents/sessions 服务用于 sessionId→Agent 解析与 followup 续跑（rice-patrol 同源用法）。 */
export const inject = ['agents', 'sessions']

const detectorSchema = z.object({
  minPeriod: z.natural().min(1).default(DEFAULT_DETECTOR.minPeriod).volatile().description('周期扫描最小周期'),
  maxPeriod: z.natural().min(4).default(DEFAULT_DETECTOR.maxPeriod).volatile().description('周期扫描最大周期'),
  periodRepeats: z.natural().min(2).default(DEFAULT_DETECTOR.periodRepeats).volatile().description('周期至少重复次数'),
  ngramSize: z.natural().min(8).default(DEFAULT_DETECTOR.ngramSize).volatile().description('n-gram 块长'),
  ngramRepeats: z.natural().min(2).default(DEFAULT_DETECTOR.ngramRepeats).volatile().description('n-gram 至少出现次数'),
  ngramWindow: z.natural().min(256).default(DEFAULT_DETECTOR.ngramWindow).volatile().description('n-gram 尾部窗口'),
  ngramStep: z.natural().min(1).default(DEFAULT_DETECTOR.ngramStep).volatile().description('n-gram 抽样步长'),
  anchorSize: z.natural().min(64).default(DEFAULT_DETECTOR.anchorSize).volatile().description('锚段长度'),
  anchorWindow: z.natural().min(1024).default(DEFAULT_DETECTOR.anchorWindow).volatile().description('锚段尾部窗口'),
  minDistinctChars: z.natural().min(1).default(DEFAULT_DETECTOR.minDistinctChars).volatile().description('重复块最少不同字符数'),
  minSubstantiveRatio: z.number().min(0).max(1).default(DEFAULT_DETECTOR.minSubstantiveRatio).volatile().description('实义字符最低占比'),
  runMinChars: z.natural().min(16).default(DEFAULT_DETECTOR.runMinChars).volatile().description('单字符刷屏判定的最少连续字符数'),
  poolWindow: z.natural().min(1024).default(DEFAULT_DETECTOR.poolWindow).volatile().description('短句池检测窗口'),
  poolUnitMinChars: z.natural().min(4).default(DEFAULT_DETECTOR.poolUnitMinChars).volatile().description('短句池参与判定的最小句长'),
  poolMinRepeats: z.natural().min(2).default(DEFAULT_DETECTOR.poolMinRepeats).volatile().description('短句池同一短句最少重复次数'),
})

export const Config = z.object({
  mode: z.union(['rescue', 'cut', 'observe']).default('rescue').volatile()
    .description('rescue：切断+剪除+自动续跑；cut：切断+剪除，不续跑；observe：只记日志'),
  watch: z.union(['both', 'reasoning', 'text']).default('both').volatile().description('检测哪类内容'),
  marker: z.boolean().default(true).volatile().description('在剪除处留一行标记，让模型知道这里删过东西'),
  minLen: z.natural().min(32).default(256).volatile().description('单 block 累计多少字符后才开始检测'),
  checkEvery: z.natural().min(8).default(32).volatile().description('每累计多少字符跑一次检测'),
  maxConsecutiveRescues: z.natural().min(1).default(3).volatile().description('连续救援上限；一次正常调用清零'),
  stallCalls: z.natural().default(3).volatile().description('连续多少次「只思考无产出」的调用后提示继续；0 关闭'),
  stallMinReasoningChars: z.natural().default(1024).volatile().description('计入空转的单次推理最小长度'),
  retryTemperature: z.number().min(0).max(2).volatile().description('续跑请求改用的 temperature；不填则不改'),
  retryReasoningEffort: z.string().volatile().description('续跑请求改用的推理强度 ID（如 low）；不填则不改'),
  retryRequests: z.natural().default(1).volatile().description('续跑后多少次请求使用上面的参数'),
  compactOnRescue: z.boolean().default(true).volatile().description('续跑前压缩会话：旧上下文用检查点摘要 shadow'),
  intentEnabled: z.boolean().default(true).volatile().description('启用工具调用意图级重复检测（web_search 等）'),
  intentNoveltyThreshold: z.number().min(0).max(1).default(0.25).volatile().description('意图检测：新词占比低于此值判重复'),
  intentConfirmCount: z.natural().min(1).default(2).volatile().description('意图检测：连续多少次低新词查询后触发'),
  language: z.union(['auto', 'zh', 'en']).default('auto').volatile().description('提示语言；auto 跟随界面'),
  debugLog: z.boolean().default(false).volatile()
    .description('写开发诊断日志到 ~/.dsh/loop-recover-debug.log；默认关'),
  detector: detectorSchema.default({}), // 叶子字段已 volatile；父级再 volatile 会被 schema 拒绝
})

/** volatile 字段在 schema 解析后是 {get} 描述符；宿主 resolve 后是裸值——两种形态兼容 */
const volatileValue = (v: any) =>
  (v !== null && typeof v === 'object' && typeof v.get === 'function' &&
   Object.keys(v).every(k => k === 'get')) ? v.get() : v

/** 深遍历归一化：所有 volatile 描述符解包成裸值（含 detector 嵌套） */
const resolveVolatile = (v: any): any => {
  const r = volatileValue(v)
  if (r !== v) return r
  if (Array.isArray(r)) return r.map(resolveVolatile)
  if (r !== null && typeof r === 'object') {
    const out: any = {}
    for (const k of Object.keys(r)) out[k] = resolveVolatile(r[k])
    return out
  }
  return r
}

type ResolvedConfig = {
  mode: 'rescue' | 'cut' | 'observe'
  watch: 'both' | 'reasoning' | 'text'
  marker: boolean
  minLen: number
  checkEvery: number
  maxConsecutiveRescues: number
  stallCalls: number
  stallMinReasoningChars: number
  retryTemperature?: number
  retryReasoningEffort?: string
  retryRequests: number
  compactOnRescue: boolean
  intentEnabled: boolean
  intentNoveltyThreshold: number
  intentConfirmCount: number
  language: 'auto' | 'zh' | 'en'
  debugLog: boolean
  detector: DetectorOptions
}

const SOURCE = { kind: 'loop-recover' }

function notice(text: string, summary: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...SOURCE, form: 'notice', summary: summary.slice(0, 120) },
  })
}

interface AgentLike {
  whenIdle?: () => Promise<unknown> | unknown
  followup?: (msg: unknown) => void
  inject?: (msg: unknown) => void
  steer?: (msg: unknown) => void
  inbox?: { hasPending?: boolean }
}

export function apply(ctx: any, config: ResolvedConfig) {
  // volatile 描述符就地热更：用 Proxy 让每次 config.* 读取都实时解包，
  // 用户在配置页改值（宿主写 ref + volatile-update 事件）立即生效，不依赖重启。
  config = new Proxy(config, {
    get(t, k) {
      const v = (t as any)[k]
      const r = volatileValue(v)
      // detector 是嵌套对象：返回子代理让 detector.xxx 也实时解包
      if (k === 'detector' && r !== null && typeof r === 'object' && !Array.isArray(r)) {
        return new Proxy(r, { get: (t2: any, k2: any) => volatileValue(t2[k2]) })
      }
      return r
    },
  }) as ResolvedConfig
  const states = new WeakMap<object, RescueState>()
  const stateOf = (agent: object) => {
    let s = states.get(agent)
    if (s === undefined) {
      s = newRescueState()
      states.set(agent, s)
    }
    return s
  }
  const lang = () => resolveLanguage(ctx, config.language)
  const watches = (kind: string) => config.watch === 'both' || config.watch === kind
  // 惰性计算——每次使用时重算，volatile 热更立即生效（开销可忽略）
  const detectorOpts = () => resolveDetectorOptions(config.detector)
  const intentOpts = () => resolveIntentOptions({
    noveltyThreshold: config.intentNoveltyThreshold,
    stallLimit: config.intentConfirmCount,
  } as Partial<IntentOptions>)
  const intentTrackers = new WeakMap<object, IntentTracker>()

  /** 回合结束后续跑；期间若有新调用（generation 变）则作废。 */
  function scheduleFollowup(agent: AgentLike | undefined, state: RescueState, message: unknown) {
    if (typeof agent?.whenIdle !== 'function' || typeof agent.followup !== 'function') return
    const generation = state.generation
    const idle = agent.whenIdle()
    void Promise.resolve(idle).then(() => {
      if (state.generation !== generation) return
      if (agent.inbox?.hasPending) return
      agent.followup!(message)
      ctx.logger.debug('loop-recover: resumed after cut')
    }).catch((error: unknown) => {
      ctx.logger.warn(`loop-recover: resume failed: ${String(error)}`)
    })
  }

  let _append: ((p: string, d: string) => void) | undefined
  void import('node:fs').then((m) => { _append = m.appendFileSync }).catch(() => {})
  const dbg = (msg: string) => {
    if (!config.debugLog) return
    try { ctx.logger.warn(`loop-recover: ${msg}`) } catch { /* */ }
    try {
      _append?.(`${(globalThis as any).process?.env?.HOME}/.dsh/loop-recover-debug.log`,
        `${new Date().toISOString()} ${msg}\n`)
    } catch { /* best-effort */ }
  }
  dbg('apply() mounted')

  // cordis 代理拦截直接属性访问，服务必须走 ctx.get()
  const agentsOf = () => {
    try { return ctx.get?.('agents') } catch { return undefined }
  }
  const sessionsOf = () => {
    try { return ctx.get?.('sessions') } catch { return undefined }
  }
  const svc = agentsOf()
  dbg(`agents service: ${svc ? `type=${typeof svc} props=${[...Object.keys(svc), ...Object.getOwnPropertyNames(Object.getPrototypeOf(svc))].join('|')}` : 'MISSING'}`)

  ctx.on('llm/stream', (options: any, next: any) => {
    const sid = options?.sessionId
    const isLoop = isAgentLoopRequest(options)
    dbg(`llm/stream fired, agentLoop=${isLoop}, sessionId=${sid}, optKeys=${Object.keys(options ?? {}).join('|')}`)
    // 门禁：只干预 agent-loop 调用——title/summary 等旁路请求必须透传
    if (!isLoop || sid === undefined) return next()
    // agent 可能找不到（job/分叉会话）：照样检测+剪枝，只是不续跑
    const svcNow = agentsOf()
    const agent: AgentLike | undefined = svcNow?.get(sid)
    if (agent === undefined) {
      try {
        const probe = ['agents', 'sessions', 'jobs', 'llm', 'connection'].map((n) => {
          let v; try { v = ctx.get?.(n) } catch { v = 'THROW' }
          return `${n}=${v === 'THROW' ? 'THROW' : (v ? typeof v : 'MISSING')}`
        }).join(' ')
        dbg(`agent miss: svc=${svcNow} | ${probe}`)
      } catch (e) { dbg(`agent miss: svc enum failed ${String(e)}`) }
    }
    const state = stateOf(agent ?? options)
    state.generation++ // 新调用开始：之前排队的续跑作废

    return (async function* rescued() {
      const open = new Map<number, OpenBlock>()
      let reasoningChars = 0
      let hasOutput = false
      let finished = false

      for await (const chunk of next()) {
        if (chunk.type === 'block-start') {
          const kind = chunk.blockType
          const detector = (kind === 'reasoning' || kind === 'text') && watches(kind)
            ? new StreamLoopDetector({ ...detectorOpts(), checkEvery: config.checkEvery, minLen: config.minLen })
            : undefined
          open.set(chunk.index, { blockType: kind, text: '', detector })
        } else if (chunk.type === 'block-end') {
          open.delete(chunk.index)
        } else if (chunk.type === 'tool-call-delta') {
          hasOutput = true
        } else if (chunk.type === 'finish') {
          finished = true
        }

        let hit: import('./detector.ts').LoopHit | null = null
        let hitBlock: (OpenBlock & { index: number }) | undefined
        if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
          if (chunk.type === 'text-delta') hasOutput = true
          else reasoningChars += chunk.text.length
          const block = open.get(chunk.index)
          if (block !== undefined) {
            block.text += chunk.text
            hit = block.detector?.push(chunk.text) ?? null
            if (hit) hitBlock = { index: chunk.index, ...block }
          }
        }

        if (hit === null || hitBlock === undefined) {
          yield chunk
          continue
        }

        const kind = hitBlock.blockType
        const removed = Math.max(0, hitBlock.text.length - (hit.cutStart ?? hitBlock.text.length))
        ctx.logger.warn(`loop-recover: ${kind} loop detected (${hit.kind}, ~${removed} chars)`)
        if (config.mode === 'observe') {
          hitBlock.detector = undefined
          const live = open.get(hitBlock.index)
          if (live) live.detector = undefined
          yield chunk
          continue
        }
        if (hasUnsafeOpenBlock(open.values())) {
          ctx.logger.warn('loop-recover: a non-text block is open; not cutting')
          const live = open.get(hitBlock.index)
          if (live) live.detector = undefined
          yield chunk
          continue
        }

        const s = strings(lang())
        const wasExhausted = state.consecutive > config.maxConsecutiveRescues
        const decision = decideRescue(state, config.maxConsecutiveRescues)
        // 不 yield 当前 chunk：其内容已在 block.text 累计里，剪切按累计文本进行。
        const tail = []
        for (const [index, block] of open) {
          let text = block.text
          if (index === hitBlock.index) {
            const pruned = prunedBlockText(block.text, hit, config.marker ? s.marker(kind, removed) : undefined)
            text = pruned.text
          }
          tail.push({ type: 'block-end', index, block: { type: block.blockType, text } })
        }
        tail.push({ type: 'finish', reason: { kind: 'stop' } })

        if (config.mode === 'rescue') {
          if (decision.action === 'exhausted') {
            if (!wasExhausted && agent) { // 只在首次越限时提示，避免每次循环都打扰用户
              ctx.logger.warn(`loop-recover: ${decision.consecutive} consecutive cuts; auto-resume paused`)
              agent.inject?.(notice(s.exhausted(decision.consecutive), s.exhaustedSummary(decision.consecutive)))
            }
          } else if (agent) {
            state.overrides = config.retryRequests
            // FP7：续跑前先压缩——旧上下文整体 shadow，下一轮只看到摘要
            if (config.compactOnRescue) {
              const r = commitLoopCompaction(agent, s.resumeSummary(kind, removed), {
                provider: options.provider, model: options.model, sessions: sessionsOf(),
              })
              dbg(`compaction ${r.ok ? `committed, shadowed=${r.shadowed}` : `skipped: ${r.reason}`}`)
            }
            scheduleFollowup(agent, state, notice(s.resume(kind, removed), s.resumeSummary(kind, removed)))
          } else {
            dbg('loop detected & pruned (no agent handle; task stops without resume)')
          }
        }
        for (const c of tail) yield c
        return
      }

      if (!finished) return
      const settled = settleFinishedStream(state, {
        hasOutput,
        reasoningChars,
        stallCalls: config.mode === 'rescue' ? config.stallCalls : 0,
        stallMinReasoningChars: config.stallMinReasoningChars,
      })
      if (settled.stalled) {
        const s = strings(lang())
        ctx.logger.warn(`loop-recover: ${settled.stallCount} reasoning-only calls in a row`)
        scheduleFollowup(agent, state, notice(s.stall(settled.stallCount), s.stallSummary(settled.stallCount)))
      }
    })()
  })

  // 续跑请求可选地换一组采样参数，打破同一前缀下的确定性复读。
  ctx.on('agent/request', async (payload: any, next: any) => {
    const resolved = await next()
    const agent = payload?.agent as object | undefined
    if (agent === undefined) return resolved
    const state = states.get(agent)
    if (state === undefined || state.overrides <= 0) return resolved
    state.overrides--
    const patch: Record<string, unknown> = {}
    if (config.retryTemperature !== undefined) patch.temperature = config.retryTemperature
    if (config.retryReasoningEffort) patch.reasoningEffort = config.retryReasoningEffort
    return Object.keys(patch).length === 0 ? resolved : { ...resolved, ...patch }
  })

  // 工具调用意图级重复：换措辞搜同一主题 → steer 纠正。
  if (config.intentEnabled) {
    ctx.on('tools/post-execute', async (exec: any, result: any, next: any) => {
      const io = intentOpts()
      const toolName = exec?.name ?? exec?.tool ?? ''
      if (typeof toolName !== 'string' || !matchesTool(toolName, io.toolPatterns)) return next()
      const agent = exec?.agent as object | undefined
      const query = extractQueryText(exec?.arguments, io.maxQueryChars)
      if (agent === undefined || query.trim().length === 0) return next()
      let tracker = intentTrackers.get(agent)
      if (tracker === undefined) {
        tracker = new IntentTracker(io)
        intentTrackers.set(agent, tracker)
      }
      if (!tracker.observe(query).repeat) return next()
      const s = strings(lang())
      ctx.logger.warn(`loop-recover: intent-level loop on ${toolName}`)
      const msg = notice(s.intent(toolName), s.intentSummary(toolName))
      if (typeof (agent as AgentLike).steer === 'function') (agent as AgentLike).steer!(msg)
      else agent.inject?.(msg)
      return next()
    })
  }
}

export default { name, Config, apply }
