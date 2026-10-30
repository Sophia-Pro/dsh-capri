'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them.
// Windows: a PowerShell helper does the Win32 calls, we turn its physical pixels into the
// overlay's coordinates. macOS: a small Swift helper (CGWindowListCopyWindowInfo) already
// speaks screen points, so we only shift them into overlay coordinates.

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { screen } = require('electron');

// in the installed app it sits next to the app archive (asarUnpack), where PowerShell can read it
const SCRIPT = path.join(__dirname, 'windows.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// the compiled macOS helper (assets/bin/capri-windows), rebuilt from windows-mac.swift on demand
const MAC_BIN = path.join(__dirname, '..', '..', 'assets', 'bin', 'capri-windows');
const MAC_SRC = path.join(__dirname, 'windows-mac.swift');

function startWindowWatch({ overlay, onUpdate }) {
  if (process.platform === 'darwin') return startMacWatch({ overlay, onUpdate });
  if (process.platform !== 'win32') return { stop() {} };

  let child = null;
  let stopped = false;
  let restarts = 0;

  const handle = overlay.getNativeWindowHandle();
  const self = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));

  const toOverlay = (win, bounds) => {
    const dip = screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h });
    return { id: win.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: win.max };
  };

  const start = () => {
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, String(self), String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let snap;
      try {
        snap = JSON.parse(line);
      } catch {
        return;
      }
      if (overlay.isDestroyed()) return;
      const bounds = overlay.getBounds();
      const wins = snap.wins
        .map((w) => toOverlay(w, bounds))
        // only what overlaps Capri's screen
        .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
      onUpdate({ fg: snap.fg, wins });
    });
    child.stderr.on('data', (d) => console.error('[capri] window watch:', String(d).trim()));
    child.on('exit', () => {
      child = null;
      if (!stopped && restarts++ < 3) setTimeout(start, 3000);
    });
  };

  start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

// macOS: the Swift helper prints one JSON line per change (screen points, front window first).
// No window titles, no contents: CGWindowList only hands over owner pid / layer / bounds.
function startMacWatch({ overlay, onUpdate }) {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');

  let child = null;
  let stopped = false;
  let restarts = 0;

  const build = () => {
    // first launch on a machine without the prebuilt helper: compile it once with the CLT
    try {
      if (fs.existsSync(MAC_BIN)) return true;
      fs.mkdirSync(path.dirname(MAC_BIN), { recursive: true });
      execFileSync('xcrun', ['swiftc', '-O', '-o', MAC_BIN, MAC_SRC], { stdio: 'pipe', timeout: 120000 });
      return true;
    } catch (err) {
      console.error('[capri] window watch: swift compile failed:', String(err && err.message).slice(0, 200));
      return false;
    }
  };

  const start = () => {
    child = spawn(MAC_BIN, [String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let snap;
      try {
        snap = JSON.parse(line);
      } catch {
        return;
      }
      if (overlay.isDestroyed()) return;
      const bounds = overlay.getBounds();
      const wins = (snap.wins || [])
        .map((w) => ({ id: w.id, x: w.x - bounds.x, y: w.y - bounds.y, w: w.w, h: w.h, max: w.max }))
        .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
      if (process.env.CAPRI_DEBUG_WINDOWS) console.error('[capri] mac windows:', JSON.stringify({ fg: snap.fg, n: wins.length, wins: wins.slice(0, 3) }));
      onUpdate({ fg: snap.fg, wins });
    });
    child.stderr.on('data', (d) => console.error('[capri] window watch:', String(d).trim()));
    child.on('error', (err) => console.error('[capri] window watch:', String(err && err.message)));
    child.on('exit', () => {
      child = null;
      if (!stopped && restarts++ < 3) setTimeout(start, 3000);
    });
  };

  if (build()) start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

module.exports = { startWindowWatch };
