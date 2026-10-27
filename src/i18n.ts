/** zh/en 提示文案（移植自 dsh-loop-rescue，简化） */

interface Strings {
  marker: (kind: string, chars: number) => string
  resume: (kind: string, chars: number) => string
  resumeSummary: (kind: string, chars: number) => string
  exhausted: (n: number) => string
  exhaustedSummary: (n: number) => string
  stall: (n: number) => string
  stallSummary: (n: number) => string
  intent: (tool: string) => string
  intentSummary: (tool: string) => string
}

const zh: Strings = {
  marker: (kind, chars) => `\n〔已剪除 ${chars} 字符的重复${kind === 'reasoning' ? '思考' : '输出'}〕`,
  resume: (kind, chars) => `检测到${kind === 'reasoning' ? '思考' : '输出'}陷入重复（已移除 ${chars} 字符）。请换一条路继续任务，不要重复刚才的内容。`,
  resumeSummary: (_k, chars) => `剪除 ${chars} 字符重复并续跑`,
  exhausted: (n) => `已连续 ${n} 次检测并剪除重复内容，自动续跑暂停。请检查模型/上下文状态后再继续。`,
  exhaustedSummary: (n) => `连续救援 ${n} 次，已暂停自动续跑`,
  stall: (n) => `检测到连续 ${n} 次只思考无产出。请直接给出结论或调用工具，不要再继续空想。`,
  stallSummary: (n) => `连续 ${n} 次空转，已提示继续`,
  intent: (tool) => `检测到 ${tool} 在换措辞重复查询同一主题且没有新信息。请停止重复检索，用已有信息继续任务。`,
  intentSummary: (tool) => `拦截 ${tool} 意图级重复`,
}

const en: Strings = {
  marker: (kind, chars) => `\n[${chars} repeated ${kind === 'reasoning' ? 'reasoning' : 'output'} chars removed]`,
  resume: (kind, chars) => `A repetition loop was detected in the ${kind} (${chars} chars removed). Continue the task a different way; do not repeat the previous content.`,
  resumeSummary: (_k, chars) => `Pruned ${chars} repeated chars and resumed`,
  exhausted: (n) => `Repetition was pruned ${n} times in a row; auto-resume paused. Check model/context state before continuing.`,
  exhaustedSummary: (n) => `${n} consecutive rescues; auto-resume paused`,
  stall: (n) => `${n} reasoning-only calls in a row. Give a conclusion or call a tool instead of more idle thinking.`,
  stallSummary: (n) => `${n} stalled calls; nudged to continue`,
  intent: (tool) => `${tool} kept re-querying the same topic with reworded queries and gained nothing new. Stop searching and continue with what you have.`,
  intentSummary: (tool) => `Blocked intent-level ${tool} loop`,
}

export function resolveLanguage(ctx: { i18n?: { language?: string } }, pref: string): 'zh' | 'en' {
  if (pref === 'zh' || pref === 'en') return pref
  try {
    // ctx.i18n 需 inject 声明；未注入时 cordis 代理抛错，降级为英文
    return ctx.i18n?.language === 'zh' || ctx.i18n?.language?.startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

export function strings(lang: 'zh' | 'en'): Strings {
  return lang === 'zh' ? zh : en
}
