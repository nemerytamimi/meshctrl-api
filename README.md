# MeshCtrl API Service

A REST API service for managing MeshCentral device power operations, including
Intel AMT out-of-band control.

## Installation

The service is installed at `/opt/meshctrl-api` and runs on port **3001**.

### Dependencies
- Node.js and npm
- MeshCentral (provides the `meshctrl` command, used for ad-hoc CLI checks)

To reinstall dependencies:
```bash
cd /opt/meshctrl-api
npm install
```

## How it talks to MeshCentral

The service connects straight to the MeshCentral control websocket
(`wss://<server>/control.ashx`) using the same `x-meshauth` login the `meshctrl`
CLI uses. It does not shell out to `meshctrl`, because the CLI only exposes
seven fixed power operations and has no flags at all for boot-device overrides
or the Intel AMT sleep states.

Everything is sent as a MeshCentral `poweraction` with an `actiontype`:

| Route | actiontype | Meaning |
| --- | --- | --- |
| MeshAgent (in-OS) | 2, 3, 4 | Graceful shutdown / restart / suspend |
| Intel AMT (out-of-band) | 300 + *n* | *n* is the AMT `RequestPowerStateChange` value (2–10) |
| Intel AMT boot override | 311–316 | Boot to BIOS setup or PXE, with power-on or reset |

### Agent vs AMT — important

**Truly graceful shutdown and suspend require a MeshAgent installed inside the
OS on the target machine.** MeshCentral routes actiontypes 2/3/4 to that agent;
if no agent is connected, the server silently drops them.

For an AMT-only device, the closest equivalents are the AMT firmware power
states. AMT soft-off (`amtoff`) asks the firmware to power down and, without
Intel LMS running in the OS, is *not* an OS-level graceful shutdown. AMT sleep
is frequently rejected by firmware for the same reason. The `/device/shutdown`
and `/device/sleep` endpoints detect which route is available, use the best one,
and return a `warning` field when they had to fall back to AMT.

Check which route a device has with `GET /device/status` → `connectivity.agent`.

## API Endpoints

Base URL: `http://localhost:3001`

All device endpoints take the same connection fields in the JSON body:

- `url` — MeshCentral server websocket URL, e.g. `wss://mc.example.com`
- `loginuser` — login username (login-token format works)
- `loginpass` — login password
- `deviceid` — target device id
- `token` — optional, 2nd-factor authentication token

### Health Check
```
GET /health
```
Returns: `{"status": "ok", "service": "meshctrl-api"}`

### List supported actions
```
GET /actions
```
Returns every action name, which route it uses, and its actiontype.

### Device status
```
GET  /device/status
POST /device/status
POST /device/amt/status   (alias, kept for existing callers)
```
Returns the live power state and connectivity:
```json
{
  "success": true,
  "deviceid": "2BgTHkUOFCI8am0...",
  "name": "10.10.0.234",
  "status": "soft-off",
  "powerState": 6,
  "connectivity": { "agent": false, "cira": false, "amt": true, "raw": 4 },
  "amtVersion": "11.12.96"
}
```
`status` is one of: `on`, `sleep-s1`, `sleep-s2`, `sleep-s3`, `hibernate-s4`,
`soft-off`, `off-hard`, `hibernate`, `off`, `unknown`.

### Safe shutdown
```
POST /device/shutdown
{
  "url": "...", "loginuser": "...", "loginpass": "...", "deviceid": "...",
  "method": "auto",
  "verify": 60
}
```
- `method` — `auto` (default: agent if present, else AMT), `agent`, or `amt`.
- `verify` — optional. Poll the power state until the device reaches an off
  state, or for this many seconds (`true` means 60). Adds a `verify` block to
  the response. MeshCentral acknowledges power actions immediately and never
  reports what the device actually did, so this is the only way to confirm.

