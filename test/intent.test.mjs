/** intent.ts 单元测试：关键词提取/工具匹配/意图级重复判定 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractKeywords,
  matchesTool,
  wildcardToRegExp,
  extractQueryText,
  IntentTracker,
  resolveIntentOptions,
  DEFAULT_INTENT,
} from '../src/intent.ts'

test('extractKeywords: 中英文分词', () => {
  const kw = extractKeywords('search for qwen3.8 flash benchmarks 千问模型')
  assert.ok(kw.has('qwen3.8') || kw.has('qwen3'))
  assert.ok(kw.size > 0)
})

test('matchesTool: 通配符匹配工具名', () => {
  assert.equal(matchesTool('web_search', ['web_search']), true)
  assert.equal(matchesTool('brave_web_search', ['*search*']), true)
  assert.equal(matchesTool('read_file', ['web_search']), false)
})

test('wildcardToRegExp: * 转任意', () => {
  assert.ok(wildcardToRegExp('web_*').test('web_search'))
  assert.ok(!wildcardToRegExp('web_*').test('api_call'))
})

test('extractQueryText: 从 args 提取查询文本', () => {
  assert.ok(extractQueryText({ query: 'test query' }).includes('test query'))
  assert.equal(typeof extractQueryText('plain string'), 'string')
})

test('IntentTracker: 同义改写重复查询被判 repeat', () => {
  const t = new IntentTracker(resolveIntentOptions({ noveltyThreshold: 0.25, stallLimit: 2 }))
  assert.equal(t.observe('qwen3.8 flash 本地部署 速度测试').repeat, false)
  assert.equal(t.observe('qwen3.8 flash 本地部署 速度测试').repeat, false) // stall=1 <2
  assert.equal(t.observe('qwen3.8 flash 本地部署 速度测试').repeat, true) // stall=2 → repeat
})

test('IntentTracker: 全新主题不误伤', () => {
  const t = new IntentTracker()
  t.observe('rust cargo build error')
  const r = t.observe('vue component props typescript')
  assert.equal(r.repeat, false)
})

test('resolveIntentOptions: 合并 partial', () => {
  const o = resolveIntentOptions({ noveltyThreshold: 0.5 })
  assert.equal(o.noveltyThreshold, 0.5)
  assert.equal(o.historySize, DEFAULT_INTENT.historySize)
})
