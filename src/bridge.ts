/**
 * dsh-desktop：仅注入已批准的顶层 DSH origin。
 * Electron 原生输入通过单向 JavaScript eval 提供已读取的字节；这里不读系统剪贴板、
 * 不抓取 URL、不调用 Electron、不打开路径，也不给页面任何原生能力。原生侧必须
 * 独立拒绝失效的导航回调和未批准的 origin。由 `scripts/build-bridge.mjs` 用
 * esbuild 打成 IIFE；下面的导出只是给 Node 内置 TypeScript 测试运行器用的纯函数，
 * 本模块唯一安装的浏览器全局是 window.__dshNativeIntake。
 *
 * dsh-desktop — injected into the approved top-level DSH origin only.
 *
 * Electron native intake supplies already-read bytes by one-way JavaScript eval.
 * Nothing here reads the system clipboard, fetches URLs, invokes Electron, opens a
 * path, or grants a page any native capability. Native code must independently
 * reject stale navigation callbacks and non-approved origins before evaluating.
 *
 * Bundle with scripts/build-bridge.mjs (esbuild IIFE). The exports below are pure
 * helpers for Node's built-in TypeScript test runner; the only browser global
 * installed by this module is window.__dshNativeIntake.
 */

export interface NativeItem {
  readonly name: string;
  readonly type: string;
  /** 标准 RFC 4648 base64，不是 data URL。 / Standard RFC 4648 base64, not a data URL. */
  readonly data: string;
}

export interface NativeIntake {
  /** 对任意目标做快照，供普通文本回退做焦点守卫。 / Snapshot even a non-composer target, for guarded ordinary-text fallback. */
  preparePaste(id: string): boolean;
  /** 只消费有效快照，并守卫下一次受信任的原生粘贴事件。 / Consume only a valid snapshot and guard the next trusted native paste event. */
  armNativePaste(id: string): boolean;
  /** 消费快照用于清理；这不会授权后续原生 Paste。 / Consume a snapshot for cleanup; this does NOT authorize a later native Paste. */
  cancelPaste(id: string): boolean;
  /** 消费快照，只把文件投递给原始且仍存活的输入框。 / Consume the snapshot and deliver files only to the original live composer. */
  paste(id: string, items: readonly NativeItem[]): boolean;
  /** 按 CSS 视口坐标投递原生文件拖放。 / Deliver a native file drop at CSS viewport coordinates. */
  drop(items: readonly NativeItem[], x: number, y: number): boolean;
  /** 可选的原生错误提示；只接受文本，不解释 HTML 或命令。 / Optional native error UI. Text only; never interprets HTML or commands. */
  notifyError(message: string): boolean;
}

declare global {
  interface Window {
    __dshNativeIntake?: Readonly<NativeIntake>;
  }
}

import { MAX_FILES, MAX_TOTAL_BYTES } from './shared/limits.ts';

export { MAX_FILES };
export const MAX_BYTES = MAX_TOTAL_BYTES;
export const NATIVE_PASTE_GUARD_MS = 5_000;
const MAX_BASE64_LENGTH = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_PENDING = 16;
const PASTE_TIMEOUT_MS = 15_000;
const COMPOSER = '[data-composer-input="true"]';
const SCOPE = '[data-conversation-content]';
const SESSION_ATTRIBUTE = 'data-conversation-session';