### Suspend / sleep
```
POST /device/sleep
{
  "url": "...", "loginuser": "...", "loginpass": "...", "deviceid": "...",
  "method": "auto",
  "depth": "deep",
  "verify": 60
}
```
- `depth` — `deep` (S3, suspend to RAM, default) or `light` (S1). Only affects
  the AMT route; the agent route uses whatever the OS is configured to do.

### What can this device boot from?
```
GET  /device/boot/options?deviceid=...
POST /device/boot/options
```
Reads `CIM_BootSourceSetting` and `AMT_BootCapabilities` from the firmware and
reports which targets are actually usable. Needs AMT credentials in
`config.json`. Read-only.

On the P520 (AMT 11.12.96) this returns:

| InstanceID | StructuredBootString |
| --- | --- |
| `Intel(r) AMT: Force Hard-drive Boot` | `CIM:Hard-Disk:1` |
| `Intel(r) AMT: Force PXE Boot` | `CIM:Network:1` |
| `Intel(r) AMT: Force CD/DVD Boot` | `CIM:CD/DVD:1` |

### Change boot device
```
POST /device/boot
{
  "url": "...", "loginuser": "...", "loginpass": "...", "deviceid": "...",
  "target": "cd",
  "mode": "poweron",
  "sol": false,
  "via": "auto"
}
```
- `target` — `bios` (setup), `pxe` (network), `cd` (CD/DVD), `hdd` (hard drive),
  or `default` (normal boot order, clears any override).
  Aliases: `hd`/`harddrive`/`disk` → `hdd`, `cdrom`/`dvd`/`iso` → `cd`.
- `mode` — `poweron` (from a powered-off machine, default) or `reset` (reboot a
  running machine into the target).
- `sol` — `bios` only. Redirect BIOS setup to Serial-over-LAN.
- `via` — `auto` (default), `amt`, or `meshcentral`. See below.

The override applies to the **next boot only**.

#### Two routes, and why

`auto` uses the direct-AMT route when `config.json` has credentials for the
device, otherwise it falls back to MeshCentral.

**Direct AMT** talks WSMAN to the firmware on port 16992 using MeshCentral's own
stack (vendored into `lib/amt/`), so it can name any boot source the device
exposes. It runs the same sequence MeshCentral does: read and Put
`AMT_BootSettingData`, `SetBootConfigRole(1)`, `ChangeBootOrder(<source>)`, then
`RequestPowerStateChange`.

**MeshCentral** relays a `poweraction` actiontype. It can only ever express BIOS
and PXE — the server hardcodes `Force PXE Boot` or nothing — so `cd` and `hdd`
are rejected on this route.

| target | direct AMT | via MeshCentral |
| --- | --- | --- |
| bios (+`sol`) | yes | yes (311–314) |
| pxe | yes | yes (315, 316) |
| cd | yes | no |
| hdd | yes | no |
| default | yes | yes (302, 310) |

#### Picking a specific OS

`ChangeBootOrder` selects a boot device **class** — note the single
`CIM:Hard-Disk:1` entry, even on a machine with four drives. To pick *which*
disk, pass `index`, which sets `AMT_BootSettingData.BootMediaIndex`: `0` uses
the BIOS boot order, `1..N` select the Nth device of that class. Values 0-4 are
verified writable on this firmware. What each index maps to is decided by the
BIOS, so establish the mapping empirically.

Other ways to choose between OSes installed on different drives:

- set the next entry from inside the running OS (`grub-reboot`), then
  `{"target":"default","mode":"reset"}`; or
- `{"target":"bios","sol":true}` and pick from setup over Serial-over-LAN; or
- boot a live image over IDE-R — see the IDER section below. This is the only
  option that needs neither the machine already running nor a person at the
  keyboard, and it is the practical answer for multi-OS work: boot something
  like Ventoy or a rescue ISO and drive the machine from there.

### Boot an arbitrary OS image — IDER

IDE Redirection streams a disk image from LXC 113 to the machine as if it were a
physically attached CD or floppy. Because AMT 11 cannot name an individual disk,
**this is the way to boot the machine into an OS of your choosing from cold.**
Verified working on the P520.

