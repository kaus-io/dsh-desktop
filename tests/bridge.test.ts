/** 只测纯函数：node --experimental-strip-types --test tests/bridge.test.ts / Pure helpers only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_BYTES, MAX_FILES, NATIVE_PASTE_GUARD_MS, decodeDataImage, decodeNativeItems,
  sameDropScope, sameSelection, takeTrustedPaste,
} from '../src/bridge.ts';
import type { DropScopeState, SelectionSnapshot } from '../src/bridge.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const item = (data = 'AAEC/w==', type = 'application/octet-stream') =>
  ({ name: 'native.bin', type, data });

test('native files preserve all bytes and metadata without image filtering', () => {
  const decoded = decodeNativeItems([item()]);
  assert.equal(decoded[0]!.name, 'native.bin');
  assert.equal(decoded[0]!.type, 'application/octet-stream');
  assert.deepEqual(Array.from(decoded[0]!.bytes), [0, 1, 2, 255]);
});

test('empty native files and unknown MIME types are supported', () => {
  assert.equal(decodeNativeItems([item('', '')])[0]!.bytes.length, 0);
  assert.equal(decodeNativeItems([item('YWJj', 'image/not-a-real-image')])[0]!.type, 'image/not-a-real-image');
});

test('each decode produces independent bytes', () => {
  const first = decodeNativeItems([item()])[0]!;
  first.bytes[0] = 99;
  assert.equal(decodeNativeItems([item()])[0]!.bytes[0], 0);
});

test('native list bounds reject zero, oversized, and non-array values', () => {
  for (const value of [null, {}, 'file', [], Array(MAX_FILES + 1).fill(item())]) {
    assert.throws(() => decodeNativeItems(value), RangeError);
  }
  assert.equal(decodeNativeItems(Array(MAX_FILES).fill(item())).length, MAX_FILES);
});

test('invalid metadata is rejected atomically', () => {
  for (const invalid of [null, {}, { ...item(), name: '' }, { ...item(), name: 'bad\0name' },
    { ...item(), name: 'x'.repeat(1025) }, { ...item(), type: '\ntext/plain' },
    { ...item(), type: 'x'.repeat(256) }, { ...item(), data: 1 }]) {
    assert.throws(() => decodeNativeItems([item(), invalid]), TypeError);
  }
});

test('native base64 must be standard, correctly placed and padded', () => {
  for (const encoded of ['a', 'AA', 'AAA', 'a===', '====', 'AA=A', 'AA-_', 'AAEC\n',
    'data:image/png;base64,AAAA', '你好吗']) {
    assert.throws(() => decodeNativeItems([item(encoded)]), TypeError, encoded);
  }
});

test('large valid base64 does not exhaust the regexp engine stack', () => {
  const encoded = 'AAAA'.repeat(512 * 1024);
  assert.equal(decodeNativeItems([item(encoded)])[0]!.bytes.length, 1536 * 1024);
});

test('16 MiB byte limit accepts the boundary and rejects aggregate excess', () => {
  const encoded = Buffer.alloc(MAX_BYTES).toString('base64');
  assert.equal(decodeNativeItems([item(encoded)])[0]!.bytes.length, MAX_BYTES);
  assert.throws(() => decodeNativeItems([item(encoded), item('AA==')]), RangeError);
});

test('oversized payload is rejected before decoding', () => {
  const encoded = 'A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 4);
  assert.throws(() => decodeNativeItems([item(encoded)]), RangeError);
});

test('HTML image fallback retains PNG/GIF original bytes', () => {
  const png = decodeDataImage(`data:image/png;base64,${PNG}`)!;
  assert.equal(png.name, 'clipboard.png');
  assert.equal(png.type, 'image/png');
  assert.deepEqual(png.bytes, new Uint8Array(Buffer.from(PNG, 'base64')));
  const gif = decodeDataImage(`data:image/gif;base64,${GIF}`)!;
  assert.equal(gif.name, 'clipboard.gif');
  assert.deepEqual(gif.bytes, new Uint8Array(Buffer.from(GIF, 'base64')));
});

test('HTML data URL allows case-insensitive MIME and base64 ASCII line wrapping', () => {
  const image = decodeDataImage(`  DATA:IMAGE/PNG;base64,${PNG.slice(0, 20)}\n ${PNG.slice(20)}  `);
  assert.equal(image?.type, 'image/png');
});

test('plain text or a MIME label alone cannot turn text into an image', () => {
  for (const source of ['plain text', 'https://example.com/image.png', `data:text/plain;base64,${PNG}`,
    'data:image/png;base64,aGVsbG8=', `data:image/jpeg;base64,${PNG}`,
    'data:image/png;base64,not-base64', 'data:image/png,hello', 'data:image/png;base64,']) {
    assert.equal(decodeDataImage(source), null, source);
  }
});

test('truncated raster headers do not qualify as image fallback', () => {
  const pngHeader = Buffer.from(PNG, 'base64').subarray(0, 24).toString('base64');
  assert.equal(decodeDataImage(`data:image/png;base64,${pngHeader}`), null);
  assert.equal(decodeDataImage('data:image/jpeg;base64,/9j/2Q=='), null);
  assert.equal(decodeDataImage(`data:image/gif;base64,${Buffer.from(GIF, 'base64').subarray(0, 13).toString('base64')}`), null);
});

test('SVG and unsupported raster formats are left for ordinary browser paste', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.equal(decodeDataImage(`data:image/svg+xml;base64,${svg}`), null);
  assert.equal(decodeDataImage('data:image/tiff;base64,SUkqAAgAAAA='), null);
});

function dropScope(): DropScopeState {
  return { target: {}, scope: {}, session: 'session-a', href: 'http://127.0.0.1:3080/',
    revision: 1, sessionRevision: 2 };
}

test('prepared drop context keeps the original target and scope identities', () => {
  const before = dropScope();
  assert.equal(sameDropScope(before, { ...before }), true);
  assert.equal(sameDropScope(before, { ...before, target: {} }), false);
  assert.equal(sameDropScope(before, { ...before, scope: {} }), false);
  assert.equal(sameDropScope(before, { ...before, scope: null }), false);
});

test('prepared drop refuses different sessions and navigation', () => {
  const before = dropScope();
  assert.equal(sameDropScope(before, { ...before, session: 'session-b' }), false);
  assert.equal(sameDropScope(before, { ...before, session: null }), false);
  assert.equal(sameDropScope(before, { ...before, href: 'http://127.0.0.1:3080/elsewhere' }), false);
  assert.equal(sameDropScope(before, { ...before, revision: 2 }), false);
});

test('prepared drop refuses session A -> B -> A and same-URL navigation round trips', () => {
  const before = dropScope();
  assert.equal(sameDropScope(before, { ...before, sessionRevision: before.sessionRevision + 2 }), false);
  assert.equal(sameDropScope(before, { ...before, revision: before.revision + 2 }), false);
});

test('synthetic paste never consumes or replaces a live native guard', () => {
  const guard = { snapshot: dropScope(), expires: 100 + NATIVE_PASTE_GUARD_MS };
  const result = takeTrustedPaste(guard, false, 101);
  assert.equal(result.guard, guard);
  assert.equal(result.snapshot, null);
});

test('trusted paste takes the original native guard exactly once', () => {
  const guard = { snapshot: dropScope(), expires: 100 + NATIVE_PASTE_GUARD_MS };
  const first = takeTrustedPaste(guard, true, 101);
  assert.equal(first.guard, null);
  assert.equal(first.snapshot, guard.snapshot);
  assert.equal(takeTrustedPaste(first.guard, true, 102).snapshot, null);
});

test('native paste lease expires instead of permanently swallowing future events', () => {
  const guard = { snapshot: dropScope(), expires: 100 + NATIVE_PASTE_GUARD_MS };
  for (const trusted of [false, true]) {
    assert.deepEqual(takeTrustedPaste(guard, trusted, guard.expires), { guard: null, snapshot: null });
    assert.deepEqual(takeTrustedPaste(guard, trusted, guard.expires + 1), { guard: null, snapshot: null });
  }
});

test('native guard retains original session after pending snapshot invalidation', () => {
  const original = dropScope();
  const pending = new Map([['native-id', original]]);
  const guard = { snapshot: original, expires: 100 + NATIVE_PASTE_GUARD_MS };
  pending.clear();
  const current = { ...original, session: 'session-b', sessionRevision: original.sessionRevision + 1 };
  const taken = takeTrustedPaste(guard, true, 101);
  assert.equal(taken.snapshot, original);
  assert.equal(sameDropScope(taken.snapshot!, current), false);
});

test('synthetic paste before the native event cannot bypass a changed-focus guard', () => {
  const original = dropScope();
  const guard = { snapshot: original, expires: 100 + NATIVE_PASTE_GUARD_MS };
  const synthetic = takeTrustedPaste(guard, false, 101);
  const native = takeTrustedPaste(synthetic.guard, true, 102);
  assert.equal(native.snapshot, original);
  assert.equal(sameDropScope(native.snapshot!, { ...original, revision: original.revision + 1 }), false);
});

function selection(): SelectionSnapshot {
  // 用不透明身份令牌，不 mock DOM 或 renderer。 / Opaque identity tokens, not a mocked DOM or renderer.
  const anchor = {} as Node;
  const focus = {} as Node;
  return { anchor, anchorOffset: 1, focus, focusOffset: 2,
    ranges: [{ start: anchor, startOffset: 1, end: focus, endOffset: 2 }], input: null };
}

test('selection comparison is identity-based, not text-based', () => {
  const initial = selection();
  assert.equal(sameSelection(initial, { ...initial, ranges: [...initial.ranges] }), true);
  assert.equal(sameSelection(initial, selection()), false);
  assert.equal(sameSelection(initial, { ...initial, anchorOffset: 2 }), false);
  assert.equal(sameSelection(initial, { ...initial, focusOffset: 1 }), false);
  assert.equal(sameSelection(initial, { ...initial, ranges: [] }), false);
  assert.equal(sameSelection(initial, { ...initial, ranges: [{ ...initial.ranges[0]!, endOffset: 3 }] }), false);
});

test('text fallback must preserve input selection, direction, and value', () => {
  const initial: SelectionSnapshot = { ...selection(), input: [1, 4, 'backward', 'draft'] };
  assert.equal(sameSelection(initial, { ...initial, input: [1, 4, 'backward', 'draft'] }), true);
  for (const input of [[1, 5, 'backward', 'draft'], [1, 4, 'forward', 'draft'],
    [1, 4, 'backward', 'other'], null] as const) {
    assert.equal(sameSelection(initial, { ...initial, input }), false);
  }
});
