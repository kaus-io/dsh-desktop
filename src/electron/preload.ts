/** 隔离世界 preload：只读取文件拖放并转发给主进程，不向页面暴露 Node。 / Isolated preload: read dropped files and forward to main; expose no Node to the page. */

import { ipcRenderer } from 'electron';
import { MAX_FILES, MAX_TOTAL_BYTES } from '../shared/limits.ts';

function base64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function installDrop(): void {
  window.addEventListener('dragover', (event: DragEvent) => {
    if (!event.isTrusted) return;
    if (event.dataTransfer?.types.includes('Files') === true) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, true);

  window.addEventListener('drop', (event: DragEvent) => {
    if (!event.isTrusted) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void (async () => {
      const items: { name: string; type: string; data: string }[] = [];
      let total = 0;
      for (const file of files.slice(0, MAX_FILES)) {
        if (file.size <= 0 || total + file.size > MAX_TOTAL_BYTES) continue;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          total += bytes.length;
          items.push({
            name: file.name.slice(0, 200) || 'file',
            type: file.type || 'application/octet-stream',
            data: base64(bytes),
          });
        } catch {
          // 跳过读失败的文件。 / Skip files that fail to read.
        }
      }
      if (items.length > 0) {
        ipcRenderer.send('dsh:intake-drop', {
          items,
          x: event.clientX,
          y: event.clientY,
        });
      }
    })();
  }, true);
}

// 主进程通过 additionalArguments 传入 origin；不匹配的页面不安装输入钩子。
// The main process passes the origin via additionalArguments; mismatched pages get no intake hooks.
const argv = typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv : [];
const expected = argv.find(argument => argument.startsWith('--dsh-origin='))?.slice('--dsh-origin='.length);
if (window.top === window && (expected === undefined || location.origin === expected)) installDrop();
