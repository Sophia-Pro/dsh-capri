// 余额卡：高点位/低谷两套配色，带倒计时（照着 dsh-whale-widget 的信息层级做的）

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

const money = (n, cur) => (cur === 'CNY' || !cur ? '¥' + Number(n).toFixed(2) : Number(n).toFixed(2) + ' ' + cur)
const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n || 0)))

function hms(ms) {
  const t = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(t / 86400)
  const h = Math.floor((t % 86400) / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const p2 = (v) => String(v).padStart(2, '0')
  return d > 0 ? d + ' 天 ' + p2(h) + ':' + p2(m) + ':' + p2(s) : p2(h) + ':' + p2(m) + ':' + p2(s)
}

export class Card {
  constructor({ capri, onRefresh } = {}) {
    this.capri = capri
    this.onRefresh = onRefresh
    this.root = null
    this.data = null
    this.timer = null
  }

  get visible() {
    return Boolean(this.root && this.root.isConnected)
  }

  outline() {
    if (!this.root) return null
    const r = this.root.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  }

  contains(x, y) {
    const r = this.outline()
    return Boolean(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
  }

  hide() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.root) { this.root.remove(); this.root = null }
  }

  place() {
    if (!this.root) return
    const r = this.root.getBoundingClientRect()
    const c = this.capri
    let left
    let top
    if (c) {
      const cx = c.pos.x
      const feet = c.pos.y
      const boxTop = feet - 470 * c.scale
      const boxLeft = cx - 150 * c.scale
      const boxRight = cx + 150 * c.scale
      top = boxTop - r.height - 12
      if (top < 8) top = feet - r.height - 30
      if (top < 8) top = 8
      left = cx > innerWidth / 2 ? boxLeft - r.width - 14 : boxRight + 14
      if (left < 8) left = boxRight + 14
      if (left + r.width > innerWidth - 8) left = boxLeft - r.width - 14
    } else {
      left = innerWidth / 2 - r.width / 2
      top = innerHeight / 2 - r.height / 2
    }
    this.root.style.left = Math.round(Math.max(8, Math.min(left, innerWidth - r.width - 8))) + 'px'
    this.root.style.top = Math.round(Math.max(8, Math.min(top, innerHeight - r.height - 8))) + 'px'
  }

  show(data) {
    this.hide()
    this.data = data
    const peak = Boolean(data && data.peak)
    const root = el('div', { class: 'capri-card', 'data-period': peak ? 'peak' : 'valley' })

    const close = el('button', { class: 'capri-card__x', type: 'button', text: '×', onclick: () => this.hide() })
    root.appendChild(el('div', { class: 'capri-card__head' },
      el('span', { class: 'capri-card__who', text: '摩羯' }),
      el('span', { class: 'capri-card__tag', text: '余额' }),
      close))

    root.appendChild(el('div', { class: 'capri-card__big', text: data && data.balance != null ? money(data.balance, data.currency) : '—' }))
    root.appendChild(el('div', { class: 'capri-card__sub', text: '账户余额' }))

    const rows = el('div', { class: 'capri-card__rows' })
    const row = (label, value, cls) => rows.appendChild(el('div', { class: 'capri-card__row' },
      el('span', { class: 'capri-card__k', text: label }),
      el('span', { class: 'capri-card__v' + (cls ? ' ' + cls : ''), text: value })))
    row('今日已用', data && data.today != null ? money(data.today, data.currency) : '—')
    if (data && Number(data.tokensToday) > 0) row('今日 token', kfmt(data.tokensToday))
    if (data && Number(data.turnsToday) > 0) row('今日轮次', String(data.turnsToday) + ' 轮')
    row('现在时段', peak ? '高峰（原价）' : '谷时（半价）')
    root.appendChild(rows)

    const period = el('div', { class: 'capri-card__period' },
      el('span', { class: 'capri-card__dot' }),
      el('span', { class: 'capri-card__p', text: peak ? '高峰 · 原价' : '低谷 · 半价' }),
      el('span', { class: 'capri-card__cd' }))
    root.appendChild(period)
    root.appendChild(el('div', { class: 'capri-card__hint', text: '谷时：工作日 12:00–14:00、18:00–次日 09:00，周末与法定节假日全天' }))

    root.appendChild(el('div', { class: 'capri-card__foot' },
      el('button', { class: 'capri-card__btn', type: 'button', text: '刷新', onclick: () => this.onRefresh?.() })))

    document.body.appendChild(root)
    this.root = root
    this.place()

    const tick = () => {
      const cd = root.querySelector('.capri-card__cd')
      if (!cd) return
      if (!data || !data.nextChangeAt) { cd.textContent = ''; return }
      cd.textContent = (peak ? '距离转谷 ' : '距离转峰 ') + hms(data.nextChangeAt - Date.now())
    }
    tick()
    this.timer = setInterval(tick, 1000)
    if (this._follow) clearInterval(this._follow)
    this._follow = setInterval(() => this.place(), 260)
  }
}
