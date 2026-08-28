// Minimal MeshCentral control websocket client.
//
// The meshctrl CLI only exposes 7 fixed power operations (wake/reset/sleep/off/
// amton/amtoff/amtreset). Boot-device control and the AMT sleep states need
// 'poweraction' actiontype values that the CLI has no flags for, so we talk to
// /control.ashx directly the same way meshctrl does.
const WebSocket = require('ws');

const DEFAULT_TIMEOUT = 20000;

// Turn 'wss://host' into 'wss://host/control.ashx', preserving a ?key= login key.
function buildUrl(url) {
  if (typeof url !== 'string' || url.length < 5) { throw new Error('Invalid url.'); }
  if (!url.startsWith('wss://') && !url.startsWith('ws://')) { throw new Error('Invalid url, must start with ws:// or wss://'); }
  let loginKey = null;
  const i = url.indexOf('?key=');
  if (i >= 0) { loginKey = url.substring(i + 5); url = url.substring(0, i); }
  if (!url.endsWith('/')) { url += '/'; }
  url += 'control.ashx';
  if (loginKey != null) { url += '?key=' + loginKey; }
  return url;
}

// Connect, send one command, resolve with the matching response.
// `match` decides which incoming message is the answer we are waiting for.
function request(cfg, command, match, timeout) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = buildUrl(cfg.url); } catch (err) { return reject({ success: false, error: err.message }); }

    const options = {
      rejectUnauthorized: false,
      checkServerIdentity: function () { return null; },
      headers: {
        'x-meshauth': Buffer.from('' + (cfg.loginuser || 'admin')).toString('base64') + ',' +
                      Buffer.from('' + cfg.loginpass).toString('base64') +
                      (cfg.token != null ? ',' + Buffer.from('' + cfg.token).toString('base64') : '')
      }
    };

    const ws = new WebSocket(url, options);
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch (ex) { } fn(arg); };
    const timer = setTimeout(() => { done(reject, { success: false, error: 'Timed out waiting for MeshCentral response.' }); }, timeout || DEFAULT_TIMEOUT);

    ws.on('open', () => { ws.send(JSON.stringify(Object.assign({ responseid: 'meshctrl-api' }, command))); });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (ex) { return; }
      if (msg.action === 'close' || msg.action === 'serverauth') {
        return done(reject, { success: false, error: 'MeshCentral rejected the login: ' + (msg.msg || msg.cause || msg.action) });
      }
      if (match(msg)) { done(resolve, msg); }
    });

    ws.on('close', () => { done(reject, { success: false, error: 'MeshCentral closed the connection before responding (check login credentials).' }); });
    ws.on('error', (err) => { done(reject, { success: false, error: err.message }); });
  });
}

// Strip the 'node//' prefix MeshCentral uses internally.
function shortId(nodeid) {
  if (typeof nodeid !== 'string') return nodeid;
  const parts = nodeid.split('/');
  return parts[parts.length - 1];
}

// Fetch a single node record, which carries the live 'conn' and 'pwr' fields.
async function getNode(cfg, deviceid) {
  const msg = await request(cfg, { action: 'nodes' }, (m) => m.action === 'nodes' && m.responseid === 'meshctrl-api');
  const want = shortId(deviceid);
  for (const meshid in msg.nodes) {
    for (const node of msg.nodes[meshid]) {
      if (shortId(node._id) === want) return node;
    }
  }
  return null;
}

// Send a raw poweraction. See ACTIONS in server.js for the actiontype values.
async function powerAction(cfg, deviceid, actiontype) {
  const msg = await request(cfg, { action: 'poweraction', nodeids: [shortId(deviceid)], actiontype: actiontype },
    (m) => m.action === 'poweraction' && m.responseid === 'meshctrl-api');
  return { result: msg.result || 'ok' };
}

// conn is a bitmask: 1 = MeshAgent, 2 = CIRA, 4 = Intel AMT, 8 = relay/other.
function hasAgent(node) { return node != null && ((node.conn | 0) & 1) !== 0; }
function hasAmt(node) { return node != null && ((node.conn | 0) & 4) !== 0; }

// MeshCentral normalised power states.
const POWER_STATES = {
  0: 'unknown', 1: 'on', 2: 'sleep-s1', 3: 'sleep-s2', 4: 'sleep-s3',
  5: 'hibernate-s4', 6: 'soft-off', 7: 'off-hard', 8: 'hibernate', 9: 'off'
};
function powerStateName(pwr) { return POWER_STATES[pwr] != null ? POWER_STATES[pwr] : 'unknown'; }

module.exports = { getNode, powerAction, hasAgent, hasAmt, shortId, powerStateName };

// 'wake' is a separate MeshCentral action, not a poweraction actiontype.
async function wakeDevice(cfg, deviceid) {
  const msg = await request(cfg, { action: 'wakedevices', nodeids: [shortId(deviceid)] },
    (m) => m.action === 'wakedevices' || (m.action === 'msg' && m.type === 'wakeonlan'));
  return { result: msg.result || 'ok' };
}
module.exports.wakeDevice = wakeDevice;
