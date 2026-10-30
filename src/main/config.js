'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  scale: 0.6,        // sprite scale, 0.6 ≈ 250px tall
  scaleAuto: true,   // 跟屏幕分辨率自动定尺寸（用户手动选大小后关掉）
  muted: false,
  volume: 0.7,
  lang: 'auto',      // 'auto' follows the system language, or 'fr' / 'en'
  displayId: null,   // null = primary display
  wander: true,      // random teleports when idle
  possess: true,     // now and then she dives into the window she sits on and takes it over
  visible: true,
  welcomed: false,   // she has introduced herself (her welcome panel)
  linked: false,     // a Claude Code event has reached her at least once
  routerUrl: 'http://127.0.0.1:8000', // the personal AI router (Sistema_AI, `python server.py`)
  routerToken: '',   // only if ROUTER_API_TOKEN is set on the router (or export it before starting her)
  askModel: 'router-auto', // router-auto picks the category; router-coding, router-appunti... force one
  askShortcut: 'Control+Alt+Space',
  axAsked: false,     // 已经为「替你敲字」问过一次系统权限，问过就不再骚扰
  // —— 桌面版回归后新增的设置（右键菜单 → 设置 里都能调）——
  quiet: false,       // 安静模式：不自己走动、不随机演出
  activity: 1,        // 活跃度：随机说话/动作的间隔倍率，0.3 慢 … 2 勤快
  idleStowMin: 5,     // 电脑空闲多久收进小芯片（0 = 不收）
  autoFacing: true,   // 按位置自动转身：在左边朝右，在右边朝左
  sideBand: 0.25,     // 允许活动的边带宽度（0.25 = 左右各 25%，中间 50% 禁区）
  balance: true,      // 气泡里常驻「查看余额」
  autostart: false,   // 开机自启
  followDsh: true,
  ambient: true,   // 设备/电源/负载感知 + 偷看屏幕
  peek: true,      // 时不时朝活动窗口探一眼    // 跟着 DSH 走：DSH 起来她也起来（靠桥插件拉起）
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[capri] could not save config:', err.message);
  }
  return cache;
}

module.exports = { load, save, DEFAULTS };
