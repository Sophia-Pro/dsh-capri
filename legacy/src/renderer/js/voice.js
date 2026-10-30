// Capri's sounds, synthesized with Web Audio so nothing has to ship with the repo.
// Any file dropped in the custom sounds folder (tray > Son) named after a cue
// (teleport-out.mp3, done.wav, alert.ogg...) replaces the synth for that cue.

import { rand, pick } from './util.js';

// a minor-pentatonic set for the talking blips; three detuned voices = a chorus of minds
const BLIP_NOTES = [62, 65, 67, 69, 72, 74, 77, 79];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export const CUES = [
  'teleport-out', 'teleport-in', 'done', 'alert', 'error', 'hello', 'blip', 'tick', 'star', 'land', 'rise',
  'bolt', 'charge', 'possess',
  // 后来加的：冷、电子、带毛刺，贴她那个人格
  'hiss', 'slam', 'zip', 'whirl', 'steam', 'sigh', 'glitch', 'tap', 'purr',
];

export const CUE_LABELS = {
  tap: '轻点', blip: '说话', tick: '滴答', hello: '打招呼', star: '星光',
  land: '软着陆', slam: '砸地', zip: '窜出去', whirl: '旋转',
  charge: '蓄力', bolt: '红电', possess: '附身', glitch: '毛刺',
  hiss: '瞪你', steam: '过热', sigh: '叹气', purr: '得意',
  alert: '提醒', error: '出错', done: '干完', 'teleport-out': '传送走', 'teleport-in': '传送来',
};

