/**
 * Electron 主进程：Chromium 窗口 + 轻量 dsh web 启动器。
 * 粘贴、拖放、输入法全部交给 Chromium；桌面壳不注入脚本、不拦截输入事件。
 *
 * Electron main: a Chromium window plus a light dsh web launcher. Paste, drop
 * and IME stay native; the shell injects no page script and intercepts no input.
 */

import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { originOf, parseCli, usage } from './pure';
import type { Cli } from './pure';
import { installShortcut, resolveUrl, status } from './service';

const APP_NAME = 'DeepSeek Harness';
const VERSION = app.getVersion();
const FONT_CSS = ':root{--dsw-font-family:"HarmonyOS Sans SC","HarmonyOS Sans",sans-serif!important}'
  + 'body{font-family:"HarmonyOS Sans SC","HarmonyOS Sans",sans-serif!important}';

app.setName(APP_NAME);

function dataDir(): string {
  const configured = process.env.XDG_DATA_HOME;
  const base = configured !== undefined && path.isAbsolute(configured)
    ? configured
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'dsh-desktop');
}

app.setPath('userData', path.join(dataDir(), 'electron'));

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** 在 Chromium 初始化字体服务前设置私有字体目录。 / Point Chromium's fontconfig at the bundled fonts before it initializes. */
function configureFonts(): void {
  const fonts = app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(app.getAppPath(), 'assets', 'fonts');
  if (!fs.existsSync(fonts)) return;
  const cache = path.join(app.getPath('userData'), 'fontconfig-cache');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const conf = path.join(app.getPath('userData'), 'fonts.conf');
  const xml = '<?xml version="1.0"?>\n'
    + '<!DOCTYPE fontconfig SYSTEM "urn:fonts.dtd">\n'
    + '<fontconfig>\n'
    + '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n'
    + `  <dir>${escapeXml(fonts)}</dir>\n`
    + `  <cachedir>${escapeXml(cache)}</cachedir>\n`
    + '</fontconfig>\n';
  fs.writeFileSync(conf, xml, { mode: 0o600 });
  process.env.FONTCONFIG_FILE = conf;
}

function cliArguments(): string[] {
  // Electron 开发模式下 argv 里会带一个 app 路径（通常是 `.`）；打包后没有。
  // In Electron dev mode argv contains the app path (usually `.`); packaged apps do not.
  const args = process.argv.slice(1);
  // Electron 会把仍留在 argv 里的 Chromium 开关传进来；先过滤，再剥离开发模式 app 路径。
  // Electron keeps some Chromium switches in argv; filter them before stripping the dev app path.
  const switches = new Set(['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--enable-logging']);
  const rest = args.filter(argument => !switches.has(argument) && !argument.startsWith('--ozone-platform='));
  return rest[0] === '.' ? rest.slice(1) : rest;
}

function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'assets', 'icon.png');
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(APP_NAME, message);
  app.quit();
}

function setupPermissions(): void {
  // DSH 的复制按钮需要 clipboard-sanitized-write；其余权限一律拒绝。
  // DSH copy buttons need clipboard-sanitized-write; deny everything else.
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

function createWindow(url: string): BrowserWindow {
  const origin = originOf(url);
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
    },
  });
  window.setMenuBarVisibility(false);
  const contents = window.webContents;

  contents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, target) => {
    let allowed = false;
    try {
      allowed = new URL(target).origin === origin;
    } catch {
      allowed = false;
    }
    if (allowed) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) void shell.openExternal(target);
  });

  contents.on('dom-ready', () => {
    void contents.insertCSS(FONT_CSS, { cssOrigin: 'user' }).catch(() => {});
  });

  contents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) template.push({ role: 'paste', label: '粘贴 / Paste' });
    if (params.editFlags.canCopy) template.push({ role: 'copy', label: '复制 / Copy' });
    template.push({ role: 'selectAll', label: '全选 / Select All' });
    Menu.buildFromTemplate(template).popup({ window });
  });

  contents.on('did-fail-load', (_event, code, description, _validatedURL, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      dialog.showErrorBox(APP_NAME, `页面加载失败 / Page failed to load: ${description} (${code})`);
    }
  });

  contents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox(APP_NAME, `渲染进程退出 / Renderer exited: ${details.reason}`);
  });

  // 仅用于无显示环境冒烟：页面就绪后退出。 / Headless smoke only.
  contents.on('did-finish-load', () => {
    if (process.env.DSH_DESKTOP_SMOKE !== '1') return;
    void contents.executeJavaScript('document.readyState').then(state => {
      console.log(`SMOKE_READY=${String(state)}`);
      setTimeout(() => { app.quit(); }, 200);
    }).catch(error => {
      console.error('SMOKE_ERROR', error instanceof Error ? error.message : String(error));
      app.exit(2);
    });
  });

  window.once('ready-to-show', () => { window.show(); });
  void window.loadURL(url).catch(fail);
  return window;
}

let mainWindow: BrowserWindow | null = null;

async function openApp(login: string | undefined): Promise<void> {
  const url = await resolveUrl(login);
  mainWindow = createWindow(url);
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function main(): Promise<void> {
  let cli: Cli;
  try {
    cli = parseCli(cliArguments());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage(VERSION));
    app.exit(2);
    return;
  }

  if (cli.mode === 'version') {
    console.log(`dsh-desktop ${VERSION} (Electron)`);
    app.exit(0);
    return;
  }
  if (cli.mode === 'help') {
    console.log(usage(VERSION));
    app.exit(0);
    return;
  }

  app.on('window-all-closed', () => { app.quit(); });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => { event.preventDefault(); });
  });

  if (cli.mode === 'status' || cli.mode === 'shortcut') {
    await app.whenReady();
    try {
      if (cli.mode === 'status') {
        const live = await status();
        console.log(live ? 'running' : 'not running');
        app.exit(live ? 0 : 1);
      } else {
        console.log(`shortcut: ${installShortcut()}`);
        app.exit(0);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      app.exit(1);
    }
    return;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // 只有真正打开窗口时才创建 userData/字体配置；--version/--status 不写用户目录。
  // Create userData/fonts only when opening a window; --version/--status write nothing.
  fs.mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  configureFonts();
  await app.whenReady();
  setupPermissions();
  app.on('activate', () => { if (mainWindow !== null) mainWindow.focus(); });
  try {
    await openApp(cli.mode === 'open' ? cli.login : undefined);
  } catch (error) {
    fail(error);
  }
}

void main().catch(fail);
