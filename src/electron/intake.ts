/** 原生剪贴板/拖放输入，复用页面内 bridge.ts 的校验与合成事件。 / Native clipboard/drop intake reusing the page bridge for validation and synthetic events. */

import { clipboard } from 'electron';
import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { MAX_FILES, MAX_TOTAL_BYTES } from '../shared/limits.ts';
import { isPasteShortcut, mimeForPath, parseUriList, safeName } from './pure';

interface NativeItem {
  readonly name: string;
  readonly type: string;
  /** 标准 RFC 4648 base64，不是 data URL。 / Standard RFC 4648 base64, not a data URL. */
  readonly data: string;
}

interface DropPayload {
  readonly items: readonly NativeItem[];
  readonly x: number;
  readonly y: number;
}

const busy = new WeakSet<WebContents>();

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function readPaths(paths: readonly string[]): Promise<NativeItem[]> {
  const items: NativeItem[] = [];
  let total = 0;
  for (const file of paths.slice(0, MAX_FILES)) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size <= 0 || total + info.size > MAX_TOTAL_BYTES) continue;
      const bytes = await readFile(file);
      total += bytes.length;
      items.push({ name: safeName(file), type: mimeForPath(file), data: base64(bytes) });
    } catch {
      // 单个文件失败不应破坏其余拖放项。 / One unreadable file must not drop the rest of the selection.
    }
  }
  return items;
}

/** 读取当前剪贴板中的本地文件或位图；普通文本返回空数组，交给原生粘贴。 / Read local files or bitmap; text returns [] and falls back to native paste. */
async function readClipboardItems(): Promise<NativeItem[]> {
  let entries;
  try {
    entries = await clipboard.read();
  } catch {
    return [];
  }

  for (const entry of entries) {
    const uriType = entry.types.find(type => type.toLowerCase().startsWith('text/uri-list'));
    if (uriType === undefined) continue;
    try {
      const payload = await entry.getType(uriType);
      if (typeof payload !== 'object' || payload === null || typeof (payload as Blob).text !== 'function') continue;
      const items = await readPaths(parseUriList(await (payload as Blob).text()));
      if (items.length > 0) return items;
    } catch {
      // 继续尝试位图。 / Fall through to bitmap entries.
    }
  }

  for (const entry of entries) {
    const imageType = entry.types.find(type => /^image\/(png|jpe?g|webp|gif)$/i.test(type));
    if (imageType === undefined) continue;
    try {
      const payload = await entry.getType(imageType);
      if (typeof payload !== 'object' || payload === null || typeof (payload as Blob).arrayBuffer !== 'function') continue;
      const bytes = new Uint8Array(await (payload as Blob).arrayBuffer());
      if (bytes.length > 0 && bytes.length <= MAX_TOTAL_BYTES) {
        const extension = imageType.toLowerCase() === 'image/jpeg' ? 'jpg'
          : imageType.toLowerCase().split('/')[1]!;
        return [{
          name: `clipboard.${extension}`,
          type: imageType.toLowerCase(),
          data: base64(bytes),
        }];
      }
    } catch {
      // 没有可用位图。 / No usable bitmap.
    }
  }
  return [];
}

function validItems(value: unknown): value is NativeItem[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) return false;
  let total = 0;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const { name, type, data } = item as Partial<NativeItem>;
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
    if (typeof type !== 'string' || type.length === 0 || type.length > 120) return false;
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_TOTAL_BYTES * 4 / 3) + 4) return false;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
    total += Math.floor(data.length * 3 / 4);
    if (total > MAX_TOTAL_BYTES) return false;
  }
  return value.length > 0;
}

async function evaluate(contents: WebContents, expression: string): Promise<unknown> {
  return contents.executeJavaScript(expression, true);
}

async function notify(contents: WebContents, message: string): Promise<void> {
  try {
    await evaluate(contents, `window.__dshNativeIntake?.notifyError(${JSON.stringify(message)})`);
  } catch {
    // 页面没有 bridge 时静默失败。 / Silence when the page has no bridge.
  }
}

/** 将原生文件/位图投递给当前焦点输入框。 / Deliver native files/bitmap to the focused composer. */
export async function deliverPaste(contents: WebContents): Promise<void> {
  if (contents.isDestroyed() || busy.has(contents)) return;
  busy.add(contents);
  const id = randomUUID();
  try {
    const prepared = await evaluate(contents,
      `Boolean(window.__dshNativeIntake?.preparePaste(${JSON.stringify(id)}))`) === true;
    const items = await readClipboardItems();

    if (items.length === 0) {
      // 普通文字：沿用 bridge 的原焦点 guard，再让 Chromium 执行真实粘贴。
      // Ordinary text: keep the bridge's focus guard, then let Chromium paste for real.
      if (prepared) {
        const armed = await evaluate(contents,
          `Boolean(window.__dshNativeIntake?.armNativePaste(${JSON.stringify(id)}))`) === true;
        if (!armed) await evaluate(contents, `Boolean(window.__dshNativeIntake?.cancelPaste(${JSON.stringify(id)}))`);
      }
      contents.paste();
      return;
    }

    if (!prepared) {
      await notify(contents, '附件未被原输入框接收，请保持会话与焦点后重试');
      return;
    }
    const applied = await evaluate(contents,
      `Boolean(window.__dshNativeIntake?.paste(${JSON.stringify(id)}, ${JSON.stringify(items)}))`) === true;
    if (!applied) await notify(contents, '附件未被原输入框接收，请保持会话与焦点后重试');
  } catch {
    contents.paste();
  } finally {
    busy.delete(contents);
  }
}

/** 接收 preload 读取的拖放文件并交给 bridge 命中测试。 / Hand preload-read files to the bridge for hit testing. */
export async function deliverDrop(contents: WebContents, payload: unknown): Promise<boolean> {
  if (contents.isDestroyed() || typeof payload !== 'object' || payload === null) return false;
  const { items, x, y } = payload as Partial<DropPayload>;
  if (!validItems(items) || typeof x !== 'number' || typeof y !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  try {
    return await evaluate(contents,
      `Boolean(window.__dshNativeIntake?.drop(${JSON.stringify(items)}, ${JSON.stringify(x)}, ${JSON.stringify(y)}))`) === true;
  } catch {
    return false;
  }
}

/** 安装 Ctrl/Cmd+V 拦截；普通文本仍走 Chromium 原生粘贴。 / Intercept Ctrl/Cmd+V; ordinary text still uses Chromium paste. */
export function attachPaste(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (!isPasteShortcut(input)) return;
    event.preventDefault();
    void deliverPaste(contents);
  });
}

/** 只在已批准的顶层 origin 注入 bridge；不记录 URL。 / Inject the bridge only on the approved top-level origin; never log the URL. */
export async function injectBridge(contents: WebContents, origin: string, source: string): Promise<void> {
  const guarded = `if (window.top === window && location.origin === ${JSON.stringify(origin)}) {\n${source}\n}`;
  await contents.executeJavaScript(guarded, true);
}
