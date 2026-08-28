// Direct Intel AMT boot control.
//
// MeshCentral's 'poweraction' can only ever express "boot to BIOS" or "boot to
// PXE" -- it hardcodes the PXE boot source and has no way to name any other
// one. To reach CD/DVD and hard-drive overrides we drive AMT ourselves, using
// MeshCentral's own WSMAN stack (copied into lib/amt) so the SOAP is identical
// to what the server would have sent.
const AmtStackCreateService = require('./amt/amt.js');
const WsmanComm = require('./amt/amt-wsman-comm.js');
const Wsman = require('./amt/amt-wsman.js');

// A CIM_BootSourceSetting end-point reference, selected by InstanceID.
function bootSourceEpr(instanceId) {
  return '<Address xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2004/08/addressing</Address>' +
         '<ReferenceParameters xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">' +
         '<ResourceURI xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_BootSourceSetting</ResourceURI>' +
         '<SelectorSet xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">' +
         '<Selector Name="InstanceID">' + instanceId + '</Selector>' +
         '</SelectorSet></ReferenceParameters>';
}

// What this API calls a target -> the AMT boot source InstanceID.
// null means "no forced source", i.e. follow the normal BIOS boot order.
const BOOT_SOURCES = {
  hdd:     'Intel(r) AMT: Force Hard-drive Boot',
  pxe:     'Intel(r) AMT: Force PXE Boot',
  cd:      'Intel(r) AMT: Force CD/DVD Boot',
  bios:    null,
  default: null
};

// AMT RequestPowerStateChange values.
const POWER_ON = 2;
const RESET = 10;

function createStack(dev) {
  const comm = WsmanComm(dev.host, dev.port || 16992, dev.user, dev.pass, dev.tls ? 1 : 0, null, null);
  const wsman = Wsman(comm);
  return AmtStackCreateService(wsman);
}

// Wrap a callback-style AMT call as a promise, with a hard timeout so a wedged
// or unreachable AMT never leaves an HTTP request hanging.
function call(fn, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Intel AMT did not respond within ' + ((timeout || 20000) / 1000) + 's.')); } }, timeout || 20000);
    fn((response, status) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (status !== 200) { return reject(new Error('Intel AMT returned status ' + status + '.')); }
      resolve(response);
    });
  });
}

// List the boot sources this particular firmware actually exposes.
async function listBootSources(dev) {
  const stack = createStack(dev);
  const res = await call((done) => {
    stack.BatchEnum(null, ['CIM_BootSourceSetting', '*AMT_BootCapabilities'], (s, name, responses, status) => done(responses, status));
  });
  const sources = ((res['CIM_BootSourceSetting'] || {}).responses || []).map((r) => ({
    instanceId: r['InstanceID'],
    bootString: r['StructuredBootString']
  }));
  const caps = (res['AMT_BootCapabilities'] || {}).response || {};
  return { sources, capabilities: caps };
}

// Force the next boot to a given source, then power on or reset into it.
// Mirrors the sequence MeshCentral uses: Put boot settings, claim the boot
// config role, set the boot order, then change power state.
async function bootTo(dev, opts) {
  const stack = createStack(dev);
  const source = BOOT_SOURCES[opts.target];
  const wantBios = (opts.target === 'bios');

  // Clear any override still in place from an earlier boot before touching the
  // settings. AMT rejects UseIDER=true with InvalidValues while a forced boot
  // order is active, which makes IDER boot look unsupported when it is only
  // dirty state left behind by the previous call.
  await call((done) => {
    stack.CIM_BootConfigSetting_ChangeBootOrder(null, (s, name, response, status) => done(response, status));
  });

  // Read current boot settings so we only change what we mean to.
  const enumRes = await call((done) => {
    stack.BatchEnum(null, ['*AMT_BootSettingData'], (s, name, responses, status) => done(responses, status));
  });
  const bsd = (enumRes['AMT_BootSettingData'] || {}).response;
  if (bsd == null) { throw new Error('Could not read AMT_BootSettingData from the device.'); }

  // Drop the read-only and version-specific fields AMT rejects on a Put.
  bsd['ConfigurationDataReset'] = false;
  ['WinREBootEnabled', 'UEFILocalPBABootEnabled', 'UEFIHTTPSBootEnabled', 'SecureBootControlEnabled',
   'BootguardStatus', 'OptionsCleared', 'BIOSLastStatus', 'UefiBootParametersArray',
   'RPEEnabled', 'RSEPassword'].forEach((k) => { delete bsd[k]; });

  bsd['BIOSSetup'] = wantBios;
  bsd['UseSOL'] = (opts.sol === true);
  bsd['BIOSPause'] = false;

  // Forcing 'cd' alone points the BIOS at the *physical* optical drive. To boot
  // a redirected image the firmware also needs UseIDER, plus which redirected
  // device to use: 0 = floppy, 1 = CD/DVD.
  bsd['UseIDER'] = (opts.ider === true);
  if (opts.ider === true) { bsd['IDERBootDevice'] = (opts.iderDevice === 'floppy') ? 0 : 1; }

  // Which device *within* the chosen class to boot. The boot source only names
  // a class -- 'Force Hard-drive Boot' is one entry however many disks are
  // fitted -- and this index picks among them. 0 leaves the BIOS boot order
  // alone; 1..N select the Nth device of that class.
  bsd['BootMediaIndex'] = (opts.mediaIndex != null) ? Number(opts.mediaIndex) : 0;

  await call((done) => { stack.Put('AMT_BootSettingData', bsd, (s, name, response, status) => done(response, status), 0, 1); });
  await call((done) => { stack.SetBootConfigRole(1, (s, name, response, status) => done(response, status)); });
  await call((done) => { stack.CIM_BootConfigSetting_ChangeBootOrder(source == null ? null : bootSourceEpr(source), (s, name, response, status) => done(response, status)); });

  const powerState = (opts.mode === 'reset') ? RESET : POWER_ON;
  const res = await call((done) => { stack.RequestPowerStateChange(powerState, (s, name, response, status) => done(response, status)); });

  // ReturnValue 0 means AMT accepted the power request.
  const rv = res && res.Body ? res.Body['ReturnValue'] : null;
  return {
    bootSource: source || 'normal boot order',
    mediaIndex: (opts.mediaIndex != null) ? Number(opts.mediaIndex) : 0,
    ider: (opts.ider === true),
    iderBootDevice: (opts.ider === true) ? ((opts.iderDevice === 'floppy') ? 'floppy' : 'cdrom') : null,
    biosSetup: wantBios,
    sol: (opts.sol === true),
    powerState: powerState,
    amtReturnValue: rv,
    accepted: (rv === 0 || rv === '0' || rv == null)
  };
}