Drop `.iso` files into `/opt/meshctrl-api/images` (override with
`ider.imagesDir` in `config.json`).

```
GET  /device/ider/images                 # what is available to mount
POST /device/ider/start                  # { deviceid, cdrom, floppy, iderstart }
GET  /device/ider/status?deviceid=...    # live state and sectors served
POST /device/ider/stop                   # { deviceid }
POST /device/ider/boot                   # mount and boot in one call
```

- `cdrom` / `floppy` — file **names** inside the images directory. Paths that
  escape the directory are rejected.
- `iderstart` — `graceful` (default), `onreboot`, or `now`.
- `mode` on `/device/ider/boot` — `reset` (default) or `poweron`.

One-shot: mount and boot into it.
```bash
post /device/ider/boot "{$CREDS,\"cdrom\":\"ubuntu.iso\",\"mode\":\"reset\"}"
```

Or drive the steps yourself:
```bash
post /device/ider/start "{$CREDS,\"cdrom\":\"ubuntu.iso\"}"
post /device/boot       "{$CREDS,\"target\":\"cd\",\"mode\":\"reset\"}"
curl -s "http://localhost:3001/device/ider/status?deviceid=$DEV"   # watch sectorsServed climb
post /device/ider/stop  "{$CREDS}"
```

`sectorsServed` is the useful signal: if it stays at 0 the target is not reading
the image, so it did not boot from it.

**A session is long-lived.** Keep it running for as long as the target needs to
read the image — a live installer reads throughout the install. Sessions do not
survive a service restart; `systemctl restart meshctrl-api` drops them.

Only one session per device at a time.

#### Clear the boot order before setting UseIDER

AMT rejects `UseIDER = true` while a forced boot order from an earlier boot is
still in place, answering:

```
HTTP/1.1 400 Bad Request
d:InvalidRepresentation - "The XML content is not valid."
wsman/faultDetail/InvalidValues
```

This reads as "the firmware does not support IDER boot", and it is not — it is
leftover state. `bootTo()` therefore issues `ChangeBootOrder(null)` before
touching `AMT_BootSettingData`, so every call starts from a clean boot config.
Confirmed on the P520: with the order cleared, `UseIDER=true` is accepted and
the machine boots the redirected image.

The full sequence is:

1. `ChangeBootOrder(null)` — drop any leftover override
2. read `AMT_BootSettingData`
3. `Put` with `UseIDER`, `IDERBootDevice`, `BIOSSetup`, `UseSOL`
4. `SetBootConfigRole(1)`
5. `ChangeBootOrder(<source>)`
6. `RequestPowerStateChange`

If a Put is still refused, `/device/ider/boot` falls back to a plain forced CD
boot and returns a `warning` rather than failing outright.

#### Telling a real boot from a failed one

`sectorsServed` is the signal, and the two cases look nothing alike:

| | Failed | Booted |
| --- | --- | --- |
| Sectors | ~52, then stops | thousands, climbing steadily |
| Session | drops after ~110s | stays alive |
| Meaning | BIOS read the volume descriptor and El Torito catalog, then fell through to its normal boot order | bootloader loaded; a plateau afterwards means it is idle at a menu |

Throughput over a WireGuard tunnel is roughly 70 KB/s, so a menu appears quickly
but anything loading a full squashfs will be slow.

Verified end to end with `ventoy-1.1.17-livecd.iso`: ~3000 sectors read over two
minutes, then a plateau with the session held open, the machine parked at
Ventoy's boot menu. Ventoy's bootloader is not Microsoft-signed, so Secure Boot
is not blocking unsigned bootloaders on this machine.

#### How this works

`meshcmd amtider` cannot run here: its `performIder()` opens the image with the
fs flag `rbN`, which only the MeshAgent's duktape runtime understands, and it
passes the username through an inverted ternary. So `lib/ider-runner.js`
rebuilds that path for plain Node against the same `amt-ider` and
`amt-redir-duk` modules, with three small compatibility shims:

