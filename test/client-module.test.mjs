// 浏览器半区（设置卡）的接线测试：不需要真浏览器，用假的 __ModuleLoader__ 接住它
import test from 'node:test'
import assert from 'node:assert/strict'

const captured = []
globalThis.window = {
  __ModuleLoader__: {
    load(mod) { captured.push(mod) },
  },
}

await import('../client/index.js')

test('模块用包名注册自己', () => {
  assert.equal(captured.length, 1)
  assert.equal(captured[0].id, 'dsh-capri')
})

test('导出 apply / inject，并把设置卡挂进插件页', () => {
  const requireStub = (name) => {
    if (name === 'react') {
      const el = (type, props, ...kids) => ({ type, props, kids })
      return { createElement: el, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn }
    }
    throw new Error('unexpected require ' + name)
  }
  const mod = captured[0].factory(requireStub)
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])

  const registrations = []
  const ctx = {
    effect(fn) { fn() },
    slots: {
      inject(name, cb) { assert.equal(name, 'plugins.item'); return cb() },
      register(entry, Component) { registrations.push({ entry, Component }) },
    },
  }
  mod.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].entry.name, 'plugins.item')
  assert.equal(registrations[0].entry.id, 'capri')
  assert.equal(typeof registrations[0].Component, 'function')
})