export interface DecodedItem {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

/** 有界、原子校验；原生文件不做图片过滤或重编码。 / Bounded, atomic validation. Native files are not image-filtered or re-encoded. */
export function decodeNativeItems(items: unknown): DecodedItem[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_FILES) {
    throw new RangeError('Expected 1–20 native files');
  }
  let total = 0;
  return items.map((item: unknown) => {
    if (item === null || typeof item !== 'object') throw new TypeError('Invalid native file');
    const { name, type, data } = item as Partial<NativeItem>;
    if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0') ||
        typeof type !== 'string' || type.length > 255 || !/^[\x20-\x7e]*$/.test(type) ||
        typeof data !== 'string') throw new TypeError('Invalid native file metadata');
    // 先检查长度，避免正则或 atob 再分配一个大值。 / Check lengths before either the regexp or atob allocates another large value.
    if (data.length > MAX_BASE64_LENGTH || total + (data.length / 4 * 3 -
        (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)) > MAX_BYTES) {
      throw new RangeError('Native files exceed 16 MiB');
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    // 这里不要用重复的四字符捕获：某些 JS 正则引擎会在合法的数 MB 附件上
    // 耗尽调用栈。 / Do not use a repeated four-character capture here: some JS
    // regexp engines exhaust their stack on otherwise valid multi-megabyte attachments.
    if (data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) {
      throw new TypeError('Invalid native file base64');
    }
    const raw = atob(data);
    total += raw.length;
    if (total > MAX_BYTES) throw new RangeError('Native files exceed 16 MiB');
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { name, type, bytes };
  });
}

/** 保守的栅格/容器检查，不是解码器；绝不接受文本或 SVG。 / Conservative raster/container checks, not a decoder. Never accept text or SVG. */
function rasterType(bytes: Uint8Array): { type: string; extension: string } | null {
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 57 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n' &&
      view.getUint32(8) === 13 && ascii(12, 4) === 'IHDR' &&
      view.getUint32(16) > 0 && view.getUint32(20) > 0) {
    let offset = 8;
    let imageData = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const kind = ascii(offset + 4, 4);
      if (length > bytes.length - offset - 12) return null;
      if (kind === 'IDAT' && length > 0) imageData = true;
      if (kind === 'IEND') return length === 0 && imageData && offset + 12 === bytes.length
        ? { type: 'image/png', extension: 'png' } : null;
      offset += length + 12;
    }
    return null;
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 &&
      bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    let offset = 2;
    let dimensions = false;
    while (offset + 3 < bytes.length - 2) {
      if (bytes[offset] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (offset + 2 > bytes.length - 2) return null;
      const length = view.getUint16(offset);
      if (length < 2 || length > bytes.length - offset - 2) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        dimensions = length >= 8 && view.getUint16(offset + 3) > 0 && view.getUint16(offset + 5) > 0;
      }
      if (marker === 0xda) return dimensions && offset + length < bytes.length - 2
        ? { type: 'image/jpeg', extension: 'jpg' } : null;
      offset += length;
    }
    return null;
  }
  if (bytes.length >= 14 && /^GIF8[79]a$/.test(ascii(0, 6)) &&
      view.getUint16(6, true) > 0 && view.getUint16(8, true) > 0 &&
      bytes[bytes.length - 1] === 0x3b) {
    const firstBlock = 13 + (bytes[10]! & 0x80 ? 3 * (2 << (bytes[10]! & 7)) : 0);
    // 逻辑屏幕/调色板之后至少还要有一个图像或扩展块。 / At least an image/extension block must follow the logical screen/table.
    if (firstBlock + 1 < bytes.length && [0x21, 0x2c].includes(bytes[firstBlock]!)) {
      return { type: 'image/gif', extension: 'gif' };
    }
  }
  if (bytes.length >= 26 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' &&
      view.getUint32(4, true) + 8 === bytes.length) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = ascii(offset, 4);
      const length = view.getUint32(offset + 4, true);
      const payload = offset + 8;
      if (length > bytes.length - payload) return null;
      if (kind === 'VP8 ' && length >= 10 && ascii(payload + 3, 3) === '\x9d\x01\x2a' &&
          (view.getUint16(payload + 6, true) & 0x3fff) > 0 &&
          (view.getUint16(payload + 8, true) & 0x3fff) > 0 ||
          kind === 'VP8L' && length >= 5 && bytes[payload] === 0x2f && (bytes[payload + 4]! & 0xe0) === 0) {
        return { type: 'image/webp', extension: 'webp' };
      }
      offset = payload + length + (length & 1);
    }
  }
  return null;
}

