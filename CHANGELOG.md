# 更新日志

## 1.0.1

- 输入全部交还 Chromium：删除页面 bridge、preload 和原生剪贴板/拖放投递层；桌面壳不再注入页面脚本、不拦截键盘事件、不读取系统剪贴板。
- 截图/文本粘贴、文件/图片拖入、输入法与浏览器完全一致；`Ctrl/Cmd+V` 和拖放都由 Chromium 自己处理。
- 失去桌面专属的文件粘贴：文件管理器里复制的本地文件粘贴到输入框只会得到路径文本（浏览器拿不到文件字节），文件夹路径投递也不可用；文件和图片请直接拖入。
- 右键菜单保留原生 copy/paste/select all；没有新增其它输入接管。
- 1.0.0 之后没有其它已发布版本，本条目是相对 1.0.0 的唯一补丁版。

## 1.0.0

首个稳定版：Electron 桌面壳。

- 用 Electron 45 + Chromium 承载 DSH Web，不再依赖 Rust、Tauri、GTK/WebKit 或 sidecar。
- 复用在线 `dsh web`；不在线时后台启动 `npx --yes @deepseek-ai/dsh web --no-open`（找不到 `npx` 时退回全局 `dsh`）。
- 原生拖放与剪贴板：preload 读取真实文件字节，页面内 bridge 只向原输入框/会话投递；单次最多 20 个文件、合计 16 MiB。
- 安全边界：`contextIsolation`、`sandbox`、禁用 `nodeIntegration`；导航锁定最初 origin，权限默认拒绝，仅放行 `clipboard-sanitized-write`。
- 随包 HarmonyOS Sans SC 六种字重，通过私有 `fonts.conf` 注入，不修改系统字体目录。
- 提供 `--login`、`--status`、`--install-shortcut`、`--version`、`--help`；打包为 Debian `.deb`。
