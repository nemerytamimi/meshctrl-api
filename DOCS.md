# meshctrl-api

A REST layer over MeshCentral and Intel AMT for out-of-band control of a
ThinkStation P520: power, safe shutdown, suspend, boot-device override, and
booting arbitrary ISOs over IDE redirection.

| | |
|---|---|
| Base URL | `http://<host>:3001` |
| Service | `meshctrl-api` (systemd) |
| Root | `/opt/meshctrl-api` |
| Target | Intel AMT 11.12.96, Admin Control Mode |

---

## Contents

- [Can you select between boot devices?](#can-you-select-between-boot-devices)
- [Conventions](#conventions)
- [Two routes: agent vs AMT](#two-routes-agent-vs-amt)
- [Endpoints](#endpoints)
  - [Status and discovery](#status-and-discovery)
  - [Power](#power)
  - [Boot control](#boot-control)
  - [IDER — boot an arbitrary ISO](#ider--boot-an-arbitrary-iso)
- [Action table](#action-table)
- [Power states](#power-states)
- [Configuration](#configuration)
- [Operating notes](#operating-notes)
- [Troubleshooting](#troubleshooting)

---

## Can you select between boot devices?

**Yes — including which hard disk.**

`POST /device/boot` takes a `target` of `bios`, `pxe`, `cd`, `hdd`, or `default`,
plus an optional `index` selecting *which* device of that class. The override
applies to the next boot only.

```bash
post /device/boot "{$CREDS,\"target\":\"hdd\",\"index\":2,\"mode\":\"reset\"}"
post /device/boot "{$CREDS,\"target\":\"hdd2\",\"mode\":\"reset\"}"   # same thing
```

Two AMT fields are involved, and missing the second one is what makes this look
impossible at first glance:

- `CIM_BootConfigSetting.ChangeBootOrder` picks the device **class**. This
  firmware exposes only three sources, and there is a single hard-drive entry
  regardless of how many disks are fitted:

  | InstanceID | StructuredBootString | API target |
  |---|---|---|
  | `Intel(r) AMT: Force Hard-drive Boot` | `CIM:Hard-Disk:1` | `hdd` |
  | `Intel(r) AMT: Force PXE Boot` | `CIM:Network:1` | `pxe` |
  | `Intel(r) AMT: Force CD/DVD Boot` | `CIM:CD/DVD:1` | `cd` |

- `AMT_BootSettingData.BootMediaIndex` then picks **which device within that
  class**. `0` leaves the BIOS boot order alone; `1..N` select the Nth device.

Verified writable on this firmware: values 0, 1, 2, 3 and 4 were all accepted
and read back correctly.

> **What the index maps to is the BIOS's business.** AMT passes the number
> through at POST; the ordering comes from the BIOS, and it need not match
> physical port order, `lsblk`, or anything visible from a running OS. Nor is
> AMT accepting the write a promise that the BIOS honours it. Find your mapping
> empirically: boot each index and see which OS comes up.

### Other ways to choose an OS

- **Bootloader.** `grub-reboot "..."` from inside the running OS, then
  `{"target":"default","mode":"reset"}`.
- **BIOS setup over serial.** `{"target":"bios","sol":true}`.
- **IDER.** Boot Ventoy or a rescue ISO and pick from there — the only route
  needing neither the machine running nor a person at the keyboard.

---

## Conventions

Every device endpoint takes the same MeshCentral connection fields in a JSON
body. Endpoints that talk to AMT directly need no credentials in the request —
they read them from `config.json`.

| Field | | Meaning |
|---|---|---|
| `url` | required | MeshCentral websocket URL, e.g. `wss://mc.example.com` |
| `loginuser` | required | Login username; login-token format works |
| `loginpass` | required | Login password |
| `deviceid` | required | Target device id, with or without the `node//` prefix |
| `token` | optional | Second-factor authentication token |

Shell setup used by every example below:

```bash
URL="wss://mc.example.com"
USER="~t:xxxxxxxxxxxxxxxx"
PASS="xxxxxxxxxxxxxxxx"
DEV="YOUR_DEVICE_ID"
API="http://localhost:3001"

CREDS="\"url\":\"$URL\",\"loginuser\":\"$USER\",\"loginpass\":\"$PASS\",\"deviceid\":\"$DEV\""
post() { curl -s -X POST "$API$1" -H "Content-Type: application/json" -d "$2"; echo; }
```

### Response shape

Success:

```json
{
  "success": true,
  "action": "amtoff",
  "via": "amt",
  "actiontype": 308,
  "description": "AMT power off, soft"
}
```

Error:

```json
{ "success": false, "error": "Device not found on this MeshCentral server." }
```

`400` bad or missing parameters and unreachable devices · `404` unknown device
id · `500` connection and server errors.

---

## Two routes: agent vs AMT

Each call travels one of two ways, and which one decides whether it actually
does anything.

- **Agent** — handled by the MeshAgent inside the OS. These are the genuinely
  graceful operations, and MeshCentral **silently drops them** when no agent is
  connected.
- **AMT** — handled out-of-band by Intel AMT, so it works with the machine
  powered off. Either relayed through MeshCentral or spoken directly to the
  firmware on port 16992.

> **Standing caveat for this P520.** The device is registered as an AMT-only
> node — `connectivity.agent` is `false`. There is no MeshAgent in the OS, so
> true graceful shutdown and suspend are not available. `/device/shutdown` and
> `/device/sleep` detect this, fall back to AMT firmware power states, and
> return a `warning` saying so. Installing the MeshAgent (or Intel LMS) is what
> would make them real.

---

## Endpoints

### Status and discovery

Read-only, safe to poll.

#### `GET /health`

Liveness check, no parameters.

```bash
curl -s $API/health
# {"status":"ok","service":"meshctrl-api"}
```

#### `GET /actions`

Every action name the service accepts, its route, and its MeshCentral
actiontype. The live version of the [action table](#action-table).

#### `GET|POST /device/status`

Live power state and connectivity, read from the node record on the control
channel. Also served at `/device/amt/status` for older callers.

```bash
post /device/status "{$CREDS}"
```

```json
{
  "success": true,
  "deviceid": "...",
  "name": "10.10.0.234",
  "status": "soft-off",
  "powerState": 6,
  "connectivity": { "agent": false, "cira": false, "amt": true, "raw": 4 },
  "amtVersion": "11.12.96"
}
```

`connectivity` decodes the MeshCentral `conn` bitmask: 1 = MeshAgent,
2 = CIRA, 4 = Intel AMT.

#### `GET|POST /device/boot/options`

Asks the firmware what it can actually boot from, rather than assuming. Needs
only `deviceid` — credentials come from `config.json`.

```bash
curl -s "$API/device/boot/options?deviceid=$DEV"
```

```json
{
  "success": true,
  "host": "10.10.0.234",
  "bootSources": [ "... the three sources listed above ..." ],
  "targets": { "hdd": true, "pxe": true, "cd": true, "bios": true, "default": true },
  "sol": true,
  "ider": true
}
```

#### `GET /device/ider/images`

Lists the disk images available to mount, from `/opt/meshctrl-api/images`.

---

### Power

All of these change machine state.

#### `POST /device/shutdown`

Safe shutdown. Uses the in-OS agent when one is connected, otherwise an AMT
soft power off.

| Field | | Meaning |
|---|---|---|
| `method` | optional | `auto` (default) · `agent` · `amt` |
| `verify` | optional | Seconds to poll until the machine reaches an off state. `true` means 60. Adds a `verify` block to the response. |

```bash
post /device/shutdown "{$CREDS,\"verify\":90}"
```

MeshCentral acknowledges power actions immediately and never reports what the
device actually did. `verify` is the only way to know rather than assume.

#### `POST /device/sleep`

Suspend.

| Field | | Meaning |
|---|---|---|
| `depth` | optional | `deep` (S3, suspend to RAM, default) · `light` (S1). AMT route only. |
| `method` | optional | `auto` · `agent` · `amt` |
| `verify` | optional | As above, polling for a sleep state |

```bash
post /device/sleep "{$CREDS,\"depth\":\"deep\",\"verify\":60}"
```

#### `POST /device/power`

Generic control. Takes `action`, one of the names in the
[action table](#action-table).

```bash
post /device/power "{$CREDS,\"action\":\"amtreset\"}"
```

#### `POST /device/amt/on` · `POST /device/amt/off`

Convenience wrappers for `amton` and `amtoff`. Connection fields only, no
`action`.

---

### Boot control

#### `POST /device/boot`

Override the next boot device, then power on or reset into it.

| Field | | Meaning |
|---|---|---|
| `target` | required | `bios` · `pxe` · `cd` · `hdd` · `default`. Aliases: `hd`/`harddrive`/`disk` → `hdd`, `cdrom`/`dvd`/`iso` → `cd`. Shorthand `hdd2` means target `hdd`, index `2`. |
| `index` | optional | Which device of that class. `0` (default) uses the BIOS boot order; `1`-`7` select the Nth. Sets `AMT_BootSettingData.BootMediaIndex`. Direct-AMT route only. |
| `mode` | optional | `poweron` from cold (default) · `reset` to reboot a running machine |
| `sol` | optional | `bios` only. Redirect setup to Serial-over-LAN. |
| `via` | optional | `auto` (default) · `amt` · `meshcentral` |

```bash
post /device/boot "{$CREDS,\"target\":\"bios\",\"sol\":true}"
post /device/boot "{$CREDS,\"target\":\"pxe\",\"mode\":\"reset\"}"
post /device/boot "{$CREDS,\"target\":\"cd\",\"mode\":\"reset\"}"
post /device/boot "{$CREDS,\"target\":\"default\",\"mode\":\"reset\"}"   # clears the override
```

The override applies to the **next boot only**.

**Which route can express what.** `auto` picks the direct-AMT route when
`config.json` has credentials for the device, otherwise it relays through
MeshCentral — whose `poweraction` can only ever say BIOS or PXE.

| Target | AMT direct | Via MeshCentral | actiontype |
|---|---|---|---|
| `bios` | yes | yes | 311 / 312 |
| `bios` + `sol` | yes | yes | 313 / 314 |
| `pxe` | yes | yes | 315 / 316 |
| `cd` | yes | **no** | — |
| `hdd` | yes | **no** | — |
| `default` | yes | yes | 302 / 310 |

**Why the boot order is cleared first.** AMT rejects `UseIDER = true` with
`InvalidRepresentation` / `InvalidValues` while a forced boot order from a
previous boot is still in place. That reads exactly like "this firmware does
not support IDER boot" and is really just leftover state. So every call issues
`ChangeBootOrder(null)` before touching anything:

```
1. ChangeBootOrder(null)          drop any leftover override
2. read AMT_BootSettingData
3. Put  UseIDER, IDERBootDevice, BootMediaIndex, BIOSSetup, UseSOL
4. SetBootConfigRole(1)
5. ChangeBootOrder(<source>)
6. RequestPowerStateChange
```

---

### IDER — boot an arbitrary ISO

IDE redirection streams a disk image from the API host to the machine as though
it were a physically attached CD or floppy. Since AMT cannot name an individual
disk, this is the practical way to boot the machine into something of your
choosing from cold. Verified with `ventoy-1.1.17-livecd.iso`.

Drop `.iso` files into `/opt/meshctrl-api/images`. Image names resolve inside
that directory only — paths that escape it are rejected.

#### `POST /device/ider/boot`

Mount an image and boot into it in one call. The usual entry point.

| Field | | Meaning |
|---|---|---|
| `cdrom` | either | Image filename inside the images directory |
| `floppy` | either | Floppy image filename. At least one of the two is required. |
| `mode` | optional | `reset` (default) · `poweron` |
| `iderstart` | optional | `graceful` (default) · `onreboot` · `now` |
| `sol` | optional | Redirect to Serial-over-LAN |

```bash
post /device/ider/boot "{$CREDS,\"cdrom\":\"ventoy-livecd.iso\",\"mode\":\"reset\"}"
```

If the firmware refuses `UseIDER`, the call falls back to a plain forced CD boot
and returns a `warning` rather than failing outright.

#### `POST /device/ider/start`

Mount without booting, when you want to drive the two steps yourself. One
session per device.

```bash
post /device/ider/start "{\"deviceid\":\"$DEV\",\"cdrom\":\"ventoy-livecd.iso\"}"
post /device/boot       "{$CREDS,\"target\":\"cd\",\"mode\":\"reset\"}"
```

#### `GET|POST /device/ider/status`

Session state and, crucially, `sectorsServed`.

```bash
curl -s "$API/device/ider/status?deviceid=$DEV"
```

```json
{ "active": true, "state": "started", "cdrom": "ventoy-livecd.iso",
  "sectorsServed": 3038, "startedAt": "...", "pid": 7793 }
```

#### `POST /device/ider/stop`

Ends the session. Takes `deviceid`.

#### Reading `sectorsServed`

AMT never reports whether a boot succeeded, so the sector counter is the signal.
The two outcomes look nothing alike.

| | Failed | Booted |
|---|---|---|
| **Sectors** | ~52, then stops | Thousands, climbing steadily |
| **Session** | Drops after ~110s | Stays alive |
| **Meaning** | BIOS read the volume descriptor and El Torito catalog, then fell through to its normal boot order | Bootloader loaded. A plateau afterwards means it is idle at a menu. |

> **Two operational limits.** Throughput over a WireGuard tunnel is roughly
> **70 KB/s** — fine for a boot menu, slow for anything loading a full squashfs.
> And sessions **do not survive a service restart**:
> `systemctl restart meshctrl-api` stops them, and the machine loses its media.

---

## Action table

Accepted by `/device/power`. `actiontype` is the value sent to MeshCentral; for
AMT it is `300 + n`, where `n` is the AMT `RequestPowerStateChange` value.

| Action | Route | Type | Effect |
|---|---|---|---|
| `off` | agent | 2 | Graceful OS shutdown |
| `reset` | agent | 3 | Graceful OS restart |
| `sleep` | agent | 4 | Suspend via the OS |
| `amton` | amt | 302 | Power on |
| `amtsleep` | amt | 303 | Sleep, S1 light |
| `amtsleepdeep` | amt | 304 | Sleep, S3 deep (suspend to RAM) |
| `amtcycle` | amt | 305 | Power cycle, off soft then on |
| `amthardoff` | amt | 306 | Power off, hard |
| `amthibernate` | amt | 307 | Hibernate, S4 |
| `amtoff` | amt | 308 | Power off, soft |
| `amtreset` | amt | 310 | Reset |
| `amtbios` | amt | 311 | Power on into BIOS setup |
| `amtresetbios` | amt | 312 | Reset into BIOS setup |
| `amtbiossol` | amt | 313 | Power on into BIOS setup with SOL |
| `amtresetbiossol` | amt | 314 | Reset into BIOS setup with SOL |
| `amtpxe` | amt | 315 | Power on into PXE |
| `amtresetpxe` | amt | 316 | Reset into PXE |
| `wake` | wake | — | Wake-on-LAN magic packet |

Kept as aliases for older callers: `poweron`→`amton`, `poweroff`→`amtoff`,
`softreset`→`reset`, `softoff`→`off`.

---

## Power states

Values of `status` and `powerState` from `/device/status`.

| powerState | status | Meaning |
|---|---|---|
| 1 | `on` | Running, S0 |
| 2 | `sleep-s1` | Sleep, light |
| 3 | `sleep-s2` | Sleep |
| 4 | `sleep-s3` | Suspend to RAM |
| 5 | `hibernate-s4` | Suspend to disk |
| 6 | `soft-off` | Off, S5 |
| 7 | `off-hard` | Off, hard |
| 8 | `hibernate` | Hibernating |
| 9 | `off` | Off |
| 0 | `unknown` | Not reported |

---

## Configuration

AMT credentials live on disk at `/opt/meshctrl-api/config.json`, mode `600` —
never in request bodies. **This file is gitignored.** Copy
`config.json.example` and fill it in.

```json
{
  "amt": {
    "defaults": { "port": 16992, "tls": false, "user": "admin" },
    "devices": {
      "<deviceid>": { "host": "10.10.0.234", "user": "admin", "pass": "..." }
    }
  },
  "ider": { "imagesDir": "/opt/meshctrl-api/images" }
}
```

Override the config path with `MESHCTRL_API_CONFIG`. A request may also carry
`amthost`, `amtuser`, `amtpass`, `amtport`, `amttls` to reach a device not yet
in the file; those take precedence.

> **AMT TLS is off on this device.** Port 16993 is closed and WSMAN runs
> unencrypted on 16992, so that traffic — including the digest exchange — is in
> the clear. Fine inside a trusted network segment; worth knowing before
> exposing it further.

---

## Operating notes

### Service

```bash
systemctl status meshctrl-api
systemctl restart meshctrl-api      # ends any live IDER session
journalctl -u meshctrl-api -f
```

Port 3001, set by `Environment="PORT=3001"` in
`/etc/systemd/system/meshctrl-api.service`. Listens on all interfaces.

### How it talks to MeshCentral

Straight to the control websocket at `wss://<server>/control.ashx` with the same
`x-meshauth` header the `meshctrl` CLI uses. It does not shell out to the CLI,
which exposes only seven fixed power operations and has no flags at all for
boot-device overrides or the AMT sleep states.

### File layout

```
/opt/meshctrl-api/
├── server.js            endpoints and the action map
├── config.json          AMT credentials, mode 600, gitignored
├── config.json.example  template
├── images/              ISO and floppy images for IDER, gitignored
└── lib/
    ├── meshws.js        MeshCentral control websocket client
    ├── amtboot.js       direct AMT boot control
    ├── idermgr.js       IDER session manager
    ├── ider-runner.js   IDER session child process
    ├── config.js        config loader
    ├── shims/           MeshAgent-runtime shims for the IDER modules
    └── amt/             MeshCentral's WSMAN stack, vendored
```

### IDER under plain Node

`meshcmd amtider` cannot run outside the MeshAgent: its `performIder()` opens
the image with the fs flag `rbN`, which only the agent's duktape runtime
understands, and it passes the username through an inverted ternary. So
`lib/ider-runner.js` rebuilds that path for plain Node against the same
`amt-ider` and `amt-redir-duk` modules, with three compatibility shims:

- `lib/shims/MD5Stream.js` — the MeshAgent native MD5 module, redone with
  `crypto`. Used only for the digest-auth hash.
- `tls.generateRandomInteger` — patched onto node's `tls` for the auth cnonce.
- `global.fs` — `amt-ider.js` reads sectors through a bare global `fs`.

Sessions run as forked children so a wedged redirection cannot take the API
down, and credentials reach them over IPC rather than argv or env, keeping them
out of `ps`.

### Installation

```bash
cd /opt/meshctrl-api
npm install
cp config.json.example config.json    # then fill in AMT credentials
chmod 600 config.json
systemctl restart meshctrl-api
```

### Testing

```bash
export MC_URL="wss://mc.example.com"
export MC_USER="~t:xxxxxxxxxxxxxxxx"
export MC_PASS="xxxxxxxxxxxxxxxx"
export MC_DEVICEID="..."

./test-api.sh            # read-only checks
./test-api.sh --power    # also runs the disruptive power tests
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `MeshCentral rejected the login: noauth-2d` | Wrong `loginuser`/`loginpass`, or the login token expired. |
| Shutdown or sleep returns success, nothing happens | No MeshAgent, so the action went over AMT and the firmware ignored it. Check `connectivity.agent`; use `verify` to confirm rather than assume. |
| `Intel AMT did not respond within 20s` | Unreachable on 16992. AMT answers even when the machine is off, so a timeout means network or credentials, not a powered-down box. |
| IDER starts but `sectorsServed` stays near zero | The target is not reading the image — it did not boot from CD. Reissue the boot with the session up, and check the image is bootable. |
| `Target 'cd' can only be set by talking to Intel AMT directly` | No AMT credentials for that device in `config.json`, or `via: "meshcentral"` was forced. |
| Port already in use | Change `Environment="PORT="` in the unit file, `daemon-reload`, restart. |

---

## Known gaps

- **No SOL console.** `sol: true` tells the firmware to redirect BIOS setup to
  Serial-over-LAN, but nothing in the API reads that serial stream. Seeing the
  machine's screen remains out of reach.
- **IDER sessions are not durable.** They die with the service process.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

The files in `lib/amt/` are copied verbatim from MeshCentral 1.1.53, Copyright
2020-2021 Intel Corporation, author Ylian Saint-Hilaire, under the same license.
They are vendored so the SOAP this service sends to Intel AMT is byte-identical
to what a MeshCentral server would send, and each file keeps its original
header. `NOTICE` records the full attribution.
