// 第二轮离线自测：DSH 风格的工具名 / 参数名归一
import http from 'node:http';
import assert from 'node:assert';
import { apply } from './lib/index.js';

const got = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { got.push(JSON.parse(body)); res.end('{"ok":true}'); });
});
await new Promise((r) => server.listen(47825, '127.0.0.1', r));

const handlers = new Map();
const ctx = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  get() { return null; },
  effect(fn) { fn(); },
};
apply(ctx, { port: 47825, quota: false, log: false });
const emit = (type, data) => handlers.get('session/event')({ id: 's9', cwd: '/tmp/w' }, { type, data });

emit('turn/start', { prompt: '跑一下测试' });
emit('tool/call', { name: 'bash', input: { command: 'npm test', description: '跑测试' } });
emit('tool/call', { name: 'read_file', input: { path: '/tmp/w/src/app.js' } });
emit('tool/call', { name: 'edit_file', input: { path: '/tmp/w/src/app.js', old: 'a', new: 'b' } });
emit('tool/call', { name: 'web_fetch', input: { url: 'https://example.com/x' } });
emit('tool/call', { name: 'grep', input: { pattern: 'TODO' } });
emit('tool/call', { name: 'ask_user_question', input: { question: '继续吗' } });
emit('tool/call', { name: 'weird_custom_tool', input: { foo: 1 } });
emit('tool/result', { isError: true, message: { content: [{ type: 'text', text: 'boom' }] } });

await new Promise((r) => setTimeout(r, 400));
server.close();

const pre = got.filter((g) => g.hook_event_name === 'PreToolUse');
const names = pre.map((p) => p.tool_name);
console.log('归一后的工具名：', names.join(', '));
assert.deepStrictEqual(names, ['Bash', 'Read', 'Edit', 'WebFetch', 'Grep', 'AskUserQuestion', 'weird_custom_tool']);
assert.strictEqual(pre[0].tool_input.command, 'npm test');
assert.strictEqual(pre[0].tool_name_raw, 'bash');
assert.strictEqual(pre[1].tool_input.file_path, '/tmp/w/src/app.js');
assert.strictEqual(pre[3].tool_input.url, 'https://example.com/x');
assert.strictEqual(pre[4].tool_input.pattern, 'TODO');

const notes = got.filter((g) => g.hook_event_name === 'Notification');
assert.strictEqual(notes.length, 1, '问用户时要额外发一条 Notification 把她叫过来');
assert.strictEqual(notes[0].notification_type, 'permission_prompt');

const fail = got.filter((g) => g.hook_event_name === 'PostToolUseFailure');
assert.strictEqual(fail.length, 1);
console.log('第二轮断言全过；失败事件工具名：', fail[0].tool_name, '错误：', fail[0].error.slice(0, 30));
