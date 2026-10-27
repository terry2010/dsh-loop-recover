/**
 * dsh-loop-recover — 流处理核心（纯函数/纯状态机，不依赖 dsh，可离线单测）
 *
 * 从 dsh-loop-rescue (citydirector, MIT) 的 index.js 提炼，
 * 检测器换用 dsh-loop-detector (viego-qiin, MIT) 的三层检测。
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

/** 增量流式检测器：接收 delta，内部按窗口节流跑全量检测。 */
export class StreamLoopDetector {
  private text = ''
  private nextCheck: number
  private readonly opts: DetectorOptions
  private readonly every: number
  private readonly minLen: number

  constructor(options: StreamDetectorOptions = {}) {
    const { checkEvery = 32, minLen = 256, ...detectorOpts } = options
    this.opts = resolveDetectorOptions(detectorOpts)
    this.every = Math.max(1, checkEvery)
    this.minLen = Math.max(0, minLen)
    this.nextCheck = this.minLen
  }

  /** 推入一段新文本；命中返回 LoopHit（含 cutStart），否则 null。 */
  push(delta: string): LoopHit | null {
    this.text += delta
    if (this.text.length < this.nextCheck) return null
    this.nextCheck = this.text.length - (this.text.length % this.every) + this.every
    const hit = detectRepetition(this.text, this.opts)
    return hit ?? null
  }

  get length(): number {
    return this.text.length
  }
}

/** 打开的流 block 的最小描述。 */
export interface OpenBlock {
  blockType: string
  text: string
  detector?: StreamLoopDetector
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

/** 救援状态机：连续救援计数、空转计数、续跑参数改写次数、世代号。 */
export interface RescueState {
  consecutive: number
  stall: number
  overrides: number
  generation: number
}

export function newRescueState(): RescueState {
  return { consecutive: 0, stall: 0, overrides: 0, generation: 0 }
}

export interface RescueDecision {
  action: 'resume' | 'exhausted'
  consecutive: number
}

/** 一次剪枝命中后的决策：续跑 or 已达上限。 */
export function decideRescue(state: RescueState, maxConsecutiveRescues: number): RescueDecision {
  state.consecutive++
  state.stall = 0
  return {
    action: state.consecutive > maxConsecutiveRescues ? 'exhausted' : 'resume',
    consecutive: state.consecutive,
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
