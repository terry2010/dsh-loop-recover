/**
 * dsh-loop-recover — web 端 client half。
 *
 * 宿主经 package.json `dsh.client` 加载本文件（__ModuleLoader__ 格式），
 * 模块本身是一个 cordis 插件：inject 客户端服务（slots/locale），
 * 再用 ctx.inject(['configForms']) 拿到本插件的持久化配置句柄，
 * 把配置表单注册进 `plugins.bundle.config` 槽位（插件页渲染）。
 *
 * 参考实现：dsh-context/lib/client.js（同机制）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-loop-recover',
  factory: (require) => {
    const ID = 'dsh-loop-recover'       // 包名：slot key / locale / 模块 id
    const NS = 'loop-recover'          // configForms 命名空间 = cordis.patch.yml entry id

    function apply(ctx) {
      // configForms 是客户端可选服务：宿主没提供就直接放弃注册卡片
      ctx.inject(['configForms'], (inner) => {
        const cf = inner.configForms
        if (cf === undefined || typeof cf.get !== 'function' || typeof cf.whileServed !== 'function') return
        const React = require('react')

        // FP8a 探针：句柄 API 形状未知，先把它渲染到插件页上确认接口
        let apiInfo = 'no handle'
        try {
          const handle = cf.get(NS)
          if (handle !== undefined && handle !== null) {
            const own = Object.getOwnPropertyNames(handle)
            const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(handle) ?? {})
            apiInfo = [...own, ...proto].join(', ')
          }
        } catch (err) { apiInfo = `get() threw: ${String(err)}` }

        inner.effect(() => cf.whileServed([NS], () =>
          inner.slots.inject('plugins.bundle.config', () =>
            inner.slots.register({
              name: 'plugins.bundle.config',
              key: ID,
              locale: ID,
              inject: () => ({ probe: apiInfo }),
            }, (slotProps) =>
              React.createElement(
                'div',
                { style: { padding: '8px 0', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' } },
                `loop-recover FP8a probe\nconfigForms.get: ${apiInfo}\nslotProps keys: ${JSON.stringify(Object.keys(slotProps ?? {}))}`,
              )),
          )), 'loop-recover: plugins-page card')
      })
    }

    return { name: ID, inject: ['slots', 'locale'], apply }
  },
})
