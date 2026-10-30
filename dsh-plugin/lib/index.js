// dsh-capri —— 只当"桥"：把 DSH 的会话事件和余额喂给桌面上的摩羯，不再往页面里画人。
//
// 两条出口（都只监听回环）：
//   ① 事件：POST http://127.0.0.1:47823/event   （桌面端在听，没开就丢掉）
//   ② 数据：GET  http://127.0.0.1:47824/state   （桌面端点"查看余额"来取）
// 事件翻译逻辑在 bridge.js，跟插件版共用同一份。

import { spawn } from 'node:child_process'
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

// ---------- 今日消耗账本（按事件累计，不靠余额差） ----------
function readLedger() {
  const s = readState()
  const day = todayKey()
  const led = s.ledger && s.ledger.day === day ? s.ledger : null
  return led || { day, cost: 0, tokens: 0, turns: 0 }
}

function addSpend(cost, tokens) {
  const led = readLedger()
  led.cost = Number((led.cost + (Number(cost) || 0)).toFixed(6))
  led.tokens = (Number(led.tokens) || 0) + (Number(tokens) || 0)
  led.turns = (Number(led.turns) || 0) + 1
  writeState({ ledger: led })
  return led
}

// 历史消耗：DSH 里装了鲸鱼挂件的话，它有一份按天的用量账本（连页面端、重启前的都算），
// 直接拿来当"今日已用"的来源；没有再用我们自己的账本。
const WHALE_LEDGERS = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
]

function readHistoryToday() {
  const day = todayKey()
  for (const file of WHALE_LEDGERS) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const events = Array.isArray(data && data.events) ? data.events : []
      if (!events.length) continue
      let cost = 0
      let tokens = 0
      let turns = 0
      for (const e of events) {
        if (!e || e.day !== day) continue
        cost += Number(e.cost) || 0
        tokens += Number(e.tokens) || 0
        turns += 1
      }
      return { cost, tokens, turns, source: file }
    } catch { /* 没有这份账本 */ }
  }
  return null
}

// 今天的起点余额：当天第一次看到余额时记下来，之后的余额差就是"今天花掉的"
function noteDayStart(amount, currency) {
  const day = todayKey()
  const s = readState()
  const rec = s.dayStart && s.dayStart.day === day ? s.dayStart : { day, amount, currency }
  if (!s.dayStart || s.dayStart.day !== day) writeState({ dayStart: rec })
  return rec
}

function balanceSpentToday(amount) {
  const rec = readState().dayStart
  if (!rec || rec.day !== todayKey() || !Number.isFinite(Number(rec.amount))) return 0
  const used = Number(rec.amount) - Number(amount)
  return used > 0 ? used : 0
}

function observeBalance(amount, currency) {
  noteDayStart(amount, currency)
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


// ---------- 计费（按 DeepSeek 官方价目表，含峰谷；元/百万 token） ----------
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) if (key !== '_default' && m.indexOf(key) !== -1) return PRICING[key]
  return PRICING._default
}
function costOf({ model, hit, miss, out, atSec }) {
  const p = priceFor(model)
  const off = isPeakTime(atSec) ? 1 : 0 // [0]=谷价 [1]=高峰
  return (Number(hit) || 0) / 1e6 * p.hit[off] + (Number(miss) || 0) / 1e6 * p.miss[off] + (Number(out) || 0) / 1e6 * p.out[off]
}

const log = (...a) => { try { console.log('[capri-bridge]', ...a) } catch { /* 忽略 */ } }

// 「跟随 DSH」：她在设置里勾了就写 ~/.capri-follow-dsh，DSH 起来时把她拉起来
const FOLLOW_FLAG = path.join(os.homedir(), '.capri-follow-dsh')
const LAUNCH_LOG = path.join(DSH_HOME, 'capri-bridge-launch.log')

function launchLog(msg) {
  try { fs.appendFileSync(LAUNCH_LOG, `${new Date().toISOString()} ${msg}\n`) } catch { /* 忽略 */ }
}

function petAppPath() {
  const cands = [
    process.env.CAPRI_APP_PATH,
    '/Applications/摩羯.app',
    path.join(os.homedir(), 'Applications', '摩羯.app'),
  ].filter(Boolean)
  return cands.find((p) => { try { return fs.existsSync(p) } catch { return false } }) || null
}

async function petAlive() {
  try {
    const res = await fetch('http://127.0.0.1:47823/health', { signal: AbortSignal.timeout(800) })
    return res.ok
  } catch { return false }
}

