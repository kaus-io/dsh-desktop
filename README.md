# dsh-desktop 1.0.0 · Electron

![language-typescript](https://img.shields.io/badge/language-typescript-orange.svg)
[![license-MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![electron-45](https://img.shields.io/badge/electron-45-47848F)](https://www.electronjs.org/)
[![ci](https://github.com/kaus-io/dsh-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/kaus-io/dsh-desktop/actions/workflows/ci.yml)

DeepSeek Harness 的独立桌面窗口：**Electron 45 + Chromium** 渲染 DSH Web，TypeScript 输入桥负责把原生文件/图片交给现有附件入口。**没有 Rust、Tauri、GTK/WebKit 或 sidecar**；服务没在线时，Electron 直接后台运行 `npx --yes @deepseek-ai/dsh web --no-open`（找不到 `npx` 时退回全局 `dsh web --no-open`）。

安装后提供 `/usr/bin/dsh-desktop`、应用菜单项、图标和私有字体；不修改 DSH 的网页、插件或后台服务。

## 架构

```text
Electron main (TS)
  ├─ Chromium 窗口 / cookie / 导航边界 / 字体 / 权限
  ├─ service.ts
  │    ├─ 复用 http://127.0.0.1:3080 或 DSH_APP_ORIGIN
  │    └─ 不在线时 detach 启动 npx --yes @deepseek-ai/dsh web --no-open
  └─ preload / intake
       ├─ 异步读取剪贴板文件与位图
       ├─ 读取拖入文件并转发
       └─ 页面内 bridge.ts 校验并合成附件事件
```

- 纯 TypeScript/Node，不再需要 Cargo、Rust 服务 helper 或 WebKitGTK。
- 页面内 bridge 只在最初选定的本机 origin 顶层页面启用；跨源导航交给系统浏览器。
- Electron cookie 存在自己的 session 目录，**不会自动导入旧 WebKit 的 `cookies.sqlite`**；首次启动或 cookie 过期时用一次 `--login`。

## 构建

需要 Linux、Node.js 22.6+（建议当前 LTS）、pnpm。不需要 Rust/Cargo，也不需要 GTK/WebKit 开发包。

```sh
pnpm install
./build.sh
./test.sh
```

`build.sh`：

1. `pnpm build:bridge`：打包页面输入桥；
2. `pnpm build:electron`：打包 main/preload（esbuild）；
3. `pnpm typecheck`；
4. `electron-builder --linux deb`。

产物：

```text
dist-electron/dsh-desktop_1.0.0_<dpkg --print-architecture>.deb
```

`build/` 和 `dist-electron/` 都是生成物，不提交；换机器或重新 clone 后跑一次 `./build.sh` 即可。

Electron 二进制由 electron-builder 下载；国内网络可设置：

```sh
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

构建缓存默认位于系统缓存目录（Electron 在 `~/.cache/electron`，builder 在 `~/.cache/electron-builder`），不需要指向仓库。

## 安装 / 卸载

如果系统里还装着旧版（同包名），先卸载再装当前 Electron 版：

```sh
sudo apt remove dsh-desktop
sudo apt install "./dist-electron/dsh-desktop_1.0.0_$(dpkg --print-architecture).deb"
dsh-desktop --install-shortcut   # 可选，以当前用户身份执行
sudo apt remove dsh-desktop
```

同版本升级直接重装，并完全关闭旧窗口后重新打开：

```sh
sudo apt install --reinstall "./dist-electron/dsh-desktop_1.0.0_$(dpkg --print-architecture).deb"
```

## 启动与后台服务

```text
图标/菜单 → Electron 窗口
  1. DSH_APP_ORIGIN 或默认 http://127.0.0.1:3080 在线 → 直接打开
  2. 不在线 → 后台启动 npx --yes @deepseek-ai/dsh web --no-open
     （找不到 npx 时用全局 dsh web --no-open）
  3. 轮询 origin 最多 30 秒，ready 后打开窗口
```

服务使用 detached 进程；**关闭窗口不会停止 dsh web**。当前实现没有进程所有权/`--stop`，需要停止时请在终端结束对应 `dsh web` 进程。

| 命令 | 作用 |
| --- | --- |
| `dsh-desktop` | 复用/启动服务，打开 Chromium 窗口 |
| `--login <url>` | 直接打开给定本机登录 URL |
| `--status` | 检查当前 origin 是否可达；在线退出 0，否则 1 |
| `--install-shortcut` | 在桌面目录写启动器 |
| `--version` / `--help` | 输出版本 / 帮助，不启动服务或窗口 |

`DSH_APP_ORIGIN` 可覆盖默认 origin（只保留 origin，路径/query 会丢弃）。TCP/HTTP 在线检查不是认证检查；如果服务需要登录，正常登录一次，或用：

```sh
dsh-desktop --login '<本次 dsh web 打印的本机登录地址>'
```

## 数据与日志

Electron userData 为 `${XDG_DATA_HOME:-$HOME/.local/share}/dsh-desktop/electron/`：

- `dsh-web.log`：自动启动 `dsh web` 时的 stdout/stderr，权限 `0600`；
- cookie、缓存和站点数据由 Electron session 管理；
- 旧 `cookies.sqlite`、`webkit-cache/`、`tauri-webview/` 不再被 Electron 使用；首次启动可能需要重新登录；
- 不再维护 `current-url`、`server.pid`、`service.lock` 或服务所有权记录；
- 不修改 DSH 的会话、插件、模型配置或 `~/.dsh` 内容。

## 输入：拖入与粘贴

- **拖入文件**：preload 读取真实 `File` 字节，转 base64 后交给 main；main 调用页面 bridge 的 `drop(items, x, y)`，由 bridge 做命中测试并合成附件事件。
- **截图/位图/文件管理器复制**：main 用 Electron 45 的异步 `clipboard.read()` 读取 `ClipboardItem`；图片直接取原始字节，`text/uri-list` 按本地文件读取。
- **普通文字**：不拦截，继续走 Chromium 原生粘贴。
- 单次最多 20 个文件、合计 16 MiB；目录、远程 URI、特殊设备、超限输入会被拒绝。
- 单次读取失败的文件跳过，不影响同批其他文件；bridge 继续做 MIME/base64 和焦点/会话校验。

Electron 的 clipboard 格式支持取决于桌面环境；如果文件管理器复制在某个发行版上不产生 `text/uri-list`，优先用拖入。原生拖入/剪贴板建议在真实桌面会话中验收。

## 安全边界

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；页面拿不到 Node。
- preload 只监听拖放并发送受限 IPC，不暴露任意文件读取接口。
- 导航只允许最初 origin；窗口打开和跨源链接交给系统浏览器。
- 默认拒绝所有权限，仅放行 DSH 复制按钮需要的 `clipboard-sanitized-write`。
- 剪贴板/拖放字节来自真实系统输入，不接受网页提交的任意路径。

## 字体

随包提供 HarmonyOS Sans SC 六种字重。Electron 启动前生成私有 `fonts.conf`（仅指向包内字体并 include 系统配置），并注入：

```css
:root { --dsw-font-family: "HarmonyOS Sans SC", "HarmonyOS Sans", sans-serif !important; }
```

不修改系统字体目录；许可证见 [LICENSE-HarmonyOS-Sans.txt](<assets/LICENSE-HarmonyOS-Sans.txt>)。

## 测试

```sh
./test.sh
```

覆盖：

1. `scripts/check-versions.mjs`：`package.json`、README 标题/产物名、CHANGELOG 顶部条目版本一致；
2. `tsc --noEmit`；
3. 页面 bridge 纯函数测试（`tests/bridge.test.ts`）；
4. Electron CLI/URL/URI-list 纯函数测试（`tests/electron.test.ts`）；
5. 版本检查纯函数测试（`tests/versions.test.mjs`）；
6. main/preload 打包；
7. 不依赖 Rust/Cargo，也不打开真实窗口。

无显示环境可做页面/bridge 冒烟（数据目录用系统临时目录，跑完清理）：

```sh
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/dsh-desktop-smoke.XXXXXX")"
trap 'rm -rf "$smoke_dir"' EXIT
XDG_DATA_HOME="$smoke_dir" DSH_DESKTOP_SMOKE=1 \
  node_modules/.bin/electron --no-sandbox --ozone-platform=headless . \
  --login 'http://127.0.0.1:3080'
# 输出 SMOKE_BRIDGE=true 后退出
```

默认测试不打开真实窗口、不读真实剪贴板、不安装包、不修改已有用户数据。

## CI

[.github/workflows/ci.yml](<.github/workflows/ci.yml>) 在 push 到 `main`/`master` 和 PR 上执行：

1. `pnpm install --frozen-lockfile`；
2. `./test.sh`（版本一致性、typecheck、纯函数测试、bridge/main/preload 打包）；
3. `./build.sh` 打 `.deb`，并作为 workflow artifact 上传。

CI 不提交、不发布任何东西；打 tag 和 GitHub Release 仍需人工操作。

## 版本与发布

版本号唯一来源是 [package.json](package.json)。README 标题/`.deb` 产物名和 [CHANGELOG.md](CHANGELOG.md) 顶部条目必须与它一致，`./test.sh` 会跑 `pnpm check:versions`；单独检查用：

```sh
pnpm check:versions
```

发布流程：

1. 按 SemVer 改 `package.json` 的 `version`（预发布用 `-alphaNN` / `-betaNN` / `-rcNN`）；
2. 更新 CHANGELOG 顶部条目和 README 里的版本；
3. `./test.sh` 与 `./build.sh` 全绿后提交；
4. 打 `v<version>` tag 并创建 GitHub Release；
5. [release.yml](<.github/workflows/release.yml>) 校验 tag 与版本，跑同一套测试和打包，把 `.deb` 上传到该 Release。

发布失败且尚未上传 `.deb` 时，修在同一版本上重试，不升号；`.deb` 已经挂到 Release 后视为已发布，需要改动就升版本。

## 主要代码

- [src/electron/main.ts](<src/electron/main.ts>)：CLI、窗口、导航、权限、字体、bridge 注入。
- [src/electron/service.ts](<src/electron/service.ts>)：复用在线服务或启动 `dsh web`。
- [src/electron/intake.ts](<src/electron/intake.ts>)：剪贴板读取与 bridge 调用。
- [src/electron/preload.ts](<src/electron/preload.ts>)：隔离世界拖放读取。
- [src/electron/pure.ts](<src/electron/pure.ts>)：CLI/URL/URI-list 纯函数。
- [src/shared/limits.ts](<src/shared/limits.ts>)：native/preload/bridge 共用的 20 文件、16 MiB 上限。
- [src/bridge.ts](<src/bridge.ts>)：页面内附件交付、焦点/会话校验。
- [scripts/build-electron.mjs](<scripts/build-electron.mjs>) / [build.sh](<build.sh>)：构建与 Debian 打包。

## 已知限制

- Electron 包体约 130 MB，明显大于系统 WebView 方案；
- 没有自动停止/所有权管理；关闭窗口后 `dsh web` 仍在运行；
- 自动启动依赖 `npx` 或 `dsh` 可用，默认等待 3080/`DSH_APP_ORIGIN`；
- 首次 Electron 启动不会迁移旧 WebKit cookie，可能需要 `--login`；
- 文件管理器剪贴板的格式支持依赖 Electron/桌面环境，拖入是更可靠的路径；
- 未包含自动更新、代码签名、远程遥测。

## 许可证

代码以 [MIT](LICENSE) 发布；随包的 HarmonyOS Sans SC 字体按 [LICENSE-HarmonyOS-Sans.txt](<assets/LICENSE-HarmonyOS-Sans.txt>) 单独授权。
