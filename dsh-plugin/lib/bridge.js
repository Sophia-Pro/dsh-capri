// dsh-plugin-capri-bridge
// ---------------------------------------------------------------------------
// 把 DSH 的会话事件翻译成 Capri 认识的 "Claude Code hook" JSON，交给同插件的页面半区。这样她不用改一行事件处理逻辑就能：
//   · 播报当前动作（工具名 + 参数摘要）      ← tool/call  → PreToolUse
//   · 失败时红屏 + 报错行                    ← tool/result(isError) → PostToolUseFailure
//   · 需要你批准时跑过来找你                 ← approval/asked → Notification
//   · 干完庆祝 + 摘要                        ← turn/end → Stop
//   · 余额 / 本轮 token 提醒、阶段提示        ← Note（Capri 侧新增的轻量事件）
// 全程 try/catch：Capri 没开、服务缺失、事件形状变了，都不许影响 DSH 本体。

import fs from 'node:fs';

const LOG_PATH = process.env.CAPRI_BRIDGE_LOG || '/tmp/dsh-capri-bridge.log';
const LOG_MAX = 512 * 1024;
const MAX_TEXT = 800;

let logEnabled = false;
let sink = null;

/** 由宿主插件把事件接到页面上（SSE） */
export function setSink(fn) { sink = fn; }
function log(...parts) {
  if (!logEnabled) return;
  try {
    const body = parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ');
    const line = `${new Date().toISOString()} ${body}\n`;
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > LOG_MAX) fs.truncateSync(LOG_PATH, 0);
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(LOG_PATH, line);
  } catch { /* 日志不许影响主流程 */ }
}

function clip(v, n = MAX_TEXT) {
  const s = String(v == null ? '' : v).replace(/\u0000/g, '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function textOf(content) {
  try {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.text === 'string') parts.push(c.text);
        else if (typeof c.content === 'string') parts.push(c.content);
        else if (Array.isArray(c.content)) parts.push(textOf(c.content));
      }
      return parts.filter(Boolean).join('\n');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  } catch { /* 形状不认识就当空 */ }
  return '';
}

function firstToolInput(data) {
  const direct = [data.input, data.args, data.toolInput, data.tool_input, data.parameters];
  for (const c of direct) {
    if (c && typeof c === 'object') return c;
  }
  // DSH 把参数放在 data.arguments 里，而且是一段 JSON 字符串（实测：调用 bash 时
  // arguments = "{\"command\": \"...\"}"）
  const raw = data.arguments !== undefined ? data.arguments : data.args;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 不是 JSON 就当没有 */ }
  }
  const list = Array.isArray(data?.message?.content) ? data.message.content : [];
  for (const c of list) {
    const cand = c && (c.toolInput || c.tool_input || c.input);
    if (cand && typeof cand === 'object') return cand;
  }
  const msg = data?.message;
  if (msg && typeof msg === 'object' && msg.input && typeof msg.input === 'object') return msg.input;
  return {};
}

// DSH 的工具名五花八门（read_file / bash / edit / web_fetch …），Capri 的动词表和参数名是按
// Claude Code 的 Read/Write/Edit/Bash/... 写的。这里做一层归一：认不出就原样透传（她会说"使用 xxx"）。
const TOOL_ALIASES = [
  // 先匹配更像"具体动作"的名字，免得 read_image 被 read 抢走
  [/^(read_image|view_image|screenshot|image_read|image)(?![a-z])/i, 'ReadImage'],
  [/^(send_message|reply_message|notify)(?![a-z])/i, 'SendMessage'],
  [/^(list_agents|agent_list|team_list)(?![a-z])/i, 'ListAgents'],
  [/^(spawn_teammate|spawn_agent|delegate)(?![a-z])/i, 'Agent'],
  [/^(update_goal|create_goal|goal_write|goal)(?![a-z])/i, 'UpdateGoal'],
  [/^(todo_write|todo|todos)(?![a-z])/i, 'TodoWrite'],
  [/^(ask_user_question|ask|question|ask_user)(?![a-z])/i, 'AskUserQuestion'],
  [/^(bash|shell|terminal|exec|run|command|sh)(?![a-z])/i, 'Bash'],
  [/^(read|read_file|readfile|open_file|cat|view)(?![a-z])/i, 'Read'],
  [/^(write|write_file|create_file|save_file)(?![a-z])/i, 'Write'],
  [/^(edit|edit_file|patch|replace|apply_patch|str_replace|multiedit)(?![a-z])/i, 'Edit'],
  [/^(grep|search_file|search_in_files|ripgrep|rg)(?![a-z])/i, 'Grep'],
  [/^(glob|find|list_files|ls|list_dir|search_files)(?![a-z])/i, 'Glob'],
  [/^(web_?fetch|fetch|http|curl|browse)(?![a-z])/i, 'WebFetch'],
  [/^(web_?search|search_web|google)(?![a-z])/i, 'WebSearch'],
  [/^(skill|load_skill)(?![a-z])/i, 'Skill'],
];

