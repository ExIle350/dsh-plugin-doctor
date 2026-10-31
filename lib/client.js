/**
 * dsh-plugin-doctor — 浏览器半侧（设置 → 插件体检）
 * ----------------------------------------------------------------------------
 * 以 dsh.client bundle 格式加载（手写 ModuleLoader bundle，无需构建产物）。
 * 注册 id 必须等于 loader entry 名（dsh-plugin-doctor），否则 ModuleLoader 报
 * "loaded without registering dsh-plugin-doctor"。
 *
 * 面板做三件事：
 *   1) 拉 Host 的 /dsh-doctor/report，把 loader 行、bundles 核对、问题清单摊开
 *   2) 提供路由探活：输入任意路径，用当前会话的凭据发一次请求，显示状态码
 *      —— 401 = 该路由已注册（插件活着）；404 = 没注册（没挂载）。
 *      这正是排查「装了但什么都没发生」最有用的一招，此前只能靠人肉开 F12。
 *   3) 一键复制完整 JSON，便于贴给别人看
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-doctor',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement
    var REPORT = '/dsh-doctor/report'

    var CSS = [
      '.__doc_root{max-width:760px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.__doc_head{display:flex;align-items:center;gap:10px}',
      '.__doc_ver{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.__doc_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}',
      '.__doc_title{font-weight:600}',
      '.__doc_row{display:flex;align-items:center;gap:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px}',
      '.__doc_bad{color:#d9480f}',
      '.__doc_ok{color:#2b8a3e}',
      '.__doc_note{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.__doc_btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer}',
      '.__doc_in{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;border-radius:7px;padding:5px 8px;font-size:12px;font-family:ui-monospace,Consolas,monospace;min-width:260px}',
      '.__doc_pre{margin:0;max-height:280px;overflow:auto;font-size:11px;font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}',
    ].join('\n')

    function Panel(ctx) {
      var s = react.useState(null); var data = s[0], setData = s[1]
      var s2 = react.useState(''); var pathIn = s2[0], setPathIn = s2[1]
      var s3 = react.useState(null); var probeRes = s3[0], setProbeRes = s3[1]
      var s4 = react.useState(''); var copied = s4[0], setCopied = s4[1]
      var s5 = react.useState(false); var showAll = s5[0], setShowAll = s5[1]

      react.useEffect(function () {
        var tag = document.createElement('style')
        tag.textContent = CSS
        document.head.appendChild(tag)
        return function () { tag.remove() }
      }, [])

      function load() {
        fetch(REPORT, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(setData)
          .catch(function (e) { setData({ error: String(e) }) })
      }
      react.useEffect(load, [])

      function probe() {
        if (!pathIn) return
        var t0 = Date.now()
        fetch(pathIn, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { setProbeRes({ path: pathIn, code: r.status, ms: Date.now() - t0 }) })
          .catch(function (e) { setProbeRes({ path: pathIn, code: 'ERR', msg: String(e) }) })
      }

      function copy() {
        try {
          navigator.clipboard.writeText(JSON.stringify(data, null, 2))
          setCopied('已复制')
          setTimeout(function () { setCopied('') }, 1500)
        } catch (e) { setCopied('复制失败') }
      }

      if (!data) return h('div', { className: '__doc_root' }, h('div', { className: '__doc_note' }, '加载中…'))
      if (data.error) return h('div', { className: '__doc_root' }, h('div', { className: '__doc_bad' }, '读取报告失败：' + data.error))

      var L = data.loader || {}
      var bundles = data.bundles || []
      var problems = data.problems || []

      return h('div', { className: '__doc_root' },
        h('div', { className: '__doc_head' },
          h('span', { className: '__doc_ver' }, '宿主 ' + (data.host && data.host.version ? data.host.version : '未知')),
          h('span', { className: '__doc_ver' }, 'profile ' + (data.profile && data.profile.dir ? data.profile.dir : '未知')),
          h('button', { className: '__doc_btn', onClick: load }, '刷新'),
          h('button', { className: '__doc_btn', onClick: copy }, copied || '复制诊断 JSON')),

        h('div', { className: '__doc_card' },
          h('div', { className: '__doc_title' }, 'Loader 行状态'),
          L.entriesApi
            ? h('div', { className: '__doc_note' },
                '共 ' + L.rowCount + ' 行；其中你安装的插件 ' + (L.disabledInstalled || []).length + ' 个被禁用，宿主内置功能 ' + (L.disabledHostCount || 0) + ' 项处于关闭状态')
            : h('div', { className: '__doc_bad' }, '读不到 loader 内部（' + (L.error || '未知原因') + '）—— 下行表不可用'),

          /* 只有「自己装的插件被禁用」才是故障信号；宿主内置关闭是正常状态 */
          (L.disabledInstalled || []).length
            ? h('div', { className: '__doc_row __doc_bad' },
                '⚠ 你安装的插件被禁用：' + L.disabledInstalled.join(', ') + '  ← 「装了但没反应」就是这个')
            : (L.entriesApi ? h('div', { className: '__doc_ok' }, '✓ 你安装的插件没有被禁用的') : null),

          (L.disabledHost || []).length
            ? h('div', { className: '__doc_note' },
                '（宿主内置关闭项，正常，非故障）：' + (showAll ? L.disabledHost.join(', ') : L.disabledHost.slice(0, 6).join(', ') + ' …'))
            : null,

          L.entriesApi
            ? h('div', null,
                (L.rows || [])
                  .filter(function (r) { return showAll || r.origin === 'installed' })
                  .map(function (r, i) {
                    return h('div', { key: i, className: '__doc_row' },
                      h('span', { className: r.disabled && r.origin === 'installed' ? '__doc_bad' : (r.disabled ? '__doc_note' : '__doc_ok') },
                        r.disabled ? '✗' : '✓'),
                      h('span', null, String(r.id || '(无 id)')),
                      h('span', { className: '__doc_note' }, String(r.name || '')))
                  }),
                h('button', { className: '__doc_btn', onClick: function () { setShowAll(!showAll) } },
                  showAll ? '只看我装的插件' : '展开全部 ' + (L.rowCount || 0) + ' 行'))
            : null),

        h('div', { className: '__doc_card' },
          h('div', { className: '__doc_title' }, 'Bundles 核对'),
          bundles.map(function (b, i) {
            return h('div', { key: i, className: '__doc_row' },
              h('span', { className: b.resolved ? '__doc_ok' : '__doc_bad' }, b.resolved ? '✓' : '✗'),
              h('span', null, b.name),
              h('span', { className: '__doc_note' },
                (b.host ? '宿主内置' : (b.inNodeModules ? '已装' : '未装')) +
                (b.notes && b.notes.length ? ' — ' + b.notes.join(' / ') : '')))
          })),

        h('div', { className: '__doc_card' },
          h('div', { className: '__doc_title' }, '路由探活'),
          h('div', { className: '__doc_note' }, '填一个路径回车。401 = 该插件已挂载（被鉴权拦住，正常）；404 = 没挂载。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', { className: '__doc_in', value: pathIn, placeholder: '/dsh-doctor/report',
              onChange: function (e) { setPathIn(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') probe() } }),
            h('button', { className: '__doc_btn', onClick: probe }, '探活'),
            probeRes
              ? h('span', { className: probeRes.code === 404 ? '__doc_bad' : '__doc_ok' },
                  probeRes.path + ' → ' + probeRes.code + (probeRes.ms ? ' (' + probeRes.ms + 'ms)' : ''))
              : null)),

        problems.length
          ? h('div', { className: '__doc_card' },
              h('div', { className: '__doc_title __doc_bad' }, '发现 ' + problems.length + ' 个问题'),
              problems.map(function (p, i) {
                return h('div', { key: i, className: '__doc_row' },
                  h('span', { className: '__doc_bad' }, '•'),
                  h('span', null, p.item),
                  h('span', { className: '__doc_note' }, (p.problems || p.problem || []).toString()))
              }))
          : h('div', { className: '__doc_card' }, h('div', { className: '__doc_ok' }, '✓ 未发现配置问题'))
      )
    }

    var inject = ['slots']

    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'plugin-doctor', order: 27, label: '插件体检' },
            function () { return h(Panel, {}) }
          )
        })
      } catch (e) {
        try { console.warn('[dsh-plugin-doctor] 面板注册失败:', e && e.message ? e.message : e) } catch (e2) { /* noop */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
