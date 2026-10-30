// 插件自身的接线测试：不起 DSH、不开浏览器，只验证"装配对不对"
//   - package.json / cordis.patch.yml 的插件声明
//   - 页面脚本和素材都被登记成路由
//   - 桌面壳的注入行会被塞进注入表
//   - 会话事件经 bridge 变成她认识的 hook 事件（走到 SSE 广播）

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name } from '../lib/index.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('插件声明齐全', () => {
  assert.equal(pkg.name, 'dsh-capri')
  assert.equal(typeof pkg.version, 'string')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('client'))
  assert.ok(pkg.files.includes('assets'))
  assert.equal(name, 'dsh-capri')
})

test('patch 文件把自己挂进 profile', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(yml, /id:\s*dsh-capri/)
  assert.match(yml, /name:\s*dsh-capri/)
})

test('页面脚本与素材都在', () => {
  for (const f of ['client/boot.js', 'client/app.js', 'client/capri.css', 'client/lines.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f)
  }
  for (const f of ['assets/capri/capri-full.png', 'assets/fonts/chakra-petch-latin-600-normal.woff2']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f)
  }
})

/** 假宿主：只够跑 apply() 用 */
function fakeHost() {
  const routes = new Map()
  const listeners = new Map()
  const sse = []
  const rowListeners = []
  const webServer = {
    register(reg) {
      routes.set(reg.path, reg)
      return () => routes.delete(reg.path)
    },
    tapIndex(fn) {
      webServer.__tap = fn
      return () => { webServer.__tap = null }
    },
  }
  const ctx = {
    webServer,
    get: (n) => (n === 'webServer' ? webServer : null),
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {}
    },
    effect(fn) { try { fn() } catch { /* 忽略 */ } },
  }
  const root = {
    on(ev, fn) {
      if (ev === 'webserver/index-inject') rowListeners.push(fn)
      return () => {}
    },
    inject(_deps, cb) { cb(ctx) },
    effect(fn) { try { fn() } catch { /* 忽略 */ } },
  }
  return { root, ctx, routes, listeners, rowListeners, sse, webServer }
}

/** 直接调路由 handler，拿到响应体 */
async function call(host, routePath, { method = 'GET', body = '', headers = {} } = {}) {
  const reg = host.routes.get(routePath)
  assert.ok(reg, `路由 ${routePath} 应该注册`)
  const chunks = []
  let status = 200
  let headersOut = {}
  const res = {
    writeHead(code, h) { status = code; headersOut = h || {} },
    write(s) { chunks.push(String(s)); return true },
    end(s) { if (s !== undefined) chunks.push(String(s)) },
    on() {},
  }
  const req = {
    method,
    url: routePath,
    headers: { host: '127.0.0.1:7311', ...headers },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) },
    on() {},
  }
  await reg.handler(req, res)
  return { status, headers: headersOut, text: chunks.join('') }
}

test('apply 装上路由、注入行和事件桥', async () => {
  const host = fakeHost()
  apply(host.root, { log: false })

  for (const p of ['/capri/config', '/capri/events', '/capri/state', '/capri/self-test',
    '/capri/client/boot.js', '/capri/client/app.js', '/capri/assets/capri/capri-full.png']) {
    assert.ok(host.routes.has(p), `缺路由 ${p}`)
  }

  const state = await call(host, '/capri/state')
  const parsed = JSON.parse(state.text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.lang, 'zh')
  assert.equal(parsed.config.dshEdition, true)
  assert.equal(typeof parsed.config.idleMin, 'number')
  assert.equal(typeof parsed.config.quiet, 'boolean')

  // 桌面壳：注入行必须能进表，并且只进一次
  const table = []
  for (const fn of host.rowListeners) fn(table)
  for (const fn of host.rowListeners) fn(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.match(table[0].text, /capri\/client\/boot\.js/)
})

test('配置写得进、广播得出去', async () => {
  const host = fakeHost()
  apply(host.root, { log: false })

  const events = await call(host, '/capri/events')
  assert.equal(events.status, 200)
  assert.match(events.headers['content-type'], /event-stream/)

  const before = JSON.parse((await call(host, '/capri/config')).text)
  const after = await call(host, '/capri/config', {
    method: 'POST',
    body: JSON.stringify({ quiet: !before.quiet, idleMin: 7 }),
    headers: { 'content-type': 'application/json' },
  })
  const cfg = JSON.parse(after.text).cfg
  assert.equal(cfg.idleMin, 7)
  assert.equal(cfg.quiet, !before.quiet)

  const again = JSON.parse((await call(host, '/capri/config')).text)
  assert.equal(again.idleMin, 7)
})

test('外来的请求被栅栏挡住', async () => {
  const host = fakeHost()
  apply(host.root, { log: false })
  const bad = await call(host, '/capri/config', {
    method: 'POST',
    body: JSON.stringify({ quiet: true }),
    headers: { host: 'evil.example.com', origin: 'http://evil.example.com' },
  })
  assert.equal(bad.status, 403)
})

test('会话事件经桥变成她能演的东西', async () => {
  const host = fakeHost()
  apply(host.root, { log: false })

  // 打开一条 SSE 连接收集广播
  const frames = []
  const reg = host.routes.get('/capri/events')
  const res = {
    writeHead() {},
    write(s) { frames.push(String(s)); return true },
    end() {},
    on() {},
  }
  await reg.handler({ method: 'GET', url: '/capri/events', headers: { host: '127.0.0.1:7311' }, on() {} }, res)

  const subs = host.listeners.get('session/event') || []
  assert.ok(subs.length > 0, '应该订阅了 session/event')
  for (const fn of subs) {
    fn({ id: 's1', cwd: '/tmp' }, { type: 'turn/start', data: { prompt: '跑一下测试' } })
    fn({ id: 's1', cwd: '/tmp' }, { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"npm test"}' } })
  }

  const claude = frames.filter((f) => f.includes('"type":"claude"')).map((f) => JSON.parse(f.replace(/^data: /, '').trim()))
  assert.ok(claude.length >= 2, '应该有事件广播出去')
  const kinds = claude.map((c) => c.evt.hook_event_name)
  assert.ok(kinds.includes('UserPromptSubmit'))
  assert.ok(kinds.includes('PreToolUse'))
  const toolUse = claude.find((c) => c.evt.hook_event_name === 'PreToolUse')
  assert.equal(toolUse.evt.tool_name, 'Bash')
  assert.equal(toolUse.evt.tool_input.command, 'npm test')
})