/** 只有声明为图片且字节匹配常见栅格的 URL 才走 HTML 回退。 / Only image-declared URLs with matching common raster bytes qualify for HTML fallback. */
export function decodeDataImage(source: string): DecodedItem | null {
  if (source.length > MAX_BASE64_LENGTH + 1024) return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(source.trim());
  if (!match) return null;
  try {
    const item = decodeNativeItems([{
      name: 'clipboard', type: match[1]!.toLowerCase(), data: match[2]!.replace(/[\t\n\r ]/g, ''),
    }])[0]!;
    const raster = rasterType(item.bytes);
    const declaredType = item.type === 'image/jpg' ? 'image/jpeg' : item.type;
    return raster !== null && declaredType === raster.type
      ? { name: `clipboard.${raster.extension}`, type: raster.type, bytes: item.bytes }
      : null;
  } catch {
    return null;
  }
}

export interface SelectionSnapshot {
  readonly anchor: Node | null;
  readonly anchorOffset: number;
  readonly focus: Node | null;
  readonly focusOffset: number;
  readonly ranges: readonly {
    readonly start: Node;
    readonly startOffset: number;
    readonly end: Node;
    readonly endOffset: number;
  }[];
  readonly input: readonly [number | null, number | null, string | null, string] | null;
}

/** 按节点身份和偏移比较选区，避免文本相同被误判。 / Compare selections by node identity and offsets, not by text. */
export function sameSelection(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return a.anchor === b.anchor && a.anchorOffset === b.anchorOffset &&
    a.focus === b.focus && a.focusOffset === b.focusOffset &&
    a.ranges.length === b.ranges.length && a.ranges.every((range, i) => {
      const other = b.ranges[i]!;
      return range.start === other.start && range.startOffset === other.startOffset &&
        range.end === other.end && range.endOffset === other.endOffset;
    }) && (a.input === null ? b.input === null : b.input !== null &&
      a.input.every((value, i) => value === b.input![i]));
}

function selectionSnapshot(target: Element): SelectionSnapshot {
  const selection = document.getSelection();
  const ranges: SelectionSnapshot['ranges'][number][] = [];
  if (selection !== null) {
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      // 保存不可变边界值，而不是会跟随 DOM 编辑的活 Range。 / Store immutable boundary values, not live Ranges that follow DOM edits.
      ranges.push({ start: range.startContainer, startOffset: range.startOffset,
        end: range.endContainer, endOffset: range.endOffset });
    }
  }
  const control = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    ? target : null;
  return {
    anchor: selection?.anchorNode ?? null, anchorOffset: selection?.anchorOffset ?? 0,
    focus: selection?.focusNode ?? null, focusOffset: selection?.focusOffset ?? 0,
    ranges,
    input: control === null ? null :
      [control.selectionStart, control.selectionEnd, control.selectionDirection, control.value],
  };
}

export interface NativePasteGuardState<T> {
  readonly snapshot: T;
  readonly expires: number;
}

/** 合成事件永不消费存活的 native guard；过期时间是有限的。 / Synthetic events never consume a live native guard; expiration is bounded. */
export function takeTrustedPaste<T>(guard: NativePasteGuardState<T> | null, isTrusted: boolean, now: number): {
  readonly guard: NativePasteGuardState<T> | null;
  readonly snapshot: T | null;
} {
  if (guard === null || now >= guard.expires) return { guard: null, snapshot: null };
  return isTrusted ? { guard: null, snapshot: guard.snapshot } : { guard, snapshot: null };
}

interface PasteSnapshot {
  readonly target: Element;
  readonly composer: HTMLElement | null;
  readonly scope: Element | null;
  readonly session: string | null;
  readonly selection: SelectionSnapshot;
  readonly text: string | null;
  readonly href: string;
  readonly revision: number;
  readonly sessionRevision: number;
  readonly expires: number;
  readonly timer: number;
}

/** 用不透明身份让上下文比较保持纯函数、可独立测试。 / Opaque identities keep this context comparison pure and independently testable. */
export interface DropScopeState {
  readonly target: object;
  readonly scope: object | null;
  readonly session: string | null;
  readonly href: string;
  readonly revision: number;
  readonly sessionRevision: number;
}

