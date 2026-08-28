const express = require('express');
const mesh = require('./lib/meshws');
const amtboot = require('./lib/amtboot');
const config = require('./lib/config');
const ider = require('./lib/idermgr');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Every supported operation, mapped to the MeshCentral 'poweraction' actiontype.
//
//   via 'agent' - handled by the MeshAgent inside the OS. These are the truly
//                 graceful operations, but they are silently dropped by the
//                 server if no MeshAgent is connected for the device.
//   via 'amt'   - handled out-of-band by Intel AMT, so they work while the
//                 machine is powered off. actiontype 300 + n, where n is the
//                 AMT RequestPowerStateChange value (2..10), or 11..16 for the
//                 boot-device overrides.
const ACTIONS = {
  // MeshAgent, in-OS
  off:              { type: 2,   via: 'agent', desc: 'Graceful OS shutdown' },
  reset:            { type: 3,   via: 'agent', desc: 'Graceful OS restart' },
  sleep:            { type: 4,   via: 'agent', desc: 'Suspend via the OS' },

  // Intel AMT, out-of-band
  amton:            { type: 302, via: 'amt', desc: 'AMT power on' },
  amtsleep:         { type: 303, via: 'amt', desc: 'AMT sleep, S1 light' },
  amtsleepdeep:     { type: 304, via: 'amt', desc: 'AMT sleep, S3 deep (suspend to RAM)' },
  amtcycle:         { type: 305, via: 'amt', desc: 'AMT power cycle, off soft then on' },
  amthardoff:       { type: 306, via: 'amt', desc: 'AMT power off, hard' },
  amthibernate:     { type: 307, via: 'amt', desc: 'AMT hibernate, S4' },
  amtoff:           { type: 308, via: 'amt', desc: 'AMT power off, soft' },
  amtreset:         { type: 310, via: 'amt', desc: 'AMT reset' },

  // Intel AMT boot-device overrides
  amtbios:          { type: 311, via: 'amt', desc: 'Power on, boot into BIOS setup' },
  amtresetbios:     { type: 312, via: 'amt', desc: 'Reset, boot into BIOS setup' },
  amtbiossol:       { type: 313, via: 'amt', desc: 'Power on, boot into BIOS setup with Serial-over-LAN' },
  amtresetbiossol:  { type: 314, via: 'amt', desc: 'Reset, boot into BIOS setup with Serial-over-LAN' },
  amtpxe:           { type: 315, via: 'amt', desc: 'Power on, boot from PXE (network)' },
  amtresetpxe:      { type: 316, via: 'amt', desc: 'Reset, boot from PXE (network)' },

  // Wake-on-LAN, a separate MeshCentral action
  wake:             { type: null, via: 'wake', desc: 'Send a Wake-on-LAN magic packet' }
};

// Names the API accepted before this version, kept so existing callers keep working.
const ALIASES = { poweron: 'amton', poweroff: 'amtoff', softreset: 'reset', softoff: 'off' };

function resolveAction(name) {
  const key = String(name || '').toLowerCase();
  return ACTIONS[key] ? key : (ALIASES[key] || null);
}

// Pull and validate the MeshCentral connection details out of a request body.
function readCreds(req, res) {
  const { url, loginuser, loginpass, deviceid } = req.body || {};
  if (!url || !loginuser || !loginpass || !deviceid) {
    res.status(400).json({
      success: false,
      error: 'Missing required parameters: url, loginuser, loginpass, deviceid'
    });
    return null;
  }
  return { cfg: { url, loginuser, loginpass, token: req.body.token }, deviceid };
}

// Run one named action against a device.
async function runAction(cfg, deviceid, actionKey) {
  const action = ACTIONS[actionKey];
  if (action.via === 'wake') { await mesh.wakeDevice(cfg, deviceid); }
  else { await mesh.powerAction(cfg, deviceid, action.type); }
  return { success: true, action: actionKey, via: action.via, actiontype: action.type, description: action.desc };
}

