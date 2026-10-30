// 离线自测：用假 ctx + 本地假服务器验证事件翻译
import http from 'node:http';
import assert from 'node:assert';
import { apply } from './lib/index.js';

const got = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    got.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => server.listen(47824, '127.0.0.1', r));

const handlers = new Map();
const ctx = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  get(name) {
    if (name !== 'deepseekAccount') return null;
    return {
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: 12.34 }],
        bonusWallets: [{ currency: 'CNY', balance: 1.66 }],
      }),
    };
  },
  effect(fn) { fn(); },
};

apply(ctx, { port: 47824, quota: true, quotaEveryMs: 0, log: true });
const emit = (type, data, session = { id: 's1', cwd: '/tmp/demo' }) =>
  handlers.get('session/event')(session, { type, data });

emit('session/title', { title: '安装 Capri' });
emit('turn/start', { prompt: '帮我把这个项目装上' });
emit('assistant/message', { usage: { inputTokens: 1200, cacheReadTokens: 800, outputTokens: 300 } });
emit('tool/call', { name: 'Bash', input: { command: 'npm install' } });
emit('tool/result', { message: { callId: 'c1', content: [{ type: 'text', text: 'ok' }] } });
emit('tool/call', { name: 'Read', input: { file_path: '/tmp/a.js' } });
emit('tool/result', { isError: true, message: { content: [{ type: 'text', text: 'ENOENT: no such file' }] } });
emit('approval/asked', { id: 'a1' });
emit('turn/end', { reason: 'end' });
handlers.get('subagent/start')({ runId: 'r1', provider: 'codex', id: 's2' });
handlers.get('subagent/end')({ runId: 'r1', provider: 'codex', id: 's2' });

await new Promise((r) => setTimeout(r, 600));
server.close();

const names = got.map((g) => g.hook_event_name);
console.log('发出的事件：', names.join(', '));
const byName = (n) => got.filter((g) => g.hook_event_name === n);

assert.deepStrictEqual(names, [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PreToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'Note',
]);
assert.strictEqual(byName('PreToolUse')[0].tool_name, 'Bash');
assert.deepStrictEqual(byName('PreToolUse')[0].tool_input, { command: 'npm install' });
assert.strictEqual(byName('PreToolUse')[1].tool_name, 'Read');
assert.match(byName('PostToolUseFailure')[0].error, /ENOENT/);
assert.strictEqual(byName('Stop')[0].actions, 2);
assert.match(byName('Note')[0].text, /余额 ¥14\.00/);
assert.match(byName('Note')[0].text, /本轮 2\.3k token/);
assert.strictEqual(byName('UserPromptSubmit')[0].prompt, '帮我把这个项目装上');
assert.strictEqual(byName('SessionStart')[0].session_title, '安装 Capri');
console.log('全部断言通过；样例 Note 文案：', byName('Note')[0].text);
