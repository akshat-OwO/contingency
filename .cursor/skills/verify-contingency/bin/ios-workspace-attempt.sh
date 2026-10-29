#!/bin/zsh
# Usage: attempt.sh <attempt-dir> <artifact-subdir> setup|run
# Setup reads CONTINGENCY_IOS_RUNTIME and CONTINGENCY_IOS_DEVICE_TYPE (default iOS 26.5, iPhone 17).
set -eu
A=$1; ART=$2; STAGE=$3
RUNTIME=${CONTINGENCY_IOS_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}
DEVICE_TYPE=${CONTINGENCY_IOS_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
CONTROL=$ROOT/.cursor/skills/verify-contingency/bin/control-contingency
cd $ROOT
mkdir -p $A
if [[ $STAGE == setup ]]; then
  [[ ! -e $A/selected ]] || exit 2
  date -u +%FT%TZ > $A/setup-start
  { memory_pressure; sysctl vm.swapusage; } > $A/memory.txt
  xcrun simctl list devices -j > $A/devices-before.json
  ps -axo pid=,ppid=,lstart=,comm= > $A/processes-before.txt
  lsof -nP -iTCP -sTCP:LISTEN > $A/listeners-before.txt
  sh .cursor/skills/verify-contingency/fixtures/ios-login/build.sh $A/fixture > $A/fixture-build.log 2>&1 || exit 3
  xcrun simctl create "contingency-selected-attempt$(basename $A | tr -cd '0-9')" "$DEVICE_TYPE" "$RUNTIME" > $A/selected || exit 4
  SELECTED=$(cat "$A/selected")
  # Fixture setup owns only the exact UDID returned by this create.
  xcrun simctl boot "$SELECTED" > "$A/boot.log" 2>&1 || exit 8
  xcrun simctl bootstatus "$SELECTED" -b >> "$A/boot.log" 2>&1 || exit 9
  xcrun simctl install "$SELECTED" "$A/fixture/IosLogin.app" > "$A/install.log" 2>&1 || exit 10
  xcrun simctl list devices -j > "$A/devices-ready.json"
  echo 'Setup complete. The exact proof-owned simulator is running with its fixture installed.'
  exit 0
fi
SELECTED=$(cat $A/selected)
cleanup() {
  set +e
  nub $CONTROL mcp stop > $A/cleanup.log 2>&1
  nub $CONTROL cleanup >> $A/cleanup.log 2>&1
  echo "cleanup exit=$?" >> $A/cleanup.log
  # Only this script's exact recorded UDID authorizes fixture teardown.
  xcrun simctl shutdown "$SELECTED" >> $A/cleanup.log 2>&1
  echo "selected shutdown exit=$?" >> $A/cleanup.log
  xcrun simctl delete "$SELECTED" >> $A/cleanup.log 2>&1
  echo "selected delete exit=$?" >> $A/cleanup.log
  rm -rf $A/fixture
  xcrun simctl list devices -j > $A/devices-after.json
  ps -axo pid=,ppid=,lstart=,comm= > $A/processes-after.txt
  lsof -nP -iTCP -sTCP:LISTEN > $A/listeners-after.txt
  { memory_pressure; sysctl vm.swapusage; } > $A/memory-after.txt
}
trap cleanup EXIT
export CONTINGENCY_IOS_SELECTED=$SELECTED CONTINGENCY_IOS_FIXTURE=$A/fixture/IosLogin.app
unset CONTINGENCY_IOS_WORKSPACE_INTERNAL
export CONTINGENCY_MCP_INTERFACE=native
export CONTINGENCY_IOS_PROOF_ENTRY=${CONTINGENCY_IOS_PROOF_ENTRY:-public}
export CONTINGENCY_VERIFY_DIR=$A/verify
export CONTINGENCY_IOS_PROOF_ARTIFACTS=.cursor/skills/verify-contingency/artifacts/$ART
nub $CONTROL launch > $A/launch.log 2>&1 || exit 5
nub $CONTROL doctor > $A/doctor.log 2>&1 || exit 6
nub $CONTROL mcp start > $A/mcp.log 2>&1 || exit 7
cp $A/verify/instance.json $A/instance.json
ps -axo pid=,ppid=,lstart=,comm= > $A/processes-launched.txt
lsof -nP -iTCP -sTCP:LISTEN > $A/listeners-launched.txt
date -u +%FT%TZ > $A/proof-start
set +e
nub ${CONTINGENCY_IOS_PROOF_SCRIPT:-.cursor/skills/verify-contingency/bin/ios-workspace-proof.mjs} > $A/proof.log 2>&1
echo $? > $A/proof-exit
set -e
date -u +%FT%TZ > $A/proof-end
ps -axo pid=,ppid=,lstart=,comm= > $A/processes-proof-ended.txt
rsync -a --prune-empty-dirs --include="*/" --include="*.json" --include="*.jsonl" --exclude="*" $A/verify/state/ $A/state-evidence/ 2>/dev/null
echo done proof-exit=$(cat $A/proof-exit)