// MeshCentral acknowledges a poweraction immediately and never reports what the
// device actually did, so optionally watch the power state settle instead.
async function verifyPowerState(cfg, deviceid, expected, seconds) {
  const deadline = Date.now() + (seconds * 1000);
  let node = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try { node = await mesh.getNode(cfg, deviceid); } catch (ex) { continue; }
    if (node && expected.includes(mesh.powerStateName(node.pwr))) {
      return { reached: true, powerState: mesh.powerStateName(node.pwr), pwr: node.pwr };
    }
  }
  return {
    reached: false,
    powerState: node ? mesh.powerStateName(node.pwr) : 'unknown',
    pwr: node ? node.pwr : null,
    note: 'Device did not reach ' + expected.join('/') + ' within ' + seconds + 's.'
  };
}

// Decide whether to go through the MeshAgent or Intel AMT.
async function pickRoute(cfg, deviceid, method) {
  const m = String(method || 'auto').toLowerCase();
  if (m === 'agent' || m === 'amt') return { route: m, node: null };
  if (m !== 'auto') { throw { success: false, error: "Invalid method. Use 'auto', 'agent' or 'amt'." }; }
  const node = await mesh.getNode(cfg, deviceid);
  if (node == null) { throw { success: false, error: 'Device not found on this MeshCentral server.' }; }
  if (mesh.hasAgent(node)) return { route: 'agent', node };
  if (mesh.hasAmt(node)) return { route: 'amt', node };
  throw { success: false, error: 'Device is not reachable: neither a MeshAgent nor an Intel AMT connection is active.' };
}

function fail(res, error) {
  if (error && error.success === false) return res.status(error.error && /not found|Invalid|not reachable/.test(error.error) ? 400 : 500).json(error);
  return res.status(500).json({ success: false, error: (error && error.message) || String(error) });
}

// ---------------------------------------------------------------- endpoints

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'meshctrl-api' });
});

// Discoverability: what this service can do.
app.get('/actions', (req, res) => {
  res.json({
    success: true,
    actions: Object.keys(ACTIONS).map((k) => ({ action: k, via: ACTIONS[k].via, actiontype: ACTIONS[k].type, description: ACTIONS[k].desc })),
    aliases: ALIASES
  });
});

// Generic power control.
app.post('/device/power', async (req, res) => {
  const creds = readCreds(req, res); if (!creds) return;
  const actionKey = resolveAction(req.body.action);
  if (!actionKey) {
    return res.status(400).json({
      success: false,
      error: 'Invalid action. Valid actions: ' + Object.keys(ACTIONS).join(', ')
    });
  }
  try { res.json(await runAction(creds.cfg, creds.deviceid, actionKey)); }
  catch (error) { fail(res, error); }
});

// Safe shutdown. Prefers the in-OS agent, falls back to an AMT soft power off.
app.post('/device/shutdown', async (req, res) => {
  const creds = readCreds(req, res); if (!creds) return;
  try {
    const { route } = await pickRoute(creds.cfg, creds.deviceid, req.body.method);
    const actionKey = (route === 'agent') ? 'off' : 'amtoff';
    const result = await runAction(creds.cfg, creds.deviceid, actionKey);
    if (route === 'amt') {
      result.warning = 'Sent over Intel AMT (no MeshAgent connected). AMT soft-off asks the firmware to power down; without Intel LMS running in the OS this is not an OS-level graceful shutdown, so unsaved work may be lost.';
    }
    if (req.body.verify) { result.verify = await verifyPowerState(creds.cfg, creds.deviceid, ['soft-off', 'off', 'off-hard'], Number(req.body.verify) > 1 ? Number(req.body.verify) : 60); }
    res.json(result);
  } catch (error) { fail(res, error); }
});

