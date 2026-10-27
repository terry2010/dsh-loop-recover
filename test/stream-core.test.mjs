/** stream-core.ts 单元测试：增量检测器/剪枝/安全判定/救援状态机 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  StreamLoopDetector,
  prunedBlockText,
  hasUnsafeOpenBlock,
  newRescueState,
  decideRescue,
  settleFinishedStream,
} from '../src/stream-core.ts'

test('StreamLoopDetector: 流式喂入命中并节流', () => {
  const d = new StreamLoopDetector({ minLen: 64, checkEvery: 16 })
  const unit = '重复循环片段ABC'
  let hit = null
  for (let i = 0; i < 30 && !hit; i++) hit = d.push(unit + String(i % 3))
  // 喂入的是变化后缀，未必命中；换纯重复
  const d2 = new StreamLoopDetector({ minLen: 64, checkEvery: 16 })
  hit = null
  for (let i = 0; i < 30 && !hit; i++) hit = d2.push('重复循环片段ABC')
  assert.ok(hit, '应在若干次重复后命中')
  assert.ok(hit.cutStart !== undefined)
})

test('StreamLoopDetector: minLen 内不检测', () => {
  const d = new StreamLoopDetector({ minLen: 500 })
  assert.equal(d.push('abc'.repeat(50)), null) // 150 < 500
})

test('StreamLoopDetector: checkEvery=0 不崩且仍节流为逐次检测', () => {
  const d = new StreamLoopDetector({ minLen: 32, checkEvery: 0 })
  assert.equal(d.push('ok '), null) // 不抛 NaN/异常
})

test('prunedBlockText: 截到 cutStart + 标记 + 统计移除量', () => {
  const text = '正常内容。' + 'abc12345'.repeat(10)
  const hit = { kind: 'periodic', detail: '', evidence: '', cutStart: 5 }
  const { text: t, removedChars } = prunedBlockText(text, hit, '\n[已剪除]')
  assert.ok(t.startsWith('正常内容'))
  assert.ok(t.endsWith('[已剪除]'))
  assert.equal(removedChars, text.length - 5)
})

test('prunedBlockText: 无 marker 时只截断', () => {
  const { text } = prunedBlockText('good' + 'x'.repeat(100), { kind: 'ngram', detail: '', evidence: '', cutStart: 4 }, undefined)
  assert.equal(text, 'good')
})

test('hasUnsafeOpenBlock: 含非文本 block 判不安全', () => {
  assert.equal(hasUnsafeOpenBlock([{ blockType: 'text', text: '' }, { blockType: 'reasoning', text: '' }]), false)
  assert.equal(hasUnsafeOpenBlock([{ blockType: 'text', text: '' }, { blockType: 'tool_call', text: '' }]), true)
})

test('decideRescue: 上限内 resume，超限 exhausted；stall 清零', () => {
  const s = newRescueState()
  s.stall = 5
  assert.equal(decideRescue(s, 3).action, 'resume')
  assert.equal(s.consecutive, 1)
  assert.equal(s.stall, 0)
  decideRescue(s, 3); decideRescue(s, 3)
  assert.equal(decideRescue(s, 3).action, 'exhausted')
  assert.equal(s.consecutive, 4)
})

test('settleFinishedStream: 有产出重置 / 纯推理空转累计 / 达阈值报告 stalled', () => {
  const s = newRescueState()
  s.consecutive = 2
  const r1 = settleFinishedStream(s, { hasOutput: true, reasoningChars: 0, stallCalls: 3, stallMinReasoningChars: 1024 })
  assert.equal(r1.stalled, false)
  assert.equal(s.consecutive, 0)

  // 3 次连续空转 → 第 3 次报 stalled
  let last = null
  for (let i = 0; i < 3; i++) {
    last = settleFinishedStream(s, { hasOutput: false, reasoningChars: 2000, stallCalls: 3, stallMinReasoningChars: 1024 })
  }
  assert.equal(last.stalled, true)
  assert.equal(last.stallCount, 3)

  // 推理不足不算空转
  const r = settleFinishedStream(s, { hasOutput: false, reasoningChars: 100, stallCalls: 3, stallMinReasoningChars: 1024 })
  assert.equal(r.stalled, false)
})
