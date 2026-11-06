/** 纯函数：CLI 与服务环境。 / Pure helpers for the CLI and the service child environment. */

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

/** 校验并取出 URL 的 origin。 / Validate a URL and return its origin. */
export function originOf(input: string): string {
  return validateHttpUrl(input).origin;
}