// Suspend / sleep.
app.post('/device/sleep', async (req, res) => {
  const creds = readCreds(req, res); if (!creds) return;
  const depth = String(req.body.depth || 'deep').toLowerCase();
  if (depth !== 'deep' && depth !== 'light') {
    return res.status(400).json({ success: false, error: "Invalid depth. Use 'deep' (S3) or 'light' (S1)." });
  }
  try {
    const { route } = await pickRoute(creds.cfg, creds.deviceid, req.body.method);
    const actionKey = (route === 'agent') ? 'sleep' : (depth === 'deep' ? 'amtsleepdeep' : 'amtsleep');
    const result = await runAction(creds.cfg, creds.deviceid, actionKey);
    if (route === 'amt') {
      result.warning = 'Sent over Intel AMT (no MeshAgent connected). Many AMT firmware builds reject sleep requests unless Intel LMS is running in the OS; check the verify block or /device/status to confirm it took effect.';
    }
    if (req.body.verify) { result.verify = await verifyPowerState(creds.cfg, creds.deviceid, ['sleep-s1', 'sleep-s2', 'sleep-s3'], Number(req.body.verify) > 1 ? Number(req.body.verify) : 60); }
    res.json(result);
  } catch (error) { fail(res, error); }
});

// Boot-device targets and how each route can express them.
//
// The direct-AMT route drives the firmware itself and can name any boot source
// the device exposes. The MeshCentral route can only ever do BIOS or PXE,
// because the server hardcodes those two.
const BOOT_TARGETS = ['bios', 'pxe', 'cd', 'hdd', 'default'];
const MESH_BOOT_ACTIONS = {
  'bios:poweron': 'amtbios', 'bios:reset': 'amtresetbios',
  'biossol:poweron': 'amtbiossol', 'biossol:reset': 'amtresetbiossol',
  'pxe:poweron': 'amtpxe', 'pxe:reset': 'amtresetpxe',
  'default:poweron': 'amton', 'default:reset': 'amtreset'
};

// What boot sources this device's firmware actually offers. Read-only.
async function bootOptionsHandler(req, res) {
  req.body = Object.assign({}, req.query, req.body);
  const deviceid = req.body.deviceid;
  if (!deviceid) { return res.status(400).json({ success: false, error: 'Missing required parameter: deviceid' }); }
  const dev = config.amtDevice(deviceid, req.body);
  if (dev == null) {
    return res.status(400).json({ success: false, error: 'No Intel AMT credentials configured for this device. Add it to ' + config.CONFIG_PATH + '.' });
  }
  try {
    const info = await amtboot.listBootSources(dev);
    const caps = info.capabilities || {};
    res.json({
      success: true,
      deviceid: deviceid,
      host: dev.host,
      bootSources: info.sources,
      targets: {
        hdd: caps.ForceHardDriveBoot === true,
        pxe: caps.ForcePXEBoot === true,
        cd: caps.ForceCDorDVDBoot === true,
        bios: caps.BIOSSetup === true,
        default: true
      },
      sol: caps.SOL === true,
      ider: caps.IDER === true,
      note: 'Intel AMT selects a boot device class, not an individual disk. Choosing a specific OS across several drives needs the bootloader or BIOS setup.'
    });
  } catch (error) { fail(res, error); }
}

app.get('/device/boot/options', bootOptionsHandler);
app.post('/device/boot/options', bootOptionsHandler);

