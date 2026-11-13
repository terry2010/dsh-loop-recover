/**
 * dsh-loop-recover — 流处理核心（纯函数/纯状态机，不依赖 dsh，可离线单测）
 *
 * 从 dsh-loop-rescue (citydirector, MIT) 的 index.js 提炼，
 * 检测器换用并扩展自 dsh-loop-detector (viego-qiin, MIT) 的文本级检测（现五层）。
 */
import { detectRepetition, resolveDetectorOptions, } from "./detector.js";
/** 增量流式检测器：接收 delta，内部按窗口节流跑全量检测。
 *  各检测层只看尾部窗口，因此内部只保留 max(各窗口) 的尾巴（×2 摊销 slice 成本），
 *  裁掉的头部长度记入 dropped，命中时把 cutStart 换算回全文坐标——
 *  长 block 下内存有界，不再随流长线性增长。 */
export class StreamLoopDetector {
    text = '';
    dropped = 0;
    total = 0;
    nextCheck;
    opts;
    every;
    minLen;
    keep;
    constructor(options = {}) {
        const { checkEvery = 32, minLen = 256, ...detectorOpts } = options;
        this.opts = resolveDetectorOptions(detectorOpts);
        this.every = Math.max(1, checkEvery);
        this.minLen = Math.max(0, minLen);
        this.keep = Math.max(this.opts.anchorWindow, this.opts.poolWindow, this.opts.ngramWindow, this.opts.maxPeriod * this.opts.periodRepeats, this.opts.runMinChars);
        this.nextCheck = this.minLen;
    }
    /** 推入一段新文本；命中返回 LoopHit（cutStart 为全文坐标），否则 null。 */
    push(delta) {
        this.text += delta;
        this.total += delta.length;
        if (this.total < this.nextCheck)
            return null;
        this.nextCheck = this.total - (this.total % this.every) + this.every;
        if (this.text.length > this.keep * 2) {
            const cut = this.text.length - this.keep;
            this.text = this.text.slice(cut);
            this.dropped += cut;
        }
        const hit = detectRepetition(this.text, this.opts);
        if (hit?.cutStart !== undefined)
            hit.cutStart += this.dropped;
        return hit ?? null;
    }
    /** 已推入的全文长度（含已裁掉的头部）。 */
    get length() {
        return this.total;
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
    return { consecutive: 0, total: 0, stall: 0, overrides: 0, generation: 0 };
}
/** 一次剪枝命中后的决策：续跑 or 已达上限（连续上限或累计上限，先到先判）。 */
export function decideRescue(state, maxConsecutiveRescues, maxTotalRescues = Infinity) {
    state.consecutive++;
    state.total++;
    state.stall = 0;
    const byTotal = state.total > maxTotalRescues;
    return {
        action: state.consecutive > maxConsecutiveRescues || byTotal ? 'exhausted' : 'resume',
        consecutive: state.consecutive,
        total: state.total,
        byTotal,
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