export class Voice {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.7;
    this.custom = new Map(); // cue -> AudioBuffer
    this.lastBlip = 0;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // soft clip so stacked cues never get harsh
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
    }
    shaper.curve = curve;
    this.master.connect(shaper).connect(ctx.destination);
    this.noise = this.makeNoise();
    return ctx;
  }

  configure({ muted, volume }) {
    if (typeof muted === 'boolean') this.muted = muted;
    if (typeof volume === 'number') {
      this.volume = volume;
      if (this.master) this.master.gain.value = volume;
    }
  }

  async loadCustom(list) {
    const ctx = this.ensure();
    this.custom.clear();
    for (const { name, url } of list) {
      if (!CUES.includes(name)) continue;
      try {
        const data = await (await fetch(url)).arrayBuffer();
        this.custom.set(name, await ctx.decodeAudioData(data));
      } catch (err) {
        console.warn('[capri] could not load sound', name, err);
      }
    }
  }

  play(cue, opts = {}) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    const custom = this.custom.get(cue);
    if (custom) {
      const src = ctx.createBufferSource();
      src.buffer = custom;
      src.connect(this.master);
      src.start();
      return;
    }
    const fn = {
      'teleport-out': () => this.zap(false),
      'teleport-in': () => this.zap(true),
      done: () => this.done(),
      alert: () => this.alert(),
      error: () => this.error(),
      hello: () => this.hello(),
      blip: () => this.blip(opts.mood),
      tick: () => this.tick(),
      star: () => this.star(),
      land: () => this.land(),
      rise: () => this.rise(),
      bolt: () => this.bolt(opts.soft),
      charge: () => this.charge(),
      possess: () => this.possess(),
      hiss: () => this.hiss(),
      slam: () => this.slam(opts.soft),
      zip: () => this.zip(),
      whirl: () => this.whirl(),
      steam: () => this.steam(),
      sigh: () => this.sigh(),
      glitch: () => this.glitch(),
      tap: () => this.tap(),
      purr: () => this.purr(),
    }[cue];
    fn?.();
  }

  makeNoise() {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  env(gain, t, a, peak, d) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  osc(type, freq, t, dur, peak, dest = this.master) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    this.env(g, t, 0.004, peak, dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  noiseBurst(t, dur, peak, from, to, q = 2) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    this.env(g, t, 0.005, peak, dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, rand(0, 0.5));
    src.stop(t + dur + 0.05);
  }

  // teleport: saw sweep + filtered noise, upward when leaving, downward when landing
  zap(arriving) {
    const t = this.ctx.currentTime;
    const o = this.osc('sawtooth', arriving ? 1600 : 180, t, 0.22, 0.12);
    o.frequency.exponentialRampToValueAtTime(arriving ? 140 : 2400, t + 0.2);
    this.noiseBurst(t, 0.2, 0.22, arriving ? 6000 : 400, arriving ? 500 : 7000, 3);
    // bit-crushy stutter
    for (let i = 0; i < 4; i++) this.osc('square', rand(800, 3200), t + 0.02 + i * 0.035, 0.02, 0.05);
    if (arriving) this.osc('triangle', 70, t + 0.16, 0.18, 0.3);
  }

  blip(mood = 'talk') {
    const now = performance.now();
    if (now - this.lastBlip < 45) return;
    this.lastBlip = now;
    const t = this.ctx.currentTime;
    const base = pick(BLIP_NOTES) + (mood === 'alert' ? 5 : mood === 'error' ? -7 : 0);
    const f = midi(base);
    this.osc('square', f, t, 0.035, 0.035);
    this.osc('triangle', f * 1.498, t + 0.004, 0.03, 0.025); // a fifth up
    this.osc('square', f * 0.501, t + 0.008, 0.03, 0.018);   // an octave down, slightly off
  }

  tick() {
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.03, 0.06, 3000, 9000, 8);
  }

  // red lightning: a buzz under a crackle of tiny bursts (soft: the small hacking sparks)
  bolt(soft = false) {
    const t = this.ctx.currentTime;
    const k = soft ? 0.35 : 1;
    const o = this.osc('sawtooth', 62, t, 0.3 * k + 0.05, 0.08 * k);
    o.frequency.setValueAtTime(58, t + 0.05);
    for (let i = 0; i < (soft ? 3 : 8); i++) {
      this.noiseBurst(t + i * rand(0.02, 0.045), 0.025, 0.14 * k, rand(2500, 6000), rand(4000, 9000), 6);
    }
  }

  // charging up before the red light goes up: a buzz swelling and climbing, crackling more and more
  charge() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(240, t + 0.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.66);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.7);
    for (let i = 0; i < 6; i++) this.noiseBurst(t + 0.08 + i * 0.09, 0.02, 0.04 + i * 0.016, 3000, 7000, 6);
  }

  // the window she took over laughs with all her voices: three falling chirps, each a detuned
  // chord, over a hiss
  possess() {
    const t = this.ctx.currentTime;
    [79, 76, 72].forEach((n, i) => {
      const at = t + i * 0.11;
      this.osc('square', midi(n), at, 0.07, 0.05);
      this.osc('square', midi(n) * 1.012, at + 0.004, 0.06, 0.035);
      this.osc('triangle', midi(n - 12), at + 0.008, 0.07, 0.04);
    });
    this.noiseBurst(t, 0.3, 0.05, 1200, 5000, 3);
  }

  // the launch into the victory pose: a quick upward whoosh
  rise() {
    const t = this.ctx.currentTime;
    const o = this.osc('sawtooth', 160, t, 0.2, 0.07);
    o.frequency.exponentialRampToValueAtTime(1400, t + 0.18);
    this.noiseBurst(t, 0.18, 0.12, 500, 6000, 2);
  }

  // touching down: a soft digital thump
  land() {
    const t = this.ctx.currentTime;
    const o = this.osc('triangle', 150, t, 0.14, 0.22);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    this.noiseBurst(t, 0.06, 0.08, 1800, 400, 1.5);
  }

  // the satellite: two soft, high pings and a shimmer
  star() {
    const t = this.ctx.currentTime;
    this.osc('sine', midi(93), t, 0.9, 0.05);
    this.osc('sine', midi(100), t + 0.14, 1.2, 0.035);
    this.noiseBurst(t + 0.05, 0.6, 0.015, 9000, 12000, 6);
  }

  hello() {
    const t = this.ctx.currentTime;
    [69, 76, 81].forEach((n, i) => this.osc('square', midi(n), t + i * 0.06, 0.07, 0.06));
    this.noiseBurst(t + 0.18, 0.08, 0.06, 2000, 8000, 5);
  }

  // bright arpeggio and a glitchy tail
  done() {
    const t = this.ctx.currentTime;
    [64, 68, 71, 75, 76].forEach((n, i) => {
      this.osc('triangle', midi(n + 12), t + i * 0.07, 0.28, 0.09);
      this.osc('square', midi(n), t + i * 0.07, 0.12, 0.035);
    });
    for (let i = 0; i < 7; i++) this.osc('square', rand(1200, 4200), t + 0.4 + i * 0.03, 0.018, 0.035);
  }

  alert() {
    const t = this.ctx.currentTime;
    for (let r = 0; r < 2; r++) {
      this.osc('square', 988, t + r * 0.28, 0.09, 0.07);
      this.osc('square', 740, t + r * 0.28 + 0.11, 0.11, 0.07);
    }
  }

  // 瞪你：压着的气声 + 低鸣，像她喉咙里那点电流
  hiss() {
    const t = this.ctx.currentTime;
    const o = this.osc('sawtooth', 48, t, 0.34, 0.06);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.3);
    this.noiseBurst(t, 0.28, 0.07, 2400, 5200, 1.4);
    this.noiseBurst(t + 0.02, 0.12, 0.05, 6000, 9000, 3);
  }

  // 落地/砸下来：低频砸一下 + 碎屑
  slam(soft = false) {
    const k = soft ? 0.45 : 1;
    const t = this.ctx.currentTime;
    const o = this.osc('sine', 90, t, 0.3 * k, 0.3 * k);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.26 * k);
    this.noiseBurst(t, 0.1, 0.12 * k, 900, 260, 1);
    this.noiseBurst(t + 0.03, 0.16, 0.05 * k, 3200, 800, 2);
  }

  // 扑/瞬移那一瞬间：细窄的上滑
  zip() {
    const t = this.ctx.currentTime;
    const o = this.osc('sawtooth', 420, t, 0.14, 0.05);
    o.frequency.exponentialRampToValueAtTime(2600, t + 0.13);
    this.noiseBurst(t, 0.14, 0.09, 1200, 7000, 5);
  }

  // 旋转/翻滚：转一圈的气流
  whirl() {
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.34, 0.09, 700, 3400, 1.6);
    this.noiseBurst(t + 0.08, 0.22, 0.05, 3400, 1100, 2.2);
    this.osc('triangle', 220, t, 0.2, 0.03).frequency.exponentialRampToValueAtTime(520, t + 0.2);
  }

  // 过热：蒸汽喷出来，先尖后闷
  steam() {
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.5, 0.1, 7000, 1600, 0.8);
    this.noiseBurst(t + 0.12, 0.4, 0.06, 5000, 1200, 1.1);
    for (let i = 0; i < 3; i++) this.noiseBurst(t + 0.06 + i * 0.11, 0.05, 0.05, 4000, 9000, 4);
  }

  // 被榨干/叹气：往下掉的弱正弦 + 一口气
  sigh() {
    const t = this.ctx.currentTime;
    const o = this.osc('sine', 320, t, 0.45, 0.05);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.42);
    this.noiseBurst(t + 0.05, 0.4, 0.03, 1600, 500, 1.2);
  }

  // 数字毛刺：bit-crush 的碎方块，短促一串
  glitch() {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 9; i++) {
      const at = t + i * rand(0.014, 0.03);
      this.osc('square', rand(600, 5200), at, 0.016, 0.045);
    }
    this.noiseBurst(t, 0.18, 0.08, 9000, 3000, 6);
  }

  // 轻点一下：极短的数码 click
  tap() {
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.012, 0.07, 5000, 9000, 9);
    this.osc('square', 1800, t, 0.014, 0.03);
  }

  // 满足/得意：低低的电子呼噜（她嘴硬，但会哼）
  purr() {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.1;
      this.osc('triangle', 84 - i * 4, at, 0.12, 0.06);
      this.osc('square', 168 - i * 8, at + 0.01, 0.08, 0.02);
    }
    this.noiseBurst(t, 0.3, 0.02, 900, 400, 1.5);
  }

  error() {
    const t = this.ctx.currentTime;
    const o = this.osc('sawtooth', 110, t, 0.32, 0.14);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.3);
    this.noiseBurst(t, 0.25, 0.15, 900, 200, 1.2);
    for (let i = 0; i < 5; i++) this.noiseBurst(t + 0.05 + i * 0.05, 0.02, 0.12, 4000, 4000, 10);
  }
}