// Change the boot device for the next boot, then power on or reset into it.
// The override applies to a single boot; the machine reverts afterwards.
app.post('/device/boot', async (req, res) => {
  const creds = readCreds(req, res); if (!creds) return;
  let target = String(req.body.target || '').toLowerCase();
  const mode = String(req.body.mode || 'poweron').toLowerCase();
  const sol = req.body.sol === true;
  const via = String(req.body.via || 'auto').toLowerCase();

  if (target === 'hd' || target === 'harddrive' || target === 'disk') { target = 'hdd'; }
  if (target === 'cdrom' || target === 'dvd' || target === 'iso') { target = 'cd'; }

  if (BOOT_TARGETS.indexOf(target) === -1) {
    return res.status(400).json({ success: false, error: 'Invalid target. Use one of: ' + BOOT_TARGETS.join(', ') + '.' });
  }
  if (mode !== 'poweron' && mode !== 'reset') {
    return res.status(400).json({ success: false, error: "Invalid mode. Use 'poweron' (from off) or 'reset' (while running)." });
  }
  if (via !== 'auto' && via !== 'amt' && via !== 'meshcentral') {
    return res.status(400).json({ success: false, error: "Invalid via. Use 'auto', 'amt' or 'meshcentral'." });
  }

  const dev = (via === 'meshcentral') ? null : config.amtDevice(creds.deviceid, req.body);
  const needsDirect = (target === 'cd' || target === 'hdd');

  if (dev == null) {
    if (via === 'amt') {
      return res.status(400).json({ success: false, error: 'No Intel AMT credentials configured for this device. Add it to ' + config.CONFIG_PATH + '.' });
    }
    if (needsDirect) {
      const why = (via === 'meshcentral')
        ? "MeshCentral's poweraction can only express 'bios' and 'pxe'. Drop via, or use via 'amt'."
        : 'No AMT credentials are configured for this device. Add it to ' + config.CONFIG_PATH + ", or use target 'bios' and pick the device from setup.";
      return res.status(400).json({
        success: false,
        error: "Target '" + target + "' can only be set by talking to Intel AMT directly. " + why
      });
    }
    // Fall back to routing through MeshCentral.
    const key = (target === 'bios' && sol ? 'biossol' : target) + ':' + mode;
    try {
      const result = await runAction(creds.cfg, creds.deviceid, MESH_BOOT_ACTIONS[key]);
      result.route = 'meshcentral';
      result.target = target;
      result.mode = mode;
      if (target === 'bios') { result.sol = sol; }
      return res.json(result);
    } catch (error) { return fail(res, error); }
  }

  try {
    const r = await amtboot.bootTo(dev, { target: target, mode: mode, sol: sol });
    res.json({
      success: true,
      route: 'amt',
      target: target,
      mode: mode,
      sol: sol,
      bootSource: r.bootSource,
      biosSetup: r.biosSetup,
      amtReturnValue: r.amtReturnValue,
      accepted: r.accepted,
      note: 'Boot override applies to the next boot only.'
    });
  } catch (error) { fail(res, error); }
});

// ------------------------------------------------------------------- IDER
//
// IDE Redirection streams a local disk image to the machine as if it were a
// physically attached CD or floppy. It is the only way to boot this box into an
// OS of your choosing from cold, since AMT 11 cannot name an individual disk.
//
// A session is long-lived: keep it running for as long as the target needs to
// read the image, then stop it.

// What images are available to mount.
app.get('/device/ider/images', (req, res) => { res.json(Object.assign({ success: true }, ider.listImages())); });

function iderDevice(req, res) {
  const deviceid = req.body.deviceid;
  if (!deviceid) { res.status(400).json({ success: false, error: 'Missing required parameter: deviceid' }); return null; }
  const dev = config.amtDevice(deviceid, req.body);
  if (dev == null) {
    res.status(400).json({ success: false, error: 'No Intel AMT credentials configured for this device. Add it to ' + config.CONFIG_PATH + '.' });
    return null;
  }
  return { deviceid, dev };
}

app.post('/device/ider/start', async (req, res) => {
  const d = iderDevice(req, res); if (!d) return;
  try {
    const session = await ider.start(d.deviceid, d.dev, {
      cdrom: req.body.cdrom, floppy: req.body.floppy, iderstart: req.body.iderstart
    });
    res.json({
      success: true,
      session: session,
      next: "Session is up. Boot the image with POST /device/boot {\"target\":\"cd\",\"mode\":\"reset\"}, then stop the session when the target no longer needs it."
    });
  } catch (error) { fail(res, error); }
});

function iderStatusHandler(req, res) {
  req.body = Object.assign({}, req.query, req.body);
  if (!req.body.deviceid) { return res.status(400).json({ success: false, error: 'Missing required parameter: deviceid' }); }
  res.json(Object.assign({ success: true }, ider.describe(req.body.deviceid)));
}
app.get('/device/ider/status', iderStatusHandler);
app.post('/device/ider/status', iderStatusHandler);

app.post('/device/ider/stop', (req, res) => {
  if (!req.body.deviceid) { return res.status(400).json({ success: false, error: 'Missing required parameter: deviceid' }); }
  res.json(Object.assign({ success: true }, ider.stop(req.body.deviceid)));
});

