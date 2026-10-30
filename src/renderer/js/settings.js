// 她身上的右键菜单 + 设置面板（桌面版回归后新增：不要菜单栏了，全走这里）

// 样式在 styles/settings.css（CSP 不允许内联 <style>）

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'html') n.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else if (k === 'style') n.setAttribute('style', v)
    else n.setAttribute(k, v)
  }
  for (const kid of kids) if (kid) n.appendChild(kid)
  return n
}

export class Settings {
  constructor({ host, capri, panel, voice, commands }) {
    this.host = host
    this.capri = capri
    this.panel = panel
    this.voice = voice
    this.commands = commands || {}
    this.menu = null
    this.dialog = null
    this.cfg = null
  }

  get config() {
    return this.cfg || (this.cfg = this.host.getConfig())
  }

  async patch(patch) {
    this.cfg = await this.host.setConfig(patch)
    this.apply()
    return this.cfg
  }

  apply() {
    const cfg = this.cfg || {}
    const capri = this.capri
    if (!capri) return
    capri.quiet = Boolean(cfg.quiet)
    capri.wander = cfg.quiet ? false : cfg.wander !== false
    capri.possessWindows = cfg.quiet ? false : cfg.possess !== false
    capri.autoFacing = cfg.autoFacing !== false
    capri.sideBand = typeof cfg.sideBand === 'number' ? cfg.sideBand : 0.25
    capri.activity = Number(cfg.activity) || 1
    if (cfg.quiet) {
      capri.nextMove = Infinity
      capri.nextGaze = Infinity
    }
  }

  // ---------- 右键菜单 ----------
  closeMenu() {
    if (this.menu) { this.menu.remove(); this.menu = null }
  }

  openMenu(at) {
    this.closeMenu()
    const cfg = this.config
    const m = el('div', { class: 'capri-menu' })
    const item = (label, key, fn) => {
      const b = el('button', { type: 'button' }, el('span', { text: label }), el('span', { class: 'k', text: key || '' }))
      b.addEventListener('click', (e) => { e.stopPropagation(); this.closeMenu(); fn() })
      m.appendChild(b)
    }
    item('设置…', '⚙', () => this.openPanel())
    item(cfg.quiet ? '放开她（不乱动）' : '安静模式', cfg.quiet ? 'ON' : '', () => this.patch({ quiet: !cfg.quiet }))
    m.appendChild(el('hr'))
    item('全部演一遍', '', () => this.commands.showAll?.())
    item('重播开场', '', () => this.commands.replayIntro?.())
    item('被抱起', '', () => this.commands.heldOnce?.())
    item('附身看看', '', () => this.commands.possessOnce?.())
    item('全屏附身', '', () => this.commands.screenPossess?.())
    item('看卫星', '', () => this.commands.satellite?.())
    item('音效试听', '', () => this.commands.soundTour?.())
    m.appendChild(el('hr'))
    item('查看余额', '', () => this.commands.balance?.())
    item(this.capri?.stowed ? '叫她出来' : '收起来', '', () => (this.capri?.stowed ? this.commands.unstow?.() : this.commands.stow?.()))
    m.appendChild(el('hr'))
    item('退出摩羯', '⌘Q', () => this.host.quit())

    m.style.visibility = 'hidden'
    document.body.appendChild(m)
    const x = at ? at.x : innerWidth - 240
    const y = at ? at.y : innerHeight - 260
    const r = m.getBoundingClientRect()
    m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px'
    m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px'
    m.style.visibility = ''
    this.menu = m
    setTimeout(() => {
      const off = (e) => { if (!m.contains(e.target)) { this.closeMenu(); document.removeEventListener('pointerdown', off, true) } }
      document.addEventListener('pointerdown', off, true)
    }, 0)
  }

  // ---------- 设置面板 ----------
  closePanel() {
    if (this.dialog) { this.dialog.remove(); this.dialog = null }
  }

