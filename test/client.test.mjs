import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// i18n.ts 边界
const { resolveLanguage, strings } = await import('../src/i18n.ts')

test('i18n: auto 跟随 ctx.i18n.language', () => {
  assert.equal(resolveLanguage({ i18n: { language: 'zh' } }, 'auto'), 'zh')
  assert.equal(resolveLanguage({ i18n: { language: 'en' } }, 'auto'), 'en')
})
test('i18n: auto 且 ctx.i18n 缺失/非法 → 兜底 en', () => {
  assert.equal(resolveLanguage({}, 'auto'), 'en')
  assert.equal(resolveLanguage({ i18n: { language: 'fr' } }, 'auto'), 'en')
})
test('i18n: 显式 zh/en 覆盖 ctx', () => {
  assert.equal(resolveLanguage({ i18n: { language: 'zh' } }, 'en'), 'en')
  assert.equal(resolveLanguage({}, 'zh'), 'zh')
})
test('i18n: strings 双语言都有必需键', () => {
  for (const lang of ['zh', 'en']) {
    const s = strings(lang)
    assert.ok(s.marker && s.stall && s.stallSummary, `${lang} 缺键`)
  }
})

// client.js：mock window.__ModuleLoader__ + require，加载真文件
test('client.js: 模块加载 + apply 在缺 configForms 时不崩', async () => {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load: (m) => { captured = m.factory((name) => ({})) } },
  }
  await import('../client/client.js')
  const mod = captured
  assert.equal(mod.name, 'dsh-loop-recover')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  // configForms 缺失时 apply 应安静返回
  const inner = { effect: () => {}, slots: { inject: () => {}, register: () => {} } }
  const ctx = { locale: { register: () => {} }, inject: (deps, fn) => fn({ configForms: undefined }) }
  mod.apply(ctx)
  delete globalThis.window
})

test('client.js: DICT 覆盖全部 FIELDS 的 f.* 键（f.language 回归）', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // FIELDS 里引用 t(`f.${f.key}`)——所有非 detector 字段的 key 必须在 DICT.zh 有 'f.<key>' 词条
  const fieldKeys = [...src.matchAll(/\{\s*group:\s*'(\w+)',\s*key:\s*'([\w.]+)',/g)]
    .map((m) => m[2])
    .filter((k) => !k.startsWith('detector.'))
  const zhKeys = new Set([...src.matchAll(/'(f\.[\w.]+)'/g)].map((m) => m[1]))
  for (const k of fieldKeys) {
    assert.ok(zhKeys.has(`f.${k}`), `DICT 缺 f.${k} 词条`)
  }
})