// Mount an image and boot straight into it, in one call.
app.post('/device/ider/boot', async (req, res) => {
  const creds = readCreds(req, res); if (!creds) return;
  const d = iderDevice(req, res); if (!d) return;
  const mode = String(req.body.mode || 'reset').toLowerCase();
  if (mode !== 'poweron' && mode !== 'reset') {
    return res.status(400).json({ success: false, error: "Invalid mode. Use 'poweron' or 'reset'." });
  }
  let session = null;
  try {
    session = ider.isActive(d.deviceid)
      ? ider.describe(d.deviceid)
      : await ider.start(d.deviceid, d.dev, { cdrom: req.body.cdrom, floppy: req.body.floppy, iderstart: req.body.iderstart });
  } catch (error) { return fail(res, error); }

  try {
    const useFloppy = (req.body.floppy && !req.body.cdrom);
    const opts = { target: 'cd', mode: mode, sol: req.body.sol === true, ider: true, iderDevice: useFloppy ? 'floppy' : 'cdrom' };
    let r, warning;
    try {
      r = await amtboot.bootTo(d.dev, opts);
    } catch (ex) {
      // Some firmware refuses UseIDER=true outright (AMT 11 on the ThinkStation
      // P520 answers InvalidRepresentation/InvalidValues). Still force a CD
      // boot so the attempt is not wasted, but say what was lost.
      if (!/status 400/.test(ex.message)) { throw ex; }
      opts.ider = false;
      r = await amtboot.bootTo(d.dev, opts);
      warning = 'This firmware rejected UseIDER (AMT returned InvalidValues), so the boot was forced to CD/DVD without marking the redirected drive as the boot device. The BIOS may read a little of the image and then fall through to its normal boot order. Watch sectorsServed: a real boot pushes it into the thousands.';
    }
    res.json({
      success: true, session: session, boot: r,
      warning: warning,
      note: 'Leave the IDER session running until the target has finished reading the image, then POST /device/ider/stop.'
    });
  } catch (error) {
    // Booting failed, so do not strand a session nobody asked to keep.
    ider.stop(d.deviceid);
    fail(res, error);
  }
});

// Convenience wrappers, unchanged request/response shape.
app.post('/device/amt/on', async (req, res) => {
  const creds = readCreds(req, res); if (!creds) return;
  try { res.json(await runAction(creds.cfg, creds.deviceid, 'amton')); }
  catch (error) { fail(res, error); }
});

app.post('/device/amt/off', async (req, res) => {
  const creds = readCreds(req, res); if (!creds) return;
  try { res.json(await runAction(creds.cfg, creds.deviceid, 'amtoff')); }
  catch (error) { fail(res, error); }
});

// Live power state and connectivity. Reads the node record over the control
// channel, which is where 'pwr' and 'conn' actually live.
async function statusHandler(req, res) {
  const body = Object.assign({}, req.query, req.body);
  req.body = body;
  const creds = readCreds(req, res); if (!creds) return;
  try {
    const node = await mesh.getNode(creds.cfg, creds.deviceid);
    if (node == null) { return res.status(404).json({ success: false, error: 'Device not found on this MeshCentral server.' }); }
    const conn = node.conn | 0;
    res.json({
      success: true,
      deviceid: mesh.shortId(node._id),
      name: node.name || 'N/A',
      status: mesh.powerStateName(node.pwr),
      powerState: node.pwr != null ? node.pwr : null,
      connectivity: { agent: (conn & 1) !== 0, cira: (conn & 2) !== 0, amt: (conn & 4) !== 0, raw: conn },
      amtVersion: node.intelamt ? node.intelamt.ver : null
    });
  } catch (error) { fail(res, error); }
}

app.post('/device/amt/status', statusHandler);
app.post('/device/status', statusHandler);
app.get('/device/status', statusHandler);

let shuttingDown = false;
function onShutdownSignal() {
  if (shuttingDown) return; // a second signal must not pre-empt the first
  shuttingDown = true;
  ider.shutdown(() => process.exit(0));
}
process.on('SIGTERM', onShutdownSignal);
process.on('SIGINT', onShutdownSignal);

app.listen(PORT, () => {
  console.log(`MeshCtrl API service running on port ${PORT}`);
});