module.exports = { listBootSources, bootTo, BOOT_SOURCES };

// Live power state straight from the firmware. MeshCentral caches a `pwr` value
// on the node record and it can sit stale for a long time on an AMT-only node,
// so anything that needs the truth asks AMT itself.
const AMT_POWER_STATES = {
  2: 'on', 3: 'sleep-s1', 4: 'sleep-s3', 6: 'off-hard',
  7: 'hibernate-s4', 8: 'soft-off', 9: 'power-cycle', 13: 'off'
};

async function powerState(dev) {
  const stack = createStack(dev);
  const res = await call((done) => {
    stack.BatchEnum(null, ['CIM_AssociatedPowerManagementService', '*AMT_BootSettingData'],
      (s, name, responses, status) => done(responses, status));
  });
  const list = (res['CIM_AssociatedPowerManagementService'] || {}).responses || [];
  const raw = list.length ? list[0].PowerState : null;
  const bsd = (res['AMT_BootSettingData'] || {}).response || {};
  return {
    powerState: raw,
    status: AMT_POWER_STATES[raw] || 'unknown',
    bootMediaIndex: bsd.BootMediaIndex != null ? bsd.BootMediaIndex : null
  };
}

// Intel AMT is out-of-band: it cannot see the operating system, and on this
// hardware it does not even share an address with it -- SharedMAC is true but
// SharedDynamicIP gives the OS its own DHCP lease. So the OS lives at a
// different IP than AMT, configured per-device as `osHost`.
const net = require('net');
function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(open); } };
    sock.setTimeout(timeout || 2000);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Ordered by how decisive each port is, not by how many match. A Windows box
// with OpenSSH Server answers on 22 as well as 3389, so counting votes ties;
// 3389 and 8006 are the ones that actually identify an OS.
const OS_PORTS = [
  { port: 8006, service: 'Proxmox web UI', decides: 'Proxmox' },
  { port: 3389, service: 'RDP',           decides: 'Windows' },
  { port: 445,  service: 'SMB',           decides: 'Windows' },
  { port: 22,   service: 'SSH',           decides: 'Linux'   }
];

// A dual-boot machine takes a different DHCP lease per OS, so each candidate
// address is probed and the first decisive port across all of them wins.
async function probeOs(hosts) {
  const list = Array.isArray(hosts) ? hosts : [hosts];
  const checks = [];
  for (const host of list) {
    for (const p of OS_PORTS) {
      checks.push(probePort(host, p.port).then((open) => ({
        host: host, port: p.port, service: p.service, decides: p.decides, open: open })));
    }
  }
  const evidence = await Promise.all(checks);
  const open = evidence.filter((e) => e.open);

  // OS_PORTS order is the priority order; take the first one that answered.
  let hit = null;
  for (const p of OS_PORTS) { hit = open.find((e) => e.port === p.port); if (hit) break; }

  return {
    os: hit ? hit.decides : 'none',
    osHost: hit ? hit.host : null,
    reachable: open.length > 0,
    openPorts: open.map((e) => e.host + ' ' + e.service + '/' + e.port),
    evidence: evidence
  };
}

module.exports.powerState = powerState;
module.exports.probeOs = probeOs;
