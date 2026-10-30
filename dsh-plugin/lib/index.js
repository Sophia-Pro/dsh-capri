// dsh-capri —— 只当"桥"：把 DSH 的会话事件和余额喂给桌面上的摩羯，不再往页面里画人。
//
// 两条出口（都只监听回环）：
//   ① 事件：POST http://127.0.0.1:47823/event   （桌面端在听，没开就丢掉）
//   ② 数据：GET  http://127.0.0.1:47824/state   （桌面端点"查看余额"来取）
// 事件翻译逻辑在 bridge.js，跟插件版共用同一份。

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as bridge from './bridge.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'capri-bridge.json')
const APP_EVENT_URL = 'http://127.0.0.1:47823/event'
const DATA_PORT = 47824

let pkgVersion = '0.0.0'
try { pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { /* 忽略 */ }

// ---------- 峰谷（DeepSeek 官方：北京 9–12、14–18 高峰，周末与法定节假日全天谷价） ----------
const PEAK_HOURS = [[9, 12], [14, 18]]
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // 北京 2026-08-23 00:00
const HOLIDAY_VALLEY = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000) // 北京 2026-09-19 00:00

const bjOf = (sec) => new Date(sec * 1000 + 8 * 3600 * 1000)

function isPeakTime(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return false
  const bj = bjOf(n)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  if (n >= HOLIDAY_VALLEY_FROM_SEC && HOLIDAY_VALLEY.has(bj.toISOString().slice(0, 10))) return false
  const hour = bj.getUTCHours()
  return PEAK_HOURS.some(([a, b]) => hour >= a && hour < b)
}

function nextPeakChangeAt(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return null
  const cur = isPeakTime(n)
  const day0 = Math.floor((n + 8 * 3600) / 86400) * 86400
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * 86400 + edge * 3600 - 8 * 3600
      if (cand <= n + 1) continue
      if (isPeakTime(cand) !== cur) return cand
    }
  }
  return null
}

// ---------- 今日花费：按当天第一次看到的余额差来算 ----------
const todayKey = () => bjOf(Math.floor(Date.now() / 1000)).toISOString().slice(0, 10)

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return s && typeof s === 'object' ? s : {}
  } catch { return {} }
}

function writeState(patch) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2))
  } catch { /* 写不进去不影响主流程 */ }
}

function observeBalance(amount, currency) {
  const day = todayKey()
  const s = readState()
  const rec = s.ledger && s.ledger.day === day ? s.ledger : { day, start: amount, currency }
  writeState({ ledger: rec })
  return rec
}

function spendToday(amount) {
  const rec = readState().ledger
  if (!rec || rec.day !== todayKey() || !Number.isFinite(Number(rec.start))) return null
  const used = Number(rec.start) - Number(amount)
  return used > 0 ? used : 0
}

const log = (...a) => { try { console.log('[capri-bridge]', ...a) } catch { /* 忽略 */ } }

export const name = 'dsh-capri'

export function apply(ctx, rawConfig = {}) {
  const cfg = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const disposers = []

  // ---------- ① 事件 → 桌面端 ----------
  let appAliveAt = 0
  let appMisses = 0

  async function postEvent(payload) {
    if (Date.now() - appAliveAt > 30_000 && appMisses > 20) return // 她没开：别一直打
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 1200)
      const res = await fetch(APP_EVENT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
      clearTimeout(timer)
      if (res.ok) { appAliveAt = Date.now(); appMisses = 0 } else { appMisses += 1 }
    } catch {
      appMisses += 1
    }
  }

  try {
    bridge.setSink((evt) => { void postEvent(evt) })
    disposers.push(bridge.apply(ctx, { quota: false, log: Boolean(cfg.log) }))
  } catch (err) { log('事件桥挂了', err && err.message) }

  // ---------- ② 余额：给桌面端一个本地接口 ----------
  async function readBalance() {
    let account = null
    try { account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch { account = null }
    if (!account || typeof account.getBalance !== 'function') return null
    try {
      const result = await account.getBalance({
        version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
        locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (!result || result.status !== 'ready') return null
      const wallets = []
      for (const list of [result.value, result.bonusWallets]) {
        if (!Array.isArray(list)) continue
        for (const w of list) if (w && Number.isFinite(Number(w.balance))) wallets.push(w)
      }
      if (!wallets.length) return null
      const cur = String((wallets.find((w) => String(w.currency || 'CNY').toUpperCase() === 'CNY') || wallets[0]).currency || 'CNY').toUpperCase()
      const total = wallets
        .filter((w) => String(w.currency || 'CNY').toUpperCase() === cur)
        .reduce((sum, w) => sum + Number(w.balance), 0)
      return { amount: total, currency: cur }
    } catch (err) {
      log('取余额失败', err && err.message)
      return null
    }
  }

  function statePayload(balance) {
    const nowSec = Math.floor(Date.now() / 1000)
    const peak = isPeakTime(nowSec)
    const next = nextPeakChangeAt(nowSec)
    const bal = balance || null
    let today = null
    if (bal) {
      observeBalance(bal.amount, bal.currency)
      today = spendToday(bal.amount)
    }
    return {
      ok: true,
      version: pkgVersion,
      at: Date.now(),
      balance: bal ? bal.amount : null,
      currency: bal ? bal.currency : 'CNY',
      today,
      peak,
      period: peak ? 'peak' : 'valley',
      peakHours: '9:00–12:00 / 14:00–18:00',
      nextChangeAt: next ? next * 1000 : null,
    }
  }

  let lastBalance = null
  let lastAt = 0
  async function freshState(force) {
    const now = Date.now()
    if (!force && lastBalance && now - lastAt < 15_000) return statePayload(lastBalance)
    const bal = await readBalance()
    if (bal) { lastBalance = bal; lastAt = now }
    return statePayload(lastBalance)
  }

  const server = http.createServer((req, res) => {
    const host = String((req.headers || {}).host || '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) { res.writeHead(403); res.end(''); return }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/state') { res.writeHead(404); res.end(''); return }
    freshState(url.searchParams.get('fresh') === '1')
      .then((data) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(data))
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      })
  })
  server.on('error', (err) => log('数据端口起不来', err && err.message))
  server.listen(DATA_PORT, '127.0.0.1')
  try { server.unref?.() } catch { /* 忽略 */ }
  disposers.push(() => { try { server.close() } catch { /* 忽略 */ } })

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { for (const off of disposers.splice(0).reverse()) { try { off() } catch { /* 忽略 */ } } })
    }
  } catch { /* 忽略 */ }

  log('已挂载：事件→47823，余额→47824')
}

export default { name, apply }
