/**
 * dsh-loop-recover — web 端 client half。
 *
 * 宿主经 package.json `dsh.client` 加载（__ModuleLoader__ 格式），
 * 模块是 cordis 插件：inject ['slots','locale']，再 inject(['configForms'])
 * 拿持久化配置句柄（subscribe/getSnapshot/set/mutate），
 * 把分组配置表单注册进 `plugins.bundle.config` 槽位渲染到插件页。
 *
 * 参考实现：dsh-context/lib/client.js、auto-continue/src/client/index.ts。
 */
window.__ModuleLoader__.load({
  id: 'dsh-loop-recover',
  factory: (require) => {
    const ID = 'dsh-loop-recover'   // 包名：slot key / locale / 模块 id
    const NS = 'loop-recover'      // configForms 命名空间 = cordis.patch.yml entry id

    // ---- i18n ----
    const DICT = {
      zh: {
        'group.basic': '基本', 'group.rescue': '救援', 'group.retry': '续跑参数',
        'group.intent': '意图检测', 'group.detect': '检测阈值', 'group.advanced': '检测器（高级）',
        'f.mode': '模式', 'f.watch': '检测内容', 'f.marker': '剪除标记',
        'f.minLen': '检测起始长度', 'f.checkEvery': '检测间隔字符',
        'f.maxConsecutiveRescues': '连续救援上限', 'f.stallCalls': '空转提示阈值',
        'f.stallMinReasoningChars': '空转最小推理长度', 'f.compactOnRescue': '续跑前压缩上下文',
        'f.retryTemperature': '续跑温度', 'f.retryReasoningEffort': '续跑推理强度',
        'f.retryRequests': '续跑生效请求数', 'f.debugLog': '启用诊断日志',
        'f.intentEnabled': '启用意图检测', 'f.intentNoveltyThreshold': '意图新词阈值',
        'f.intentConfirmCount': '意图确认次数', 'f.language': '语言',
        'o.rescue': '救援（断+剪+压+续）', 'o.cut': '只剪不续', 'o.observe': '只观察',
        'o.both': '思考+输出', 'o.reasoning': '仅思考', 'o.text': '仅输出',
        'o.auto': '跟随界面', 'o.zh': '中文', 'o.en': 'English',
        'saved': '已保存', 'writeFail': '写入失败',
      },
      en: {
        'group.basic': 'Basics', 'group.rescue': 'Rescue', 'group.retry': 'Resume Params',
        'group.intent': 'Intent', 'group.detect': 'Detection', 'group.advanced': 'Detector (Advanced)',
        'f.mode': 'Mode', 'f.watch': 'Watch', 'f.marker': 'Prune marker',
        'f.minLen': 'Detect after chars', 'f.checkEvery': 'Check every chars',
        'f.maxConsecutiveRescues': 'Max consecutive rescues', 'f.stallCalls': 'Stall calls threshold',
        'f.stallMinReasoningChars': 'Stall min reasoning chars', 'f.compactOnRescue': 'Compact before resume',
        'f.retryTemperature': 'Resume temperature', 'f.retryReasoningEffort': 'Resume reasoning effort',
        'f.retryRequests': 'Retry requests', 'f.debugLog': 'Debug log file',
        'f.intentEnabled': 'Intent detection', 'f.intentNoveltyThreshold': 'Intent novelty threshold',
        'f.intentConfirmCount': 'Intent confirm count', 'f.language': 'Language',
        'o.rescue': 'rescue (cut+prune+compact+resume)', 'o.cut': 'cut only', 'o.observe': 'observe only',
        'o.both': 'reasoning + text', 'o.reasoning': 'reasoning', 'o.text': 'text',
        'o.auto': 'follow UI', 'o.zh': '中文', 'o.en': 'English',
        'saved': 'saved', 'writeFail': 'write failed',
      },
    }

    // ---- 字段定义：type ∈ select|bool|num|text；path 支持 detector.xxx 嵌套 ----
    const FIELDS = [
      { group: 'basic', key: 'mode', type: 'select', options: ['rescue', 'cut', 'observe'] },
      { group: 'basic', key: 'watch', type: 'select', options: ['both', 'reasoning', 'text'] },
      { group: 'basic', key: 'language', type: 'select', options: ['auto', 'zh', 'en'] },
      { group: 'basic', key: 'marker', type: 'bool' },
      { group: 'basic', key: 'debugLog', type: 'bool' },
      { group: 'rescue', key: 'maxConsecutiveRescues', type: 'num', min: 1 },
      { group: 'rescue', key: 'compactOnRescue', type: 'bool' },
      { group: 'rescue', key: 'stallCalls', type: 'num', min: 0 },
      { group: 'rescue', key: 'stallMinReasoningChars', type: 'num', min: 0 },
      { group: 'retry', key: 'retryTemperature', type: 'num', min: 0, max: 2, step: 0.1 },
      { group: 'retry', key: 'retryReasoningEffort', type: 'text' },
      { group: 'retry', key: 'retryRequests', type: 'num', min: 0 },
      { group: 'intent', key: 'intentEnabled', type: 'bool' },
      { group: 'intent', key: 'intentNoveltyThreshold', type: 'num', min: 0, max: 1, step: 0.05 },
      { group: 'intent', key: 'intentConfirmCount', type: 'num', min: 1 },
      { group: 'detect', key: 'minLen', type: 'num', min: 32 },
      { group: 'detect', key: 'checkEvery', type: 'num', min: 8 },
    ]
    // detector.* 嵌套字段收进高级折叠组
    const DETECTOR_KEYS = [
      'minPeriod', 'maxPeriod', 'periodRepeats', 'ngramSize', 'ngramRepeats',
      'ngramWindow', 'ngramStep', 'anchorSize', 'anchorWindow', 'minDistinctChars',
      'minSubstantiveRatio', 'runMinChars', 'poolWindow', 'poolUnitMinChars', 'poolMinRepeats',
    ]
    for (const k of DETECTOR_KEYS) {
      FIELDS.push({ group: 'advanced', key: `detector.${k}`, type: 'num', label: k })
    }
    const GROUP_ORDER = ['basic', 'rescue', 'retry', 'intent', 'detect', 'advanced']

    // ---- 小工具 ----
    const vol = (v) => {
      if (v === null || typeof v !== 'object' || typeof v.get !== 'function') return v
      const keys = Object.keys(v)
      if (keys.every(k => k === 'get')) return v.get()
      if (keys.every(k => k === 'get' || k === 'value')) return v.get() // 带 value 标记的形态
      return v
    }
    const deepVol = (v) => {
      const r = vol(v)
      if (r !== v) return r
      if (Array.isArray(r)) return r.map(deepVol)
      if (r !== null && typeof r === 'object') {
        const o = {}; for (const k of Object.keys(r)) o[k] = deepVol(r[k]); return o
      }
      return r
    }
    const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj)
    const setPath = (obj, path, value) => {
      const keys = path.split('.')
      let o = obj
      for (const k of keys.slice(0, -1)) o = (o[k] ??= {})
      o[keys[keys.length - 1]] = value
    }

    // ---- 表单组件 ----
    function makePanel(React, handle) {
      const el = React.createElement

      const row = (label, control) => el('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 },
      }, el('span', null, label), control)

      // 官方 primitives 可用则用（Input 自带边框，不要再叠加样式）
      const P = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return {} } })()
      const bareStyle = { width: 110, fontSize: 13, textAlign: 'right' }
      const inputStyle = P.Input
        ? bareStyle // P.Input 自带边框
        : { ...bareStyle, padding: '3px 8px', borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l2,#d9d9d9)',
            background: 'var(--dsw-alias-bg-layer-2,#f5f5f5)' }
      const selectStyle = { ...inputStyle, textAlign: 'left', minWidth: 140 }

      const control = (f, value, write, t) => {
        if (f.type === 'select') {
          // dsh-context 同款：边框圆角 + 右侧 chevron 箭头的胶囊下拉
          return el('div', {
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 8px', borderRadius: 6, cursor: 'pointer', position: 'relative',
              border: '1px solid var(--dsw-alias-border-l2,#d9d9d9)',
              background: 'var(--dsw-alias-bg-layer-2,#f5f5f5)', fontSize: 13, minWidth: 140,
            },
          },
            el('select', {
              value: value ?? '', onChange: (e) => write(f.key, e.target.value),
              style: {
                appearance: 'none', border: 'none', background: 'transparent',
                fontSize: 13, flex: 1, outline: 'none', cursor: 'pointer', padding: 0,
              },
            }, (f.options || []).map((o) => el('option', { key: o, value: o }, t(`o.${o}`)))),
            P.IconChevronDownOutline14
              ? el(P.IconChevronDownOutline14)
              : el('span', { style: { fontSize: 10, opacity: 0.6 } }, '▼'))
        }
        if (f.type === 'bool') {
          // app 同款 toggle 开关：隐藏 checkbox + CSS pill
          const on = !!value
          return el('label', {
            style: {
              display: 'inline-flex', alignItems: 'center', cursor: 'pointer',
              width: 32, height: 18, borderRadius: 9, position: 'relative',
              background: on ? 'var(--dsw-alias-button-primary-fill,#4a6cf7)' : 'var(--dsw-alias-border-l3,#d1d5db)',
              transition: 'background .15s', flexShrink: 0,
            },
          },
            el('input', {
              type: 'checkbox', checked: on,
              onChange: (e) => write(f.key, e.target.checked),
              style: { position: 'absolute', opacity: 0, pointerEvents: 'none' },
            }),
            el('span', {
              style: {
                position: 'absolute', left: on ? 16 : 2, top: 2,
                width: 14, height: 14, borderRadius: '50%',
                background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)',
                transition: 'left .15s',
              },
            }))
        }
        if (f.type === 'text') {
          const props = {
            type: 'text', value: value ?? '', placeholder: '（不改）',
            onChange: (e) => write(f.key, e.target.value || undefined),
            style: inputStyle,
          }
          return P.Input ? el(P.Input, props) : el('input', props)
        }
        const props = {
          type: 'number', value: value ?? '', min: f.min, max: f.max, step: f.step ?? 1,
          onChange: (e) => write(f.key, e.target.value === '' ? undefined : Number(e.target.value)),
          style: inputStyle,
        }
        return P.Input ? el(P.Input, props) : el('input', props)
      }

      return function ConfigPanel({ t: slotT } = {}) {
        const t = (key) => {
          try { const v = slotT?.(key); if (typeof v === 'string' && v && v !== key) return v } catch { /* */ }
          return DICT.zh[key] ?? key
        }
        const cfg = React.useSyncExternalStore(
          (cb) => handle.subscribe(cb),
          () => handle.getSnapshot(),
        )
        // 快照结构 {status,value,base,user,revision,writable}：配置本体在 .value
        const data = deepVol(cfg?.value ?? cfg ?? {})
        const [status, setStatus] = React.useState('')
        const write = (path, value) => {
          try {
            if (path.includes('.')) {
              // 嵌套路径直接 mutate——set 可能按字面 key 写顶层死键
              handle.mutate((d) => { const v = d?.value ?? d; setPath(v, path, value) })
            } else {
              handle.set(path, value)
            }
            setStatus(t('saved'))
          } catch (e2) { setStatus(`${t('writeFail')}: ${String(e2).slice(0, 60)}`) }
        }

        const children = []
        for (const g of GROUP_ORDER) {
          const items = FIELDS.filter((f) => f.group === g)
          if (!items.length) continue
          const fields = items.map((f) => row(f.label ?? t(`f.${f.key}`), control(f, getPath(data, f.key), write, t)))
          const body = g === 'advanced'
            ? el('details', { key: g, style: { marginBottom: 12 } },
                el('summary', { style: { cursor: 'pointer', fontWeight: 600, padding: '6px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l3,#ddd)' } }, t(`group.${g}`)),
                ...fields)
            : el('div', { key: g, style: { marginBottom: 12 } }, el('div', { style: { fontWeight: 600, padding: '6px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l3,#ddd)' } }, t(`group.${g}`)), ...fields)
          children.push(body)
        }
        children.push(el('div', { key: 'status', style: { fontSize: 11, opacity: 0.6 } }, status))
        return el('div', { style: { padding: '4px 0' } }, ...children)
      }
    }

    function apply(ctx) {
      try { ctx.locale?.register?.(ID, DICT) } catch { /* 字典注册失败不阻断 */ }
      ctx.inject(['configForms'], (inner) => {
        const cf = inner.configForms
        if (cf === undefined || typeof cf.get !== 'function' || typeof cf.whileServed !== 'function') return
        const React = require('react')
        const handle = (() => { try { return cf.get(NS) } catch { return undefined } })()
        if (!handle) return
        const Panel = makePanel(React, handle)
        // ErrorBoundary 定义一次（不放 render 回调里——每次新建 class 会 remount）
        const el0 = React.createElement
        class Boundary extends React.Component {
          constructor(p) { super(p); this.state = { err: null } }
          static getDerivedStateFromError(err) { return { err } }
          render() {
            if (this.state.err) {
              return el0('div', { style: { padding: '8px 0', fontSize: 12, fontFamily: 'monospace', color: '#c33', whiteSpace: 'pre-wrap' } },
                `loop-recover render error:\n${String(this.state.err?.stack || this.state.err).slice(0, 400)}`)
            }
            return el0(Panel, this.props)
          }
        }

        inner.effect(() => cf.whileServed([NS], () =>
          inner.slots.inject('plugins.bundle.config', () =>
            inner.slots.register({
              name: 'plugins.bundle.config',
              key: ID,
              locale: ID,
              inject: () => ({}),
            }, (slotProps) => React.createElement(Boundary, slotProps)),
          )), 'loop-recover: config card')
      })
    }

    return { name: ID, inject: ['slots', 'locale'], apply }
  },
})