- `lib/shims/MD5Stream.js` — the MeshAgent native MD5 module, redone with
  `crypto`. Used only for the digest-auth hash.
- `tls.generateRandomInteger` — patched onto node's `tls` for the auth cnonce.
- `global.fs` — `amt-ider.js` reads sectors through a bare global `fs`.

The session runs as a forked child so a wedged redirection cannot take the API
down, and credentials reach it over IPC rather than argv or env, keeping them
out of `ps`.

### Generic power control
```
POST /device/power
{ "...connection fields...", "action": "amton" }
```

**Valid actions:**

MeshAgent (needs the agent running in the OS):
- `off` — graceful OS shutdown
- `reset` — graceful OS restart
- `sleep` — suspend via the OS

Intel AMT (works with the machine powered off):
- `amton` — power on
- `amtsleep` — sleep, S1 light
- `amtsleepdeep` — sleep, S3 deep (suspend to RAM)
- `amtcycle` — power cycle, off soft then on
- `amthardoff` — power off, hard
- `amthibernate` — hibernate, S4
- `amtoff` — power off, soft
- `amtreset` — reset

Intel AMT boot overrides:
- `amtbios`, `amtresetbios`, `amtbiossol`, `amtresetbiossol`, `amtpxe`, `amtresetpxe`

Other:
- `wake` — send a Wake-on-LAN magic packet

Aliases kept for backwards compatibility: `poweron`→`amton`,
`poweroff`→`amtoff`, `softreset`→`reset`, `softoff`→`off`.

### Convenience Endpoints
```
POST /device/amt/on
POST /device/amt/off
```
Connection fields only, no `action`.

## Usage Examples

```bash
URL="wss://mc.example.com"
USER="~t:xxxxxxxxxxxxxxxx"
PASS="xxxxxxxxxxxxxxxx"
DEV="YOUR_DEVICE_ID"
CREDS="\"url\":\"$URL\",\"loginuser\":\"$USER\",\"loginpass\":\"$PASS\",\"deviceid\":\"$DEV\""

# Where is it and how can we reach it?
curl -s -X POST http://localhost:3001/device/status \
  -H "Content-Type: application/json" -d "{$CREDS}"

# Safe shutdown, and wait up to 90s to confirm it powered down
curl -s -X POST http://localhost:3001/device/shutdown \
  -H "Content-Type: application/json" -d "{$CREDS,\"verify\":90}"

# Suspend to RAM
curl -s -X POST http://localhost:3001/device/sleep \
  -H "Content-Type: application/json" -d "{$CREDS,\"depth\":\"deep\"}"

# What can it boot from?
curl -s -X POST http://localhost:3001/device/boot/options \
  -H "Content-Type: application/json" -d "{$CREDS}"

# Boot the CD/DVD drive (direct AMT only)
curl -s -X POST http://localhost:3001/device/boot \
  -H "Content-Type: application/json" -d "{$CREDS,\"target\":\"cd\",\"mode\":\"reset\"}"

# Power on straight into BIOS setup
curl -s -X POST http://localhost:3001/device/boot \
  -H "Content-Type: application/json" -d "{$CREDS,\"target\":\"bios\",\"mode\":\"poweron\"}"

# Reboot a running machine into PXE
curl -s -X POST http://localhost:3001/device/boot \
  -H "Content-Type: application/json" -d "{$CREDS,\"target\":\"pxe\",\"mode\":\"reset\"}"

# Back to the normal boot order
curl -s -X POST http://localhost:3001/device/boot \
  -H "Content-Type: application/json" -d "{$CREDS,\"target\":\"default\",\"mode\":\"reset\"}"
```

### Test Script
A read-only test script is included at `/opt/meshctrl-api/test-api.sh`:
```bash
/opt/meshctrl-api/test-api.sh
```
It only exercises the endpoints that do not change device power state. Pass
`--power` to also run the disruptive power tests.

## Service Management

The service is managed by systemd.

