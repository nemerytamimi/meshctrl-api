// IDER session child process.
//
// An IDER session is long-lived: it stays up while the target boots off the
// redirected image and streams every sector read on demand. Running it in a
// child keeps a wedged or crashing redirection away from the API process, and
// lets us kill it cleanly.
//
// This is meshcmd's performIder() rebuilt for plain Node. meshcmd opens the
// image with fs flag 'rbN', which only the MeshAgent's duktape fs understands,
// and it also passes the username wrong ('admin' whenever one is set).
const fs = require('fs');
const crypto = require('crypto');

// amt-redir-duk.js expects the MeshAgent's extended 'tls' module. It uses one
// function node's tls does not have, for the digest-auth cnonce.
// amt-ider.js reads sectors through a bare global 'fs', which the MeshAgent
// runtime provides and node does not.
global.fs = fs;

const tls = require('tls');
if (typeof tls.generateRandomInteger !== 'function') {
  tls.generateRandomInteger = function (min, max) {
    return crypto.randomInt(parseInt(min, 10), parseInt(max, 10) + 1);
  };
}

process.env.NODE_PATH = [
  __dirname + '/shims',
  __dirname + '/../node_modules',
  '/usr/lib/node_modules/meshcentral/agents/modules_meshcmd'
].join(':');
require('module')._initPaths();

const STATES = ['disconnected', 'connecting', 'connected', 'started'];
let ider = null;
let openFds = [];

function send(msg) { try { process.send(msg); } catch (ex) { } }

function openImage(file) {
  const st = fs.statSync(file);
  st.file = fs.openSync(file, 'r');
  openFds.push(st.file);
  return st;
}

function start(cfg) {
  const cdrom = cfg.cdrom ? openImage(cfg.cdrom) : null;
  const floppy = cfg.floppy ? openImage(cfg.floppy) : null;

  ider = require('amt-redir-duk')(require('amt-ider')());
  ider.onStateChanged = function (stack, state) {
    send({ type: 'state', state: STATES[state] || ('unknown:' + state) });
  };
  ider.m.floppy = floppy;
  ider.m.cdrom = cdrom;
  // 0 = on reboot, 1 = graceful, 2 = now
  ider.m.iderStart = ['onreboot', 'graceful', 'now'].indexOf(cfg.iderstart || 'graceful');
  if (ider.m.iderStart < 0) { ider.m.iderStart = 1; }
  ider.m.debug = false;

  // Report sector traffic so the API can tell a live boot from a dead session.
  let sectors = 0, lastSent = 0;
  ider.m.sectorStats = function () {
    sectors++;
    const now = Date.now();
    if (now - lastSent > 500) { lastSent = now; send({ type: 'sectors', sectors: sectors }); }
  };

  ider.Start(cfg.host, cfg.tls ? 16995 : 16994, cfg.user, cfg.pass, cfg.tls ? 1 : 0);
  send({ type: 'started' });
}

function stop() {
  try { if (ider && ider.Stop) ider.Stop(); } catch (ex) { }
  openFds.forEach((fd) => { try { fs.closeSync(fd); } catch (ex) { } });
  openFds = [];
  process.exit(0);
}

process.on('message', (msg) => {
  if (msg && msg.cmd === 'start') {
    try { start(msg); } catch (ex) { send({ type: 'error', error: ex.message }); process.exit(1); }
  } else if (msg && msg.cmd === 'stop') { stop(); }
});

process.on('SIGTERM', stop);
process.on('uncaughtException', (ex) => { send({ type: 'error', error: ex.message }); process.exit(1); });
