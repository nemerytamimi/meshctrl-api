// Tracks live IDER sessions, one per device.
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const RUNNER = path.join(__dirname, 'ider-runner.js');
const sessions = new Map();

function imagesDir() {
  const cfg = config.get().ider || {};
  return cfg.imagesDir || path.join(__dirname, '..', 'images');
}

// Only ever open files inside the images directory, whatever the caller sends.
function resolveImage(name) {
  if (typeof name !== 'string' || name === '') { throw new Error('Image name must be a non-empty string.'); }
  const dir = path.resolve(imagesDir());
  const full = path.resolve(dir, name);
  if (full !== dir && !full.startsWith(dir + path.sep)) {
    throw new Error('Image must be inside ' + dir + '.');
  }
  if (!fs.existsSync(full)) { throw new Error('Image not found: ' + name); }
  return full;
}

function listImages() {
  const dir = imagesDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (ex) { return { dir: dir, images: [], error: 'Images directory not readable.' }; }
  const images = names.filter((n) => !n.startsWith('.')).map((n) => {
    let st = null;
    try { st = fs.statSync(path.join(dir, n)); } catch (ex) { return null; }
    if (!st.isFile()) return null;
    return { name: n, bytes: st.size, mb: Math.round(st.size / 1048576), modified: st.mtime.toISOString() };
  }).filter((x) => x != null);
  return { dir: dir, images: images };
}

function describe(deviceid) {
  const s = sessions.get(deviceid);
  if (s == null) { return { active: false, deviceid: deviceid }; }
  return {
    active: true,
    deviceid: deviceid,
    state: s.state,
    cdrom: s.cdrom,
    floppy: s.floppy,
    iderstart: s.iderstart,
    sectorsServed: s.sectors,
    startedAt: s.startedAt,
    pid: s.child.pid,
    error: s.error || undefined
  };
}

// Start a session and resolve once IDER is actually up, not merely spawned.
function start(deviceid, dev, opts) {
  return new Promise((resolve, reject) => {
    if (sessions.has(deviceid)) { return reject(new Error('An IDER session is already running for this device. Stop it first.')); }

    let cdrom = null, floppy = null;
    try {
      if (opts.cdrom) { cdrom = resolveImage(opts.cdrom); }
      if (opts.floppy) { floppy = resolveImage(opts.floppy); }
    } catch (ex) { return reject(ex); }
    if (cdrom == null && floppy == null) { return reject(new Error('Specify a cdrom and/or floppy image.')); }

    const iderstart = opts.iderstart || 'graceful';
    if (['onreboot', 'graceful', 'now'].indexOf(iderstart) === -1) {
      return reject(new Error("Invalid iderstart. Use 'onreboot', 'graceful' or 'now'."));
    }

    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const s = {
      child, state: 'connecting', sectors: 0, error: null,
      cdrom: opts.cdrom || null, floppy: opts.floppy || null,
      iderstart, startedAt: new Date().toISOString()
    };
    sessions.set(deviceid, s);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (ex) { }
      sessions.delete(deviceid);
      reject(new Error('IDER session did not start within 30s.'));
    }, 30000);

    child.on('message', (m) => {
      if (m.type === 'state') {
        s.state = m.state;
        if ((m.state === 'connected' || m.state === 'started') && !settled) {
          settled = true; clearTimeout(timer); resolve(describe(deviceid));
        }
        if (m.state === 'disconnected') { sessions.delete(deviceid); }
      } else if (m.type === 'sectors') { s.sectors = m.sectors; }
      else if (m.type === 'error') {
        s.error = m.error;
        if (!settled) { settled = true; clearTimeout(timer); sessions.delete(deviceid); reject(new Error(m.error)); }
      }
    });

    child.on('exit', () => {
      if (sessions.get(deviceid) === s) { sessions.delete(deviceid); }
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(s.error || 'IDER process exited before the session started.')); }
    });

    // Credentials go over IPC, never argv or env, so they stay out of `ps`.
    child.send({
      cmd: 'start', host: dev.host, user: dev.user, pass: dev.pass, tls: dev.tls,
      cdrom: cdrom, floppy: floppy, iderstart: iderstart
    });
  });
}

function stop(deviceid) {
  const s = sessions.get(deviceid);
  if (s == null) { return { stopped: false, reason: 'No IDER session running for this device.' }; }
  try { s.child.send({ cmd: 'stop' }); } catch (ex) { }
  setTimeout(() => { try { s.child.kill(); } catch (ex) { } }, 2000);
  sessions.delete(deviceid);
  return { stopped: true, deviceid: deviceid };
}

// Shutdown path. stop() schedules its kill on a timer, which never fires if the
// caller exits on the same tick -- that orphans any child which misses or
// ignores the IPC stop, leaving an AMT redirection open. So ask everyone to
// stop, wait a bounded time for them to actually exit, then kill the rest.
// The caller must not exit until `done` fires.
function shutdown(done, graceMs) {
  const children = Array.from(sessions.values()).map((s) => s.child);
  sessions.clear();
  if (children.length === 0) { return done(); }

  let pending = children.length, finished = false;
  const finish = () => { if (!finished) { finished = true; clearTimeout(timer); done(); } };

  const timer = setTimeout(() => {
    children.forEach((c) => { try { c.kill('SIGKILL'); } catch (ex) { } });
    finish();
  }, graceMs || 3000);

  children.forEach((c) => {
    c.once('exit', () => { if (--pending === 0) { finish(); } });
    try { c.send({ cmd: 'stop' }); } catch (ex) { try { c.kill('SIGKILL'); } catch (e) { } }
  });
}

module.exports = { start, stop, shutdown, describe, listImages, resolveImage, imagesDir, isActive: (id) => sessions.has(id) };
