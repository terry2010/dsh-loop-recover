/**
 * dsh-loop-detector — 文本级重复检测器（纯函数，可离线单测）
 *
 * 三层检测，全部只看文本尾部窗口，避免长输出下的二次方开销：
 *   1. 周期扫描：尾部 N 个周期逐字符一致（周期 8..256）
 *   2. n-gram：最近窗口内 64 字符块出现 >= 3 次（步长抽样，允许不对齐）
 *   3. 大段锚段：尾部锚段在更早文本再现，并向前扩展 >= 锚段长度
 *
 * 每一层都过一遍"实义字符"判据：只有标点/空白/符号构成的重复块（例如
 * markdown 分隔线 `|:---|:---|`、`--------`、`=====`）不算死循环，避免误伤。
 */

export interface DetectorOptions {
  /** 周期扫描的最小周期。默认 8 */
  minPeriod: number
  /** 周期扫描的最大周期。默认 256 */
  maxPeriod: number
  /** 周期至少要重复几次才算死循环。默认 4 */
  periodRepeats: number
  /** n-gram 块长度。默认 64 */
  ngramSize: number
  /** n-gram 块至少出现几次。默认 3 */
  ngramRepeats: number
  /** n-gram 检测窗口（只看尾部这么多字符）。默认 2048 */
  ngramWindow: number
  /** n-gram 抽样步长；越小越不容易漏检，越大越省 CPU。默认 16 */
  ngramStep: number
  /** 大段锚段长度。默认 512 */
  anchorSize: number
  /** 大段锚段检测窗口。默认 8192 */
  anchorWindow: number
  /** 重复块内至少要有几个不同字符（拦 "-----" 这类单字符涂抹）。默认 2 */
  minDistinctChars: number
  /** 重复块内实义字符（字母/数字/汉字，排除标点空白符号）的最低占比。默认 0.3 */
  minSubstantiveRatio: number
  /** 单字符刷屏检测：尾部同一实义字符连续出现超过该长度即判循环。默认 128 */
  runMinChars: number
  /** 短句池：检测窗口（尾部字符数）。默认 8192 */
  poolWindow: number
  /** 短句池：参与判定的最小句长（字符）。默认 8 */
  poolUnitMinChars: number
  /** 短句池：同一短句至少出现几次判循环。默认 4 */
  poolMinRepeats: number
}

export const DEFAULT_DETECTOR: DetectorOptions = {
  minPeriod: 8,
  maxPeriod: 256,
  periodRepeats: 4,
  ngramSize: 64,
  ngramRepeats: 3,
  ngramWindow: 2048,
  ngramStep: 16,
  anchorSize: 512,
  anchorWindow: 8192,
  minDistinctChars: 2,
  minSubstantiveRatio: 0.3,
  runMinChars: 128,
  poolWindow: 8192,
  poolUnitMinChars: 8,
  poolMinRepeats: 4,
}

export type LoopKind = 'periodic' | 'ngram' | 'anchor' | 'charrun' | 'pool'

export interface LoopHit {
  kind: LoopKind
  /** 面向日志的一句话说明 */
  detail: string
  /** 重复内容预览，便于人工判断误报 */
  evidence: string
  /** 循环区域在全文中的起始下标（剪枝位置）；未计算时为 undefined */
  cutStart?: number
  /** 命中的周期长度（仅 periodic）；用于调试与扩展回溯 */
  period?: number
}

/** 实义字符：字母、数字、汉字等；排除空白、标点、符号。 */
const SUBSTANTIVE = /[^\s\p{P}\p{S}]/u

function substantiveRatio(text: string): number {
  if (text.length === 0) return 0
  let n = 0
  for (const ch of text) if (SUBSTANTIVE.test(ch)) n++
  return n / [...text].length
}

/**
 * 重复块是否"有信息量"。用于压掉排版噪声：
 * 只有 ≥2 种字符、且实义字符占比达标（或至少含 1 个实义字符且块足够长）的重复才算循环。
 */
