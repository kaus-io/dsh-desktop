import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

await build({
  ...shared,
  entryPoints: ['src/electron/preload.ts'],
  outfile: 'build/electron/preload.cjs',
});

console.log('Built Electron main/preload');
