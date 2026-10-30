'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, protocol, net, shell, globalShortcut, nativeImage, powerMonitor,
} = require('electron');

const config = require('./config');
const { TRAY } = require('./labels');
const { createBridge } = require('./bridge');
const { startWindowWatch } = require('./windows');
const { startDshWatch } = require('./dsh-watch');
const hooks = require('../../scripts/install-hooks');
const demoSteps = require('../../scripts/demo-sequence');

const ROOT = path.resolve(__dirname, '..', '..');
const DEV = process.argv.includes('--dev');
const TRAY_UI = false; // 不要菜单栏（用户要求）
const PORT = Number(process.env.CAPRI_PORT) || 47823;
const SOUND_EXT = /\.(mp3|wav|ogg|m4a)$/i;
const CLAUDE_CODE_HELP = 'https://code.claude.com/docs/en/quickstart';

protocol.registerSchemesAsPrivileged([
  { scheme: 'capri', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let overlay = null;
let tray = null;
let trayMenu = null; // also what she opens when you right-click her
let demoTimer = null;
let windowWatch = null;
let dshWatch = null;
// the watcher only speaks when something changes: the overlay asks for this when it (re)loads
let lastWindows = null;

const userSoundsDir = () => path.join(app.getPath('userData'), 'sounds');

// capri://app/...        -> files of this repo
// capri://usersounds/... -> the user's own sound overrides
function serveProtocol() {
  protocol.handle('capri', (request) => {
    const url = new URL(request.url);
    const base = url.host === 'usersounds' ? userSoundsDir() : ROOT;
    const target = path.resolve(base, '.' + decodeURIComponent(url.pathname));
    if (target !== base && !target.startsWith(base + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

function targetDisplay() {
  const { displayId } = config.load();
  return screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
}

function fitOverlay() {
  if (!overlay) return;
  const { workArea } = targetDisplay();
  overlay.setBounds(workArea);
  overlay.webContents.send('overlay:resize', { width: workArea.width, height: workArea.height });
}

function createOverlay() {
  const { workArea } = targetDisplay();
  overlay = new BrowserWindow({
    ...workArea,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadURL('capri://app/src/renderer/index.html');
  // 窗口快照只在"变了"的时候发；渲染层第一次加载时那个快照早就发过了，会丢。
  // 加载完补一次，免得她一上来以为桌面上没有窗口。
  overlay.webContents.on('did-finish-load', () => {
    if (lastWindows) overlay.webContents.send('windows:update', lastWindows);
    paintTrayIcon();
    // 窗口监视器在 overlay 之前启动，第一份快照可能比渲染层就绪还早：
    // 加载完隔一会儿再补一次（那时候快照一定有了），否则她会一直以为桌面是空的。
    for (const delay of [600, 2500]) {
      setTimeout(() => {
        if (lastWindows && overlay && !overlay.isDestroyed()) overlay.webContents.send('windows:update', lastWindows);
      }, delay);
    }
  });
  // always shown: put away, she's still there as her biochip in the corner
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.webContents.on('render-process-gone', (_e, details) => {
    console.error('[capri] renderer gone:', details.reason);
  });
  if (DEV) {
    overlay.webContents.on('console-message', (e) => {
      const { level, message, lineNumber, sourceId } = e;
      console.log(`[renderer:${level}] ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
    });
    if (process.env.CAPRI_DEVTOOLS) overlay.webContents.openDevTools({ mode: 'detach' });
  }
}

function sendCommand(name, payload = {}) {
  overlay?.webContents.send('capri:command', { name, ...payload });
}

// Ctrl+Alt+C: she folds herself away into her biochip in the corner, or comes back out of it.
function toggleVisible(force) {
  const visible = typeof force === 'boolean' ? force : !config.load().visible;
  config.save({ visible });
  sendCommand('stow', { on: !visible });
  rebuildTray();
}

function playDemo() {
  clearTimeout(demoTimer);
  let i = 0;
  const next = () => {
    if (i >= demoSteps.length) return;
    const [delay, evt] = demoSteps[i++];
    demoTimer = setTimeout(() => {
      overlay?.webContents.send('claude:event', evt);
      next();
    }, delay);
  };
  next();
}

// During the demo, a little fake terminal for her to sit on and take over (window tracking is
// Windows only, so only there). Opened without stealing focus; closing it drops her off it.
let demoWin = null;
const DEMO_TERMINAL = `<body style="margin:0;background:#14101c;color:#8f8aa3;font:13px/1.7 Consolas,monospace;padding:14px 18px">
<div style="color:#36ff7a">PS C:\\night-city-api&gt; npm test -- gigs</div>
<div>&nbsp;&nbsp;GET /gigs</div><div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ returns 20 items per page</div>
<div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ paginates with a cursor</div><div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ rejects a bad cursor</div>
<div>&nbsp;&nbsp;6 passing (212ms)</div><div style="color:#36ff7a">PS C:\\night-city-api&gt; _</div></body>`;

function demoWindow(open) {
  demoWin?.destroy();
  demoWin = null;
  if (!open || process.platform !== 'win32') return false;
  const b = overlay.getBounds();
  demoWin = new BrowserWindow({
    x: Math.round(b.x + b.width * 0.5 - 310), y: Math.round(b.y + b.height * 0.42), width: 620, height: 300,
    show: false, alwaysOnTop: true, title: 'night-city-api — npm test', backgroundColor: '#14101c', autoHideMenuBar: true,
  });
  demoWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DEMO_TERMINAL)}`);
  demoWin.once('ready-to-show', () => demoWin?.showInactive());
  demoWin.on('closed', () => { demoWin = null; });
  return true;
}

// 'auto' -> the first system language Capri speaks, English otherwise.
function resolveLang() {
  return 'zh'; // 只做中文，语言菜单已去掉
}

// What the overlay gets: `lang` is the resolved one, `langSetting` what the user picked.
// dshEdition：这一版接的是 DSH（DeepSeek Harness）桥，不是 Claude Code 的 hooks，
// 所以「插上我」不该去改 ~/.claude/settings.json，改成让她说「重启 DSH 就行」。
const DSH_EDITION = true;

// 屏幕越大她越大：以 1080p 的 0.6 为基准，按较短边等比缩放，夹在 0.42～0.95 之间。
// 4K/5K 上不会小成蚂蚁，1366×768 上也不会顶满半个屏幕。
function autoScaleFor(display) {
  // 用整块屏幕而不是工作区：菜单栏/Dock 占掉的高度不该让她缩水
  const { width, height } = display.size;
  const base = Math.min(width / 1920, height / 1080);
  return Math.round(0.6 * clamp(base, 0.7, 1.6) * 100) / 100;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function rendererConfig() {
  const cfg = config.load();
  const display = targetDisplay();
  const scale = cfg.scaleAuto ? autoScaleFor(display) : cfg.scale;
  return { ...cfg, scale, scaleAuto: Boolean(cfg.scaleAuto), lang: resolveLang(cfg.lang), langSetting: 'zh', dshEdition: DSH_EDITION };
}

// 「跟随 DSH」：标记文件 ~/.capri-follow-dsh，DSH 的桥插件启动时看到它就把她拉起来
function syncFollowFlag(cfg) {
  const flag = path.join(app.getPath('home'), '.capri-follow-dsh');
  try {
    if (cfg.followDsh !== false) fs.writeFileSync(flag, '1');
    else fs.rmSync(flag, { force: true });
  } catch (err) { console.error('[capri] 跟随 DSH 标记写不进去', err.message); }
}

function updateConfig(patch) {
  const before = config.load();
  config.save(patch);
  const after = config.load();
  syncFollowFlag(after);
  // 开机自启：改了就立刻跟系统同步
  if ('autostart' in patch || before.autostart !== after.autostart) {
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(after.autostart), openAsHidden: true });
    } catch (err) { console.error('[capri] 设置开机自启失败', err.message); }
  }
  const cfg = rendererConfig();
  overlay?.webContents.send('capri:config', cfg);
  rebuildTray();
  return cfg;
}

function rebuildTray() {
  if (!TRAY_UI || !tray) return;
  const cfg = config.load();
  const hookState = hooks.status();
  const t = TRAY[resolveLang(cfg.lang)];

  const displays = screen.getAllDisplays();
  const current = targetDisplay().id;

  const menu = Menu.buildFromTemplate([
    { label: t.online(PORT), enabled: false },
    { type: 'separator' },
    { label: t.teleport, click: () => sendCommand('teleport') },
    { label: t.satellite, click: () => sendCommand('satellite') },
    { label: t.possessOnce || '附身看看', click: () => sendCommand('possessOnce') },
    { label: t.screenPossess || '全屏附身', click: () => sendCommand('screenPossess') },
    { label: t.replayIntro || '重播入场', click: () => sendCommand('replayIntro') },
    { label: t.heldOnce || '被抱起', click: () => sendCommand('heldOnce') },
    { label: t.demo, click: playDemo },
    { label: t.help, click: () => sendCommand('welcome') },
    { label: cfg.visible ? t.hide : t.show, accelerator: 'Ctrl+Alt+C', click: () => toggleVisible() },
    { type: 'separator' },
    {
      label: t.size,
      submenu: [
        { label: t.sizeAuto || '自动（跟屏幕）', type: 'radio', checked: Boolean(cfg.scaleAuto), click: () => updateConfig({ scaleAuto: true }) },
        { type: 'separator' },
        ...[[t.small, 0.45], [t.medium, 0.6], [t.large, 0.8]].map(([label, scale]) => ({
          label, type: 'radio', checked: !cfg.scaleAuto && Math.abs(cfg.scale - scale) < 0.01,
          click: () => updateConfig({ scaleAuto: false, scale }),
        })),
      ],
    },
    {
      label: t.sound,
      submenu: [
        { label: t.mute, type: 'checkbox', checked: cfg.muted, click: (item) => updateConfig({ muted: item.checked }) },
        { type: 'separator' },
        {
          label: t.soundsDir,
          click: () => {
            fs.mkdirSync(userSoundsDir(), { recursive: true });
            shell.openPath(userSoundsDir());
          },
        },
      ],
    },
    {
      label: t.screen,
      enabled: displays.length > 1,
      submenu: displays.map((d, i) => ({
        label: `${i + 1} — ${d.size.width}×${d.size.height}`,
        type: 'radio',
        checked: d.id === current,
        click: () => { config.save({ displayId: d.id }); fitOverlay(); rebuildTray(); },
      })),
    },
    { label: t.wander, type: 'checkbox', checked: cfg.wander, click: (item) => updateConfig({ wander: item.checked }) },
    { label: t.possess, type: 'checkbox', checked: cfg.possess, click: (item) => updateConfig({ possess: item.checked }) },
    {
      label: t.startup,
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }),
    },
    { type: 'separator' },
    // DSH 版不显示 Claude Code hooks 的三项：桥由 DSH 插件装，这里没有可点的事
    ...(DSH_EDITION ? [] : [
      hookState.installed
        ? { label: t.hooksOn, enabled: false }
        : { label: t.hooksOff, click: () => runHooks('install') },
      ...(hookState.installed ? [{ label: t.hooksRemove, click: () => runHooks('uninstall') }] : []),
    ]),
    { type: 'separator' },
    { label: t.quit, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  trayMenu = menu;
  paintTrayIcon();
}

// Run from a clone (`npm start`), electron.exe alone would open the default Electron app at login:
// it needs the project folder as argument.
function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: [ROOT] };
}

// From the tray, she says how it went; from her welcome panel (quiet), the panel does.
function runHooks(action, { quiet = false } = {}) {
  let outcome;
  try {
    const result = action === 'install' ? hooks.install() : hooks.uninstall();
    outcome = { action, ok: true, file: result.file };
  } catch (err) {
    outcome = { action, ok: false, error: err.message };
  }
  if (!quiet) sendCommand('hooks', outcome);
  rebuildTray();
  return outcome;
}

// ---- 菜单栏图标（macOS）----------------------------------------------------
// 一个状态一个模板图标（template image：纯黑 + 透明，系统自动适配亮/深色菜单栏），
// 干活时两帧眨一下；Windows 沿用原来的彩色 tray.png。
let trayState = 'idle';
let trayIcons = null;
let blinkTimer = null;
let blinkOn = false;
let doneTimer = null;
let sleepTimer = null;

const TRAY_TIP = {
  idle: 'idle', work: 'work', alert: 'alert', done: 'done', asleep: 'asleep',
};

function trayIconFor(state) {
  if (process.platform !== 'darwin') return null;
  if (!trayIcons) trayIcons = new Map();
  if (!trayIcons.has(state)) {
    // 36px 的图当 1x 用会被 macOS 当成 36 点，菜单栏里比别人的图标宽一倍（实测 AX 报 36×24）。
    // 所以按 scaleFactor 2 读，逻辑尺寸就是 18pt；createFromPath 的 @2x 自动嗅探不吃这套。
    const dir = path.join(ROOT, 'assets', 'icons', 'mac');
    let img = null;
    try {
      const buf = fs.readFileSync(path.join(dir, `tray-${state}@2x.png`));
      img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
    } catch {
      img = nativeImage.createFromPath(path.join(dir, `tray-${state}.png`));
    }
    if (!img || img.isEmpty()) return null;
    img.setTemplateImage(true);
    trayIcons.set(state, img);
  }
  return trayIcons.get(state);
}

function paintTrayIcon() {
  if (!tray) return;
  const t = TRAY[resolveLang(config.load().lang)];
  const tip = {
    idle: t.tipIdle, work: t.tipWork, alert: t.tipAlert, done: t.tipDone, asleep: t.tipAsleep,
  }[trayState] || 'idle';
  tray.setToolTip(`Capri — ${tip}`);
  const img = trayIconFor(trayState === 'work' && blinkOn ? 'work2' : trayState);
  if (img) tray.setImage(img);
}

function setTrayState(state) {
  if (!TRAY_TIP[state]) state = 'idle';
  if (state === trayState) return;
  trayState = state;
  clearTimeout(doneTimer);
  clearTimeout(sleepTimer);
  // 太久没事发生，图标跟着她一起装睡
  if (state === 'idle') sleepTimer = setTimeout(() => setTrayState('asleep'), 10 * 60 * 1000);
  if (state === 'work') {
    if (!blinkTimer) {
      blinkTimer = setInterval(() => {
        blinkOn = !blinkOn;
        paintTrayIcon();
      }, 650);
    }
  } else {
    clearInterval(blinkTimer);
    blinkTimer = null;
    blinkOn = false;
  }
  paintTrayIcon();
  if (state === 'done') doneTimer = setTimeout(() => setTrayState('idle'), 6000);
}

// 事件 -> 菜单栏图标状态
function trayStateFor(evt) {
  const name = String((evt && evt.hook_event_name) || '');
  if (name === 'Stop') return 'done';
  if (name === 'Notification') return 'alert';
  if (name === 'StopFailure') return 'alert';
  if (name === 'SessionEnd') return 'idle';
  if (name === 'SessionStart' || name === 'UserPromptSubmit' || name === 'PreToolUse' || name === 'SubagentStart') return 'work';
  return '';
}

function createTray() {
  // 桌面版回归：不要菜单栏图标、不要原生菜单；设置走她身上的右键菜单
  if (!TRAY_UI) return;
  const mac = trayIconFor('idle');
  const icon = mac || nativeImage.createFromPath(path.join(ROOT, 'assets', 'icons', 'tray.png'));
  tray = new Tray(icon);
  if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);
  tray.setToolTip('Capri');
  tray.on('click', () => sendCommand('status'));
  paintTrayIcon();
  rebuildTray();
}

// 电脑空闲多久 → 通知页面收起来 / 唤醒（用系统空闲时间，不是页面鼠标）
let idleOn = false;
let idleTimer = null;
function startIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    try {
      const cfg = config.load();
      const min = Number(cfg.idleStowMin) || 0;
      if (!min) {
        if (idleOn) { idleOn = false; overlay?.webContents.send('capri:idle', { on: false, idle: 0 }); }
        return;
      }
      const idle = powerMonitor.getSystemIdleTime();
      const on = idle >= min * 60;
      if (on !== idleOn) {
        idleOn = on;
        overlay?.webContents.send('capri:idle', { on, idle });
      }
    } catch { /* 忽略 */ }
  }, 15000);
  try { idleTimer.unref?.() } catch { /* 忽略 */ }
}

function registerIpc() {
  ipcMain.on('overlay:interactive', (_e, on) => {
    overlay?.setIgnoreMouseEvents(!on, { forward: true });
  });
  ipcMain.handle('overlay:cursor', () => {
    const p = screen.getCursorScreenPoint();
    const b = overlay.getBounds();
    return { x: p.x - b.x, y: p.y - b.y, inside: p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height };
  });
  ipcMain.handle('config:get', () => rendererConfig());
  ipcMain.on('app:quit', () => { app.quit(); });
  ipcMain.on('app:openConfig', () => {
    try { shell.showItemInFolder(path.join(app.getPath('userData'), 'config.json')); } catch { /* 忽略 */ }
  });
  ipcMain.handle('balance:get', async (_e, fresh) => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      const res = await fetch(`http://127.0.0.1:47824/state${fresh ? '?fresh=1' : ''}`, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: 'bridge ' + res.status };
      return await res.json();
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('hooks:status', () => hooks.status());
  ipcMain.handle('config:set', (_e, patch) => updateConfig(patch));
  ipcMain.handle('demo:window', (_e, open) => demoWindow(open));
  // right-clicking her: the same menu as the tray icon (which Windows often hides behind the ^ by the clock)
  ipcMain.on('menu:open', () => overlay?.webContents.send('capri:menu'));
  // 菜单/设置打开时临时允许聚焦：点击别的软件 → 窗口失焦 → 页面收到 capri:blur 自己关
  ipcMain.on('overlay:focusable', (_e, on) => {
    try {
      overlay.setFocusable(Boolean(on));
      if (on) {
        if (process.platform === 'darwin') app.focus({ steal: true });
        overlay.focus();
      } else {
        overlay.blur();
      }
    } catch { /* 忽略 */ }
  });
  // her welcome panel's buttons
  ipcMain.handle('hooks:install', () => runHooks('install', { quiet: true }));
  // DSH 版：她的「文件夹」是 DSH 的配置目录（profiles / cordis.patch.yml 都在里面）
  const dshHome = () => process.env.DSH_HOME || path.join(app.getPath('home'), '.dsh');
  ipcMain.handle('claude:found', () => (DSH_EDITION ? fs.existsSync(dshHome()) : fs.existsSync(path.dirname(hooks.status().file))));
  ipcMain.on('claude:help', () => shell.openExternal(DSH_EDITION ? 'https://github.com/deepseek-ai/deepseek-harness' : CLAUDE_CODE_HELP));
  ipcMain.handle('guide:claudeFolder', () => {
    if (DSH_EDITION) {
      const dir = dshHome();
      if (!fs.existsSync(dir)) return { found: false, dir };
      shell.openPath(dir);
      const file = path.join(dir, 'cordis.patch.yml');
      return { found: true, dir, file: fs.existsSync(file) };
    }
    const file = hooks.status().file;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) return { found: false, dir };
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(dir);
    return { found: true, dir, file: fs.existsSync(file) };
  });
  ipcMain.handle('windows:get', () => lastWindows);
  // her guide: where her tray icon is (it lives in the taskbar, off the overlay, hence overlay
  // coordinates past its edge), and the corner by the clock in case Windows hid it behind the ^
  ipcMain.handle('guide:tray', () => {
    const o = overlay.getBounds();
    const d = targetDisplay().bounds;
    const b = tray?.getBounds();
    const icon = b && b.width > 0 ? { x: b.x - o.x, y: b.y - o.y, w: b.width, h: b.height } : null;
    const corner = { x: d.x + d.width - 150 - o.x, y: d.y + d.height - 44 - o.y, w: 140, h: 40 };
    return { icon, corner };
  });
  ipcMain.handle('sounds:list', () => {
    try {
      return fs.readdirSync(userSoundsDir())
        .filter((f) => SOUND_EXT.test(f))
        .map((f) => ({ name: f.replace(SOUND_EXT, '').toLowerCase(), url: `capri://usersounds/${encodeURIComponent(f)}` }));
    } catch {
      return [];
    }
  });
}

// Only in --dev: lets scripts drive the overlay and grab frames of it (no desktop content, just our window).
const testWins = new Map(); // name -> test window

async function debugHandler(route, body) {
  if (!DEV) throw new Error('debug routes need --dev');
  if (route === 'command') {
    sendCommand(body.name, body);
    return { ok: true };
  }
  if (route === 'reload') {
    overlay.webContents.reloadIgnoringCache();
    return { ok: true };
  }
  if (route === 'testwin') {
    // plain windows to sit on, opened without stealing focus, by name (`id`, default "main");
    // each one opened goes in front of the others. { open: false } without an id closes them all.
    const id = body.id ?? 'main';
    if (!body.open && body.id === undefined) {
      for (const win of testWins.values()) win.destroy();
      testWins.clear();
      return { ok: true };
    }
    testWins.get(id)?.destroy();
    testWins.delete(id);
    if (body.open) {
      const b = overlay.getBounds();
      const win = new BrowserWindow({
        x: b.x + (body.x ?? 300), y: b.y + (body.y ?? 380), width: body.w ?? 720, height: body.h ?? 380,
        show: false, alwaysOnTop: true, title: `Capri test window ${id}`, backgroundColor: '#1b1726',
      });
      win.loadURL('data:text/html,<body style="background:%231b1726"></body>');
      win.showInactive();
      testWins.set(id, win);
    }
    return { ok: true };
  }
  if (route === 'movewin' && testWins.has(body.id ?? 'main')) {
    const win = testWins.get(body.id ?? 'main');
    const [x, y] = win.getPosition();
    win.setPosition(x + (body.dx || 0), y + (body.dy || 0));
    return { ok: true };
  }
  if (route === 'mouse') {
    // the pointer moving over the overlay (css px), and clicking if asked, without touching the real one
    const at = { x: Math.round(body.x), y: Math.round(body.y) };
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...at });
    if (body.click) {
      overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
      overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at });
    }
    return { ok: true };
  }
  if (route === 'demo') {
    playDemo();
    return { ok: true, steps: demoSteps.length };
  }
  if (route === 'js') {
    // --dev: 在渲染层跑一段 JS 拿状态（调试用）
    return { ok: true, value: await overlay.webContents.executeJavaScript(String(body.code || 'null'), true) };
  }
  if (route === 'capture') {
    const image = await overlay.webContents.capturePage();
    // installed, the app's own folder is read-only: its data folder instead
    const dir = path.join(app.isPackaged ? app.getPath('userData') : ROOT, 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${(body.name || 'frame').replace(/[^\w-]/g, '')}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { ok: true, file };
  }
  throw new Error('unknown debug route');
}

function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => sendCommand('status'));
  if (process.platform === 'win32') app.setAppUserModelId('capri.desktop');
  // macOS：不占 Dock、不进 Cmd-Tab，点击她也不会把整个 app 提到前台 —— 不会抢你打字的焦点
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  app.whenReady().then(() => {
    serveProtocol();
    registerIpc();
    syncFollowFlag(config.load());
    createOverlay();
    // 刚打开菜单那一两帧的 blur 是噪音（窗口还没抢到焦点），延迟确认再通知
    overlay.on('blur', () => {
      setTimeout(() => {
        try { if (!overlay.isDestroyed() && !overlay.isFocused()) overlay.webContents.send('capri:blur'); } catch { /* 忽略 */ }
      }, 250);
    });
    createTray();
    startIdleWatch();
    windowWatch = startWindowWatch({
      overlay,
      onUpdate: (data) => {
        lastWindows = data;
        overlay?.webContents.send('windows:update', data);
      },
    });
    // 不用重启 DSH：直接读它的会话投影，实时知道它在干什么
    dshWatch = startDshWatch({
      onEvent: (evt) => {
        overlay?.webContents.send('claude:event', evt);
        const state = trayStateFor(evt);
        if (state) setTrayState(state);
      },
    });
    createBridge({
      port: PORT,
      onEvent: (evt) => {
        overlay?.webContents.send('claude:event', evt);
        const state = trayStateFor(evt);
        if (state) setTrayState(state);
      },
      onDebug: DEV ? debugHandler : null,
    });
    globalShortcut.register('Control+Alt+C', () => toggleVisible());
    screen.on('display-metrics-changed', fitOverlay);
    screen.on('display-added', () => { fitOverlay(); rebuildTray(); sendCommand('refit'); });
    screen.on('display-removed', () => { fitOverlay(); rebuildTray(); sendCommand('refit'); });
    // 换分辨率 / 改缩放 / 换主屏：overlay 跟着重排，自动尺寸跟着重算
    screen.on('display-metrics-changed', () => {
      fitOverlay();
      rebuildTray();
      overlay?.webContents.send('capri:config', rendererConfig());
      // 换分辨率/缩放/主屏之后，她原来的落点可能已经在屏幕外：让她自己收回可视区
      sendCommand('refit');
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    windowWatch?.stop();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}

main();
