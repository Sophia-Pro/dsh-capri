// 摩羯 · 浏览器半区（DSH 模块系统加载的那一份）
// 只做一件事：在「插件」页里给她加一张设置卡，字段直接读写宿主半区的 /capri/config。
// 她本人不从这里加载 —— 她还是靠宿主半区注入的 boot.js 画在页面上，互不影响。

window.__ModuleLoader__.load({
  id: 'dsh-capri',
  factory: (require) => {
    const exports = {}
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const inject = ['slots']

    const CARD = {
      border: '1px solid rgba(255,255,255,.12)',
      borderRadius: 12,
      padding: '14px 16px',
      margin: '10px 0',
      background: 'rgba(255,255,255,.03)',
      color: 'inherit',
    }
    const ROW = { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0', flexWrap: 'wrap' }
    const LABEL = { minWidth: 88, opacity: 0.85 }
    const BUTTON = {
      padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(255,46,136,.6)',
      background: 'rgba(255,46,136,.14)', color: 'inherit', cursor: 'pointer',
    }

    async function load() {
      const r = await fetch('/capri/config', { cache: 'no-store' })
      if (!r.ok) throw new Error('config ' + r.status)
      return r.json()
    }
    async function save(patch) {
      const r = await fetch('/capri/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!r.ok) throw new Error('save ' + r.status)
      return r.json()
    }

    function Row(props) {
      return h('div', { style: ROW }, h('span', { style: LABEL }, props.label), props.children)
    }

    function CapriCard(props) {
      const view = (props && props.view) || 'page'
      const [cfg, setCfg] = useState(null)
      const [err, setErr] = useState('')
      const [saved, setSaved] = useState(false)

      const reload = useCallback(() => {
        load().then(setCfg).catch((e) => setErr(String(e.message || e)))
      }, [])
      useEffect(() => { reload() }, [reload])

      // 列表行里只放一句简介；点进去（view=page）才是表单
      if (view === 'summary') {
        return h('div', { style: { opacity: 0.7, fontSize: 12 } },
          '住在 DSH 页面里的挂件：安静模式、空闲收起、大小与站边')
      }
      if (err) return h('div', { style: CARD }, '摩羯：读不到设置（', err, '）')
      if (!cfg) return h('div', { style: CARD }, '摩羯：读取中…')

      const set = (patch) => { setCfg({ ...cfg, ...patch }); setSaved(false) }
      const commit = () => {
        save(cfg).then(() => { setSaved(true); setErr('') }).catch((e) => setErr(String(e.message || e)))
      }

      const num = (v) => Number(v)
      return h('div', { style: CARD },
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '摩羯'),
        h('div', { style: { opacity: 0.7, fontSize: 12, marginBottom: 8 } },
          '住在 DSH 页面里的挂件。改完点保存，立刻生效，不用重启。'),
        h(Row, { label: '显示她' },
          h('input', { type: 'checkbox', checked: cfg.visible !== false, onChange: (e) => set({ visible: e.target.checked }) })),
        h(Row, { label: '安静模式' },
          h('input', { type: 'checkbox', checked: Boolean(cfg.quiet), onChange: (e) => set({ quiet: e.target.checked }) }),
          h('span', { style: { opacity: 0.6, fontSize: 12 } }, '开了就不乱走、不随机演出')),
        h(Row, { label: '空闲收起' },
          h('select', {
            value: String(cfg.idleMin ?? 5),
            onChange: (e) => set({ idleMin: num(e.target.value) }),
          },
          h('option', { value: '0' }, '关'),
          h('option', { value: '3' }, '3 分钟'),
          h('option', { value: '5' }, '5 分钟'),
          h('option', { value: '10' }, '10 分钟'),
          h('option', { value: '30' }, '30 分钟')),
          h('span', { style: { opacity: 0.6, fontSize: 12 } }, '页面多久没操作就收进角落的小芯片')),
        h(Row, { label: '站哪边' },
          h('select', { value: cfg.side || 'right', onChange: (e) => set({ side: e.target.value }) },
            h('option', { value: 'right' }, '右边'),
            h('option', { value: 'left' }, '左边'))),
        h(Row, { label: '大小' },
          h('select', {
            value: String(cfg.scale ?? 0.8),
            onChange: (e) => set({ scale: num(e.target.value) }),
          },
          h('option', { value: '0.6' }, '小'),
          h('option', { value: '0.7' }, '偏小'),
          h('option', { value: '0.8' }, '正常'),
          h('option', { value: '1' }, '大'))),
        h(Row, { label: '音效' },
          h('input', { type: 'checkbox', checked: cfg.sound !== false, onChange: (e) => set({ sound: e.target.checked }) })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 } },
          h('button', { style: BUTTON, onClick: commit }, '保存'),
          h('button', { style: { ...BUTTON, background: 'transparent' }, onClick: reload }, '撤销'),
          saved ? h('span', { style: { color: '#5ad' } }, '已保存') : null,
          err ? h('span', { style: { color: '#f66' } }, err) : null),
      )
    }

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'capri',
          order: 90,
          label: () => '摩羯',
        }, CapriCard)), 'dsh-capri: 设置卡')
      } catch (err) {
        try { console.warn('[capri] 设置卡注册失败', err) } catch { /* 忽略 */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    return exports
  },
})
