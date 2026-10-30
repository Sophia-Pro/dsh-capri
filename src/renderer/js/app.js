import { Capri } from './capri.js';
import { FxLayer, GRAB_FRAMES } from './fx.js';
import { FxLayer as FxLayerClassic } from './fx-classic.js';
import { Chip, Mask } from './chip.js';
import { Panel } from './panel.js';
import { Voice, CUES, CUE_LABELS } from './voice.js';
import { Brain } from './brain.js';
import { Guide } from './guide.js';
import { Settings } from './settings.js';
import { Card } from './card.js';
import { LINES } from './lines.js';
import { ACTS } from './acting.js';
import { pick, fmt, tween, ease } from './util.js';

const host = window.host;
let settings = null;   // 右键菜单与设置面板（后面装）
let balanceCard = null; // 余额卡（后面装）
let cfgNow = {};       // 当前设置的一份快照

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// close-ups of her for the cut-ins, frames of the show (tools/build-cutins.py)
const CUTINS = ['grin', 'laugh', 'eyes', 'many', 'look'];

async function boot() {
  const [config, image, intro, classicStrip, ...cutins] = await Promise.all([
    host.getConfig(),
    loadImage('../../assets/capri/capri-full.png'),
    // 她的开场：那张"抓住屏幕边缘"的近距离大图，加上嘴/手/残影的几张画（工具逐帧切出来的）
    Promise.all(GRAB_FRAMES.map((name) => loadImage(`../../assets/capri/intro-${name}.webp`).catch(() => null)))
      .then((cels) => cels[0] ? Object.fromEntries(GRAB_FRAMES.map((name, i) => [name, cels[i]])) : null),
    loadImage('../../assets/capri/intro-face.webp').catch(() => null), // 经典开场那条帧带
    ...CUTINS.map((name) => loadImage(`../../assets/capri/cutin-${name}.png`)),
    document.fonts.load('600 16px "Chakra Petch"'),
    document.fonts.load('400 11px "JetBrains Mono"'),
  ]);
  document.documentElement.lang = config.lang;

  const fx = new FxLayer(document.getElementById('fx'), {
    cutins: Object.fromEntries(CUTINS.map((name, i) => [name, cutins[i]])),
    intro,
  });
  fx.resize(innerWidth, innerHeight);
  const classicFx = new FxLayerClassic(document.getElementById('fx2'), { intro: classicStrip });
  classicFx.resize(innerWidth, innerHeight);
  const chip = new Chip(document.getElementById('chip'));
  chip.place(innerWidth, innerHeight);
  const mask = new Mask(document.getElementById('mask'));

  const voice = new Voice();
  voice.configure(config);
  host.listSounds().then((list) => list.length && voice.loadCustom(list));

  const panel = new Panel({
    panel: document.getElementById('panel'),
    ticker: document.getElementById('ticker'),
    labels: LINES.zh,
  });

  const capri = new Capri({
    root: document.getElementById('capri'),
    canvas: document.getElementById('sprite'),
    image,
    fx,
    voice,
  });
  capri.wander = config.wander;
  capri.possessWindows = config.possess;
  capri.setScale(config.scale);

  const brain = new Brain({ capri, panel, voice, host, lang: config.lang });

  // Click-through everywhere except on her body, the panel and her biochip.
  let interactive = false;
  let mouse = null;
  // --dev 调试：看鼠标命中/可点状态
  Object.defineProperty(window, '__dbg', { value: { get interactive() { return interactive; }, get mouse() { return mouse; } } });
  const setInteractive = (on) => {
    if (on === interactive) return;
    interactive = on;
    host.setInteractive(on);
  };
  const onChip = () => Boolean(chip.visible && mouse && chip.contains(mouse.x, mouse.y, 0));
  const refreshHit = () => {
    if (capri.dragging) return setInteractive(true);
    // 菜单或设置开着：整层都要接鼠标，不然点不动
    if (settings && settings.isOpen()) return setInteractive(true);
    if (balanceCard && balanceCard.visible) return setInteractive(true);
    if (!mouse) return setInteractive(false);
    const r = panel.rect();
    const onPanel = r && mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom;
    const onSettings = Boolean(settings && settings.contains(mouse.x, mouse.y));
    const onCard = Boolean(balanceCard && balanceCard.visible && balanceCard.contains(mouse.x, mouse.y));
    document.body.style.cursor = onChip() || onSettings ? 'pointer' : '';
    return setInteractive(Boolean(onPanel || onSettings || onCard || capri.hit(mouse.x, mouse.y) || onChip()));
  };
  // Her biochip: her eyes on it follow the pointer over it, and she comes out when you click it
  // (only then, so the pointer passing through that corner doesn't call her back).
  // Her mask, asleep: the pointer coming over it stirs her, and a moment of that wakes her up.
  let wakeTimer = 0;
  const comeOut = () => {
    if (capri.stowed) host.setConfig({ visible: true }); // the tray and Ctrl+Alt+C follow
    capri.unstow();
  };
  const hoverChip = () => {
    chip.pointer = chip.visible && mouse && chip.contains(mouse.x, mouse.y) ? mouse : null;
    const near = mask.visible && mouse && mask.contains(mouse.x, mouse.y, 30);
    mask.pointer = near ? mouse : null;
    if (!near) {
      clearTimeout(wakeTimer);
      wakeTimer = 0;
    } else if (!wakeTimer) {
      wakeTimer = setTimeout(() => {
        wakeTimer = 0;
        if (capri.dormant) capri.wake();
      }, 400);
    }
  };
  window.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    refreshHit();
    hoverChip();
  });
  // macOS：透明窗靠 setIgnoreMouseEvents(true, {forward:true}) 转发鼠标移动，
  // 指针刚压到她身上那一两帧可能还没转到"可点"状态，点下去就漏到下面的窗口了。
  // 这里再用主进程的 cursor 轮询兜一层：位置对得上就直接切成可点。
  setInterval(async () => {
    try {
      const p = await host.cursor();
      if (!p || !p.inside) return;
      if (!mouse || Math.abs(mouse.x - p.x) > 1 || Math.abs(mouse.y - p.y) > 1) {
        mouse = { x: p.x, y: p.y };
        refreshHit();
        hoverChip();
      }
    } catch { /* 主进程还没就绪 */ }
  }, 60);
  document.addEventListener('mouseleave', () => {
    mouse = null;
    refreshHit();
    hoverChip();
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (chip.visible && chip.contains(e.clientX, e.clientY, 0)) host.openMenu();
  });
  window.addEventListener('click', (e) => {
    if (chip.visible && chip.contains(e.clientX, e.clientY, 0)) comeOut();
  });

  // wiring
  capri.onMove = (head) => {
    // pointing at something: the panel goes on her other side, so it doesn't cover it
    panel.setAnchor({ ...head, lean: capri.pointing ? -capri.pointing.dir : 0 }, capri.view);
    // she may have moved out from under a still pointer: never leave a dead click zone behind
    refreshHit();
  };
  capri.onTeleport = (phase) => (phase === 'start' ? panel.suspend() : panel.resume());
  capri.chipAt = () => chip.center();
  capri.onStow = () => {
    chip.setMode(capri.mode);
    chip.show();
  };
  capri.onUnstow = () => chip.hide();
  capri.onDoze = (phase, face) => {
    if (phase === 'start') {
      mask.place(face.x, face.y, capri.scale * 1.1);
      mask.show();
    } else if (phase === 'waking') {
      mask.wake();
    } else {
      mask.hide();
    }
  };
  capri.onMode = (mode, prev) => chip.setMode(mode, prev);
  // now and then she says something about the satellite: while she looks at it, or once
  // the red light has gone up (never during, nothing should cover that)
  capri.onGaze = (when) => {
    const lines = when === 'end' ? brain.t.uplink : brain.t.gaze;
    if (!panel.visible && Math.random() < (when === 'end' ? 0.6 : 0.4)) panel.say({ kind: 'info', line: pick(lines), hold: 3800 });
  };
  // 双击：随机来一段（不打开面板）
  // 双击能演什么：所有"一次性"动作都算上（循环动作 perform 不会结束，会卡住）
  // 双击 = 来一段"看得见"的演出（细碎的小动作太短，容易被当成没反应）
  const STANCES = ['stand', 'sit', 'peek', 'sleep', 'fall']; // 姿态不是动作，别当表演抽
  const ACT_NAMES = Object.keys(ACTS).filter((n) => !STANCES.includes(n));
  // 双击：所有动画里随机来一段（循环动作会在 1.5 秒后自动收）
  const SHOWCASES = [...ACT_NAMES, 'possess', 'screenPossess', 'split', 'satellite', 'teleport', 'classic', 'entrance', 'grab'];
  // 加权随机：没出来过的权重最高，越久没出来的权重越高，刚看过的往后排
  const lastPlayed = new Map();
  function pickShowcase() {
    const now = performance.now();
    const weights = SHOWCASES.map((name) => {
      const at = lastPlayed.get(name);
      if (!at) return 10;                         // 从没演过
      const mins = (now - at) / 60000;
      return Math.min(10, 0.6 + mins * 1.6);      // 越久没演越容易被抽到
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < SHOWCASES.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        lastPlayed.set(SHOWCASES[i], now);
        return SHOWCASES[i];
      }
    }
    const last = SHOWCASES[SHOWCASES.length - 1];
    lastPlayed.set(last, now);
    return last;
  }
  // 入场动画：三选一，演完接开场白（托盘「重播入场」也用它）
  let entranceRunning = false;
  // 第三套开场：经典「hi」——画像带速度线砸出来、红标签、然后像截图里那样叠着缩小收走
  async function playClassicIntro(spot) {
    const head = capri.head();
    await classicFx.intro({
      to: { x: head.x, y: head.y, size: 165 * capri.scale },
      label: brain.t.intro.hi,
      caption: brain.t.intro.caption,
      still: false,
      onCue: (cue) => {
        // 经典开场的提示点：屏幕裂开 / 画像撕开 / 喊"嗨" / 收进站位
        if (cue === 'open') { voice.play('charge'); voice.play('glitch'); }
        else if (cue === 'tear') voice.play('teleport-in');
        else if (cue === 'hi') voice.play('hello');
        else if (cue === 'dive') voice.play('zip');
      },
    });
  }

  // 看卫星的整段（托盘「看卫星」和双击随机都用它）
  async function watchSatellite() {
    if (capri.stowed) {
      host.setConfig({ visible: true });
      await capri.unstow();
    }
    capri.wake();
    if (capri.stance === 'peek') await capri.unpeek();
    if (!capri.gaze({ big: true })) setTimeout(() => capri.gaze({ big: true }), 1500);
  }

  async function playEntrance(force) {
    if (entranceRunning) return;
    entranceRunning = true;
    const spot = capri.spot('post');
    try {
      const opening = pick([
        async () => { // 从天上掉下来：先出现在屏幕上方，再落到站位，砸一下、蹲着缓过来
          capri.teleport({ x: spot.x, y: spot.y - capri.view.h * 0.32 });
          await new Promise((r) => setTimeout(r, 90));
          capri.teleport(spot);
          await capri.perform('touchdown');
          await capri.perform('crouch');
        },
        async () => { // 从右边摸出来，甩一圈再站定
          capri.teleport({ x: capri.view.w + 40, y: spot.y });
          await new Promise((r) => setTimeout(r, 70));
          capri.teleport(spot);
          await capri.perform('spin');
          await capri.perform('hop');
        },
        async () => { // 碎块重组落地，回头
          capri.teleport({ x: spot.x, y: spot.y - capri.view.h * 0.22 });
          capri.p.glitch = 0.4;
          capri.p.split = 3;
          capri.p.glitchSeed = Math.random() * 100;
          await new Promise((r) => setTimeout(r, 80));
          capri.teleport(spot);
          await capri.perform('land');
          capri.p.glitch = 0;
          capri.p.split = 0;
          await capri.perform('turn');
        },
      ]);
      // 三套开场随机：大近景 / 小动作入场 / 右上角大头照
      const pickKind = force || pick(['grab', 'entrance', 'classic']);
      if (pickKind === 'classic') {
        // 大头照播的时候她本人得藏起来，不然会提前出现在站位上（旧版 intro 就是这么做的）
        capri.pos = { ...spot };
        capri.p.alpha = 0;
        capri.p.collapse = 1;
        capri.p.dissolve = 0.5;
        capri.busy = true;
        capri.place();
        await playClassicIntro(spot);
        // 收回来的那一下别硬切：把 alpha/collapse 补间回去，同时给一声落地
        voice.play('land');
        await tween(capri.p, { alpha: 1, collapse: 0, dissolve: 0 }, 280, ease.out);
        capri.busy = false;
        capri.place();
      } else if (pickKind === 'grab') {
        await capri.intro(spot, { label: brain.t.intro.hi, caption: brain.t.intro.caption });
      } else {
        await opening();
      }
      // 不管哪套，落定之后都要把"现在手上是什么活"说出来
      brain.status();
    } finally {
      entranceRunning = false;
    }
  }

  // 托盘「全部演一遍」：所有动作按固定顺序来一遍（看得全，不随机）
  let showingAll = false;
  async function showAll() {
    if (showingAll) return;
    showingAll = true;
    try {
      const order = ACT_NAMES.filter((n) => n !== 'talk');
      for (const name of order) {
        if (ACTS[name]?.loop) {
          capri.perform(name);
          await new Promise((r) => setTimeout(r, 1300));
          capri.endAct?.(true);
        } else {
          await capri.perform(name);
        }
        await new Promise((r) => setTimeout(r, 180));
      }
      await playEntrance('classic');
      await playEntrance('grab');
      for (const special of ['possess', 'screenPossess', 'satellite', 'split']) {
        if (special === 'possess') {
          if (!capri.canPossess()) {
            const seat = capri.pickSeat();
            if (seat) await capri.sitOn(seat);
          }
          if (capri.canPossess()) await capri.possess();
        } else if (special === 'screenPossess') await capri.screenPossess();
        else if (special === 'satellite') await watchSatellite();
        else { capri.p.glitch = 0.4; capri.p.split = 3; capri.teleport(capri.spot('random')); await new Promise((r) => setTimeout(r, 500)); capri.p.glitch = 0; capri.p.split = 0; }
        await new Promise((r) => setTimeout(r, 600));
      }
    } finally {
      showingAll = false;
    }
  }

  // --dev 调试：单独触发某套开场/动作
  window.__dbgPlay = { classic: () => playClassicIntro(capri.spot('post')), entrance: () => playEntrance(), sat: () => watchSatellite() };

  capri.onDoubleClick = () => {
    if (capri.busy) return;
    voice.play('tap');
    const act = pickShowcase();
    switch (act) {
      case 'screenPossess': return void capri.screenPossess();
      case 'satellite': return void watchSatellite();
      case 'classic': return void playEntrance('classic');
      case 'grab': return void playEntrance('grab');
      case 'entrance': return void playEntrance('entrance');
      case 'teleport': return void capri.teleport(capri.spot('random'));
      case 'split': {
        capri.p.glitch = 0.4;
        capri.p.split = 3;
        capri.teleport(capri.spot('random'));
        setTimeout(() => { capri.p.glitch = 0; capri.p.split = 0; }, 600);
        return;
      }
      case 'possess': {
        if (capri.canPossess()) return void capri.possess();
        const seat = capri.pickSeat();
        if (!seat) return;
        capri.sitOn(seat).then(() => setTimeout(() => { if (capri.canPossess()) capri.possess(); }, 450));
        return;
      }
      default:
        capri.perform(act);
        if (ACTS[act]?.loop) setTimeout(() => capri.endAct?.(true), 1500);
    }
  };

  capri.onClick = () => {
    if (panel.visible) panel.hide();
    else brain.clickTalk();
  };
  panel.onChar = (kind) => voice.play('blip', { mood: kind });
  panel.onTalk = (talking) => talking && capri.perform('talk');
  capri.onMenu = () => settings?.openMenu();

  // Her guide (guide.js): her welcome on first launch, and "How does it work?" in her menu,
  // where she takes you to things and points at them.
  const guide = new Guide({ capri, panel, voice, host, brain });
  // the first Claude Code event that ever reaches her: so you know it worked
  // ---------- 右键菜单 / 设置面板 ----------
  balanceCard = new Card({ capri, onRefresh: () => showBalance() });
  const showBalance = async () => {
    panel.hide();
    balanceCard.show({ pending: true });
    const d = await host.balance(true);
    if (!d || !d.ok) {
      balanceCard.hide();
      panel.say({ kind: 'error', tag: '余额', line: '余额暂时取不到', summary: (d && d.error) || '桥没开：先在 DSH 里启用 dsh-capri 插件', hold: 9000, force: true });
      return;
    }
    balanceCard.show(d);
  };

  settings = new Settings({
    host,
    capri,
    panel,
    voice,
    commands: {
      showAll: () => showAll(),
      replayIntro: () => playEntrance(),
      heldOnce: () => { capri.perform('held'); setTimeout(() => capri.endAct?.(true), 2600); },
      possessOnce: async () => {
        if (!capri.canPossess()) {
          const seat = capri.pickSeat();
          if (seat) await capri.sitOn(seat);
        }
        if (capri.canPossess()) capri.possess();
        else panel.say({ kind: 'info', line: '这会儿没窗口可占，宿主。', hold: 3500 });
      },
      screenPossess: () => capri.screenPossess(),
      satellite: () => watchSatellite(),
      soundTour: async () => {
        const { CUES, CUE_LABELS } = await import('./voice.js');
        for (const cue of CUES) {
          panel.say({ kind: 'info', line: `音效 · ${CUE_LABELS[cue] || cue}`, hold: 900 });
          voice.play(cue);
          await new Promise((r) => setTimeout(r, 950));
        }
      },
      balance: () => showBalance(),
      stow: () => capri.stow(),
      unstow: () => capri.unstow(),
    },
  });
  settings.onOpenChange = (open) => { setInteractive(Boolean(open)); if (!open) refreshHit(); };
  window.__settings = settings;
  window.__showBalance = showBalance;
  settings.cfg = cfgNow = config;
  settings.apply();

  // 气泡里常驻「查看余额」；面板原来的按钮（引导）不动
  const sayBase = panel.say.bind(panel);
  panel.say = (msg = {}) => {
    // 她在演动作/附身的时候别盖普通气泡；但"要你点头 / 干完了 / 出错"必须说
    const important = msg.kind === 'alert' || msg.kind === 'done' || msg.kind === 'error';
    if (!msg.force && !important && (capri.busy || capri.act || capri.possessed)) return null;
    panel._force = Boolean(msg.force) || important;
    const actions = (msg.actions || []).filter((a) => a.id !== 'balance');
    const isBalance = msg.tag === '余额';
    if (!isBalance && cfgNow.balance !== false) actions.push({ id: 'balance', label: '查看余额' });
    return sayBase({ ...msg, actions });
  };

  // 气泡只做「演出中不新弹」的抑制，不自动收掉已有的（不然点她说话会一闪就没）

  const answer = panel.onAction;
  panel.onAction = (id) => {
    if (id === 'balance' || id === 'balanceRefresh') { showBalance(); return; }
    answer?.(id);
  };

  // 点到别的软件、窗口失焦 → 菜单和设置一起收
  // 菜单/设置：开着的时候整层接鼠标，点哪里都由这一层收（不靠窗口焦点，省得闪）
  // 电脑空闲 → 播放收起来的动画；回来 → 出来
  host.onIdle(({ on }) => {
    if (!cfgNow.idleStowMin) return;
    if (on && !capri.stowed) capri.stow();
    else if (!on && capri.stowed) capri.unstow();
  });

  brain.linked = config.linked;
  brain.onLinked = () => {
    host.setConfig({ linked: true, welcomed: true });
    voice.play('hello');
    capri.perform('hop');
    panel.say({ kind: 'done', badge: 'LINK', line: brain.t.welcome.linked, hold: 6000 });
  };

  // The demo's second half, after its fake Claude session: everything she does on her own, one
  // after the other, a line before each.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (done, max = 15000) => {
    for (const t0 = Date.now(); !done() && Date.now() - t0 < max;) await wait(100);
  };
  const free = () => !capri.busy && !capri.act && capri.stance !== 'fall';
  brain.onShowcase = async () => {
    const t = brain.t.showcase;
    const caption = (line) => panel.say({ kind: 'info', line, hold: 2200 });
    capri.nextMove = capri.nextGaze = performance.now() + 120000; // nothing of her own in between
    if (capri.stowed) await capri.unstow();
    if (capri.dormant) capri.wake();
    await until(free);
    panel.hide();

    caption(t.minds);
    await wait(1000);
    await capri.perform('split');
    await wait(900);

    caption(t.zap);
    await wait(1000);
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    await wait(1800);

    panel.hide();
    if (capri.gaze({ big: true })) await until(() => !capri.sky);
    await wait(2500);

    // a little terminal opens for her to take over, and closes under her once she's done with it
    if (capri.possessWindows && (await host.demoWindow(true))) {
      const top = () => capri.windows.wins.find((w) => capri.canSit(w)); // it opens on top of everything
      await until(top, 4000);
      const win = top();
      const seat = win && { win, dx: win.w * 0.4 };
      if (seat) {
        panel.hide();
        await capri.sitOn(seat);
        await until(free);
        caption(t.possess);
        await wait(1400);
        panel.hide();
        await capri.possess();
        await wait(1800);
      }
      host.demoWindow(false);
      await wait(400);
      await until(free); // she may have fallen off it
      await wait(900);
    }

    caption(t.sleep);
    await wait(1400);
    panel.hide();
    capri.setMode('sleep');
    await wait(2500); // dozing off
    await capri.doze();
    await wait(4500);
    capri.wake();
    await until(free);
    await wait(1200);

    caption(t.chip);
    await wait(1600);
    panel.hide();
    await capri.stow();
    await wait(3500);
    await capri.unstow();
    await wait(600);
    panel.say({ kind: 'info', line: t.end, hold: 5000 });
  };

  window.__capri = capri;
  window.__brain = brain; // --dev 调试入口（/debug/js）
  host.onClaudeEvent((evt) => brain.handle(evt));
  host.onWindows((data) => {
    capri.setWindows(data);
    brain.onWindows(data);
  });
  // the windows as they are now: the watcher only speaks again when something changes
  host.windowsNow().then((data) => data && capri.setWindows(data));

  host.onResize(({ width, height }) => {
    fx.resize(width, height);
    classicFx.resize(width, height);
    chip.place(width, height);
    capri.setView(width, height);
  });
  window.addEventListener('resize', () => {
    fx.resize(innerWidth, innerHeight);
    classicFx.resize(innerWidth, innerHeight);
    chip.place(innerWidth, innerHeight);
    capri.setView(innerWidth, innerHeight);
  });

  host.onConfig((cfg) => {
    cfgNow = cfg;
    if (settings) { settings.cfg = cfg; settings.apply(); }
    capri.autoFacing = cfg.autoFacing !== false;
    capri.sideBand = typeof cfg.sideBand === 'number' ? cfg.sideBand : 0.25;
    capri.activity = Number(cfg.activity) || 1;
    voice.configure(cfg);
    capri.wander = cfg.wander;
    capri.possessWindows = cfg.possess;
    if (cfg.scale !== capri.scale) capri.setScale(cfg.scale);
    if (cfg.lang !== brain.lang) {
      brain.lang = cfg.lang;
      panel.labels = LINES.zh;
      document.documentElement.lang = cfg.lang;
    }
  });

  host.onCommand(async (cmd) => {
    const t = brain.t;
    switch (cmd.name) {
      case 'teleport':
        capri.teleport(capri.spot('random'));
        break;
      case 'status':
        brain.status();
        break;
      case 'welcome': // "How does it work?" in her menu
        guide.menu();
        break;
      case 'fakeClaude': { // --dev: the topmost window (the test window) is where a prompt was typed, and you're elsewhere
        const win = capri.windows.wins[0];
        if (win) {
          brain.sessions.set('dev', { id: 'dev', project: 'dev', taskStart: Date.now(), count: 0, files: new Set(), log: [], working: true, waiting: false, window: win.id, seen: Date.now() });
          capri.windows = { ...capri.windows, fg: -1 };
        }
        break;
      }
      case 'guide': // --dev: one topic of her guide (welcome, menu, connect, icon, claude, folder)
        if (cmd.topic === 'welcome') guide.welcome();
        else if (cmd.topic === 'menu') guide.menu();
        else if (typeof guide[cmd.topic] === 'function') guide.scene(() => guide[cmd.topic]());
        break;
      case 'stow': // Ctrl+Alt+C: into her biochip, or back out
        if (cmd.on) capri.stow();
        else capri.unstow();
        break;
      case 'heldOnce': // 托盘：被抱起（循环动作，挂两秒半再放下）
        capri.perform('held');
        setTimeout(() => capri.endAct?.(true), 2600);
        break;
      case 'refit': // 屏幕尺寸/缩放变了：把她收回到可视区，坐着的窗没了就落下
        capri.view = { w: innerWidth, h: innerHeight };
        capri.pos = {
          x: Math.min(Math.max(capri.pos.x, 40), capri.view.w - 40),
          y: Math.min(Math.max(capri.pos.y, 40), capri.view.h * 0.98),
        };
        if (capri.stance === 'sit' && !capri.windows.wins.some((w) => w.id === capri.perch?.id)) capri.fall();
        else if (capri.stance === 'peek') capri.unpeek?.();
        capri.place();
        break;
      case 'soundTour': { // 托盘：音效试听（每声配一句名字）
        for (const cue of CUES) {
          panel.say({ kind: 'info', line: `音效 · ${CUE_LABELS[cue] || cue}`, hold: 900 });
          voice.play(cue);
          await new Promise((r) => setTimeout(r, 950));
        }
        break;
      }
      case 'showAll': // 托盘：所有动作按顺序演一遍
        await showAll();
        break;
      case 'replayIntro': // 托盘：重播入场动画
        playEntrance();
        break;
      case 'screenPossess': // 托盘：整块屏幕附身
        capri.screenPossess();
        break;
      case 'possessOnce': // 托盘：附身一次（先找个窗口坐下）
        if (!capri.canPossess()) {
          const seat = capri.pickSeat();
          if (seat) await capri.sitOn(seat);
        }
        if (capri.canPossess()) capri.possess();
        else panel.say({ kind: 'info', line: '这会儿没窗口可占，宿主。', hold: 3500 });
        break;
      case 'satellite': // the whole sequence, on demand (tray)
        await watchSatellite();
        break;
      case 'hooks':
        if (cmd.ok) panel.say({ kind: 'info', line: cmd.action === 'install' ? t.hooksOk : t.hooksRemoved, hold: 6000 });
        else panel.say({ kind: 'error', line: fmt(t.hooksFail, { error: cmd.error }), hold: 9000 });
        break;
      // --dev helpers
      case 'intro': // her intro again, as when she starts (still: as with Windows' animations off)
        panel.hide();
        await capri.intro(capri.spot('post'), { label: brain.t.intro.hi, caption: brain.t.intro.caption, ...(cmd.still ? { still: true } : {}) });
        break;
      case 'pose':
        capri.debug = cmd.params || null;
        if (cmd.still) capri.nextMove = capri.nextGaze = Infinity; // no wandering off mid-test
        if (cmd.hush) {
          panel.setTicker(null);
          panel.hide();
        }
        if (cmd.scale) capri.setScale(cmd.scale);
        if (cmd.stance) capri.setStance(cmd.stance, cmd);
        if (cmd.at) capri.pos = cmd.at;
        if (cmd.facing) capri.facing = cmd.facing;
        capri.drawFrame();
        break;
      case 'config': // a setting, as if changed from her menu
        host.setConfig(cmd.patch || {});
        break;
      case 'focus': // as if window `fg` had come to the front
        capri.windows = { ...capri.windows, fg: cmd.fg };
        brain.onWindows(capri.windows);
        break;
      case 'freeze':
        capri.hidden = Boolean(cmd.on);
        break;
      case 'act':
        // behaviours by method name (gaze, celebrate, hurt, shed, peek, fall, wanderStep...) or acts by name
        if (cmd.act === 'sit') {
          // pile: n-th window she could sit on from the top of the pile (0: the --dev test window
          // opened last), instead of the usual choice
          const top = cmd.pile !== undefined && capri.windows.wins.filter((w) => capri.canSit(w))[cmd.pile];
          const seat = top ? { win: top, dx: top.w * 0.4 } : capri.pickSeat();
          if (seat) capri.sitOn(seat);
        } else if (typeof capri[cmd.act] === 'function') capri[cmd.act](...(cmd.args || []));
        else capri.perform(cmd.act, cmd.dir || 0);
        break;
      default:
        break;
    }
  });

  // entrance: her face big in the corner says hi, then she dives down to her spot
  // (put away last time: she starts in her biochip)
  if (config.visible === false) capri.stowNow();
  else if (intro) await playEntrance();
  else await capri.materialize(capri.spot('post'));
  const hooks = await host.hooksStatus();
  // DSH 版没有「hooks 已装」这回事（桥由插件装），所以只在她没被欢迎过的时候出来
  if (!config.welcomed || (!config.dshEdition && !hooks.installed)) guide.welcome();
  else panel.say({ kind: 'info', line: pick(brain.t.online), hold: 4000 });
}

boot().catch((err) => {
  console.error('[capri] boot failed', err);
});
