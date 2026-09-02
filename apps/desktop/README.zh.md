# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

该 Electron 应用启动安全的桌面 profile，拥有一个受监管的 Harness 实用进程，并在沙箱化 renderer 中显示现有的插件组合 Web 客户端。Electron Main 仅负责进程、窗口和应用生命周期；产品任务状态仍由 Harness 插件与会话事件管理。

## 开发

安装仓库依赖，然后依次构建 Harness 库、Web 前端、Electron Main 入口和 CommonJS preload，再启动 Electron：

```sh
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop build
pnpm --filter @deepseek-ai/dsh-desktop start
```

`start` 运行已构建的 `lib/main.js`，不会编译源文件。调用目录会成为 Harness 工作目录，`DSH_HOME` 则按照普通 CLI 规则选择 profile 与持久化根目录。

## 运行时生命周期

Main 在应用就绪前启用 Chromium 沙箱并获取 Electron 单实例锁。`app.whenReady()` 完成后，持有锁的实例创建本地启动窗口，使用 `desktop` profile 在随机 loopback 端口启动且仅启动一个 Harness，并且只在经过认证的就绪检查通过后交接给已授权主窗口。原生窗口关闭后，Main 会清除窗口所有权，后续事件不会调用失效句柄。第二次启动会恢复并聚焦仍然存在的窗口，不会再启动 Harness；在 macOS 上，它会使用现有 Harness 授权重新创建并聚焦已关闭的窗口。

第一次显式退出会中止尚未完成的 Harness 启动，等待启动资源归属完成结算，停止一次已就绪的 Harness，然后在退出锁存状态下再次调用 `app.quit()`。即使关闭失败被报告，应用仍会最终退出。在 Windows 和 Linux 上关闭最后一个窗口会退出；在 macOS 上激活应用会使用现有 Harness 授权重新创建缺失的窗口。

## 安全

安装器关闭辅助进程与普通启动使用相同的 Electron 用户数据目录。验证唯一的 `--installer-request-close` 参数后，它发送显式单实例通知并退出，不组合 Harness 或窗口。Windows 打包测试在任一种启动模式获取锁之前认证 appData 与 home 覆盖值；测试元数据只有通过验证后才会从参数分类输入中移除。隔离的 Electron 主目录使 CLI 的 dotenv 加载留在 fixture 内，同时不改变原生 Windows 配置目录环境变量。

- Main 为每次启动生成 32 字节 capability，并且只将其交给 Harness 进程和隔离的 Electron session。该 session 仅针对完成结算后的确切 HTTP 与 WebSocket origin，且仅为其拥有的 renderer 添加 `Authorization: Bearer <capability>`。
- renderer 与 preload API、URL、DOM 状态、Web 存储、日志、设置和会话事件均不包含 capability。没有该 header 的直接 loopback 客户端会收到 `401`。
- renderer 使用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和 `webSecurity: true`。冻结的 preload bridge 只公开 `deepseekDesktop.platform`，不公开通用 IPC、进程、文件系统、shell、环境或 capability 访问权。
- 导航与重定向仅限于完成结算后的 origin，所有新窗口请求都会被拒绝，renderer 权限检查与权限请求也默认拒绝。

## 失败

Harness 启动错误、就绪超时或初始窗口故障会保留本地恢复窗口，供用户重试、打开桌面日志或退出。每次尝试为模块加载、端点发现和经过认证的就绪检查合计提供 60 秒；安装后首次读取文件可能明显慢于后续启动。这是故障检测上限，不是固定启动延迟。超时日志包含有长度限制且经过脱敏的子进程 stderr 尾部；原始诊断绝不进入恢复 renderer。启动取消和 Harness 关闭都有有界的进程等待。请求取消启动所产生的 `AbortError` 不会被报告；取消后发现的子进程退出超时或其他故障会作为关闭故障报告一次。session handler 清理和窗口关闭订阅方的故障会被报告，但不会逃逸 Electron 回调；诊断报告自身的故障也会被隔离。

## 模型体验

Electron 应用不添加模型可见内容。桌面 profile 的 [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md) 覆盖层会禁用 Web 表层提示词段，并负责 loopback 授权 guard。

## Windows 安装程序开发

`pnpm run desktop:package` 构建按用户安装的 x64 辅助安装程序，支持选择目录以及独立的桌面、开始菜单和登录启动选项。打包前会验证生成的 [PowerShell 命令](../../scripts/desktop/generate-installer-powershell.ts)和[卸载文件操作](../../scripts/desktop/generate-installer-file-operations.ts)。后者保留 electron-builder 的移动和回滚算法，并使用 Windows 扩展长度路径；上游模板变化时，必须先审查，再通过 `pnpm run desktop:generate-installer-file-operations` 重新生成。所有权与清理规则参见[安装程序决策](../../.agents/notes/implemented/feature/2026-08-24-retryable-desktop-startup-and-uninstall-cleanup.md)。

在 Windows x64 上安装仓库依赖后，从仓库根目录构建并验证分发物：

```powershell
pnpm run build
pnpm run desktop:package
pnpm run desktop:validate-package
```

`.artifacts/desktop/installer/` 下的输出包括 `DeepSeek-Harness-Setup-<version>-x64.exe`、对应 `.sha256` 和 `release-metadata.json`。提供给测试者的应是 setup EXE，而不是 `win-unpacked` 内的可执行文件。双击 setup 打开辅助安装程序，默认目录为 `%LOCALAPPDATA%\Programs\DeepSeek Harness`。卸载默认保留 `%APPDATA%\DeepSeek Harness` 下的 Harness 数据和日志，除非用户明确选择并确认删除。未签名构建可能触发 SmartScreen；校验和验证能检测下载文件是否被修改，但不能证明发布者身份，也不能替代签名批准。

只在没有现有产品安装的临时 Windows 账户中运行生命周期验收。测试会认证隔离的应用数据路径，使用测试专用快捷方式和登录启动注册，并拒绝生产产品标识冲突，但仍会操作真实的按用户安装器注册表：

```powershell
$env:DSH_INSTALLER_E2E = '1'
try { pnpm run test:desktop:installer }
finally { Remove-Item Env:DSH_INSTALLER_E2E }
```

测试覆盖无 API 凭据启动、选项变更、通过较旧注册版本触发的运行中应用替换，以及两种卸载数据选择。它不能替代断网机器验收，也不能替代从单独构建的旧发布产物升级的验收。

[Windows 安装器工作流](../../.github/workflows/desktop-installer.yml) 在全新的托管 Windows runner 上为拉取请求运行全新安装冒烟测试，为 master 和 `dsh-v*` 推送运行完整安装器测试。通过包验证的 EXE、校验和与元数据保留 30 天，即使后续验收失败也会保留；使用产物前须查看该次运行的测试结果。该工作流不持有签名凭据，也不发布生产版本。

## 已知限制

- **安装程序验证** — 分发前必须完成 Windows 生命周期验证；未签名的本地构建可能触发 SmartScreen。尚未实现自动更新。
- **前台窗口生命周期** — 当前没有托盘驻留或感知任务的后台策略；在 Windows 和 Linux 上关闭最后一个窗口会退出。
- **基础 UI** — renderer 仍是现有 Web 客户端，并非计划中的 Mission Control 任务概览、审查模式或 Harness Studio。
- **原生集成** — 尚未实现深层链接、原生通知、外部链接处理和窗口位置持久化。
- **崩溃恢复** — Main 会报告启动与关闭故障，但尚未提供感知任务的恢复，也不会在 Harness 运行时异常退出后将其重启。
