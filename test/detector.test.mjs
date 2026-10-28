/** detector.ts 单元测试：三层检测 + cutStart + 误伤过滤 + 选项合并 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectPeriodic,
  detectNgram,
  detectAnchor,
  detectCharRun,
  detectRepetition,
  isMeaningfulUnit,
  resolveDetectorOptions,
  DEFAULT_DETECTOR,
} from '../src/detector.ts'

const pad = (n = 600) => '这是正常的上下文前缀。'.repeat(Math.ceil(n / 9)).slice(0, n)

test('detectPeriodic: 命中周期复读并给出 cutStart', () => {
  const text = pad() + 'abc12345'.repeat(10)
  const hit = detectPeriodic(text)
  assert.equal(hit?.kind, 'periodic')
  assert.equal(hit?.period, 8)
  assert.ok(hit.cutStart !== undefined)
  // 剪掉循环段后不应再含重复单元
  const pruned = text.slice(0, hit.cutStart)
  assert.ok(!pruned.includes('abc12345abc12345'))
})

test('detectPeriodic: 回溯扩展把更早的同周期内容也纳入剪枝', () => {
  const unit = 'xy.'
  const text = pad() + unit.repeat(40)
  const hit = detectPeriodic(text)
  assert.ok(hit)
  assert.equal(text.slice(hit.cutStart), unit.repeat(40))
})

test('detectPeriodic: 短文本/无周期返回 null', () => {
  assert.equal(detectPeriodic('short'), null)
  assert.equal(detectPeriodic(pad() + 'abcdefghi'), null)
})

// 用互不相同的句子构造前缀，避免 pad 自身周期性干扰断言
const varied = (n = 600) =>
  Array.from({ length: Math.ceil(n / 24) }, (_, i) => `第${i}句：内容各异的正常前缀。`).join('').slice(0, n)

test('detectPeriodic: 单字符刷屏不命中周期层（distinct 过滤）', () => {
  const spam = varied() + 's'.repeat(500)
  assert.equal(detectPeriodic(spam), null) // period=1 < minPeriod=8
})

test('detectCharRun: "ssss" 坍缩刷屏命中且剪枝点保住正常前缀', () => {
  const prefix = varied()
  const text = prefix + ' next move is ' + 's'.repeat(500)
  const hit = detectCharRun(text)
  assert.equal(hit?.kind, 'charrun')
  // 剪枝点落在 s 刷屏起点，前缀完整保留
  assert.equal(text.slice(0, hit.cutStart), prefix + ' next move is ')
  assert.equal(text.slice(hit.cutStart), 's'.repeat(500))
})

test('detectCharRun: 中文单字刷屏命中；非实义符号刷屏不命中', () => {
  assert.equal(detectCharRun(varied() + '啊'.repeat(200))?.kind, 'charrun')
  assert.equal(detectCharRun(varied() + '-'.repeat(200)), null)   // 符号非实义
  assert.equal(detectCharRun(varied() + '='.repeat(200)), null)
})

test('detectCharRun: 未达阈值不误伤', () => {
  assert.equal(detectCharRun(varied() + 'x'.repeat(100)), null)  // < 128
  assert.equal(detectCharRun('sssss'), null)                     // 全文太短
})

test('detectRepetition: ssss 刷屏经 charrun 命中且剪枝干净', () => {
  const prefix = varied()
  const text = prefix + 's'.repeat(500)
  const hit = detectRepetition(text)
  assert.equal(hit?.kind, 'charrun')
  assert.equal(text.slice(0, hit.cutStart), prefix)
})

test('detectPoolRepeat + 真实样本回归（session-22a31d69 叙事型死循环）', async () => {
  const { detectPoolRepeat } = await import('../src/detector.ts')
  const fs = await import('node:fs')
  const sample = fs.readFileSync(new URL('./fixtures-real-loop.txt', import.meta.url), 'utf8')
  // 直接层
  const p = detectPoolRepeat(sample)
  assert.equal(p?.kind, 'pool')
  assert.ok(p.detail.includes('由于服务器性能有限'))
  // 链式入口在 8K 尾部即命中
  const hit = detectRepetition(sample.slice(-8192))
  assert.equal(hit?.kind, 'pool')
})

test('detectNgram: 64 字符块重复 3 次命中', () => {
  const block = 'The quick brown fox jumps over the lazy dog repeatedly again abc'
  const text = pad() + block + 'XX' + block + 'YY' + block + 'ZZ'
  const hit = detectNgram(text)
  assert.equal(hit?.kind, 'ngram')
  assert.ok(hit.cutStart !== undefined)
  // 剪枝点落在循环区域开始附近（首个重复块不晚于第二个块起点）
  const firstBlock = text.indexOf(block)
  const secondBlock = text.indexOf(block, firstBlock + 1)
  assert.ok(hit.cutStart <= secondBlock)
})

test('detectAnchor: 大段重排复现命中', () => {
  const para = '模型在长上下文中容易陷入重复输出，这是一个已知的退化模式。'.repeat(20)
  const text = pad(200) + para + pad(60) + para
  const hit = detectAnchor(text)
  assert.equal(hit?.kind, 'anchor')
  assert.ok(hit.cutStart !== undefined && hit.cutStart < text.length / 2)
})

test('isMeaningfulUnit: 纯符号/单字符不算循环', () => {
  assert.equal(isMeaningfulUnit('--------'), false)
  assert.equal(isMeaningfulUnit('|:--:|:--:|'), false)
  assert.equal(isMeaningfulUnit('ssssssss'), false)
  assert.equal(isMeaningfulUnit('abc123中文'), true)
})

test('detectRepetition: markdown 分隔线不误伤', () => {
  const md = varied(300) + '|:---|:---|:---|\n'.repeat(10)
  assert.equal(detectRepetition(md), null)
})

test('detectRepetition: 正常长文/代码不误伤', () => {
  const code = varied(200) + ['function a() {', '  return 1;', '}', 'function b() {', '  return 2;', '}'].join('\n')
  assert.equal(detectRepetition(varied(600)), null)
  assert.equal(detectRepetition(code), null)
})

test('resolveDetectorOptions: partial 合并与自洽兜底', () => {
  const o = resolveDetectorOptions({ minPeriod: 4, maxPeriod: 2 })
  assert.equal(o.maxPeriod, 4) // 上限不得小于下限
  assert.equal(o.minPeriod, 4)
  const d = resolveDetectorOptions()
  assert.deepEqual(d, DEFAULT_DETECTOR)
})

// === SECTION: 误伤样本补充 ===

test('detectRepetition: JSON 结构化输出不误伤', () => {
  // 模型输出多段不同的 JSON 记录——键名重复但内容各异
  const chunks = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({ id: i, title: `文档-${i}`, tags: [`tag-${i}`], body: `第${i}份记录的独特内容片段` }, null, 2)).join('\n')
  assert.equal(detectRepetition(varied(50) + chunks), null)
})

test('detectRepetition: 中英混排长文不误伤', () => {
  const mixed = Array.from({ length: 40 }, (_, i) =>
    `Section ${i} 讨论性能优化策略 optimization-${i}: hit ratio 达到 ${60 + i}%，整体 throughput 提升约 ${i * 2.5}x。`).join('\n')
  assert.equal(detectRepetition(mixed), null)
})

test('StreamLoopDetector: 1M 字符流摊销不卡顿', async () => {
  const { StreamLoopDetector } = await import('../src/stream-core.ts')
  const d = new StreamLoopDetector({ minLen: 64, checkEvery: 256 })
  const chunk = varied(100) // ~数 KB 的非重复前缀内容
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) d.push(chunk + `#${i}`) // 总量 ~1MB
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 5000, `1M 字符处理耗时 ${elapsed}ms，超过 5s 阈值`)
})