// 「跟随 DSH」：DSH 一启动就把她拉起来（已经在跑就不动）
async function launchPetIfWanted() {
  try {
    if (!fs.existsSync(FOLLOW_FLAG)) { launchLog('没开跟随（没有标记文件）'); return }
    if (await petAlive()) { launchLog('她已经在了'); return }
    const app = petAppPath()
    if (!app) { launchLog('找不到摩羯.app'); return }
    // 直接跑包里的可执行文件（macOS 的 `open` 在装了带同 bundle id 的旧副本时会静默不启动）
    const exe = path.join(app, 'Contents', 'MacOS', 'Electron')
    // 关键：DSH 自己是 ELECTRON_RUN_AS_NODE=1 跑的，子进程必须去掉这个变量，否则她也变成 node 起来就退出
    const childEnv = { ...process.env }
    delete childEnv.ELECTRON_RUN_AS_NODE
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (fs.existsSync(exe)) {
          spawn(exe, [], { detached: true, stdio: 'ignore', env: childEnv }).unref()
          launchLog(`第 ${attempt} 次启动 ${exe}`)
        } else {
          spawn('open', ['-g', app], { detached: true, stdio: 'ignore', env: childEnv }).unref()
          launchLog(`第 ${attempt} 次启动(open) ${app}`)
        }
      } catch (err) { launchLog('spawn 失败: ' + (err && err.message)) }
      await new Promise((r) => setTimeout(r, 1500 * attempt))
      if (await petAlive()) { launchLog('起来了'); return }
    }
    launchLog('三次都没起来')
  } catch (err) { launchLog('跟随 DSH 出错: ' + (err && err.message)) }
}

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

  // ---------- ①.5 今日消耗：按每轮 token + 峰谷价目表算，写进账本 ----------
  const turnAgg = new Map() // sessionId -> {hit, miss, out, model, tokens}
  function aggOf(session) {
    const id = String((session && session.id) || 'default')
    let a = turnAgg.get(id)
    if (!a) { a = { hit: 0, miss: 0, out: 0, tokens: 0, model: '' }; turnAgg.set(id, a) }
    return a
  }
  try {
    disposers.push(ctx.on('session/event', (session, event) => {
      try {
        const type = String((event && event.type) || '')
        const data = (event && event.data) || {}
        if (type === 'assistant/message') {
          const a = aggOf(session)
          const usage = data.usage || (data.message && data.message.usage) || null
          const model = String(data.model || (data.message && data.message.model) || '')
          if (model) a.model = model
          if (usage && typeof usage === 'object') {
            a.hit += Number(usage.cacheReadTokens) || 0
            a.miss += Number(usage.inputTokens) || Number(usage.promptTokens) || 0
            a.out += Number(usage.outputTokens) || Number(usage.completionTokens) || 0
          }
          return
        }
        if (type === 'turn/end') {
          const a = aggOf(session)
          const atSec = Math.floor((Number(data.ts) || Date.now()) / 1000)
          const tokens = a.hit + a.miss + a.out
          const cost = costOf({ model: a.model, hit: a.hit, miss: a.miss, out: a.out, atSec })
          if (tokens > 0) addSpend(cost, tokens)
          turnAgg.set(String((session && session.id) || 'default'), { hit: 0, miss: 0, out: 0, tokens: 0, model: a.model })
        }
      } catch (err) { log('记账出错', err && err.message) }
    }))
  } catch (err) { log('订阅记账失败', err && err.message) }

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
    const led = readLedger()
    const hist = readHistoryToday()
    // 自己记的账本为主；打开时先看一眼"今天的起点余额"，用余额差兜住开机之前的消耗。
    // 有 DSH 用量账本（鲸鱼挂件）时，它的历史更全，取三者最大，宁多算不少算。
    const own = Number(led.cost) || 0
    const byBalance = bal ? balanceSpentToday(bal.amount) : 0
    const byHistory = hist ? Number(hist.cost) || 0 : 0
    const today = Math.max(own, byBalance, byHistory)
    return {
      ok: true,
      version: pkgVersion,
      at: Date.now(),
      balance: bal ? bal.amount : null,
      currency: bal ? bal.currency : 'CNY',
      today,
      tokensToday: Math.max(Number(led.tokens) || 0, hist ? Number(hist.tokens) || 0 : 0),
      turnsToday: Math.max(Number(led.turns) || 0, hist ? Number(hist.turns) || 0 : 0),
      todaySource: byHistory >= own ? 'history' : (byBalance > own ? 'balance' : 'ledger'),
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

  void launchPetIfWanted()
  log('已挂载：事件→47823，余额→47824')
}

export default { name, apply }
