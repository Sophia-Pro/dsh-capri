'use strict';

// 让摩羯「看见」DSH 在干什么，而不用重启 DSH、也不用等插件加载。
//
// DSH 每个会话都会把折叠后的投影实时写到 ~/.dsh/storages/session_projcache/sessions/*.json
// （纯 JSON，秒级刷新），里面已经有：会话标题、当前轮、每一轮的提问与回答、步数、token、
// 目标（goal）、待回答问题。这里轮询最新那个文件，把变化翻译成摩羯认识的 hook 事件。
//
// 为什么不用 session.v4.jsonl.zstd：那是 zstd 压缩的事件流，Electron 31 的 Node 20 没有
// zstd 解压，而投影缓存已经够了。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DIR = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const EVERY = 900;

function newestFile() {
  let best = null;
  let bestMs = 0;
  let names = [];
  try {
    names = fs.readdirSync(DIR);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs > bestMs) {
        bestMs = st.mtimeMs;
        best = full;
      }
    } catch { /* 文件被换掉了，跳过 */ }
  }
  return best ? { file: best, mtimeMs: bestMs } : null;
}

function readRows(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  const rows = doc && doc.record && doc.record.rows;
  if (!rows || typeof rows !== 'object') return null;
  const val = (k) => (rows[k] && rows[k].val !== undefined ? rows[k].val : null);
  return {
    identity: (doc.record.identity) || {},
    title: (val('title') || '').toString(),
    cwd: (val('workingDirectory') || '').toString(),
    outline: val('turnOutline') || { turns: [] },
    boundary: val('turnBoundary') || {},
    stats: val('sessionStats') || {},
    tokens: val('tokenUsage') || {},
    questions: val('userQuestions') || {},
    goal: val('goal') || {},
    context: val('contextPressure') || {},
  };
}

function fmtMinutes(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
}

function startDshWatch({ onEvent, every = EVERY } = {}) {
  let stopped = false;
  let timer = null;
  const state = {
    file: null,
    mtimeMs: 0,
    sessionId: '',
    seenTurns: 0,
    seenSteps: 0,
    startedAt: 0,
    lastNoteAt: 0,
    hadStop: -1,
    questions: '',
  };

  const emit = (evt) => {
    try {
      onEvent(evt);
    } catch { /* 渲染层没准备好就算了 */ }
  };

  function tick() {
    if (stopped) return;
    timer = setTimeout(tick, every);
    const fresh = newestFile();
    if (!fresh) return;
    if (fresh.file === state.file && fresh.mtimeMs === state.mtimeMs) return;
    state.file = fresh.file;
    state.mtimeMs = fresh.mtimeMs;

    let rows;
    try {
      rows = readRows(fresh.file);
    } catch {
      return; // 正在写，下一次再读
    }
    if (!rows) return;

    const id = path.basename(fresh.file, '.json');
    if (id !== state.sessionId) {
      state.sessionId = id;
      state.seenTurns = 0;
      state.seenSteps = 0;
      state.hadStop = -1;
      emit({
        hook_event_name: 'SessionStart',
        session_id: id,
        cwd: rows.cwd,
        session_title: rows.title,
        source: 'startup',
      });
    } else if (rows.title && rows.title !== state.title) {
      state.title = rows.title;
    }
    state.title = rows.title;

    const turns = Array.isArray(rows.outline.turns) ? rows.outline.turns : [];
    const last = turns[turns.length - 1] || null;
    const steps = Number(rows.stats.steps) || 0;

    // 新的一轮：把这一轮的提问交给她（她会说"新单子"并跑到窗口上）
    if (last && state.seenTurns && last.turn > state.seenTurns) {
      state.seenTurns = last.turn;
      state.seenSteps = steps;
      state.startedAt = Date.now();
      state.hadStop = -1;
      emit({
        hook_event_name: 'UserPromptSubmit',
        session_id: id,
        cwd: rows.cwd,
        session_title: rows.title,
        prompt: String(last.prompt || '').slice(0, 220),
      });
      return;
    }
    if (!state.seenTurns && last) {
      state.seenTurns = last.turn;
      state.seenSteps = steps;
      state.startedAt = Date.now();
      return;
    }
    if (!last) return;

    // 上一个还没回答完：进度 + 阶段用便签说，不假装有工具调用
    if (steps > state.seenSteps + 12) {
      state.seenSteps = steps;
      const now = Date.now();
      if (now - state.lastNoteAt > 45000) {
        state.lastNoteAt = now;
        const phase = rows.questions && rows.questions.questions && (rows.questions.questions.active || []).length
          ? '等你回话'
          : (rows.boundary && rows.boundary.lastStepBoundary && rows.boundary.lastStepBoundary.kind === 'end' ? '收尾' : '干活中');
        emit({
          hook_event_name: 'Note',
          session_id: id,
          cwd: rows.cwd,
          session_title: rows.title,
          note_kind: 'info',
          text: `第 ${last.turn} 轮 · ${steps} 步 · ${phase}`,
        });
      }
    }

    // 等用户回话/批准
    const active = (rows.questions && rows.questions.questions && rows.questions.questions.active) || [];
    const qSig = active.map((q) => q && (q.id || q.question || '')).join('|');
    if (qSig && qSig !== state.questions) {
      state.questions = qSig;
      emit({
        hook_event_name: 'Notification',
        session_id: id,
        cwd: rows.cwd,
        session_title: rows.title,
        notification_type: 'permission_prompt',
        message: 'DSH 在等你',
      });
    } else if (!qSig) {
      state.questions = '';
    }

    // 这一轮的回答写好了 = 这一轮结束：把整段回答端给她
    const response = String(last.response || '');
    if (response && state.hadStop !== last.turn) {
      state.hadStop = last.turn;
      emit({
        hook_event_name: 'Stop',
        session_id: id,
        cwd: rows.cwd,
        session_title: rows.title,
        last_assistant_message: response.slice(0, 4000),
      });
      // 顺手报一句 token 用量（代替读不到的余额）
      const totals = rows.tokens.totals || {};
      const used = (Number(totals.uncachedInputTokens) || 0) + (Number(totals.cacheReadTokens) || 0) + (Number(totals.outputTokens) || 0);
      if (used > 0) {
        const k = used >= 1e6 ? `${(used / 1e6).toFixed(2)}M` : `${(used / 1000).toFixed(1)}k`;
        emit({
          hook_event_name: 'Note',
          session_id: id,
          cwd: rows.cwd,
          session_title: rows.title,
          note_kind: 'info',
          text: `这单跑完 · 会话累计 ${k} token`,
        });
      }
    }
  }

  tick();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// 给「问摩羯」输入框用：读当前最新会话的轮次（提问题 + 回答）
function latestTurns() {
  const fresh = newestFile();
  if (!fresh) return [];
  try {
    const rows = readRows(fresh.file);
    const turns = rows && rows.outline && rows.outline.turns;
    return Array.isArray(turns) ? turns : [];
  } catch {
    return [];
  }
}

module.exports = { startDshWatch, latestTurns };
