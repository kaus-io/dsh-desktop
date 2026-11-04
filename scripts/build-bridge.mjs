import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'build'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/bridge.ts'],
  outfile: 'build/bridge.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari16'],
  legalComments: 'none',
  minify: false,
});
console.log('Built TypeScript native-input bridge');
