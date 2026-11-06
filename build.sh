#!/usr/bin/env bash
# 构建 Electron 主进程并打出 .deb。 / Build the Electron main process and a .deb.
set -euo pipefail
umask 022
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
cd "$ROOT"

command -v pnpm >/dev/null || { echo 'missing build tool: pnpm' >&2; exit 1; }
[ -x node_modules/.bin/electron-builder ] || { echo 'run pnpm install (with electron/electron-builder) first' >&2; exit 1; }

pnpm build:electron
pnpm typecheck

# electron-builder 下载 Electron 时可用 ELECTRON_MIRROR 指向镜像。
# electron-builder may use ELECTRON_MIRROR for the Electron download.
pnpm exec electron-builder --linux deb --publish never
ls -l dist-electron/*.deb