export function isMeaningfulUnit(unit: string, options: DetectorOptions = DEFAULT_DETECTOR): boolean {
  if (unit.length === 0) return false
  const distinct = new Set(unit).size
  if (distinct < options.minDistinctChars) return false
  return substantiveRatio(unit) >= options.minSubstantiveRatio
}

/** pool 单元的"句形"判定：至少 2 个词元（字母词≥2字符或单个 CJK）。
 *  滤掉 JSON/代码结构行——`"tags": [` 只有 1 个词元，真短句必然 ≥2。 */
function hasSentenceShape(unit: string): boolean {
  return (unit.match(/[A-Za-z]{2,}|[一-鿿]/g)?.length ?? 0) >= 2
}

/** 1) 周期扫描：尾部 `periodRepeats` 个周期逐字符一致。 */
export function detectPeriodic(text: string, options: DetectorOptions = DEFAULT_DETECTOR): LoopHit | null {
  const len = text.length
  const max = Math.min(options.maxPeriod, Math.floor(len / options.periodRepeats))
  for (let period = options.minPeriod; period <= max; period++) {
    const need = period * options.periodRepeats
    const tail = text.slice(len - need)
    const unit = tail.slice(0, period)
    if (!isMeaningfulUnit(unit, options)) continue
    let ok = true
    for (let r = 1; r < options.periodRepeats; r++) {
      if (tail.slice(r * period, (r + 1) * period) !== unit) {
        ok = false
        break
      }
    }
    if (ok) {
      // 向前回溯：只要前一个字符仍延续同一周期模式，循环起点就继续前移
      let start = len - need
      while (start > 0 && text[start - 1] === text[start - 1 + period]) start--
      return {
        kind: 'periodic',
        detail: `periodic repeat: period=${period} x${options.periodRepeats}`,
        evidence: unit.slice(0, 60),
        cutStart: start,
        period,
      }
    }
  }
  return null
}

/** 2) n-gram：最近窗口内同一 64 字符块出现 >= 3 次。 */
export function detectNgram(text: string, options: DetectorOptions = DEFAULT_DETECTOR): LoopHit | null {
  const window = text.length > options.ngramWindow ? text.slice(-options.ngramWindow) : text
  const size = options.ngramSize
  const step = Math.max(1, options.ngramStep)
  const counts = new Map<string, number>()
  for (let i = 0; i + size <= window.length; i += step) {
    const seg = window.slice(i, i + size)
    if (!isMeaningfulUnit(seg, options)) continue
    const n = (counts.get(seg) ?? 0) + 1
    if (n >= options.ngramRepeats) {
      // 该块在窗口内最早出现的位置即循环起点（换算回全文坐标）
      const firstIdx = window.indexOf(seg)
      const offset = text.length - window.length
      return {
        kind: 'ngram',
        detail: `n-gram repeat: ${size}-char block x${n}`,
        evidence: seg.slice(0, 60),
        cutStart: firstIdx === -1 ? undefined : offset + firstIdx,
      }
    }
    counts.set(seg, n)
  }
  return null
}

/** 3) 大段锚段：尾部锚段在更早文本再现，且向前扩展 >= 锚段长度。 */
export function detectAnchor(text: string, options: DetectorOptions = DEFAULT_DETECTOR): LoopHit | null {
  const size = options.anchorSize
  if (text.length < size * 2) return null
  const window = text.length > options.anchorWindow ? text.slice(-options.anchorWindow) : text
  if (window.length < size * 2) return null

  const anchor = window.slice(-size)
  if (!isMeaningfulUnit(anchor, options)) return null
  const head = window.slice(0, -size)
  const idx = head.lastIndexOf(anchor)
  if (idx === -1) return null

  // 向前扩展，量出真正重复了多长
  let extended = size
  let i = idx - 1
  let j = window.length - size - 1
  while (i >= 0 && j >= 0 && window[i] === window[j]) {
    extended++
    i--
    j--
  }
  if (extended < size) return null
  // 重复段起点 = 第一次出现位置向前扩展后的起点（换算回全文坐标）
  const offset = text.length - window.length
  return {
    kind: 'anchor',
    detail: `large-scale repeat: ~${extended} chars repeated 2x+`,
    evidence: anchor.slice(0, 60),
    cutStart: offset + i + 1,
  }
}

