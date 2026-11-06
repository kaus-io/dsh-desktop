import assert from 'node:assert/strict';
import test from 'node:test';
import { childEnvironment, parseCli, usage, validateHttpUrl } from '../src/electron/pure.ts';

test('CLI accepts the public desktop flags and rejects extras', () => {
  assert.deepEqual(parseCli([]), { mode: 'open' });
  assert.deepEqual(parseCli(['--status']), { mode: 'status' });
  assert.deepEqual(parseCli(['--install-shortcut']), { mode: 'shortcut' });
  assert.deepEqual(parseCli(['--version']), { mode: 'version' });
  assert.deepEqual(parseCli(['--help']), { mode: 'help' });
  assert.deepEqual(parseCli(['--login', 'http://127.0.0.1:3080/?token=x']), {
    mode: 'open', login: 'http://127.0.0.1:3080/?token=x',
  });
  assert.throws(() => parseCli(['--status', 'extra']));
  assert.throws(() => parseCli(['--login']));
  assert.throws(() => parseCli(['--login', 'file:///tmp/x']));
  assert.throws(() => parseCli(['--login', 'http://user:pass@127.0.0.1/']));
  assert.throws(() => parseCli(['--unknown']));
});

test('help text uses the package version and lists the public flags', () => {
  const text = usage('9.9.9');
  assert.match(text, /^dsh-desktop 9\.9\.9 \(Electron\)$/m);
  assert.match(text, /--version, -V/);
  assert.match(text, /--help, -h/);
});

test('dsh web child env drops the shell-private FONTCONFIG_FILE only', () => {
  const parent = { FONTCONFIG_FILE: '/tmp/fonts.conf', PATH: '/usr/bin', DSH_APP_ORIGIN: 'http://127.0.0.1:1' };
  assert.deepEqual(childEnvironment(parent), { PATH: '/usr/bin', DSH_APP_ORIGIN: 'http://127.0.0.1:1' });
  assert.equal(parent.FONTCONFIG_FILE, '/tmp/fonts.conf');
});

test('HTTP URL validation rejects credentials and non-http schemes', () => {
  assert.equal(validateHttpUrl('http://127.0.0.1:3080/').origin, 'http://127.0.0.1:3080');
  assert.throws(() => validateHttpUrl('javascript:alert(1)'));
  assert.throws(() => validateHttpUrl('http://a:b@127.0.0.1/'));
  assert.throws(() => validateHttpUrl('not a url'));
});