function normalizeTool(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'Tool';
  for (const [re, canon] of TOOL_ALIASES) if (re.test(raw)) return canon;
  return raw;
}

// 参数名的归一：不同工具族用的键不一样，Capri 只认 Claude 那套
function normalizeInput(tool, input) {
  const from = input && typeof input === 'object' ? input : {};
  const pick = (...keys) => {
    for (const k of keys) if (from[k] !== undefined && from[k] !== null) return from[k];
    return undefined;
  };
  const out = { ...from };
  const file = pick('file_path', 'path', 'file', 'filename', 'target_file', 'abs_path');
  if (file && !out.file_path) out.file_path = file;
  const nb = pick('notebook_path', 'notebook');
  if (nb && !out.notebook_path) out.notebook_path = nb;
  const cmd = pick('command', 'cmd', 'script', 'shell_command');
  if (cmd === undefined && (tool === 'Bash' || tool === 'PowerShell')) {
    const argv = pick('argv', 'args');
    if (Array.isArray(argv)) out.command = argv.join(' ');
  } else if (cmd !== undefined && !out.command) out.command = cmd;
  const pattern = pick('pattern', 'query', 'regex', 'expression', 'needle');
  if (pattern !== undefined && !out.pattern) out.pattern = pattern;
  const url = pick('url', 'uri', 'href');
  if (url !== undefined && !out.url) out.url = url;
  const q = pick('query', 'q', 'search', 'keywords');
  if (q !== undefined && !out.query) out.query = q;
  const desc = pick('description', 'desc', 'summary', 'title');
  if (desc !== undefined && !out.description) out.description = desc;
  return out;
}

function toolNameOf(data) {
  const cands = [data.name, data.toolName, data.tool_name, data.tool, data?.message?.name, data?.message?.toolName];
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim();
  const list = Array.isArray(data?.message?.content) ? data.message.content : [];
  for (const c of list) {
    const n = c && (c.name || c.toolName);
    if (typeof n === 'string' && n.trim()) return n.trim();
  }
  return 'Tool';
}

function isToolFailure(data) {
  try {
    if (data.isError === true || data.is_error === true) return true;
    if (data.error) return true;
    const msg = data.message;
    if (msg && (msg.isError === true || msg.is_error === true || msg.error)) return true;
    const list = [msg?.content, data.content].flat().filter(Boolean);
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      if (c.isError === true || c.is_error === true) return true;
      if (c.type === 'tool-error' || c.type === 'error') return true;
    }
    const txt = textOf(msg?.content) || textOf(data.content);
    if (/\b(error|failed|exception|exit code [1-9])/i.test(txt) && /^(error|failed)/i.test(txt.trim())) return true;
  } catch { /* 判不出来就不算失败 */ }
  return false;
}

function failureText(data) {
  const cands = [data.error, textOf(data?.message?.content), textOf(data?.content), data.result];
  for (const c of cands) {
    const s = String(c == null ? '' : c);
    if (s.trim()) return clip(s, 400);
  }
  return '命令失败了';
}

export const name = 'capri-bridge';