  openPanel() {
    this.closePanel()
    const cfg = { ...this.config }
    const d = el('div', { class: 'capri-settings' })
    d.appendChild(el('h2', { text: '摩羯 · 设置' }))
    d.appendChild(el('p', { class: 'sub', text: '改完立刻生效；右键她随时能叫出这个面板。' }))

    const row = (...kids) => d.appendChild(el('div', { class: 'row' }, ...kids))
    const slider = (label, key, min, max, step, fmt) => {
      const val = el('span', { class: 'val', text: fmt(cfg[key]) })
      const input = el('input', {
        type: 'range', min: String(min), max: String(max), step: String(step), value: String(cfg[key]),
        oninput: (e) => {
          const v = Number(e.target.value)
          cfg[key] = v
          val.textContent = fmt(v)
          this.patch({ [key]: v })
        },
      })
      row(el('label', { text: label }), input, val)
    }
    const toggle = (label, key, hint) => {
      const box = el('input', { type: 'checkbox', onchange: (e) => { cfg[key] = e.target.checked; this.patch({ [key]: e.target.checked }) } })
      box.checked = Boolean(cfg[key])
      row(el('label', { text: label }), box, hint ? el('span', { class: 'hint', text: hint }) : null)
    }
    const select = (label, key, options) => {
      const s = el('select', { onchange: (e) => { cfg[key] = Number(e.target.value); this.patch({ [key]: Number(e.target.value) }) } })
      for (const [v, text] of options) {
        const o = el('option', { value: String(v), text })
        if (Number(cfg[key]) === Number(v)) o.selected = true
        s.appendChild(o)
      }
      row(el('label', { text: label }), s)
    }

    // 1 大小
    const auto = el('input', {
      type: 'checkbox',
      onchange: (e) => {
        cfg.scaleAuto = e.target.checked
        this.patch({ scaleAuto: e.target.checked })
        this.capri?.setScale?.(cfg.scale)
      },
    })
    auto.checked = cfg.scaleAuto !== false
    row(el('label', { text: '大小自动' }), auto, el('span', { class: 'hint', text: '关掉后用下面的滑块定尺寸' }))
    slider('大小', 'scale', 0.35, 1.2, 0.05, (v) => Number(v).toFixed(2))
    // 2 活跃度
    slider('活跃度', 'activity', 0.3, 2, 0.1, (v) => Number(v).toFixed(1) + '×')
    // 3 安静模式
    toggle('安静模式', 'quiet', '不乱走、不随机演出')
    // 4 空闲收起
    select('空闲收起', 'idleStowMin', [[0, '关'], [3, '3 分钟'], [5, '5 分钟'], [10, '10 分钟'], [15, '15 分钟'], [30, '30 分钟']])
    // 5 音效
    toggle('音效', 'muted')
    slider('音量', 'volume', 0, 1, 0.05, (v) => Math.round(Number(v) * 100) + '%')
    // 6 自动朝向
    toggle('自动朝向', 'autoFacing', '在左边朝右，在右边朝左')
    // 7 活动范围
    slider('活动范围', 'sideBand', 0.1, 0.4, 0.01, (v) => '边上 ' + Math.round(Number(v) * 100) + '%')
    // 8 附身窗口
    toggle('附身窗口', 'possess', '偶尔钻到她坐着的窗口里')
    // 9 开机自启
    toggle('开机自启', 'autostart')
    // 10 余额显示
    toggle('气泡显示余额', 'balance', '单击她时多一个「查看余额」按钮')

    const actions = el('div', { class: 'actions' })
    actions.appendChild(el('button', { class: 'ghost', type: 'button', text: '打开设置文件', onclick: () => this.host.openConfigFile?.() }))
    actions.appendChild(el('button', { class: 'ghost', type: 'button', text: '关闭', onclick: () => this.closePanel() }))
    d.appendChild(actions)

    document.body.appendChild(d)
    this.dialog = d
    d.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); d.remove() }
    })
  }
}
