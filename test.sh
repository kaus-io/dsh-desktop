#!/usr/bin/env bash
# Electron 纯函数/输入桥测试；不打开真实窗口，不改动用户数据。 / Electron/bridge tests without a real window.
set -euo pipefail
umask 022
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
cd "$ROOT"

node scripts/check-versions.mjs
pnpm typecheck
node --experimental-strip-types --test tests/bridge.test.ts tests/electron.test.ts tests/versions.test.mjs
pnpm build:bridge
pnpm build:electron
printf 'Version checks, Electron bridge/electron tests passed\n'
