import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'build', 'electron'), { recursive: true, force: true });
await mkdir(path.join(root, 'build', 'electron'), { recursive: true });

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node22'],
  external: ['electron'],
  legalComments: 'none',
  sourcemap: false,
};

await build({
  ...shared,
  entryPoints: ['src/electron/main.ts'],
  outfile: 'build/electron/main.cjs',
});

console.log('Built Electron main');