export function apply(ctx, rawConfig = {}) {
  const cfg = { quota: true, quotaEveryMs: 60_000, log: false, ...(rawConfig || {}) };
  logEnabled = cfg.log !== false;
  log('apply v2', cfg);

  const sessions = new Map();
  const disposers = [];

  function sess(session) {
    const id = String((session && session.id) || 'default');
    let s = sessions.get(id);
    if (!s) {
      s = { id, cwd: '', title: '', started: false, turnTokens: 0, tokens: 0, actions: 0, lastQuota: 0, lastText: '', lastThinkAt: 0, dayTokens: 0, day: '' };
      sessions.set(id, s);
    }
    try {
      const cwd = session && (session.cwd || (session.meta && session.meta.cwd) || (session.workspace && session.workspace.cwd));
      if (cwd) s.cwd = String(cwd);
    } catch { /* 忽略 */ }
    return s;
  }

  // 事件不再 POST 出去：交给同插件的页面半区（SSE 广播）
  function post(payload) {
    try {
      if (typeof sink === 'function') sink(payload);
    } catch (err) {
      log('sink fail', String((err && err.message) || err));
    }
  }

  function evt(s, body) {
    return { session_id: s.id, cwd: s.cwd, ...(s.title ? { session_title: s.title } : {}), ...body };
  }

  async function pushQuota(s) {
    if (cfg.quota === false) return;
    const every = Number(cfg.quotaEveryMs) || 60_000;
    const now = Date.now();
    if (now - s.lastQuota < every) return;
    s.lastQuota = now;
    let account = null;
    try { account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null; } catch { account = null; }
    if (!account || typeof account.getBalance !== 'function') { log('quota: 无账号服务'); return; }
    let result = null;
    try {
      result = await account.getBalance({
        version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
        locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
    } catch (err) { log('quota fail', String((err && err.message) || err)); return; }
    if (!result || result.status !== 'ready') { log('quota not ready', result && result.status); return; }
    const wallets = [];
    for (const list of [result.value, result.bonusWallets]) {
      if (!Array.isArray(list)) continue;
      for (const w of list) if (w && Number.isFinite(Number(w.balance))) wallets.push(w);
    }
    if (!wallets.length) return;
    const cur = String((wallets.find((w) => String(w.currency || 'CNY').toUpperCase() === 'CNY') || wallets[0]).currency || 'CNY').toUpperCase();
    const total = wallets
      .filter((w) => String(w.currency || 'CNY').toUpperCase() === cur)
      .reduce((sum, w) => sum + Number(w.balance), 0);
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const parts = [`余额 ${cur === 'CNY' ? '¥' : ''}${total.toFixed(2)}`];
    if (s.turnTokens) parts.push(`本轮 ${k(s.turnTokens)} token`);
    const today = new Date().toISOString().slice(0, 10);
    if (s.day !== today) { s.day = today; s.dayTokens = 0; }
    if (s.dayTokens) parts.push(`今天 ${k(s.dayTokens)} token`);
    if (s.actions) parts.push(`${s.actions} 步`);
    await post(evt(s, { hook_event_name: 'Note', note_kind: 'info', text: parts.join(' · ') }));
  }

  function handleSessionEvent(session, event) {
    try {
      const type = String((event && event.type) || '');
      const data = (event && event.data) || {};
      const s = sess(session);

      if (type === 'session/title') {
        const t = String(data.title == null ? '' : data.title).trim();
        if (t) s.title = clip(t, 120);
        return;
      }
      if (type === 'assistant/message') {
        log('assistant/message', JSON.stringify(data).slice(0, 400));
        const said = textOf(data?.message?.content) || textOf(data.content);
        if (said && said.trim()) s.lastText = clip(said, 4000);
        // 她得看得见"我在想什么"：把这一步的思路开头当成便签，6 秒最多一条
        const think = String(said || '').replace(/\s+/g, ' ').trim();
        if (think && Date.now() - (s.lastThinkAt || 0) > 6000) {
          s.lastThinkAt = Date.now();
          post(evt(s, { hook_event_name: 'Note', note_kind: 'info', phase: '琢磨', text: `琢磨：${clip(think, 46)}` }));
        }
        const usage = data.usage;
        if (usage && typeof usage === 'object') {
          const n = (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.outputTokens) || 0);
          s.turnTokens += n;
          if (s.day !== new Date().toISOString().slice(0, 10)) { s.day = new Date().toISOString().slice(0, 10); s.dayTokens = 0; }
          s.dayTokens += n;
          s.tokens += n;
        }
        return;
      }
      if (type === 'turn/start') {
        s.lastText = '';
        s.turnTokens = 0;
        s.actions = 0;
        if (!s.started) {
          s.started = true;
          post(evt(s, { hook_event_name: 'SessionStart', source: 'startup' }));
        }
        const prompt = clip(data.prompt || textOf(data?.message?.content) || data.title || '', 220);
        post(evt(s, { hook_event_name: 'UserPromptSubmit', prompt, phase: '思考中' }));
        return;
      }
      if (type === 'tool/call') {
        s.actions += 1;
        log('tool/call', JSON.stringify(data).slice(0, 600));
        const rawName = toolNameOf(data);
        const tool = normalizeTool(rawName);
        post(evt(s, {
          hook_event_name: 'PreToolUse',
          tool_name: tool,
          tool_input: normalizeInput(tool, firstToolInput(data)),
          tool_name_raw: rawName,
          phase: '调用工具',
        }));
        // 她在等你回答/批准：跟 Claude Code 的 permission_prompt 一样把她叫过来
        if (tool === 'AskUserQuestion') {
          post(evt(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'DSH 在问你' }));
        }
        return;
      }
      if (type === 'tool/result') {
        if (isToolFailure(data)) {
          post(evt(s, {
            hook_event_name: 'PostToolUseFailure',
            tool_name: normalizeTool(toolNameOf(data)),
            error: failureText(data),
            phase: '出错',
          }));
        }
        return;
      }
      if (type === 'approval/asked') {
        // 必须带 notification_type：Capri 只认 permission_prompt / elicitation_dialog / agent_needs_input
        post(evt(s, {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'DSH 等你批准',
          phase: '等你点头',
        }));
        return;
      }
      if (type.indexOf('approval/') === 0) return;
      if (type === 'turn/end') {
        post(evt(s, {
          hook_event_name: 'Stop',
          phase: '完成',
          reason: String(data.reason || ''),
          actions: s.actions,
          // 你没在窗口前时，她能把整段回答端给你看（Capri 的 reply 面板）
          last_assistant_message: s.lastText || undefined,
        }));
        pushQuota(s);
        return;
      }
      if (type === 'session/error' || type === 'turn/failure') {
        post(evt(s, {
          hook_event_name: 'StopFailure',
          error: failureText(data),
        }));
      }
    } catch (err) {
      log('handleSessionEvent err', String((err && err.message) || err));
    }
  }

  try {
    disposers.push(ctx.on('session/event', (session, event) => handleSessionEvent(session, event)));
  } catch (err) { log('cannot listen session/event', String((err && err.message) || err)); }

  try {
    disposers.push(ctx.on('subagent/start', (info) => {
      try {
        const s = sess(null);
        const agent = String((info && (info.provider || info.runId || info.id)) || 'subagent');
        post(evt(s, { hook_event_name: 'SubagentStart', agent }));
      } catch { /* 忽略 */ }
    }));
    disposers.push(ctx.on('subagent/end', (info) => {
      try {
        const s = sess(null);
        const agent = String((info && (info.provider || info.runId || info.id)) || 'subagent');
        post(evt(s, { hook_event_name: 'SubagentStop', agent }));
      } catch { /* 忽略 */ }
    }));
  } catch (err) { log('cannot listen subagent', String((err && err.message) || err)); }

  const dispose = () => {
    for (const off of disposers.splice(0).reverse()) {
      try { off(); } catch { /* 继续归还 */ }
    }
    sessions.clear();
  };
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
  } catch { /* 忽略 */ }
  return dispose;
}

export default { name, apply };
