#!/bin/bash
# Test script for MeshCtrl API.
# By default only runs checks that do NOT change device power state.
# Pass --power to also run the disruptive power tests.
#
# Credentials come from the environment so they stay out of the repository:
#
#   export MC_URL="wss://mc.example.com"
#   export MC_USER="~t:xxxxxxxxxxxxxxxx"
#   export MC_PASS="xxxxxxxxxxxxxxxx"
#   export MC_DEVICEID="..."
#   ./test-api.sh

URL="${MC_URL:?set MC_URL, e.g. wss://mc.example.com}"
LOGINUSER="${MC_USER:?set MC_USER}"
LOGINPASS="${MC_PASS:?set MC_PASS}"
DEVICEID="${MC_DEVICEID:?set MC_DEVICEID}"
API="${MC_API:-http://localhost:3001}"

CREDS="\"url\":\"$URL\",\"loginuser\":\"$LOGINUSER\",\"loginpass\":\"$LOGINPASS\",\"deviceid\":\"$DEVICEID\""

post() { curl -s -X POST "$API$1" -H "Content-Type: application/json" -d "$2"; echo; }

echo "Testing MeshCtrl API at $API..."
echo ""

echo "1. Health check:"
curl -s "$API/health"; echo -e "\n"

echo "2. Supported actions:"
curl -s "$API/actions"; echo -e "\n"

echo "3. Device status:"
post /device/status "{$CREDS}"; echo

echo "4. Boot options reported by the firmware:"
post /device/boot/options "{\"deviceid\":\"$DEVICEID\"}"; echo

echo "5. IDER images available:"
curl -s "$API/device/ider/images"; echo -e "\n"

if [ "$1" != "--power" ]; then
  echo "Skipping power tests. Re-run with --power to include them."
  exit 0
fi

echo "=== Power tests (these WILL change the device power state) ==="
echo ""

echo "6. AMT power on:"
post /device/amt/on "{$CREDS}"

echo "Waiting 30 seconds..."
sleep 30

echo "7. Device status (after power on):"
post /device/status "{$CREDS}"; echo

echo "8. Safe shutdown, verifying for up to 90s:"
post /device/shutdown "{$CREDS,\"verify\":90}"

echo "9. Device status (after shutdown):"
post /device/status "{$CREDS}"; echo

echo "10. Power on into BIOS setup:"
post /device/boot "{$CREDS,\"target\":\"bios\",\"mode\":\"poweron\"}"
