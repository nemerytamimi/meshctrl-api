// AMT credentials live on disk, not in request bodies. See config.json.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.MESHCTRL_API_CONFIG || path.join(__dirname, '..', 'config.json');

let cache = null;

function load() {
  try { cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (ex) { cache = { amt: { defaults: {}, devices: {} } }; if (ex.code !== 'ENOENT') { console.log('config.json could not be parsed: ' + ex.message); } }
  return cache;
}

function get() { return cache || load(); }

// Resolve the AMT connection for a device: config first, then any explicit
// override in the request body (handy for a device not yet in config.json).
function amtDevice(deviceid, body) {
  const cfg = get().amt || {};
  const defaults = cfg.defaults || {};
  const entry = (cfg.devices || {})[deviceid];
  body = body || {};

  const host = body.amthost || (entry && entry.host);
  const user = body.amtuser || (entry && entry.user) || defaults.user || 'admin';
  const pass = body.amtpass || (entry && entry.pass);
  if (!host || !pass || pass === 'REPLACE_ME') return null;

  return {
    host: host,
    port: body.amtport || (entry && entry.port) || defaults.port || 16992,
    user: user,
    pass: pass,
    tls: (body.amttls != null) ? !!body.amttls : ((entry && entry.tls != null) ? !!entry.tls : !!defaults.tls)
  };
}

module.exports = { load, get, amtDevice, CONFIG_PATH };
