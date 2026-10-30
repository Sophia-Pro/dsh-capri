// dsh-capri —— 摩羯，DSH 里的桌面挂件（纯插件版）
// ---------------------------------------------------------------------------
// 以前她住在一个 Electron 透明窗里（得装、得签名、得给辅助功能权限，只认 macOS）。
// 现在整只塞进 DSH 自己的页面：宿主这半边负责
//   · 把会话事件翻译成她能读懂的话（bridge.js，原来的独立桥接插件并进来）
//   · 给她一条 SSE 事件流（页面那半边订阅）
//   · 把页面半边的脚本注入进 DSH 的网页，并托管她的图片 / 字体 / 代码
//   · 记住她的设置（安静模式、空闲收起多少分钟、显示不显示）
// 页面那半边（client/boot.js + client/*.js）就是原来渲染层，几乎原样搬过来的。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as bridge from './bridge.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const ASSETS_DIR = path.join(ROOT, 'assets')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'capri.json')
const BOOT_SRC = '/capri/client/boot.js'

let pkgVersion = '0.0.0'
try { pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { /* 忽略 */ }

const DEFAULTS = {
  lang: 'zh',
  scale: 0.8,
  side: 'right',
  wander: true,
  possess: false,      // 页面里没有别人的窗口可坐，附身先关掉
  visible: true,
  linked: false,
  welcomed: true,
  dshEdition: true,
  sound: true,
  quiet: false,        // 安静模式：不乱走、不乱演
  idleMin: 5,          // 页面多久没操作就收起来；0 = 收起关了
}

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
}

function readConfig() {
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {}
  } catch { /* 第一次跑，没有文件 */ }
  return { ...DEFAULTS, ...stored }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    const tmp = CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    fs.renameSync(tmp, CONFIG_FILE)
    return true
  } catch (err) {
    try { console.warn('[capri] 写配置失败', err && err.message) } catch { /* 忽略 */ }
    return false
  }
}

const INDEX_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__capriBooted)return;var s=document.createElement("script");s.src="' + BOOT_SRC + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export const name = 'dsh-capri'

