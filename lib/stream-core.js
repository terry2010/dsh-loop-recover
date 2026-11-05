/**
 * dsh-loop-recover — 流处理核心（纯函数/纯状态机，不依赖 dsh，可离线单测）
 *
 * 从 dsh-loop-rescue (citydirector, MIT) 的 index.js 提炼，
 * 检测器换用 dsh-loop-detector (viego-qiin, MIT) 的三层检测。
 */
import { detectRepetition, resolveDetectorOptions, } from "./detector.js";
/** 增量流式检测器：接收 delta，内部按窗口节流跑全量检测。 */
export class StreamLoopDetector {
    text = '';
    nextCheck;
    opts;
    every;
    minLen;
    constructor(options = {}) {
        const { checkEvery = 32, minLen = 256, ...detectorOpts } = options;
        this.opts = resolveDetectorOptions(detectorOpts);
        this.every = Math.max(1, checkEvery);
        this.minLen = Math.max(0, minLen);
        this.nextCheck = this.minLen;
    }
    /** 推入一段新文本；命中返回 LoopHit（含 cutStart），否则 null。 */
    push(delta) {
        this.text += delta;
        if (this.text.length < this.nextCheck)
            return null;
        this.nextCheck = this.text.length - (this.text.length % this.every) + this.every;
        const hit = detectRepetition(this.text, this.opts);
        return hit ?? null;
    }
    get length() {
        return this.text.length;
    }
}
/** 剪枝后的 block-end 载荷：截到 cutStart + 可选标记行。 */
export function prunedBlockText(blockText, hit, markerText) {
    const cut = hit.cutStart ?? blockText.length;
    let text = blockText.slice(0, Math.max(0, cut)).replace(/\s+$/, '');
    if (markerText)
        text += markerText;
    return { text, removedChars: Math.max(0, blockText.length - cut) };
}
/** 是否含非文本/推理类未闭合 block（含则不可剪，半截工具调用会被执行）。 */
export function hasUnsafeOpenBlock(open) {
    for (const b of open) {
        if (b.blockType !== 'text' && b.blockType !== 'reasoning')
            return true;
    }
    return false;
}
export function newRescueState() {
    return { consecutive: 0, stall: 0, overrides: 0, generation: 0 };
}
/** 一次剪枝命中后的决策：续跑 or 已达上限。 */
export function decideRescue(state, maxConsecutiveRescues) {
    state.consecutive++;
    state.stall = 0;
    return {
        action: state.consecutive > maxConsecutiveRescues ? 'exhausted' : 'resume',
        consecutive: state.consecutive,
    };
}
/** 流自然结束的结算：有产出重置；纯推理空转累计。 */
export function settleFinishedStream(state, args) {
    if (args.hasOutput) {
        state.consecutive = 0;
        state.stall = 0;
        return { stalled: false, stallCount: 0 };
    }
    if (args.stallCalls > 0 && args.reasoningChars >= args.stallMinReasoningChars) {
        state.stall++;
        if (state.stall >= args.stallCalls) {
            const n = state.stall;
            state.stall = 0;
            return { stalled: true, stallCount: n };
        }
    }
    return { stalled: false, stallCount: 0 };
}
