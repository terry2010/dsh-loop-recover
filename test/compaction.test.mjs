/** compaction.ts 单元测试：shadow 提交 / 锚点提取 / 降级路径 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitLoopCompaction, extractTaskAnchor } from '../src/compaction.ts'

function makeSession(rawEvents) {
  const appended = []
  const events = rawEvents.map((e, i) => ({ ...e, seq: i }))
  return {
    appended,
    events,
    surface: { nodes: events.map((e) => e.seq) },
    eventAt(seq) { return events.find((e) => e.seq === seq) },
    append(type, data, meta) { appended.push({ type, data, meta }); return data },
  }
}

const sys = { type: 'system/message', data: {} }
const user = (t) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text: t }] } } })
const asst = { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'x' }] } } }

test('commitLoopCompaction: system 保留 + replacement 摘 surface 节点', () => {
  const s = makeSession([sys, user('翻译这个文件'), asst, asst])
  const r = commitLoopCompaction({ session: s }, 'loop cut')
  assert.equal(r.ok, true)
  assert.equal(r.shadowed, 3) // user+asst+asst，system 不 shadow
  const evts = s.appended.map((a) => a.type)
  // 契约：start → summary(log-only) → user/message(replace，真正摘节点) → end
  assert.deepEqual(evts, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  const summary = s.appended[1].data
  assert.equal(summary.shadowedRange.start, 1)
  assert.equal(summary.shadowedRange.end, 3)
  assert.ok(summary.summary[0].text.includes('翻译这个文件'))
  assert.ok(summary.shadowedTokenCount > 0)
  // replacement：data 是扁平消息体（content/source 顶层），v4 读 data.source.kind
  const rep = s.appended[2]
  assert.ok(rep.data?.content?.[0]?.text, 'data.content 缺失')
  assert.equal(rep.data?.source?.kind, 'compact-checkpoint') // v4 producer-owned kind
  const replaceMeta = rep.meta
  assert.equal(replaceMeta?.surfaceOp?.op, 'replace')
  assert.equal(replaceMeta?.surfaceOp?.startSeq, 1)
  assert.equal(replaceMeta?.surfaceOp?.endSeq, 3)
  assert.deepEqual(replaceMeta?.sourceEventSeqs?.slice(-3), [1, 2, 3])
})

test('commitLoopCompaction: append 抛错时补写 error end 并降级', () => {
  const s = makeSession([sys, user('任务')])
  s.append = (type, data, meta) => {
    if (type === 'compaction/summary') throw new Error('append failed')
    s.appended.push({ type, data, meta })
    return data
  }
  const r = commitLoopCompaction({ session: s }, 'n')
  assert.equal(r.ok, false)
  // summary 失败后应尝试补 compaction/end 标记
  assert.ok(s.appended.some((a) => a.type === 'compaction/end' && a.data.error))
})

test('commitLoopCompaction: 无 session API 降级', () => {
  assert.equal(commitLoopCompaction({}, 'n').ok, false)
  assert.equal(commitLoopCompaction(undefined, 'n').ok, false)
  assert.ok(commitLoopCompaction({ session: {} }, 'n').reason?.startsWith('session-api-unavailable'))
})

test('commitLoopCompaction: 内部异常降级不抛出（不拖垮回合）', () => {
  // surface.nodes 里是字符串而非 seq，eventAt 返回结构异常 → 必须 ok:false 而非 throw
  const bad = { session: { append() {}, surface: { nodes: ['a','b'] }, eventAt() { return undefined } } }
  const r = commitLoopCompaction(bad, 'n')
  assert.equal(r.ok, false)
})

test('extractTaskAnchor: 首个用户消息为锚点', () => {
  const s = makeSession([sys, user('第一个任务'), asst, user('第二个')])
  assert.equal(extractTaskAnchor(s), '第一个任务')
  assert.equal(extractTaskAnchor(makeSession([])), '')
})
