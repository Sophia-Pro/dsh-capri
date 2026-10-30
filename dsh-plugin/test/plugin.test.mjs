// 桥插件接线测试：不起 DSH，只验证声明和"会话事件能翻成她的 hook 事件"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capri-bridge-'))
process.env.DSH_HOME = TMP

const mod = await import('../lib/index.js')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('插件声明齐全', () => {
  assert.equal(pkg.name, 'dsh-capri')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(mod.name, 'dsh-capri')
})

test('patch 把自己挂进 profile', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(yml, /id:\s*dsh-capri/)
})

test('会话事件 → 她的 hook 事件（走 sink）', async () => {
  // 截住事件出口：临时把 fetch 换掉，看它要发给桌面端什么
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('47823')) { sent.push(JSON.parse(init.body)) }
    return { ok: true, status: 200 }
  }
  const listeners = new Map()
  const ctx = {
    get: () => null,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return () => {} },
    effect() {},
  }
  try {
    mod.apply(ctx, { log: false })
    const subs = listeners.get('session/event') || []
    assert.ok(subs.length > 0, '应订阅 session/event')
    for (const fn of subs) {
      fn({ id: 's1', cwd: '/tmp' }, { type: 'turn/start', data: { prompt: '跑测试' } })
      fn({ id: 's1', cwd: '/tmp' }, { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"npm test"}' } })
    }
    // postEvent 是异步的，等一拍
    await new Promise((r) => setTimeout(r, 60))
    const kinds = sent.map((e) => e.hook_event_name)
    assert.ok(kinds.includes('UserPromptSubmit'), '应有 UserPromptSubmit：' + kinds.join(','))
    assert.ok(kinds.includes('PreToolUse'), '应有 PreToolUse：' + kinds.join(','))
    const tool = sent.find((e) => e.hook_event_name === 'PreToolUse')
    assert.equal(tool.tool_name, 'Bash')
    assert.equal(tool.tool_input.command, 'npm test')
  } finally {
    globalThis.fetch = realFetch
  }
})
