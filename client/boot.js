/*
 * 摩羯 · DSH 挂件 —— 页面侧入口（由宿主插件注入到 DSH 的网页里）
 *
 * 她以前住在一个 Electron 透明窗里；现在住进 DSH 自己的页面：
 *   - 造一层覆盖全屏的根节点（#capri-root），页面照样能点，只有她自己的框接管指针
 *   - 把 window.host（原来是 Electron preload 桥）换成走 HTTP/SSE 的适配层
 *   - 右键她出来的菜单：安静模式、空闲收起、全部演一遍、音效、重播开场、收起来
 *   - 电脑（其实是 DSH 页面）五分钟没操作，她自己收进角落的小芯片，一动就出来
 */
(function () {
  if (window.__capriBooted) return;
  window.__capriBooted = true;

  const BASE = '/capri';
  const log = (...a) => { try { console.log('%c[capri]', 'color:#f6f', ...a) } catch {} };

  // ---------- 小工具 ----------
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'html') n.innerHTML = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    }
    for (const kid of kids) if (kid) n.appendChild(kid);
    return n;
  };
  const j = async (url, opts) => {
    const r = await fetch(BASE + url, { cache: 'no-store', ...(opts || {}) });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.status === 204 ? null : r.json();
  };

  // ---------- 布局 ----------
  const PANEL_HTML = `
    <aside id="panel" class="panel" data-kind="info" hidden role="dialog" aria-labelledby="panel-who" aria-live="polite">
      <div class="panel__frame">
        <div class="panel__plate">
          <figure class="panel__face" aria-hidden="true"><img src="/capri/assets/capri/capri-face.png" alt=""></figure>
          <div class="panel__body">
            <header class="panel__meta">
              <span id="panel-who" class="panel__who">摩羯</span>
              <span class="panel__tag"></span>
              <span class="panel__state"></span>
            </header>
            <p class="panel__line"></p>
            <p class="panel__quote" hidden></p>
            <div class="panel__reply" hidden></div>
            <p class="panel__summary" hidden></p>
            <ol class="panel__log" hidden></ol>
            <div class="panel__actions"></div>
            <p class="panel__hint" aria-hidden="true"></p>
          </div>
        </div>
        <div class="panel__tail" aria-hidden="true"></div>
      </div>
    </aside>
    <div id="ticker" class="ticker" hidden>
      <div class="ticker__plate">
        <span class="ticker__dot" aria-hidden="true"></span>
        <span class="ticker__verb"></span>
        <span class="ticker__target"></span>
      </div>
    </div>`;

  const STYLE = `
    #capri-menu{position:fixed;z-index:2147483000;min-width:190px;padding:6px;background:#0b0714;
      border:2px solid #ff2e88;box-shadow:6px 6px 0 rgba(122,60,255,.55);color:#f2e9ff;
      font:600 13px/1.35 'Chakra Petch','PingFang SC',system-ui,sans-serif;letter-spacing:.02em}
    #capri-menu button{display:flex;justify-content:space-between;gap:12px;width:100%;padding:5px 8px;
      background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
    #capri-menu button:hover{background:#ff2e88;color:#0b0714}
    #capri-menu .k{opacity:.75;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px}
    #capri-menu hr{margin:4px 6px;border:0;border-top:1px solid rgba(255,46,136,.35)}`;

  // ---------- 运行时状态 ----------
  const state = {
    config: null,
    events: null,     // EventSource
    onClaude: null,
    onConfig: null,
    onCommand: null,
    quiet: false,
    idleMin: 5,
    lastInput: Date.now(),
    stowedForIdle: false,
    menu: null,
    capri: null,
  };

  // ---------- host：原来 Electron 主进程那一套，现在全走本地 HTTP ----------
  const host = {
    async getConfig() { return state.config },
    async setConfig(patch) {
      state.config = Object.assign({}, state.config, patch);
      applyConfig(state.config);
      try { await j('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }) } catch (e) { log('setConfig failed', e) }
    },
    async listSounds() { return [] },
    async hooksStatus() { return { installed: true } },
    async demoWindow() { return false },
    async windowsNow() { return { fg: -1, wins: [] } },
    async claudeFound() { return true },
    async installHooks() { return { ok: true } },
    async openClaudeFolder() {},
    async openClaudeHelp() {},
    async trayPlace() {},
    async cursor() { return { inside: false } },
    setInteractive() { /* 页面里不需要整窗穿透开关 */ },
    onResize() { /* 我们自己听 window.resize */ },
    onWindows(cb) { state.onWindows = cb },
    onClaudeEvent(cb) { state.onClaude = cb },
    onConfig(cb) { state.onConfig = cb },
    onCommand(cb) { state.onCommand = cb },
    openMenu() { showMenu() },
  };

  // ---------- 菜单 ----------
  function hideMenu() {
    if (state.menu) { state.menu.remove(); state.menu = null }
  }
  function command(name, extra) {
    hideMenu();
    state.onCommand && state.onCommand(Object.assign({ name }, extra || {}));
  }
  function showMenu(at) {
    hideMenu();
    const x = at ? at.x : innerWidth - 220;
    const y = at ? at.y : innerHeight - 200;
    const m = el('div', { id: 'capri-menu' });
    const item = (label, key, fn) => {
      const b = el('button', { type: 'button' });
      b.append(el('span', { text: label }), el('span', { class: 'k', text: key || '' }));
      b.addEventListener('click', (e) => { e.stopPropagation(); fn() });
      m.appendChild(b);
    };
    item(state.quiet ? '放开她（乱动）' : '安静模式（不乱动）', state.quiet ? 'OFF' : 'ON', () => {
      toggleQuiet(!state.quiet);
      hideMenu();
    });
    item('站左边', globalThis.__capriSide === 'left' ? 'ON' : '', () => {
      setConfig({ side: 'left' });
      state.capri && state.capri.teleport(state.capri.spot('post'));
      hideMenu();
    });
    item('站右边', globalThis.__capriSide === 'left' ? '' : 'ON', () => {
      setConfig({ side: 'right' });
      state.capri && state.capri.teleport(state.capri.spot('post'));
      hideMenu();
    });
    item('空闲收起', state.idleMin ? state.idleMin + ' 分钟' : '关', () => {
      const next = state.idleMin === 5 ? 10 : state.idleMin === 10 ? 0 : 5;
      setConfig({ idleMin: next });
      hideMenu();
    });
    m.appendChild(el('hr'));
    item('全部演一遍', '', () => command('showAll'));
    item('重播开场', '', () => command('replayIntro'));
    item('音效试听', '', () => command('soundTour'));
    m.appendChild(el('hr'));
    item('收起来', '', () => command('stow', { on: true }));
    item('叫她出来', '', () => command('stow', { on: false }));
    m.style.visibility = 'hidden';
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    m.style.visibility = '';
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    state.menu = m;
    setTimeout(() => document.addEventListener('pointerdown', onOutside, { capture: true, once: true }), 0);
  }
  function onOutside(e) {
    if (state.menu && !state.menu.contains(e.target)) hideMenu();
  }

  // ---------- 配置 ----------
  function applyConfig(cfg) {
    if (!cfg) return;
    if (typeof cfg.quiet === 'boolean') state.quiet = cfg.quiet;
    if (typeof cfg.idleMin === 'number') state.idleMin = cfg.idleMin;
    const capri = state.capri;
    if (cfg.side === 'left' || cfg.side === 'right') globalThis.__capriSide = cfg.side;
    if (capri) {
      capri.side = globalThis.__capriSide || 'right';
      capri.wander = stage_quiet() ? false : cfg.wander !== false;
      capri.possessWindows = stage_quiet() ? false : cfg.possess !== false;
      if (cfg.scale && cfg.scale !== capri.scale) capri.setScale(cfg.scale);
    }
  }
  const stage_quiet = () => state.quiet;
  function setConfig(patch) {
    state.config = Object.assign({}, state.config, patch);
    applyConfig(state.config);
    j('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch((e) => log('config save failed', e));
  }
  function toggleQuiet(on) {
    state.quiet = typeof on === 'boolean' ? on : !state.quiet;
    setQuiet(state.quiet);
    setConfig({ quiet: state.quiet });
  }
  // 安静模式：不自己走、不看卫星、不附身、不随机演出；点她、DSH 有活要报的时候照样说话
  function setQuiet(on) {
    const capri = state.capri;
    if (!capri) return;
    capri.wander = !on;
    capri.possessWindows = !on;
    if (on) {
      capri.nextMove = Infinity;
      capri.nextGaze = Infinity;
      // 正在演的循环动作收掉
      if (capri.act && typeof capri.endAct === 'function') capri.endAct(true);
    } else {
      const now = performance.now();
      capri.nextMove = now + 25000;
      capri.nextGaze = now + 40000;
    }
    if (!capri.__quietHooked) {
      capri.__quietHooked = true;
      const inner = capri.perform.bind(capri);
      capri.perform = function (name, dir) {
        if (state.quiet) return Promise.resolve();
        return inner(name, dir);
      };
    }
  }

  // ---------- 空闲收起 ----------
  function noteInput() {
    state.lastInput = Date.now();
    if (state.stowedForIdle && state.capri) {
      state.stowedForIdle = false;
      state.capri.unstow && state.capri.unstow();
    }
  }
  function watchIdle() {
    setInterval(() => {
      const capri = state.capri;
      if (!capri || !state.idleMin) return;
      const idle = Date.now() - state.lastInput;
      if (idle > state.idleMin * 60000 && !state.stowedForIdle && !capri.stowed) {
        state.stowedForIdle = true;
        try { capri.stow() } catch (e) { log('stow failed', e) }
      }
    }, 15000);
  }

  // ---------- 事件流 ----------
  function connectEvents() {
    if (state.events) try { state.events.close() } catch {}
    const es = new EventSource(BASE + '/events');
    state.events = es;
    es.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data) } catch { return }
      if (!msg) return;
      if (msg.type === 'claude') state.onClaude && state.onClaude(msg.evt);
      else if (msg.type === 'config') { state.config = Object.assign({}, state.config, msg.cfg); state.onConfig && state.onConfig(state.config); applyConfig(state.config) }
      else if (msg.type === 'command') state.onCommand && state.onCommand(msg.cmd);
    };
    es.onerror = () => { /* EventSource 自己会重连 */ };
  }

  // ---------- 起 ----------
  async function boot() {
    let cfg = {};
    try { cfg = await j('/config') } catch (e) { log('config load failed', e) }
    state.config = cfg || {};
    state.quiet = Boolean(cfg.quiet);
    state.idleMin = typeof cfg.idleMin === 'number' ? cfg.idleMin : 5;

    document.head.appendChild(el('style', { text: STYLE }));
    const link = el('link', { rel: 'stylesheet', href: BASE + '/client/capri.css' });
    document.head.appendChild(link);

    const root = el('div', { id: 'capri-root' });
    root.innerHTML =
      '<div id="capri" class="capri"><canvas id="sprite" class="capri__sprite" aria-label="摩羯"></canvas></div>' +
      '<canvas id="fx" class="fx" aria-hidden="true"></canvas>' +
      '<canvas id="fx2" class="fx" aria-hidden="true"></canvas>' +
      '<canvas id="chip" class="chip" hidden aria-hidden="true"></canvas>' +
      '<canvas id="mask" class="chip" hidden aria-hidden="true"></canvas>' +
      PANEL_HTML;
    document.body.appendChild(root);

    window.host = host;
    connectEvents();

    // 页面上的操作都算"她在被关注"
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      window.addEventListener(ev, noteInput, { passive: true, capture: true });
    }
    window.addEventListener('resize', () => hideMenu());

    // 页面的右键：在她身上才是她的菜单
    window.addEventListener('contextmenu', (e) => {
      const capri = state.capri;
      if (!capri) return;
      if (capri.hit && capri.hit(e.clientX, e.clientY)) {
        e.preventDefault();
        e.stopPropagation();
        showMenu({ x: e.clientX, y: e.clientY });
      }
    }, true);

    // 透明的画布不该吃掉页面的点击：指针压到她身上才把这一层变成可点
    const capriEl = root.querySelector('#capri');
    let hot = false;
    const refreshHot = (x, y) => {
      const capri = state.capri;
      if (!capri) return;
      const next = Boolean(capri.dragging || (typeof capri.hit === 'function' && capri.hit(x, y)));
      if (next === hot) return;
      hot = next;
      capriEl.classList.toggle('is-hot', hot);
    };
    window.addEventListener('mousemove', (e) => refreshHot(e.clientX, e.clientY), { passive: true, capture: true });
    setInterval(() => {
      const capri = state.capri;
      if (!capri) return;
      if (capri.dragging && !hot) { hot = true; capriEl.classList.add('is-hot') }
    }, 200);

    // 她自己的右键（canvas 上）也走同一套
    root.querySelector('#sprite').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu({ x: e.clientX, y: e.clientY });
    }, true);

    await import(BASE + '/client/app.js');

    // app.js 是异步起的，等她上岗
    const waitCapri = setInterval(() => {
      const capri = window.__capri;
      if (!capri) return;
      clearInterval(waitCapri);
      state.capri = capri;
      applyConfig(state.config);
      setQuiet(state.quiet);
      watchIdle();
      window.__capriControl = {
        quiet: (on) => toggleQuiet(on),
        idleMin: (m) => setConfig({ idleMin: m }),
        menu: () => showMenu(),
        state,
      };
      log('ready');
    }, 120);
  }

  boot().catch((e) => log('boot failed', e));
})();
