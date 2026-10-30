// 第三轮：Stop 要带上整套回答文本（她端给没看屏幕的你）
import http from 'node:http';
import assert from 'node:assert';
import { apply } from './lib/index.js';

const got = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => { got.push(JSON.parse(b)); res.end('{}'); });
});
await new Promise((r) => server.listen(47826, '127.0.0.1', r));
const h = new Map();
apply({ on(n, f) { h.set(n, f); return () => h.delete(n); }, get() { return null; }, effect(f) { f(); } },
  { port: 47826, quota: false });
const emit = (t, d) => h.get('session/event')({ id: 's1', cwd: '/tmp/p' }, { type: t, data: d });
emit('turn/start', { prompt: '写个总结' });
emit('assistant/message', { message: { content: [{ type: 'text', text: '第一段结论。' }] }, usage: { inputTokens: 10, outputTokens: 5 } });
emit('assistant/message', { message: { content: [{ type: 'text', text: '第二段收尾。' }] } });
emit('turn/end', { reason: 'end' });
await new Promise((r) => setTimeout(r, 300));
server.close();
const stop = got.find((g) => g.hook_event_name === 'Stop');
console.log('Stop 文本：', JSON.stringify(stop.last_assistant_message));
assert.match(stop.last_assistant_message, /第二段收尾/);
assert.strictEqual(stop.actions, 0);
console.log('第三轮断言通过');
