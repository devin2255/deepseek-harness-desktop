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

Main 在应用就绪前启用 Chromium 沙箱并获取 Electron 单实例锁。`app.whenReady()` 完成后，持有锁的实例创建本地启动窗口，使用 `desktop` profile 在随机 loopback 端口启动且仅启动一个 Harness，并且只在经过认证的就绪检查通过后交接给已授权主窗口。原生窗口关闭时会先释放旧窗口的隔离 session 授权，之后托盘操作或第二次启动才能使用现有 Harness 授权重建并聚焦窗口；该过程不会再启动 Harness。

在所有桌面平台上，关闭最后一个窗口后，Harness 与原生后台驻留仍会继续运行。显式退出时，如果没有活动 Task，应用会立即执行有界清理；如果仍有运行中的 Task 或无法取得活动状态，则显示原生选项：继续后台运行会隐藏当前窗口，停止并退出会先释放后台驻留再停止 Harness，取消则不做任何更改。并发退出请求共享同一次选择。安装器替换和启动恢复中的退出会跳过此提示，但仍执行有界清理。即使关闭失败被报告，应用仍会最终退出。

## 后台任务与通知

Electron Main 以串行的两秒间隔轮询经过认证的 `task.list` 和 `session.list` 投影，并为请求设置独立的十秒超时。第一次实时基线不会产生通知。后续值会更新唯一托盘摘要中的活动 Task、Agent 与注意事项数量；请求失败时会把新鲜度标记为不可用、保留最后的计数并继续重试，且不会让请求重叠。Main 只保存分离的展示值，不创建另一份持久 Task 记录。

新增的可操作注意事项、失败状态转换，以及从运行中的任务树转为可以审查或已结束时，会创建原生通知。点击通知会恢复或重建已授权窗口，并打开其确切 owner Session，包括 subagent。Main 仅通过具名的单向 preload 事件发送非空且有长度上限的 Session id；客户端等待权威目录就绪后，使用与总览点击相同的 Task 导航控制器。目标缺失时会打开“任务”并显示可读错误，后续成功或替代该尝试的导航会清除错误。

## 安全

安装器关闭辅助进程与普通启动使用相同的 Electron 用户数据目录。验证唯一的 `--installer-request-close` 参数后，它发送显式单实例通知并退出，不组合 Harness 或窗口。Windows 打包测试在任一种启动模式获取锁之前认证 appData 与 home 覆盖值；测试元数据只有通过验证后才会从参数分类输入中移除。隔离的 Electron 主目录使 CLI 的 dotenv 加载留在 fixture 内，同时不改变原生 Windows 配置目录环境变量。

- Main 为每次启动生成 32 字节 capability，并且只将其交给 Harness 进程和隔离的 Electron session。该 session 仅针对完成结算后的确切 HTTP 与 WebSocket origin，且仅为其拥有的 renderer 添加 `Authorization: Bearer <capability>`。
- renderer 与 preload API、URL、DOM 状态、Web 存储、日志、设置和会话事件均不包含 capability。没有该 header 的直接 loopback 客户端会收到 `401`。
- renderer 使用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和 `webSecurity: true`。冻结的 preload bridge 只通过 Main 拥有且经过验证的事件公开 `deepseekDesktop.platform` 与 `onOpenSession(listener)`，不公开通用 IPC、进程、文件系统、shell、环境或 capability 访问权。
- 导航与重定向仅限于完成结算后的 origin，所有新窗口请求都会被拒绝，renderer 权限检查与权限请求也默认拒绝。

## 失败

Harness 启动错误、就绪超时或初始窗口故障会保留本地恢复窗口，供用户重试、打开桌面日志或退出。每次尝试为模块加载、端点发现和经过认证的就绪检查合计提供 60 秒；安装后首次读取文件可能明显慢于后续启动。这是故障检测上限，不是固定启动延迟。超时日志包含有长度限制且经过脱敏的子进程 stderr 尾部；原始诊断绝不进入恢复 renderer。启动取消和 Harness 关闭都有有界的进程等待。请求取消启动所产生的 `AbortError` 不会被报告；取消后发现的子进程退出超时或其他故障会作为关闭故障报告一次。session handler 清理和窗口关闭订阅方的故障会被报告，但不会逃逸 Electron 回调；诊断报告自身的故障也会被隔离。

Harness 在就绪后异常退出时，Main 会撤销旧 Renderer 授权、销毁所有已授权 Task 窗口、dispose 原生后台驻留，并显示本地恢复窗口。Main 绝不自动重启 Host。用户点击重试后才会使用新的启动能力凭证启动一个新 Harness；冷态 Session 恢复会关闭被中断轮次，Task 投影把该中断显示为持久且不可直接操作的故障，而不是重放未经确认的工具调用。

## 模型体验

Electron 应用不添加模型可见内容。桌面 profile 的 [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md) 覆盖层会禁用 Web 表层提示词段，并负责 loopback 授权 guard。

## 并行任务工作区

“任务”界面默认在应用拥有的 Git worktree 中创建根 Session。所选 Workspace 仍是 UI 展示的项目身份，Task 投影则把确切的源路径、执行路径、分支、基准提交、源 `HEAD` 和源目录脏状态摘要记录到 Session 日志。从同一仓库创建的两个任务会从同一已提交基线获得不同的 worktree 路径和分支；创建过程不会复制源目录的未提交更改，也不会修改源 checkout。

