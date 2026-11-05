/**
 * 版本一致性检查：`package.json` 是唯一来源，README 的标题/产物名与 CHANGELOG
 * 顶部条目必须一致；Release 触发时再比对 tag（`v<version>` 或裸版本号）。
 *
 * Version consistency: `package.json` is the single source, so the README title/
 * artifact name and the top CHANGELOG entry must agree with it. A release run
 * also compares the tag (`v<version>` or the bare version).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 完整 SemVer，含预发布与构建元数据。 / Full SemVer, prerelease and build metadata included. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
/** README 标题里的版本。 / The version in the README title. */
const README_TITLE = /^#\s+dsh-desktop\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+·/m;
/** README 里 `.deb` 产物名的版本。 / The version in README `.deb` artifact names. */
const README_ARTIFACT = /dsh-desktop_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_/g;
/** CHANGELOG 第一条 `## <version>` 条目。 / The first `## <version>` CHANGELOG entry. */
const CHANGELOG_ENTRY = /^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m;

/**
 * 校验一组输入并返回问题列表；空数组表示一致。
 * Check one set of inputs and return the problems; an empty array means they agree.
 */
export function versionProblems(input) {
  const problems = [];
  const { version, tag } = input;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    problems.push(`package.json version "${String(version)}" is not valid SemVer`);
    return problems;
  }

  const title = README_TITLE.exec(input.readme ?? '')?.[1];
  const artifacts = [...String(input.readme ?? '').matchAll(README_ARTIFACT)].map(match => match[1]);
  const pinned = [...new Set([title, ...artifacts].filter(value => value !== undefined))];
  if (pinned.length === 0) {
    problems.push(`README.md does not pin "${version}" in its title or .deb artifact name`);
  }
  for (const value of pinned) {
    if (value !== version) problems.push(`README.md pins "${value}" but package.json says "${version}"`);
  }

  const entry = CHANGELOG_ENTRY.exec(input.changelog ?? '')?.[1];
  if (entry === undefined) {
    problems.push('CHANGELOG.md has no "## <version>" entry for the current version');
  } else if (entry !== version) {
    problems.push(`CHANGELOG.md starts at "${entry}" but package.json says "${version}"; add the entry`);
  }

  if (tag !== undefined && tag !== version && tag !== `v${version}`) {
    problems.push(`release tag "${tag}" does not match package.json version "${version}"; use tag "v${version}" or "${version}"`);
  }
  return problems;
}

/** 读取仓库内参与检查的文件。 / Read the files this check inspects. */
export async function readVersionInputs(root, tag) {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const [overview, usage, changelog] = await Promise.all([
    readFile(join(root, 'README.md'), 'utf8'),
    readFile(join(root, 'docs', 'README.md'), 'utf8'),
    readFile(join(root, 'CHANGELOG.md'), 'utf8'),
  ]);
  return { version: packageJson.version, readme: `${overview}\n${usage}`, changelog, tag };
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const args = process.argv.slice(2);
  const tagIndex = args.indexOf('--tag');
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  if (tagIndex >= 0 && (tag === undefined || tag === '')) {
    process.stderr.write('--tag needs a release tag value\n');
    process.exitCode = 1;
  } else {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const inputs = await readVersionInputs(root, tag);
    const problems = versionProblems(inputs);
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`::error::${problem}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`versions agree: ${inputs.version}${tag === undefined ? '' : ` (tag ${tag})`}\n`);
    }
  }
}
