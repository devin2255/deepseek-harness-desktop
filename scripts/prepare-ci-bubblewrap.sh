#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

if ! command -v bwrap >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends bubblewrap
fi

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'
bwrap --version
bwrap --ro-bind / / --dev /dev --proc /proc --die-with-parent -- true
echo 'bubblewrap functional probe passed'
