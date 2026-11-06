# 使用文档

[返回项目首页](<../README.md>)

## 安装

当前打包配置面向 Debian / Ubuntu 等使用 `.deb` 的 Linux 桌面，未提供 Windows / macOS 安装包构建配置。以下从源码构建，不依赖预先发布的安装包。

构建需要 **Node.js 22.6+** 和 **pnpm 10.28.2**；依赖安装与首次打包需要下载资源。

```sh
git clone https://github.com/kaus-io/dsh-desktop.git
cd dsh-desktop
pnpm install --frozen-lockfile
./build.sh
sudo apt install "./dist-electron/dsh-desktop_1.0.1_$(dpkg --print-architecture).deb"
```

安装后从应用菜单打开 **DeepSeek Harness**，或运行 `dsh-desktop`。需要桌面快捷方式时，以当前用户执行：

```sh
dsh-desktop --install-shortcut
```

卸载应用：

```sh
sudo apt remove dsh-desktop
```

## 启动与登录

默认连接 `http://127.0.0.1:3080`。服务不在线时，应用在后台执行 `npx --yes @deepseek-ai/dsh web --no-open`；仅当找不到 `npx` 时，改用全局 `dsh web --no-open`，最多等待 30 秒。

因此，自动启动需要可用的 `npx` 或全局 `dsh`；`npx` 首次运行还可能需要联网下载 DSH。桌面包不内置 DSH 服务。已有服务地址可通过 `DSH_APP_ORIGIN` 指定，只使用协议、主机和端口；该变量不会更改自动启动服务的监听配置。

若页面要求登录，可用 DSH Web 输出的登录地址打开窗口：

```sh
dsh-desktop --login '<dsh web 输出的登录地址>'
```

如果已有窗口，请先完全退出桌面应用再执行登录命令。桌面窗口使用独立的 cookie，不自动继承浏览器或旧版 WebKit 的登录状态。

| 命令 | 作用 |
| --- | --- |
| `dsh-desktop --status` | 检查服务是否可达，在线退出 0，否则退出 1；不校验登录状态 |
| `dsh-desktop --version` | 显示版本 |
| `dsh-desktop --help` | 显示参数帮助 |

**关闭桌面窗口不会停止后台 DSH Web**，当前没有 `--stop` 命令；需要停止时请手动结束对应服务进程。

## 文件输入与限制

- 粘贴、拖放和输入法全部由 Chromium 原生处理；把图片/文件拖入当前会话的附件区域即可添加附件。
- 截图、文本用普通 `Ctrl/Cmd+V` 粘贴；从网页复制的图片按浏览器原生行为处理。
- 文件管理器里复制的**本地文件**粘贴到输入框只会得到路径文本（浏览器拿不到文件字节），请改用拖入。
- 这是现有 DSH 网页的桌面入口；没有额外的页面脚本注入或剪贴板读取。
- 当前没有自动更新；跨源链接交给系统浏览器打开。

## 数据与排查

应用数据默认位于 `~/.local/share/dsh-desktop/electron/`，包含独立 cookie、缓存及自动启动服务的日志 `dsh-web.log`。设置绝对路径的 `XDG_DATA_HOME` 可更改数据根目录。

启动超时或登录异常时，先检查 `dsh-desktop --status` 和日志；也可在终端手动执行上述 DSH Web 启动命令，确认服务已就绪后再打开桌面窗口。

## 开发与验证

安装依赖后，可在仓库根目录运行：

```sh
pnpm start
./test.sh
./build.sh
```

分别用于开发启动、类型检查与自动化测试、生成 `.deb`。自动化测试不打开真实窗口；输入法、粘贴与拖放仍需在真实桌面会话验证。

构建与测试入口见 [build.sh](<../build.sh>)、[test.sh](<../test.sh>)；更改版本相关文档后可用 `pnpm check:versions` 检查[首页](<../README.md>)、[使用文档](<README.md>)与清单版本的一致性。

## 许可证

项目代码采用 [MIT](<../LICENSE>) 许可证；随包的 HarmonyOS Sans SC 字体单独授权，见[字体许可证](<../assets/LICENSE-HarmonyOS-Sans.txt>)。