隔离要求所选目录是可访问且已有 `HEAD` 的 Git 仓库根目录，目录布局不是不受支持的嵌套仓库，`PATH` 中存在 Git，并且 Harness home 所在磁盘空间充足。预检或创建失败时不会创建 Session。恢复面板提供重试隔离和带写入风险提示的显式“直接使用项目”选择，绝不会静默切换到直接模式。复用已记录的 worktree 前会根据 Git 实时注册表验证其身份；路径缺失或身份不一致时会拒绝继续。

## Task 审查与交付

处于审查、就绪或已结算状态的隔离 Task 会在独立“审查”工作区打开。该工作区显示已记录的源目录与 worktree 身份、验收标准、风险、有界文件摘要，以及所选文本文件的统一 diff。二进制文件和截断输出都有明确标记。Renderer 只通过类型化 Host API 获取这些值，不拥有直接文件系统或 Git 权限。

“要求修改”会使 Task 返回活动工作状态，不会伪造交付结果。“提交”把界面所示的确切 worktree 状态加入暂存区，并在 Task 分支创建提交，但不改变源 checkout。“应用”要求使用已记录的提交、已审查 revision、干净的源 checkout 和它的确切当前 `HEAD`；它先执行三方预检，再把相同 patch 应用到源目录索引与工作树。冲突、过期 revision、源目录移动或源目录脏状态都会在变更前失败。“应用”刻意保持源 `HEAD` 不变，让用户仍可检查并提交已暂存结果。

“丢弃”始终需要显式确认。界面会把未提交的脏内容说明为不可恢复，并要求用户确认；已提交的 Task 分支在受管 worktree 删除后仍然保留。提交、应用和丢弃回执都是 Session 事件，因此其中确切的 Git 身份与恢复事实可在 Renderer 重载和冷态回放后恢复。

## Windows 安装程序开发

`pnpm run desktop:package` 构建按用户安装的 x64 辅助安装程序，支持选择目录以及独立的桌面、开始菜单和登录启动选项。打包前会验证生成的 [PowerShell 命令](../../scripts/desktop/generate-installer-powershell.ts)和[卸载文件操作](../../scripts/desktop/generate-installer-file-operations.ts)。后者保留 electron-builder 的移动和回滚算法，并使用 Windows 扩展长度路径；上游模板变化时，必须先审查，再通过 `pnpm run desktop:generate-installer-file-operations` 重新生成。所有权与清理规则参见[安装程序决策](../../.agents/notes/implemented/feature/2026-08-24-retryable-desktop-startup-and-uninstall-cleanup.md)。

在 Windows x64 上安装仓库依赖后，从仓库根目录构建并验证分发物：

```powershell
pnpm run build
pnpm run desktop:package
pnpm run desktop:validate-package
```

`.artifacts/desktop/installer/` 下的输出包括 `DeepSeek-Harness-Setup-<version>-x64.exe`、对应 `.sha256` 和 `release-metadata.json`。提供给测试者的应是 setup EXE，而不是 `win-unpacked` 内的可执行文件。双击 setup 打开辅助安装程序，默认目录为 `%LOCALAPPDATA%\Programs\DeepSeek Harness`。卸载默认保留 `%APPDATA%\DeepSeek Harness` 下的 Harness 数据和日志，除非用户明确选择并确认删除。发布校验直接读取 PE 证书目录来识别未签名产物；只要证书存在，就必须通过 Windows Authenticode 信任校验。未签名构建可能触发 SmartScreen；校验和验证能检测下载文件是否被修改，但不能证明发布者身份，也不能替代签名批准。

只在没有现有产品安装的临时 Windows 账户中运行生命周期验收。测试会认证隔离的应用数据路径，使用测试专用快捷方式和登录启动注册，并拒绝生产产品标识冲突，但仍会操作真实的按用户安装器注册表：

```powershell
$env:DSH_INSTALLER_E2E = '1'
try { pnpm run test:desktop:installer }
finally { Remove-Item Env:DSH_INSTALLER_E2E }
```

测试覆盖无 API 凭据启动、选项变更、通过较旧注册版本触发的运行中应用替换，以及两种卸载数据选择。它不能替代断网机器验收，也不能替代从单独构建的旧发布产物升级的验收。

[Windows 安装器工作流](../../.github/workflows/desktop-installer.yml) 在全新的托管 Windows runner 上为拉取请求、master 和 `dsh-v*` 推送运行完整安装器测试。通过包验证的 EXE、校验和与元数据保留 30 天，即使后续验收失败也会保留；使用产物前须查看该次运行的测试结果。该工作流不持有签名凭据，也不发布生产版本。

## 已知限制

- **安装程序验证** — 分发前必须完成 Windows 生命周期验证；未签名的本地构建可能触发 SmartScreen。尚未实现自动更新，也未实现 macOS 打包、签名和公证。
- **任务集成** — 任务总览、根任务 worktree 隔离、审查、提交、冲突安全的应用及感知可恢复性的丢弃已经可用。子写入 Agent 的 worktree、并行写入者之间的自动协调、Task 归档和 Harness Studio 尚未实现。
- **原生集成** — 已提供感知任务的托盘驻留，以及完成或注意事项通知。尚未实现深层链接、外部链接处理和窗口位置持久化。
- **崩溃恢复** — 运行时退出恢复是显式且仅限本机的。计算机重启或断电后，应用不会自行重新启动；下次正常启动会执行冷态 Session 修复。