/**
 * 4) 单字符刷屏：尾部同一"实义"字符连续 >= runMinChars。
 * 覆盖 `next move is sssssss` 这类注意力坍缩——周期 1 被 minDistinctChars 过滤，
 * 但单个字母/数字/汉字刷几百字在真实输出里不可能是正常排版（`----` 等符号因非实义被排除）。
 */
export function detectCharRun(text: string, options: DetectorOptions = DEFAULT_DETECTOR): LoopHit | null {
  let i = text.length - 1
  if (i < 0 || i < options.runMinChars - 1) return null
  const ch = text[i]
  if (!SUBSTANTIVE.test(ch)) return null
  while (i >= 0 && text[i] === ch) i--
  const runLen = text.length - 1 - i
  if (runLen < options.runMinChars) return null
  return {
    kind: 'charrun',
    detail: `char-run repeat: '${ch}' x${runLen}`,
    evidence: ch.repeat(Math.min(40, runLen)),
    cutStart: i + 1,
  }
}

/**
 * 5) 短句池：尾部窗口内同一"实义短句"反复出现（散布型复读）。
 * 覆盖 `由于服务器性能有限` ×216 这类叙事打转——句子太短过不了 ngram，
 * 散布又过不了 periodic/anchor，但对计数敏感。
 */
export function detectPoolRepeat(text: string, options: DetectorOptions = DEFAULT_DETECTOR): LoopHit | null {
  const window = text.length > options.poolWindow ? text.slice(-options.poolWindow) : text
  const offset = text.length - window.length
  // 按句/行切分，归一化空白
  const units = window.split(/[。！？!?\n;；]/)
  const counts = new Map<string, { n: number; first: number }>()
  let pos = 0
  for (const raw of units) {
    const u = raw.trim()
    const start = pos
    pos += raw.length + 1
    if (u.length < options.poolUnitMinChars || !isMeaningfulUnit(u, options) || !hasSentenceShape(u)) continue
    const e = counts.get(u)
    if (e) {
      e.n++
      if (e.n >= options.poolMinRepeats) {
        return {
          kind: 'pool',
          detail: `sentence pool repeat: '${u.slice(0, 30)}' x${e.n}`,
          evidence: u.slice(0, 60),
          cutStart: offset + e.first,
        }
      }
    } else {
      counts.set(u, { n: 1, first: start })
    }
  }
  return null
}

/**
 * 五层依次检测；命中第一层即返回。
 * 入口下限取"最小周期 × 重复次数"：更短的文本连最小周期都放不下，不必进入扫描。
 */
export function detectRepetition(text: string, options: DetectorOptions = DEFAULT_DETECTOR): LoopHit | null {
  const floor = Math.max(32, options.minPeriod * options.periodRepeats)
  if (text.length < floor) return null
  return detectPeriodic(text, options) ?? detectNgram(text, options)
    ?? detectAnchor(text, options) ?? detectCharRun(text, options)
    ?? detectPoolRepeat(text, options)
}

/** 把配置里的 partial 覆盖合并成完整选项。 */
export function resolveDetectorOptions(patch: Partial<DetectorOptions> = {}): DetectorOptions {
  const merged: DetectorOptions = { ...DEFAULT_DETECTOR }
  for (const key of Object.keys(DEFAULT_DETECTOR) as (keyof DetectorOptions)[]) {
    const value = patch[key]
    if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value
  }
  // 自洽性兜底：周期下限不得高于上限，步长必须为正
  if (merged.minPeriod < 1) merged.minPeriod = 1
  if (merged.maxPeriod < merged.minPeriod) merged.maxPeriod = merged.minPeriod
  if (merged.periodRepeats < 2) merged.periodRepeats = 2
  if (merged.ngramRepeats < 2) merged.ngramRepeats = 2
  if (merged.ngramStep < 1) merged.ngramStep = 1
  if (merged.runMinChars < 16) merged.runMinChars = 16
  return merged
}
