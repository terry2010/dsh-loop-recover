/**
 * dsh-loop-recover — 流处理核心（纯函数/纯状态机，不依赖 dsh，可离线单测）
 *
 * 从 dsh-loop-rescue (citydirector, MIT) 的 index.js 提炼，
 * 检测器换用并扩展自 dsh-loop-detector (viego-qiin, MIT) 的文本级检测（现五层）。
 */

import {
  detectRepetition,
  resolveDetectorOptions,
  type DetectorOptions,
  type LoopHit,
} from './detector.ts'

export interface StreamDetectorOptions extends Partial<DetectorOptions> {
  /** 每累计多少字符才跑一次检测（摊销成本）。默认 32 */
  checkEvery?: number
  /** 文本短于该值不检测（防误判）。默认 256 */
  minLen?: number
}

/** 增量流式检测器：接收 delta，内部按窗口节流跑全量检测。
 *  各检测层只看尾部窗口，因此内部只保留 max(各窗口) 的尾巴（×2 摊销 slice 成本），
 *  裁掉的头部长度记入 dropped，命中时把 cutStart 换算回全文坐标——
 *  长 block 下内存有界，不再随流长线性增长。 */
export class StreamLoopDetector {
  private text = ''
  private dropped = 0
  private total = 0
  private nextCheck: number
  private readonly opts: DetectorOptions
  private readonly every: number
  private readonly minLen: number
  private readonly keep: number

  constructor(options: StreamDetectorOptions = {}) {
    const { checkEvery = 32, minLen = 256, ...detectorOpts } = options
    this.opts = resolveDetectorOptions(detectorOpts)
    this.every = Math.max(1, checkEvery)
    this.minLen = Math.max(0, minLen)
    this.keep = Math.max(
      this.opts.anchorWindow, this.opts.poolWindow, this.opts.ngramWindow,
      this.opts.maxPeriod * this.opts.periodRepeats, this.opts.runMinChars,
    )
    this.nextCheck = this.minLen
  }

  /** 推入一段新文本；命中返回 LoopHit（cutStart 为全文坐标），否则 null。 */
  push(delta: string): LoopHit | null {
    this.text += delta
    this.total += delta.length
    if (this.total < this.nextCheck) return null
    this.nextCheck = this.total - (this.total % this.every) + this.every
    if (this.text.length > this.keep * 2) {
      const cut = this.text.length - this.keep
      this.text = this.text.slice(cut)
      this.dropped += cut
    }
    const hit = detectRepetition(this.text, this.opts)
    if (hit?.cutStart !== undefined) hit.cutStart += this.dropped
    return hit ?? null
  }

  /** 已推入的全文长度（含已裁掉的头部）。 */
  get length(): number {
    return this.total
  }
}

/** 打开的流 block 的最小描述。 */
export interface OpenBlock {
  blockType: string
  text: string
  detector?: StreamLoopDetector
  /** 曾因未闭合非文本 block 暂缓剪枝（只告警一次；闭合后命中仍可剪） */
  deferred?: boolean
}

/** 剪枝后的 block-end 载荷：截到 cutStart + 可选标记行。 */
export function prunedBlockText(
  blockText: string,
  hit: LoopHit,
  markerText: string | undefined,
): { text: string; removedChars: number } {
  const cut = hit.cutStart ?? blockText.length
  let text = blockText.slice(0, Math.max(0, cut)).replace(/\s+$/, '')
  if (markerText) text += markerText
  return { text, removedChars: Math.max(0, blockText.length - cut) }
}

/** 是否含非文本/推理类未闭合 block（含则不可剪，半截工具调用会被执行）。 */
export function hasUnsafeOpenBlock(open: Iterable<OpenBlock>): boolean {
  for (const b of open) {
    if (b.blockType !== 'text' && b.blockType !== 'reasoning') return true
  }
  return false
}

/** 救援状态机：连续/累计救援计数、空转计数、续跑参数改写次数、世代号。 */
export interface RescueState {
  consecutive: number
  /** 累计救援次数；不随正常产出清零——封顶防"打一次嘴干一次活"式无限救援 */
  total: number
  stall: number
  overrides: number
  generation: number
}

export function newRescueState(): RescueState {
  return { consecutive: 0, total: 0, stall: 0, overrides: 0, generation: 0 }
}

export interface RescueDecision {
  action: 'resume' | 'exhausted'
  consecutive: number
  total: number
  /** 触发上限的是累计次数而非连续次数 */
  byTotal: boolean
}

/** 一次剪枝命中后的决策：续跑 or 已达上限（连续上限或累计上限，先到先判）。 */
export function decideRescue(
  state: RescueState,
  maxConsecutiveRescues: number,
  maxTotalRescues = Infinity,
): RescueDecision {
  state.consecutive++
  state.total++
  state.stall = 0
  const byTotal = state.total > maxTotalRescues
  return {
    action: state.consecutive > maxConsecutiveRescues || byTotal ? 'exhausted' : 'resume',
    consecutive: state.consecutive,
    total: state.total,
    byTotal,
  }
}

/** 流自然结束的结算：有产出重置；纯推理空转累计。 */
export function settleFinishedStream(
  state: RescueState,
  args: { hasOutput: boolean; reasoningChars: number; stallCalls: number; stallMinReasoningChars: number },
): { stalled: boolean; stallCount: number } {
  if (args.hasOutput) {
    state.consecutive = 0
    state.stall = 0
    return { stalled: false, stallCount: 0 }
  }
  if (args.stallCalls > 0 && args.reasoningChars >= args.stallMinReasoningChars) {
    state.stall++
    if (state.stall >= args.stallCalls) {
      const n = state.stall
      state.stall = 0
      return { stalled: true, stallCount: n }
    }
  }
  return { stalled: false, stallCount: 0 }
}
