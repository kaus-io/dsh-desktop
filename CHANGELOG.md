# 更新日志

## 1.0.0

首个稳定版：Electron 桌面壳。

- 用 Electron 45 + Chromium 承载 DSH Web，不再依赖 Rust、Tauri、GTK/WebKit 或 sidecar。
- 复用在线 `dsh web`；不在线时后台启动 `npx --yes @deepseek-ai/dsh web --no-open`（找不到 `npx` 时退回全局 `dsh`）。
- 原生拖放与剪贴板：preload 读取真实文件字节，页面内 bridge 只向原输入框/会话投递；单次最多 20 个文件、合计 16 MiB。
- 安全边界：`contextIsolation`、`sandbox`、禁用 `nodeIntegration`；导航锁定最初 origin，权限默认拒绝，仅放行 `clipboard-sanitized-write`。
- 随包 HarmonyOS Sans SC 六种字重，通过私有 `fonts.conf` 注入，不修改系统字体目录。
- 提供 `--login`、`--status`、`--install-shortcut`、`--version`、`--help`；打包为 Debian `.deb`。