export function apply(root, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const disposers = []
  const sseClients = new Set()
  let current = readConfig()
  let lastDiag = null

  const log = (...a) => { if (config.log) try { console.log('[capri]', ...a) } catch { /* 忽略 */ } }

  function broadcast(msg) {
    const frame = `data: ${JSON.stringify(msg)}\n\n`
    for (const res of sseClients) {
      try { res.write(frame) } catch { sseClients.delete(res) }
    }
  }

  // —— 页面半区：注入 ——
  // 桌面壳（Electron）的 index.html 从安装包静态出，tapIndex 到不了，只能靠宿主启动时
  // 收集一次的结构化行；web 形态则用 tapIndex。两条都挂，各自去重（鲸鱼挂件踩过的坑）。
  try {
    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === BOOT_SRC) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(BOOT_SRC) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: INDEX_ROW_TEXT })
      } catch { /* 一行注入失败不影响宿主 */ }
    }))
  } catch (err) { log('index-inject 订阅失败', err && err.message) }

  root.inject(['webServer'], (ctx) => {
    const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
    if (!webServer || typeof webServer.register !== 'function') {
      try { console.warn('[capri] 没拿到 webServer，页面挂件没挂上') } catch { /* 忽略 */ }
      return
    }

    // —— 信任栅栏：只认本机回环、同源、非跨站 ——
    function isLoopback(hostname) {
      const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
      if (!h) return false
      if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
      return Boolean(m) && Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
    }
    function guard(req) {
      try {
        const h = req.headers || {}
        if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
        let hostUrl
        try { hostUrl = new URL('http://' + String(h.host || '')) } catch { return 403 }
        if (!isLoopback(hostUrl.hostname)) return 403
        const origin = h.origin
        if (typeof origin === 'string' && origin && origin !== 'null') {
          let o
          try { o = new URL(origin) } catch { return 403 }
          if (o.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
        }
        return null
      } catch { return 403 }
    }
    function route(pathname, handler, opts = {}) {
      const reg = {
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          const bad = guard(req)
          if (bad) { try { res.writeHead(bad) } catch { /* 忽略 */ } try { res.end('') } catch { /* 忽略 */ } return }
          try { await handler(req, res) } catch (err) {
            log('route 出错', pathname, err && err.message)
            try { res.writeHead(500) } catch { /* 忽略 */ }
            try { res.end('error') } catch { /* 忽略 */ }
          }
        },
      }
      try {
        const off = webServer.register(reg)
        if (typeof off === 'function') disposers.push(off)
      } catch (err) { log('注册路由失败', pathname, err && err.message) }
    }
    function json(res, body, code = 200) {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    function sendFile(res, base, relPath) {
      const safe = String(relPath || '').replace(/\\/g, '/')
      if (safe.indexOf('..') >= 0 || safe.startsWith('/')) { res.writeHead(400); res.end(''); return }
      const full = path.join(base, safe)
      if (!full.startsWith(base + path.sep) && full !== base) { res.writeHead(400); res.end(''); return }
      let buf
      try { buf = fs.readFileSync(full) } catch { res.writeHead(404); res.end(''); return }
      res.writeHead(200, {
        'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      res.end(buf)
    }

    // 页面脚本 / 素材：启动时把目录里每个文件登记成一条精确路由
    // （webServer 只保证 exact，不赌 prefix 支持）
    function walk(dir, prefix, out) {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, prefix + '/' + e.name, out)
        else if (e.isFile() && e.name.endsWith('.js') || e.isFile() && /\.(css|png|webp|jpe?g|svg|woff2?|json)$/i.test(e.name)) out.push({ full, url: prefix + '/' + e.name })
        else if (e.isFile()) out.push({ full, url: prefix + '/' + e.name })
      }
      return out
    }
    const files = []
    walk(CLIENT_DIR, '/capri/client', files)
    walk(ASSETS_DIR, '/capri/assets', files)
    for (const f of files) {
      route(f.url, (req, res) => {
        let buf
        try { buf = fs.readFileSync(f.full) } catch { res.writeHead(404); res.end(''); return }
        res.writeHead(200, {
          'content-type': MIME[path.extname(f.full).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        })
        res.end(buf)
      })
    }
    log('静态路由', files.length, '条')

    // 设置
    route('/capri/config', async (req, res) => {
      if (String(req.method || 'GET').toUpperCase() === 'GET') { json(res, current); return }
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 8192) break }
      let patch = {}
      try { patch = JSON.parse(body || '{}') } catch { json(res, { ok: false, error: 'bad json' }, 400); return }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) { json(res, { ok: false }, 400); return }
      current = { ...current, ...patch }
      writeConfig(current)
      broadcast({ type: 'config', cfg: current })
      json(res, { ok: true, cfg: current })
    })

    // 事件流
    route('/capri/events', (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      try { res.write(`data: ${JSON.stringify({ type: 'hello', cfg: current })}\n\n`) } catch { /* 忽略 */ }
      sseClients.add(res)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* 忽略 */ } }, 25000)
      try { ping.unref?.() } catch { /* 忽略 */ }
      const done = () => { clearInterval(ping); sseClients.delete(res) }
      try { req.on('close', done) } catch { /* 忽略 */ }
      try { res.on('close', done) } catch { /* 忽略 */ }
    })

    // 页面半区上报自己的状态：她被挡住了/没画出来时，靠这个查
    route('/capri/diag', async (req, res) => {
      if (String(req.method || 'GET').toUpperCase() === 'GET') { json(res, { ok: true, last: lastDiag }); return }
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 65536) break }
      try { lastDiag = JSON.parse(body || '{}') } catch { json(res, { ok: false }, 400); return }
      try { lastDiag.at = Date.now() } catch { /* 忽略 */ }
      json(res, { ok: true })
    })

    // 自检：塞一条假事件给她，验证"页面 ← 事件流"这一路通不通
    route('/capri/self-test', async (req, res) => {
      const evt = {
        session_id: 'self-test',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo 摩羯自检' },
        phase: '调用工具',
      }
      broadcast({ type: 'claude', evt })
      json(res, { ok: true, sent: evt })
    })

    // 自检：浏览器里跑了没、配置是什么
    route('/capri/state', (req, res) => json(res, {
      ok: true,
      version: pkgVersion,
      clients: sseClients.size,
      config: current,
      configFile: CONFIG_FILE,
      diag: lastDiag,
    }))

    // web 形态的注入通道（桌面壳走上面那条结构化行）
    try {
      if (typeof webServer.tapIndex === 'function') {
        disposers.push(webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.indexOf(BOOT_SRC) >= 0) return html
          const tag = `<script defer src="${BOOT_SRC}"></script>`
          return html.indexOf('</body>') >= 0 ? html.replace('</body>', tag + '</body>') : html + tag
        }))
      }
    } catch (err) { log('tapIndex 挂了', err && err.message) }

    // —— 会话事件 → 页面 ——
    try {
      bridge.setSink((evt) => {
        try { broadcast({ type: 'claude', evt }) } catch { /* 忽略 */ }
      })
      disposers.push(bridge.apply(ctx, {
        quota: config.quota !== false,
        quotaEveryMs: Number(config.quotaEveryMs) || 60000,
        log: Boolean(config.log),
      }))
    } catch (err) { log('桥没挂上', err && err.message) }

    log('已挂载，配置在', CONFIG_FILE)
  })

  try {
    if (typeof root.effect === 'function') {
      root.effect(() => () => {
        for (const res of sseClients) { try { res.end() } catch { /* 忽略 */ } }
        sseClients.clear()
        for (const off of disposers.splice(0).reverse()) { try { off() } catch { /* 继续归还 */ } }
      })
    }
  } catch { /* 忽略 */ }
}

export default { name, apply }
