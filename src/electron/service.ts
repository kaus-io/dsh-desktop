/** 纯 TypeScript 服务入口：复用在线 dsh web，或后台启动它。 / Pure-TS service entry: reuse a live dsh web or start one. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { childEnvironment, validateHttpUrl } from './pure';

const DEFAULT_ORIGIN = 'http://127.0.0.1:3080';
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/** 当前使用的 DSH 地址；只保留 origin。 / The DSH origin currently in use. */
export function appOrigin(): string {
  const raw = (process.env.DSH_APP_ORIGIN ?? '').trim() || DEFAULT_ORIGIN;
  return validateHttpUrl(raw).origin;
}

/** 服务是否可达；任何 HTTP 响应都算在线。 / Reachable if any HTTP response arrives. */
export async function online(target: string = appOrigin()): Promise<boolean> {
  try {
    await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** 查找可执行文件，包含 nvm 的 node bin 目录（GUI 启动时 PATH 常常没有）。 / Locate an executable, including nvm node bins. */
function locate(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const versions = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    // 按数字排序选最新 Node，避免 v9 排在 v24 前面。 / Sort numerically so v24 wins over v9.
    for (const version of fs.readdirSync(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      dirs.push(path.join(versions, version, 'bin'));
    }
  } catch {
    // nvm 不存在时只用 PATH。 / No nvm: use PATH only.
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // 继续找。 / Keep looking.
    }
  }
  return null;
}

/** 后台启动 `dsh web`，优先 npx，找不到 npx 时退回全局 dsh。 / Start `dsh web` detached; prefer npx, fall back to a global dsh. */
function startWeb(): void {
  const npx = locate('npx');
  const command = npx ?? locate('dsh');
  if (command === null) {
    throw new Error('找不到 npx 或 dsh；请先安装 @deepseek-ai/dsh / Cannot find npx or dsh; install @deepseek-ai/dsh first');
  }
  const logDir = app.getPath('userData');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(logDir, 'dsh-web.log'), 'a', 0o600);
  const args = npx === null
    ? ['web', '--no-open']
    : ['--yes', '@deepseek-ai/dsh', 'web', '--no-open'];
  // 私有 fonts.conf 不能让 detached 的 dsh web 继承，否则卸载或重装后服务仍指向旧路径。
  // The private fonts.conf must not leak into the detached dsh web; it would outlive the app.
  const childEnv = childEnvironment(process.env);
  try {
    const child = spawn(command, args, {
      cwd: os.homedir(),
      detached: true,
      stdio: ['ignore', log, log],
      env: childEnv,
    });
    child.on('error', () => { /* resolveUrl 会以 origin 超时报错。 / resolveUrl reports a timeout with the origin. */ });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

/** 复用在线服务或启动一个；登录 URL 直接返回。 / Reuse/start a service; a login URL is returned as-is. */
export async function resolveUrl(login?: string): Promise<string> {
  if (login !== undefined) return validateHttpUrl(login).toString();
  const target = appOrigin();
  if (await online(target)) return target;
  startWeb();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    if (await online(target)) return target;
  }
  throw new Error(`dsh web 未在 ${READY_TIMEOUT_MS / 1000} 秒内就绪：${target}`);
}

/** `--status`：只检查当前 origin。 / `--status`: check the current origin only. */
export async function status(): Promise<boolean> {
  return online();
}

/** `--install-shortcut`：在桌面目录写启动器。 / `--install-shortcut`: write a desktop launcher. */
export function installShortcut(): string {
  const desktop = app.getPath('desktop');
  const target = fs.existsSync('/usr/bin/dsh-desktop') ? '/usr/bin/dsh-desktop' : process.execPath;
  const quoted = `"${target.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const file = path.join(desktop, 'dsh-desktop.desktop');
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DeepSeek Harness',
    'Comment=Open DeepSeek Harness in its own window',
    `Exec=${quoted}`,
    'Icon=dsh-desktop',
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=dsh-desktop',
    '',
  ].join('\n');
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}
