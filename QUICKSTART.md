# MeshCtrl API - Quick Start Guide

## Service Info
- **Location**: `/opt/meshctrl-api`
- **Port**: 3001
- **Status**: Running as systemd service
- **Auto-start**: Enabled (starts on boot)

## Quick Commands

### Check Service Status
```bash
systemctl status meshctrl-api
```

### View Logs
```bash
journalctl -u meshctrl-api -f
```

### Restart Service
```bash
systemctl restart meshctrl-api
```

## API Usage

Every device endpoint takes the same connection fields, so define them once:

```bash
URL="wss://mc.example.com"
USER="~t:xxxxxxxxxxxxxxxx"
PASS="xxxxxxxxxxxxxxxx"
DEV="YOUR_DEVICE_ID"
CREDS="\"url\":\"$URL\",\"loginuser\":\"$USER\",\"loginpass\":\"$PASS\",\"deviceid\":\"$DEV\""
post() { curl -s -X POST "http://localhost:3001$1" -H "Content-Type: application/json" -d "$2"; echo; }
```

### Test the API
```bash
# Health check
curl http://localhost:3001/health

# Read-only test script
/opt/meshctrl-api/test-api.sh
```

### Status — power state and how the device is reachable
```bash
post /device/status "{$CREDS}"
```

### Power On / Off
```bash
post /device/amt/on  "{$CREDS}"
post /device/amt/off "{$CREDS}"
```

### Safe Shutdown
```bash
# add "verify":90 to poll until it actually powers down
post /device/shutdown "{$CREDS,\"verify\":90}"
```

### Suspend (Sleep)
```bash
post /device/sleep "{$CREDS,\"depth\":\"deep\"}"   # S3, suspend to RAM
post /device/sleep "{$CREDS,\"depth\":\"light\"}"  # S1
```

### What can it boot from?
```bash
post /device/boot/options "{$CREDS}"
```

### Change Boot Device
```bash
post /device/boot "{$CREDS,\"target\":\"bios\",\"mode\":\"poweron\"}"   # power on into BIOS
post /device/boot "{$CREDS,\"target\":\"bios\",\"sol\":true}"           # BIOS over Serial-over-LAN
post /device/boot "{$CREDS,\"target\":\"pxe\",\"mode\":\"reset\"}"      # reboot into network boot
post /device/boot "{$CREDS,\"target\":\"cd\",\"mode\":\"reset\"}"       # reboot into CD/DVD
post /device/boot "{$CREDS,\"target\":\"hdd\",\"mode\":\"reset\"}"      # force hard-drive boot
post /device/boot "{$CREDS,\"target\":\"default\",\"mode\":\"reset\"}"  # back to normal boot order
```
The override applies to the next boot only.

`cd` and `hdd` need AMT credentials in `config.json` — MeshCentral's own API
cannot express them. `bios`, `pxe` and `default` work either way.

### Booting a specific OS

AMT picks a boot device **class**, not a disk. On this AMT 11 box there is one
`CIM:Hard-Disk:1` entry regardless of how many drives are installed, so there is
no "boot the Windows disk" command. Use `grub-reboot` from the running OS then
`target: default, mode: reset`, or go into BIOS setup over SOL and pick.

### Boot Another OS (IDER)

Put ISOs in `/opt/meshctrl-api/images`, then:

```bash
curl -s http://localhost:3001/device/ider/images                          # list
post /device/ider/boot "{$CREDS,\"cdrom\":\"ubuntu.iso\",\"mode\":\"reset\"}"  # mount + boot
curl -s "http://localhost:3001/device/ider/status?deviceid=$DEV"          # watch sectorsServed
post /device/ider/stop "{$CREDS}"                                         # when done
```

Keep the session up while the target reads the image. It does not survive
`systemctl restart meshctrl-api`. One session per device.

This is the way to boot this machine into an arbitrary OS from cold. Verified
with `ventoy-1.1.17-livecd.iso`.

Watch `sectorsServed` to tell a real boot from a failed one: a booted machine
reads thousands of sectors and the session stays alive, while a failed one reads
about 52 (the volume descriptor and boot catalog) and the session drops after
~110s. Expect roughly 70 KB/s over the tunnel.

### Generic Power Control
```bash
post /device/power "{$CREDS,\"action\":\"amtreset\"}"
```

**Available actions** (`curl http://localhost:3001/actions` for the live list):

- MeshAgent, needs the agent running in the OS: `off`, `reset`, `sleep`
- Intel AMT: `amton`, `amtsleep`, `amtsleepdeep`, `amtcycle`, `amthardoff`,
  `amthibernate`, `amtoff`, `amtreset`
- Intel AMT boot overrides: `amtbios`, `amtresetbios`, `amtbiossol`,
  `amtresetbiossol`, `amtpxe`, `amtresetpxe`
- Other: `wake`

Old names still accepted: `poweron`, `poweroff`, `softreset`, `softoff`.

## Heads-up: agent vs AMT

Real graceful shutdown and suspend need a **MeshAgent installed in the OS** on
the target machine. On an AMT-only device the API falls back to Intel AMT
firmware power states and returns a `warning` saying so — AMT soft-off is not an
OS-level graceful shutdown, and AMT sleep is often rejected by the firmware.

Check `connectivity.agent` in `/device/status` to see which route you have.

## Parameters

- **url**: MeshCentral server WebSocket URL
- **loginuser**: Login username (token format)
- **loginpass**: Login password
- **deviceid**: Target device ID
- **token**: Optional 2FA token
- **action**: Power action (for `/device/power`)
- **method**: `auto` | `agent` | `amt` (for `/device/shutdown`, `/device/sleep`)
- **depth**: `deep` | `light` (for `/device/sleep`)
- **target**, **mode**, **sol**: boot selection (for `/device/boot`)
- **verify**: seconds to poll for the expected power state
- **via**: `auto` | `amt` | `meshcentral` (for `/device/boot`)

## Files

- `server.js` - Main API server
- `config.json` - AMT credentials, mode 600
- `lib/meshws.js` - MeshCentral control websocket client
- `lib/amtboot.js` - Direct Intel AMT boot control
- `lib/idermgr.js`, `lib/ider-runner.js` - IDER sessions
- `images/` - ISO images available to IDER
- `lib/amt/` - MeshCentral's WSMAN stack, vendored
- `package.json` - Dependencies
- `README.md` - Full documentation
- `test-api.sh` - Test script
- `QUICKSTART.md` - This file

For complete documentation, see: `/opt/meshctrl-api/README.md`
