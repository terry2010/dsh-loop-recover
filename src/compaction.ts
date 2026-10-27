/**
 * 循环命中后的上下文压缩（FP7）：把会话表面所有旧节点用一条检查点摘要 shadow，
 * 下一轮模型只看到 system + 摘要——上下文物理瘦身，不是文字提示。
 *
 * 移植自 rice-patrol 的 commitMainSessionHandoff（MIT），去掉 tokenMeter 校验
 * 和异步摘要调用：检查点直接由插件合成（原任务 + 循环提示），零额外模型请求。
 */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'

export interface CompactResult {
  ok: boolean
  reason?: string
  shadowed?: number
}

/** 从会话表面提取首个用户消息文本作为"原任务"锚点。 */
export function extractTaskAnchor(session: any, maxChars = 1200): string {
  try {
    const nodes = [...session.surface.nodes]
    for (const seq of nodes) {
      const ev = session.eventAt(seq)
      if (ev?.type !== 'user/message') continue
      const content = ev.data?.message?.content ?? ev.data?.content ?? []
      const text = content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
      if (text.trim()) return text.slice(0, maxChars)
    }
  } catch { /* best-effort */ }
  return ''
}

/**
 * 提交一次循环压缩：所有非 system 节点被摘要 shadow。
 * agent.session API 不符时返回 {ok:false} 走纯 followup 降级。
 */
export function commitLoopCompaction(agent: any, note: string, opts: { provider?: string; model?: string; sessions?: any } = {}): CompactResult {
  try {
    return commitInner(agent, note, opts)
  } catch (e) {
    // session 结构与假设不符时绝不能拖垮当前回合——降级走纯 followup
    return { ok: false, reason: `threw: ${String(e)}` }
  }
}

function commitInner(agent: any, note: string, opts: { provider?: string; model?: string; sessions?: any } = {}): CompactResult {
  const session = agent?.session
  const nodes = session?.surface?.nodes
  if (!session?.append || !Array.isArray(nodes) || nodes.length === 0) {
    const aKeys = agent ? [...Object.keys(agent), ...Object.getOwnPropertyNames(Object.getPrototypeOf(agent) ?? {})].slice(0, 20).join(',') : 'null'
    const sKeys = session ? [...Object.keys(session), ...Object.getOwnPropertyNames(Object.getPrototypeOf(session) ?? {})].slice(0, 20).join(',') : 'null'
    return { ok: false, reason: `session-api-unavailable agent=[${aKeys}] session=[${sKeys}]` }
  }
  // 真实 session 没有 .events 数组；用 snapshotEvents()/eventsSnapshot/eventAt 建 seq→event 索引喂 toolPairing
  let eventList: any[] | undefined
  try {
    eventList = typeof session.snapshotEvents === 'function' ? session.snapshotEvents()
      : Array.isArray(session.eventsSnapshot) ? session.eventsSnapshot : undefined
  } catch { /* */ }
  if (!eventList?.length) {
    eventList = nodes.map((s: any) => session.eventAt(s)).filter(Boolean)
  }
  const bySeq: Record<number, any> = {}
  for (const e of eventList) if (e && typeof e.seq === 'number') bySeq[e.seq] = e
  const adapter = { surface: session.surface, events: bySeq }
  const first = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  const shadowedSeqs = nodes.slice(first)
  if (!shadowedSeqs.length) return { ok: false, reason: 'nothing-to-shadow' }
  const start = shadowedSeqs[0]
  const end = shadowedSeqs.at(-1)
  try {
    if (!toolPairingBalancedBefore(adapter, start) || !toolPairingBalancedAfter(adapter, end)) {
      return { ok: false, reason: 'unbalanced-tools' }
    }
  } catch (e) {
    return { ok: false, reason: `pairing-threw ${String(e)}` }
  }
  const anchor = extractTaskAnchor(session)
  const checkpoint =
    'Loop-recover checkpoint. A repetition loop was detected and pruned; ' +
    'the earlier context was compacted away. Continue the task from this state; ' +
    'use a different approach and do not replay the previous reasoning.\n\n' +
    (anchor ? `Original task:\n${anchor}\n\n` : '') + note
  const compactionId = randomUUID()
  const marker = { compactionId, turn: null }
  try {
    const startEvent = session.append('compaction/start', marker)
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: checkpoint }],
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount: Math.ceil((eventList?.length ?? shadowedSeqs.length) * 64),
      provider: opts.provider ?? 'dsh-loop-recover',
      model: opts.model ?? 'checkpoint',
      maxTokens: 8192,
    })
    // 契约关键：summary 仅 log-only，紧跟的 replace user/message 才真正摘 surface 节点；
    // v4 的 user/message data 是扁平消息体（data.content/data.source 顶层，无 message 包裹），
    // 且 source.kind 必须是 producer-owned 'compact-checkpoint'（'plugin' 被拒）
    const src = { kind: 'compact-checkpoint', compactionId }
    const message = createUserMessage({
      content: [{ type: 'text', text: checkpoint }],
      source: src,
    })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs].filter((s: any) => s !== undefined),
    })
    session.append('compaction/end', marker)
    // 落盘：sessions.flush 保证后续 turn 读到的是替换后的 surface
    try { void opts.sessions?.flush?.(session) } catch { /* best-effort */ }
    return { ok: true, shadowed: shadowedSeqs.length }
  } catch (e) {
    try { session.append('compaction/end', { ...marker, error: String(e) }) } catch { /* */ }
    return { ok: false, reason: String(e) }
  }
}