/** 比较拖放上下文的不透明身份与版本。 / Compare drop-context identities and revisions. */
export function sameDropScope(before: DropScopeState, after: DropScopeState): boolean {
  return before.target === after.target && before.scope === after.scope &&
    before.session === after.session && before.href === after.href &&
    before.revision === after.revision && before.sessionRevision === after.sessionRevision;
}

interface DropContext extends DropScopeState {
  readonly target: Element;
  readonly scope: Element;
  readonly session: string;
  readonly x: number;
  readonly y: number;
  readonly expires: number;
}

function installBridge(): void {
  // 原生侧只在批准的 origin 注入；子 frame 不安装。 / Native code injects only on its approved origin; do not install in subframes.
  if (window.top !== window) return;
  if (window.__dshNativeIntake) return;

  const pastes = new Map<string, PasteSnapshot>();
  let revision = 0;
  let sessionRevision = 0;
  let nativePasteGuard: NativePasteGuardState<PasteSnapshot> | null = null;
  let nativePasteInvalidated = false;
  let nativePasteTimer = 0;
  const clearNativePasteGuard = () => {
    window.clearTimeout(nativePasteTimer);
    nativePasteTimer = 0;
    nativePasteGuard = null;
    nativePasteInvalidated = false;
  };
  const remove = (id: string) => {
    const snapshot = pastes.get(id);
    if (snapshot) window.clearTimeout(snapshot.timer);
    pastes.delete(id);
    return snapshot;
  };
  const invalidate = () => {
    revision++;
    for (const id of pastes.keys()) remove(id);
    // 保留已 armed 的 native guard：它接下来的受信任粘贴必须在焦点/session
    // 失效后被取消，而不是悄悄落到新目标上。
    // Keep an armed native guard: its upcoming trusted paste must be cancelled
    // after focus/session invalidation, not silently released into the new target.
    if (nativePasteGuard !== null) nativePasteInvalidated = true;
  };
  const activeComposer = () => {
    const active = document.activeElement;
    const composer = active?.closest(COMPOSER);
    return composer instanceof HTMLElement && composer.isContentEditable &&
      composer.getAttribute('aria-disabled') !== 'true' ? composer : null;
  };
  const scopeOf = (target: Element) => target.closest(SCOPE);
  const sessionOf = (scope: Element | null) => scope?.getAttribute(SESSION_ATTRIBUTE) ?? null;
  const selectionInside = (selection: SelectionSnapshot, composer: HTMLElement) =>
    selection.ranges.length === 0 || selection.ranges.every((range) =>
      composer.contains(range.start) && composer.contains(range.end));

  // 常驻输入框可能在原生剪贴板 IO 结束前经历 A -> B -> A；Mutation 记录让
  // 这种往返也判原请求失效。
  // A resident composer may change A -> B -> A before native clipboard IO ends.
  // Mutation records make even that round trip invalidate the original request.
  const processMutations = (records: readonly MutationRecord[]) => {
    if (records.some((record) => record.type === 'attributes'
      ? record.attributeName === SESSION_ATTRIBUTE
      : [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
        node instanceof Element && (node.matches(SCOPE) || node.querySelector(SCOPE) !== null)))) sessionRevision++;
    const affects = (snapshot: PasteSnapshot) => records.some((record) => record.type === 'attributes'
      ? record.target === snapshot.scope || record.target === snapshot.composer ||
        (record.target instanceof Element && record.target.contains(snapshot.target))
      : Array.from(record.removedNodes).some((node) => node === snapshot.target ||
          node.contains(snapshot.target) || node === snapshot.scope) ||
        (snapshot.composer !== null && snapshot.composer.contains(record.target)));
    for (const [id, snapshot] of pastes) if (affects(snapshot)) remove(id);
    // Arming 消费的是 map 条目，不是它的失效历史；即使 DOM 之后恢复原状，
    // 也要保留 guard 并记住这些变更。
    // Arming consumes the map entry, not its invalidation history. Preserve the
    // guard and remember mutations even if the DOM later returns to its old state.
    if (nativePasteGuard !== null && affects(nativePasteGuard.snapshot)) nativePasteInvalidated = true;
  };
  const observer = new MutationObserver(processMutations);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: [SESSION_ATTRIBUTE, 'contenteditable', 'aria-disabled'] });
  const matches = (snapshot: PasteSnapshot) => {
    processMutations(observer.takeRecords());
    return snapshot.revision === revision && snapshot.sessionRevision === sessionRevision &&
      snapshot.expires >= Date.now() &&
      location.href === snapshot.href && document.visibilityState !== 'hidden' &&
      snapshot.target.isConnected && document.activeElement === snapshot.target &&
      snapshot.scope === scopeOf(snapshot.composer ?? snapshot.target) &&
      snapshot.session === sessionOf(snapshot.scope) &&
      snapshot.text === (snapshot.composer?.textContent ?? null) &&
      sameSelection(snapshot.selection, selectionSnapshot(snapshot.target));
  };

  for (const type of ['pagehide', 'beforeunload', 'popstate', 'hashchange', 'blur']) {
    window.addEventListener(type, invalidate);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') invalidate();
  });
  document.addEventListener('focusout', invalidate, true);
  const checkSelections = () => {
    for (const [id, snapshot] of pastes) if (!matches(snapshot)) remove(id);
    if (nativePasteGuard !== null && !matches(nativePasteGuard.snapshot)) nativePasteInvalidated = true;
  };
  document.addEventListener('input', checkSelections, true);
  document.addEventListener('selectionchange', checkSelections);
  // pushState/replaceState 不会触发 popstate；保留 receiver、返回值和异常，
  // 只在成功的同文档导航后失效。
  // pushState/replaceState do not emit popstate. Preserve their receivers, return
  // values and failures, while invalidating on successful same-document navigation.
  for (const key of ['pushState', 'replaceState'] as const) {
    const original = history[key];
    try {
      history[key] = function (this: History, ...args: Parameters<History[typeof key]>) {
        const result = original.apply(this, args);
        invalidate();
        return result;
      };
    } catch { /* 页面锁定 History 时仍有 URL、DOM session 和原生守卫。 / A locked-down page still has URL, DOM-session and native guards. */ }
  }

  const transfer = (items: readonly DecodedItem[]) => {
    const data = new DataTransfer();
    for (const item of items) {
      // 新 ArrayBuffer 是刻意的：不使用 SharedArrayBuffer 支撑的 Blob。 / A fresh ArrayBuffer is intentional: no SharedArrayBuffer-backed Blob parts.
      const bytes = new Uint8Array(item.bytes.length);
      bytes.set(item.bytes);
      data.items.add(new File([bytes.buffer], item.name, { type: item.type }));
    }
    return data;
  };

  const captureDrop = (x: number, y: number): DropContext | null => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
        x >= window.innerWidth || y >= window.innerHeight || document.visibilityState === 'hidden') return null;
    processMutations(observer.takeRecords());
    const target = document.elementFromPoint(x, y);
    const scope = target === null ? null : scopeOf(target);
    const session = sessionOf(scope);
    // 外部或含糊的拖放不能被重定向到文件系统 IO 完成时碰巧选中的会话。
    // An outside/ambiguous drop must not be redirected to whichever session is
    // selected when filesystem IO eventually completes.
    if (!target || !scope || !session) return null;
    return { target, scope, session, x, y, href: location.href, revision, sessionRevision,
      expires: Date.now() + PASTE_TIMEOUT_MS };
  };
  const dropMatches = (snapshot: DropContext) => {
    processMutations(observer.takeRecords());
    return snapshot.expires >= Date.now() && document.visibilityState !== 'hidden' &&
      snapshot.target.isConnected && snapshot.scope.isConnected &&
      sameDropScope(snapshot, { target: snapshot.target, scope: scopeOf(snapshot.target),
        session: sessionOf(snapshot.scope), href: location.href, revision, sessionRevision });
  };
  const deliverDrop = (snapshot: DropContext, items: readonly NativeItem[]): boolean => {
    try {
      if (!dropMatches(snapshot)) return false;
      const options: DragEventInit = { dataTransfer: transfer(decodeNativeItems(items)),
        bubbles: true, cancelable: true, clientX: snapshot.x, clientY: snapshot.y };
      if (!dropMatches(snapshot)) return false;
      for (const type of ['dragenter', 'dragover']) {
        snapshot.target.dispatchEvent(new DragEvent(type, options));
        if (!dropMatches(snapshot)) return false;
      }
      const event = new DragEvent('drop', options);
      snapshot.target.dispatchEvent(event);
      return event.defaultPrevented;
    } catch {
      return false;
    }
  };

  let errorBox: HTMLDivElement | null = null;
  let errorTimer = 0;
  const bridge: NativeIntake = {
    preparePaste(id) {
      if (typeof id !== 'string' || !id || id.length > 256) return false;
      processMutations(observer.takeRecords());
      if (pastes.has(id) || pastes.size >= MAX_PENDING) return false;
      const target = document.activeElement;
      if (!target || !target.isConnected || document.visibilityState === 'hidden') return false;
      const composer = activeComposer();
      const scope = scopeOf(composer ?? target);
      const selection = selectionSnapshot(target);
      const snapshot: PasteSnapshot = {
        target, composer, scope, session: sessionOf(scope), selection,
        text: composer?.textContent ?? null, href: location.href, revision, sessionRevision,
        expires: Date.now() + PASTE_TIMEOUT_MS,
        timer: window.setTimeout(() => remove(id), PASTE_TIMEOUT_MS),
      };
      pastes.set(id, snapshot);
      return composer !== null && !!snapshot.session && selectionInside(selection, composer);
    },
    armNativePaste(id) {
      const snapshot = pastes.get(id);
      if (snapshot === undefined || !matches(snapshot) || pastes.get(id) !== snapshot) return false;
      const now = Date.now();
      remove(id);
      // 绝不用更新的目标替换一条尚未完成的原生命令的 guard。 / Never replace an outstanding native command's guard with a newer target.
      if (nativePasteGuard !== null && nativePasteGuard.expires > now) return false;
      clearNativePasteGuard();
      const armed = { snapshot, expires: Math.min(snapshot.expires, now + NATIVE_PASTE_GUARD_MS) };
      nativePasteGuard = armed;
      nativePasteTimer = window.setTimeout(() => {
        if (nativePasteGuard === armed) clearNativePasteGuard();
      }, Math.max(0, armed.expires - now));
      return true;
    },
    cancelPaste(id) {
      const snapshot = pastes.get(id);
      const valid = snapshot !== undefined && matches(snapshot) && pastes.get(id) === snapshot;
      remove(id);
      return valid;
    },
    paste(id, items) {
      const snapshot = pastes.get(id);
      const valid = snapshot !== undefined && matches(snapshot) && pastes.get(id) === snapshot;
      remove(id); // 一次性消费，包括无效载荷和分发失败。 / Single-use, including invalid payloads and dispatch failures.
      if (!valid || !snapshot?.composer || !snapshot.session ||
          activeComposer() !== snapshot.composer ||
          !selectionInside(snapshot.selection, snapshot.composer)) return false;
      try {
        const event = new ClipboardEvent('paste', {
          clipboardData: transfer(decodeNativeItems(items)), bubbles: true, cancelable: true,
        });
        if (!matches(snapshot) || activeComposer() !== snapshot.composer) return false;
        snapshot.target.dispatchEvent(event);
        return event.defaultPrevented;
      } catch {
        return false;
      }
    },
    drop(items, x, y) {
      const snapshot = captureDrop(x, y);
      return snapshot !== null && deliverDrop(snapshot, items);
    },
    notifyError(message) {
      if (typeof message !== 'string' || !message.trim() || !document.documentElement) return false;
      if (errorBox) errorBox.remove();
      window.clearTimeout(errorTimer);
      errorBox = document.createElement('div');
      errorBox.setAttribute('role', 'alert');
      errorBox.setAttribute('aria-live', 'assertive');
      errorBox.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483647;max-width:min(640px,90vw);padding:12px 16px;border-radius:8px;' +
        'background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);' +
        'border:1px solid var(--dsw-alias-state-error-primary);' +
        'box-shadow:0 4px 24px var(--dsw-alias-bg-mask-1);' +
        'white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 var(--dsw-font-family),sans-serif;';
      errorBox.textContent = message.slice(0, 2000);
      document.documentElement.append(errorBox);
      const current = errorBox;
      errorTimer = window.setTimeout(() => { current.remove(); if (errorBox === current) errorBox = null; }, 12_000);
      return true;
    },
  };
  window.__dshNativeIntake = Object.freeze(bridge);

  // 普通文本走「原生 eval + 原生 Paste」两步；在真实 paste 事件上原子复核，
  // 早于 HTML 回退或页面监听器改道。合成 ClipboardEvent 不能消费这个 guard。
  // Native ordinary-text fallback is a two-step native eval/Paste operation.
  // Revalidate atomically on its real paste event, before HTML fallback or page
  // listeners can redirect it. Synthetic ClipboardEvents cannot consume this guard.
  document.addEventListener('paste', (event: ClipboardEvent) => {
    if (nativePasteGuard !== null && event.isTrusted) processMutations(observer.takeRecords());
    const invalidated = nativePasteInvalidated;
    const taken = takeTrustedPaste(nativePasteGuard, event.isTrusted, Date.now());
    if (taken.guard !== nativePasteGuard) clearNativePasteGuard();
    nativePasteGuard = taken.guard;
    const snapshot = taken.snapshot;
    if (snapshot === null) return;
    const originalTarget = event.target instanceof Node && snapshot.target.contains(event.target);
    if (invalidated || !originalTarget || !matches(snapshot) ||
        snapshot.composer !== null && activeComposer() !== snapshot.composer) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  // 已有的原生 File 对象永远优先；普通文本、含正文的 HTML、URL 图片、SVG
  // 和未知数据格式保留浏览器原生粘贴。
  // Existing native File objects always win. Ordinary text, prose-containing
  // HTML, URL images, SVG, and unknown data formats retain the browser's paste.
  document.addEventListener('paste', (event: ClipboardEvent) => {
    const composer = activeComposer();
    const data = event.clipboardData;
    if (event.defaultPrevented || !composer || !data || data.files.length ||
        Array.from(data.items).some((item) => item.kind === 'file') ||
        !(event.target instanceof Node) || !composer.contains(event.target)) return;
    const html = data.getData('text/html');
    if (!html || html.length > MAX_BASE64_LENGTH + 65_536) return;
    try {
      // template 内容是惰性的且从不挂载：不发起远程图片请求、不执行脚本、
      // 不把剪贴板 HTML 插入页面。
      // Template contents stay inert and are never attached: no remote image
      // fetches, script execution, or insertion of clipboard HTML into the page.
      const template = document.createElement('template');
      template.innerHTML = html;
      if (template.content.textContent?.trim()) return;
      const images = Array.from(template.content.querySelectorAll('img'));
      if (images.length !== 1) return;
      const source = images[0]!.getAttribute('src') ?? '';
      const text = data.getData('text/plain').trim();
      if (text && text !== source.trim()) return;
      const image = decodeDataImage(source);
      if (!image) return;
      const replacement = new ClipboardEvent('paste', {
        clipboardData: transfer([image]), bubbles: true, cancelable: true,
      });
      event.target.dispatchEvent(replacement);
      // 只有真实输入框接收了文件，才压掉原始事件。 / Do not suppress the original unless the real composer accepted a file.
      if (replacement.defaultPrevented) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    } catch { /* 非法 HTML/base64 绝不能禁用普通粘贴。 / Invalid HTML/base64 must never disable ordinary paste. */ }
  }, true);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') installBridge();
