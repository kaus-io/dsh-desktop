import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVersionInputs, versionProblems } from '../scripts/check-versions.mjs';

const VERSION = '1.0.0';

const clean = {
  version: VERSION,
  readme: [
    '# dsh-desktop 1.0.0 · Electron',
    '',
    '```text',
    'dist-electron/dsh-desktop_1.0.0_<dpkg --print-architecture>.deb',
    '```',
    '',
  ].join('\n'),
  changelog: `# 更新日志\n\n## ${VERSION}\n\n- 首个版本\n`,
};

describe('readVersionInputs', () => {
  it('checks artifact versions in the separate usage README', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-desktop-versions-'));
    try {
      await mkdir(join(root, 'docs'));
      await Promise.all([
        writeFile(join(root, 'package.json'), JSON.stringify({ version: VERSION })),
        writeFile(join(root, 'README.md'), '### dsh-desktop\n\n[传送门](<docs/README.md>)。\n'),
        writeFile(join(root, 'docs', 'README.md'), `dsh-desktop_${VERSION}_amd64.deb\n`),
        writeFile(join(root, 'CHANGELOG.md'), clean.changelog),
      ]);
      const inputs = await readVersionInputs(root);
      assert.match(inputs.readme, /### dsh-desktop/);
      assert.deepEqual(versionProblems(inputs), []);
      await writeFile(join(root, 'docs', 'README.md'), 'dsh-desktop_0.9.0_amd64.deb\n');
      assert.match(versionProblems(await readVersionInputs(root))[0], /README\.md pins "0\.9\.0"/);
    } finally {
      assert.equal(await realpath(root), root);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('versionProblems', () => {
  it('accepts manifest, README, and CHANGELOG in agreement', () => {
    assert.deepEqual(versionProblems(clean), []);
  });

  it('accepts a release tag with or without the v prefix', () => {
    assert.deepEqual(versionProblems({ ...clean, tag: 'v1.0.0' }), []);
    assert.deepEqual(versionProblems({ ...clean, tag: '1.0.0' }), []);
  });

  it('rejects a tag that names another version', () => {
    const problems = versionProblems({ ...clean, tag: 'v1.0.1' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /release tag "v1\.0\.1" does not match/);
  });

  it('rejects a README title that pins another version', () => {
    const problems = versionProblems({ ...clean, readme: clean.readme.replace('# dsh-desktop 1.0.0', '# dsh-desktop 0.9.0') });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /README\.md pins "0\.9\.0"/);
  });

  it('rejects a README artifact name that pins another version', () => {
    const problems = versionProblems({ ...clean, readme: clean.readme.replace('1.0.0_<dpkg', '0.9.0_<dpkg') });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /README\.md pins "0\.9\.0"/);
  });

  it('rejects a README with no pinned version', () => {
    const problems = versionProblems({ ...clean, readme: '# dsh-desktop\n\nBuild it.\n' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /does not pin "1\.0\.0"/);
  });

  it('rejects a CHANGELOG whose first entry is another version', () => {
    const problems = versionProblems({ ...clean, changelog: '# 更新日志\n\n## 0.9.0\n\n- old\n' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /CHANGELOG\.md starts at "0\.9\.0"/);
  });

  it('rejects a CHANGELOG with no entry', () => {
    const problems = versionProblems({ ...clean, changelog: '# 更新日志\n\n' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no "## <version>" entry/);
  });

  it('rejects an invalid manifest version before checking anything else', () => {
    const problems = versionProblems({ ...clean, version: '1.0.0alpha01', tag: 'v1.0.0alpha01' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not valid SemVer/);
  });

  it('reports every disagreement at once', () => {
    const problems = versionProblems({
      version: VERSION,
      tag: 'v9.9.9',
      readme: '# dsh-desktop 8.8.8 · Electron\n\ndsh-desktop_7.7.7_x.deb\n',
      changelog: '## 6.6.6\n',
    });
    assert.equal(problems.length, 4);
  });
});
