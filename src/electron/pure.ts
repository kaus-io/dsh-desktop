/** 纯函数：CLI、URL、剪贴板 URI 列表和输入上限。 / Pure helpers for CLI parsing, URLs, URI lists and intake limits. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 生成 dsh web 子进程环境：去掉桌面壳私有的 FONTCONFIG_FILE。 / Build the dsh web child env, dropping the shell-private FONTCONFIG_FILE. */
export function childEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const child = { ...env };
  delete child.FONTCONFIG_FILE;
  return child;
}

export type Cli =
  | { readonly mode: 'open'; readonly login?: string }
  | { readonly mode: 'status' | 'shortcut' | 'version' | 'help' };

/** 解析桌面壳公开参数；登录 URL 只接受 http(s)。 / Parse public desktop flags; login URLs are http(s) only. */
export function parseCli(argv: readonly string[]): Cli {
  const [first, second, ...rest] = argv;
  if (first === undefined) return { mode: 'open' };
  if (first === '--login') {
    if (second === undefined || rest.length > 0) throw new Error('--login requires exactly one URL');
    validateHttpUrl(second);
    return { mode: 'open', login: second };
  }
  if (second !== undefined) throw new Error(`Unexpected argument after ${first}`);
  switch (first) {
    case '--status': return { mode: 'status' };
    case '--install-shortcut': return { mode: 'shortcut' };
    case '--version': case '-V': return { mode: 'version' };
    case '--help': case '-h': return { mode: 'help' };
    default: throw new Error(`Unknown argument: ${first}`);
  }
}

/** 生成 `--help` 文本；版本由 package.json 传入。 / Build the `--help` text; the version comes from package.json. */
export function usage(version: string): string {
  return [
    `dsh-desktop ${version} (Electron)`,
    '',
    '在独立 Chromium 窗口中打开/复用 dsh web。 / Open or reuse dsh web in its own Chromium window.',
    '  --login <url>',
    '  --status',
    '  --install-shortcut',
    '  --version, -V',
    '  --help, -h',
  ].join('\n');
}

/** 只允许无凭据的 http(s) URL。 / Reject non-http(s) URLs and inline credentials. */
export function validateHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must be http(s)');
  if (url.username !== '' || url.password !== '') throw new Error('URL must not contain credentials');
  return url;
}

/** 解析 X11 剪贴板的 text/uri-list；只接受本地 file URI。 / Parse text/uri-list; local file URIs only. */
export function parseUriList(text: string): string[] {
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!line.startsWith('file://')) continue;
    try {
      const file = fileURLToPath(line);
      if (file !== '' && !paths.includes(file)) paths.push(file);
    } catch {
      // 忽略格式错误的 URI；调用方会按数量/大小再限制。 / Ignore malformed URIs; callers enforce limits.
    }
  }
  return paths;
}

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip',
  '.ts': 'text/plain', '.tsx': 'text/plain', '.js': 'text/plain', '.css': 'text/plain',
  '.html': 'text/html', '.xml': 'application/xml', '.log': 'text/plain',
};

/** 按扩展名推断 MIME；未知类型回退为 octet-stream。 / Map an extension to MIME, falling back to octet-stream. */
export function mimeForPath(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 生成最多 200 字符的展示文件名。 / Build a display-safe basename capped at 200 chars. */
export function safeName(file: string): string {
  const base = path.basename(file).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base === '' ? 'file' : base.slice(0, 200);
}

/** Electron Input 的最小结构，便于纯测试。 / Minimal Electron Input shape for pure tests. */
export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly control?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/** Ctrl/Cmd+V 且不带 Alt/Shift 时视为粘贴。 / Treat Ctrl/Cmd+V without Alt/Shift as paste. */
export function isPasteShortcut(input: KeyInput): boolean {
  return input.type === 'keyDown' && input.key.toLowerCase() === 'v'
    && (input.control === true || input.meta === true)
    && input.alt !== true && input.shift !== true;
}

/** 校验并取出 URL 的 origin。 / Validate a URL and return its origin. */
export function originOf(input: string): string {
  return validateHttpUrl(input).origin;
}