```bash
sudo systemctl start meshctrl-api
sudo systemctl stop meshctrl-api
sudo systemctl restart meshctrl-api
sudo systemctl status meshctrl-api
sudo journalctl -u meshctrl-api -f
sudo systemctl enable meshctrl-api    # already enabled
sudo systemctl disable meshctrl-api
```

## Configuration

### AMT credentials — `config.json`

Direct-AMT boot control needs the AMT admin password. It lives in
`/opt/meshctrl-api/config.json` (mode `600`), never in request bodies:

```json
{
  "amt": {
    "defaults": { "port": 16992, "tls": false, "user": "admin" },
    "devices": {
      "<deviceid>": { "host": "10.10.0.234", "user": "admin", "pass": "..." }
    }
  }
}
```

See `config.json.example`. Override the path with `MESHCTRL_API_CONFIG`.
A request may also carry `amthost`/`amtuser`/`amtpass`/`amtport`/`amttls` to
reach a device that is not in the file yet; those take precedence.

Note that AMT on this device has **TLS disabled**, so WSMAN traffic to port
16992 is unencrypted on the wire. Keep it on a trusted network.

### Port

The service runs on port **3001** by default. To change the port:

1. Edit `/etc/systemd/system/meshctrl-api.service`
2. Modify the `Environment="PORT=3001"` line to your desired port
3. Reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart meshctrl-api
```

## Files Structure

```
/opt/meshctrl-api/
├── server.js           # Main API server, endpoints and action map
├── config.json         # AMT credentials, mode 600, not in git
├── config.json.example # Template
├── lib/
│   ├── meshws.js       # MeshCentral control websocket client
│   ├── amtboot.js      # Direct Intel AMT boot control
│   ├── idermgr.js      # IDER session manager
│   ├── ider-runner.js  # IDER session child process
│   ├── config.js       # Config loader
│   ├── shims/          # MeshAgent-runtime shims for the IDER modules
│   └── amt/            # MeshCentral's WSMAN stack, vendored
├── images/             # ISO / floppy images available to IDER
├── package.json        # Node.js dependencies
├── node_modules/       # Installed dependencies
├── README.md           # This file
└── test-api.sh         # Test script
```

## Response Format

### Success Response:
```json
{
  "success": true,
  "action": "amtoff",
  "via": "amt",
  "actiontype": 308,
  "description": "AMT power off, soft"
}
```
Plus `warning` when an AMT fallback was used, and `verify` when requested.

### Error Response:
```json
{
  "success": false,
  "error": "Error message"
}
```
`400` for bad or missing parameters and unreachable/unknown devices, `404` for a
device id not on the server, `500` for connection and server errors.

## Troubleshooting

### Service not starting
```bash
journalctl -u meshctrl-api -n 50
```

### `MeshCentral rejected the login: noauth-2d`
Bad `loginuser`/`loginpass`, or the login token has expired.

### Shutdown or sleep returns success but nothing happens
The device almost certainly has no MeshAgent, so the action went out over AMT
and the firmware ignored it. Check `connectivity.agent` in `/device/status`. To
get real graceful shutdown and suspend, install the MeshAgent on the target
machine. Use `"verify": 60` to have the API confirm rather than assume.

### `Intel AMT did not respond within 20s`
AMT is unreachable on 16992. Check the host in `config.json` and that the
machine is on a reachable network. AMT answers even when the machine is powered
off, so a timeout means a network or credential problem, not a powered-down box.

### IDER session starts but `sectorsServed` stays at 0
The target is not reading the image. It probably did not boot from CD — reissue
`POST /device/boot {"target":"cd","mode":"reset"}` while the session is up, and
check the image is actually bootable.

### Port already in use
Edit the service file to use a different port.

### meshctrl command not found
Only needed for CLI checks, not by the service itself:
```bash
npm install -g meshcentral
ln -sf /usr/lib/node_modules/meshcentral/meshctrl.js /usr/local/bin/meshctrl
```
