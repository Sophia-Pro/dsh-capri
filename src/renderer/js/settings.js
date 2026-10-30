// 右键菜单 + 设置面板（没有菜单栏、没有托盘，一切从这里进）
// 样式在 styles/settings.css。

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'html') n.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v)
  }
  for (const kid of kids) if (kid) n.appendChild(kid)
  return n
}

const onOff = (on) => (on ? '开' : '关')

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
    this.onOpenChange = null
  }

  get config() {
    if (!this.cfg) this.cfg = this.host.getConfig()
    return this.cfg
  }

  isOpen() {
    return Boolean(this.menu || this.dialog)
  }

  contains(x, y) {
    for (const n of [this.menu, this.dialog]) {
      if (!n) continue
      const r = n.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
    }
    return false
  }

  capriBox() {
    const c = this.capri
    if (!c) return null
    const s = c.scale
    return { left: c.pos.x - 150 * s, right: c.pos.x + 150 * s, top: c.pos.y - 470 * s, bottom: c.pos.y + 6, cx: c.pos.x }
  }

  // 打开/关闭任一层时统一处理：整层接鼠标（不抢系统焦点，避免开了就闪）
  setOpenState(open) {
    this.onOpenChange?.(Boolean(open))
    this.bindOutside()
  }

  // 菜单/设置开着时，点空白处（别的窗口的点击也会先落到这层）就收起来
  bindOutside() {
    if (this._outside) { document.removeEventListener('pointerdown', this._outside, true); this._outside = null }
    if (!this.isOpen()) return
    this._outside = (e) => {
      if (this.menu && !this.menu.contains(e.target)) { this.closeMenu(); return }
      if (this.dialog && !this.dialog.contains(e.target)) this.closePanel()
    }
    document.addEventListener('pointerdown', this._outside, true)
  }

  async patch(patch) {
    this.cfg = await this.host.setConfig(patch)
    this.apply()
    if (this.dialog) this.refreshDialog()
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
    if (cfg.quiet) { capri.nextMove = Infinity; capri.nextGaze = Infinity }
  }

  closeAll() {
    this.closeMenu()
    this.closePanel()
  }

  // ---------- 右键菜单 ----------
  openMenu() {
    if (this.menu) { this.closeMenu(); return }
    this.closePanel()
    const cfg = this.config
    const m = el('div', { class: 'capri-menu' })
    const item = (label, key, fn) => {
      const b = el('button', { type: 'button' }, el('span', { text: label }), el('span', { class: 'k', text: key || '' }))
      b.addEventListener('click', (e) => { e.stopPropagation(); this.closeMenu(); fn() })
      m.appendChild(b)
    }
    item('设置…', '⚙', () => this.openPanel())
    item(cfg.quiet ? '放开她' : '安静模式', cfg.quiet ? '开' : '关', () => this.patch({ quiet: !cfg.quiet }))
    m.appendChild(el('hr'))
    item('全部演一遍', '', () => this.commands.showAll?.())
    item('重播开场', '', () => this.commands.replayIntro?.())
    item('被抱起', '', () => this.commands.heldOnce?.())
    item('附身窗口', '', () => this.commands.possessOnce?.())
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
    this.placeMenu(m)
    m.style.visibility = ''
    this.menu = m
    this.setOpenState(true)
    if (this._follow) clearInterval(this._follow)
    this._follow = setInterval(() => {
      if (!this.menu) { clearInterval(this._follow); this._follow = null; return }
      this.placeMenu(this.menu)
    }, 220)
    if (!this._keys) {
      this._keys = true
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        if (this.menu) { this.closeMenu(); e.preventDefault() }
        else if (this.dialog) { this.closePanel(); e.preventDefault() }
      })
    }
  }

  placeMenu(m, at) {
    const r = m.getBoundingClientRect()
    const head = this.capri && this.capri.head ? this.capri.head() : null
    if (head) {
      // 紧贴她：优先头顶上方，横向以她的头为准，绝不住她身上压
      let top = head.top - r.height - 8
      if (top < 8) top = head.y + 40
      let left = head.x - r.width / 2
      left = Math.max(8, Math.min(left, innerWidth - r.width - 8))
      top = Math.max(8, Math.min(top, innerHeight - r.height - 8))
      m.style.left = Math.round(left) + 'px'
      m.style.top = Math.round(top) + 'px'
      return
    }
    const box = this.capriBox()
    let left
    let top
    if (box) {
      top = box.top - r.height - 10
      if (top < 8) top = box.bottom - r.height - 10
      if (top < 8) top = 8
      const outer = box.cx > innerWidth / 2
      left = outer ? box.left - r.width - 12 : box.right + 12
      if (left < 8) left = box.right + 12
      if (left + r.width > innerWidth - 8) left = box.left - r.width - 12
    } else {
      left = (at && at.x) || innerWidth - 240
      top = (at && at.y) || innerHeight - 260
    }
    left = Math.max(8, Math.min(left, innerWidth - r.width - 8))
    top = Math.max(8, Math.min(top, innerHeight - r.height - 8))
    m.style.left = Math.round(left) + 'px'
    m.style.top = Math.round(top) + 'px'
  }

  closeMenu() {
    if (this._follow) { clearInterval(this._follow); this._follow = null }
    if (this.menu) { this.menu.remove(); this.menu = null; this.setOpenState(false) }
  }

  // ---------- 设置面板 ----------
  openPanel() {
    if (this.dialog) { this.closePanel(); return }
    this.closeMenu()
    const d = el('div', { class: 'capri-settings' })
    this.dialog = d
    document.body.appendChild(d)
    this.renderDialog()
    this.setOpenState(true)
    d.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  closePanel() {
    if (this.dialog) { this.dialog.remove(); this.dialog = null; this.setOpenState(false) }
  }

  // 数据变了只需要重画表单部分（面板壳不动）
  refreshDialog() {
    if (!this.dialog) return
    const body = this.dialog.querySelector('.capri-settings__body')
    if (body) body.replaceChildren(...this.rows())
  }

  renderDialog() {
    const d = this.dialog
    if (!d) return
    d.replaceChildren(
      el('div', { class: 'capri-settings__head' },
        el('h2', { text: '摩羯 · 设置' }),
        el('p', { class: 'sub', text: '改完立刻生效。右键她可以随时打开这里。' })),
      el('div', { class: 'capri-settings__body' }, ...this.rows()),
      el('div', { class: 'capri-settings__foot' },
        el('button', { class: 'ghost', type: 'button', text: '打开设置文件', onclick: () => this.host.openConfigFile?.() }),
        el('button', { type: 'button', text: '关闭', onclick: () => this.closePanel() })),
    )
  }

  rows() {
    const cfg = this.config
    const out = []
    const section = (title) => out.push(el('div', { class: 'sec', text: title }))
    const hint = (text) => (text ? el('span', { class: 'hint', text }) : null)

    // 一行：左边名字，右边开关 + 开/关文字
    const toggle = (label, key, hintText, invert) => {
      const checked = invert ? !Boolean(cfg[key]) : Boolean(cfg[key])
      const state = el('span', { class: 'state', text: onOff(checked) })
      const box = el('input', {
        type: 'checkbox',
        class: 'switch',
        onchange: (e) => {
          const value = invert ? !e.target.checked : e.target.checked
          cfg[key] = value
          state.textContent = onOff(e.target.checked)
          this.patch({ [key]: value })
          if (key === 'muted') this.refreshDialog()
        },
      })
      box.checked = checked
      out.push(el('div', { class: 'row' },
        el('label', { text: label }),
        el('span', { class: 'ctl' }, state, box),
        hint(hintText)))
      return box
    }

    // 从属的一行：只有上级开着才出现
    const depend = (visible, ...nodes) => {
      if (!visible) return
      out.push(el('div', { class: 'row row--sub' }, ...nodes))
    }

    const sliderRow = (label, key, min, max, step, fmt, sub) => {
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
      out.push(el('div', { class: sub ? 'row row--sub' : 'row' },
        el('label', { text: label }), input, val))
    }

    const selectRow = (label, key, options) => {
      const s = el('select', {
        onchange: (e) => {
          const v = Number(e.target.value)
          cfg[key] = v
          this.patch({ [key]: v })
          this.refreshDialog()
        },
      })
      for (const [v, text] of options) {
        const o = el('option', { value: String(v), text })
        if (Number(cfg[key]) === Number(v)) o.selected = true
        s.appendChild(o)
      }
      out.push(el('div', { class: 'row' }, el('label', { text: label }), s))
    }

    // —— 外观 ——
    section('外观')
    toggle('自动适配大小', 'scaleAuto', '按屏幕分辨率自动决定大小')
    depend(cfg.scaleAuto === false, el('label', { text: '自定义大小' }))
    if (cfg.scaleAuto === false) {
      // 关掉自动后展开自定义大小
      out.pop()
      sliderRow('自定义大小', 'scale', 0.35, 1.2, 0.05, (v) => Number(v).toFixed(2) + ' 倍', true)
    }

    // —— 行为 ——
    section('行为')
    sliderRow('活跃程度', 'activity', 0.3, 2, 0.1, (v) => Number(v).toFixed(1) + ' 倍')
    toggle('安静模式', 'quiet', '不自己走动、不随机演出')
    selectRow('空闲时收起', 'idleStowMin', [[0, '不收起来'], [3, '3 分钟'], [5, '5 分钟'], [10, '10 分钟'], [15, '15 分钟'], [30, '30 分钟']])
    toggle('自动朝向', 'autoFacing', '在左边朝右，在右边朝左')
    sliderRow('活动区域', 'sideBand', 0.1, 0.4, 0.01, (v) => '两侧各 ' + Math.round(Number(v) * 100) + '%')
    toggle('窗口附身', 'possess', '偶尔钻到她坐着的窗口里')

    // —— 声音 ——
    section('声音')
    toggle('音效', 'muted', '关掉后她只做动作不出声', true)
    depend(!cfg.muted, el('label', { text: '音量' }))
    if (!cfg.muted) {
      out.pop()
      sliderRow('音量', 'volume', 0, 1, 0.05, (v) => Math.round(Number(v) * 100) + '%', true)
    }

    // —— 系统 ——
    section('系统')
    toggle('跟随 DSH 启动与退出', 'followDsh', 'DSH 起来她也起来，DSH 关掉她也关掉')
    toggle('开机自启', 'autostart')

    // —— 气泡 ——
    section('气泡')
    toggle('气泡内显示余额', 'balance', '单击她时气泡里带「查看余额」')

    return out
  }
}
