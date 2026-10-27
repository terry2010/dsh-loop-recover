/**
 * dsh-loop-detector — 工具调用"意图级"重复检测（纯函数 + 可单测的状态机）
 *
 * 场景：模型换着措辞反复搜同一主题（字符串层面毫无重复，纯文本检测看不见）。
 *
 * 判定：把每次调用的关键参数抽成关键词集合，与"最近 N 次调用的关键词并集"
 * 比较。新词占比低于阈值即认为"换了说法、没带新信息"；连续若干次后判定为
 * 意图级循环。
 *
 * 中文处理：旧实现按非字母数字切词，一整句中文会变成单个 token，导致中文
 * 场景下永远判不出重复。这里改成"停用字切分 + 中文 bigram"，中英文都有效。
 */

export interface IntentOptions {
  /** 参与检测的工具名通配符（`*` 通配）。空数组表示关闭意图级检测。 */
  toolPatterns: string[]
  /** "主题词集"取最近几次调用。默认 3 */
  historySize: number
  /** 新词占比低于该值算"没有新信息"。默认 0.25 */
  noveltyThreshold: number
  /** 与主题词集的 Jaccard 相似度高于该值也算"同一主题"。默认 0.5 */
  similarityThreshold: number
  /** 连续几次"没有新信息"才判定为意图级循环。默认 2 */
  stallLimit: number
  /** 单次调用参与比对的文本上限（字符）。默认 2000 */
  maxQueryChars: number
}

export const DEFAULT_INTENT: IntentOptions = {
  toolPatterns: ['web_search'],
  historySize: 3,
  noveltyThreshold: 0.25,
  similarityThreshold: 0.5,
  stallLimit: 2,
  maxQueryChars: 2000,
}

/**
 * 中文停用字：既是切分点，也用于剔除"怎么""如何"这类噪声 bigram。
 * 用停用字切断后再取 bigram，可以避免 "报怎"、"么样" 这种跨虚词边界的伪词。
 */
const STOP_CHARS =
  '的了呢吗呀吧啊嘛哦嗯是和在有着与我你他她它们这那就都也还很更最把被给对从到为以其之则而且但或及等个' +
  '请帮我想要需要怎么如何哪什谁些儿里面中上下前后时候能可会得让使因由于所才再又只没不无非未别太挺比较像似若'

const CJK = /[\u4e00-\u9fff]+/g
const LATIN = /[a-z0-9][a-z0-9._+#-]*/g

/** 提取关键词：英文/数字按词，中文按停用字切段后取 bigram。 */
export function extractKeywords(text: string): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  const lower = text.toLowerCase()

  for (const match of lower.matchAll(LATIN)) {
    if (match[0].length >= 2) out.add(match[0])
  }

  for (const run of text.match(CJK) ?? []) {
    let start = 0
    for (let i = 0; i <= run.length; i++) {
      const isStop = i === run.length || STOP_CHARS.includes(run[i]!)
      if (!isStop) continue
      const segment = run.slice(start, i)
      if (segment.length === 1) out.add(segment)
      else for (let k = 0; k + 2 <= segment.length; k++) out.add(segment.slice(k, k + 2))
      start = i + 1
    }
  }
  return out
}

/** 把 `*` 通配符编译成锚定正则；其余正则元字符按字面量处理。 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** 工具名是否命中任一模式（空模式表 => 全部命中）。 */
export function matchesTool(toolName: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  return patterns.some((pattern) => wildcardToRegExp(pattern).test(toolName))
}

/**
 * 从工具参数里抽出用于比对主题的文本。
 * 递归收集字符串值（跳过过长内容），让 grep/bash/search 等工具都能参与意图比对。
 */
export function extractQueryText(args: unknown, maxChars = 2000): string {
  const parts: string[] = []
  let total = 0
  const walk = (value: unknown, depth: number): void => {
    if (total >= maxChars || depth > 4) return
    if (typeof value === 'string') {
      const slice = value.slice(0, maxChars - total)
      if (slice) {
        parts.push(slice)
        total += slice.length
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1)
    }
  }
  walk(args, 0)
  return parts.join(' ')
}

export interface IntentVerdict {
  /** 是否判定为"换措辞重做同一件事" */
  repeat: boolean
  /** 新词占比（1 = 全新主题） */
  novelty: number
  /** 与主题词集的 Jaccard 相似度（0 = 毫无重叠） */
  similarity: number
  /** 连续"无新信息"次数 */
  stall: number
  /** 本次调用的关键词数 */
  keywords: number
}

/** 每个 agent 一个实例；跟踪主题词集与连续停滞次数。 */
export class IntentTracker {
  private options: IntentOptions
  private history: Set<string>[] = []
  private stall = 0

  constructor(options: IntentOptions = DEFAULT_INTENT) {
    this.options = options
  }

  /** 记录一次调用并给出判定。 */
  observe(text: string): IntentVerdict {
    const keywords = extractKeywords(text)
    if (keywords.size === 0) {
      return { repeat: false, novelty: 1, similarity: 0, stall: this.stall, keywords: 0 }
    }

    const topic = new Set<string>()
    for (const entry of this.history) for (const token of entry) topic.add(token)

    let shared = 0
    for (const token of keywords) if (topic.has(token)) shared++
    const novel = keywords.size - shared
    const novelty = topic.size === 0 ? 1 : novel / keywords.size
    const union = keywords.size + topic.size - shared
    const similarity = topic.size === 0 || union === 0 ? 0 : shared / union

    this.history.push(keywords)
    while (this.history.length > Math.max(1, this.options.historySize)) this.history.shift()

    // 双判据：新词占比够低，或与既有主题高度重叠（中文 bigram 会天然产生新组合，
    // 只看"新词占比"会漏判"换措辞说同一件事"）。
    const stalled = novelty < this.options.noveltyThreshold || similarity >= this.options.similarityThreshold
    if (stalled) {
      this.stall += 1
      if (this.stall >= Math.max(1, this.options.stallLimit)) {
        const stall = this.stall
        this.stall = 0
        this.history = []
        return { repeat: true, novelty, similarity, stall, keywords: keywords.size }
      }
    } else {
      this.stall = 0
    }
    return { repeat: false, novelty, similarity, stall: this.stall, keywords: keywords.size }
  }

  reset(): void {
    this.history = []
    this.stall = 0
  }
}

/** 把配置里的 partial 覆盖合并成完整选项。 */
export function resolveIntentOptions(patch: Partial<IntentOptions> = {}): IntentOptions {
  const merged: IntentOptions = { ...DEFAULT_INTENT }
  if (Array.isArray(patch.toolPatterns)) merged.toolPatterns = patch.toolPatterns.filter((p) => typeof p === 'string')
  if (typeof patch.historySize === 'number' && patch.historySize >= 1) merged.historySize = Math.floor(patch.historySize)
  if (typeof patch.noveltyThreshold === 'number' && patch.noveltyThreshold >= 0 && patch.noveltyThreshold <= 1) {
    merged.noveltyThreshold = patch.noveltyThreshold
  }
  if (typeof patch.similarityThreshold === 'number' && patch.similarityThreshold >= 0 && patch.similarityThreshold <= 1) {
    merged.similarityThreshold = patch.similarityThreshold
  }
  if (typeof patch.stallLimit === 'number' && patch.stallLimit >= 1) merged.stallLimit = Math.floor(patch.stallLimit)
  if (typeof patch.maxQueryChars === 'number' && patch.maxQueryChars >= 32) merged.maxQueryChars = Math.floor(patch.maxQueryChars)
  return merged
}
