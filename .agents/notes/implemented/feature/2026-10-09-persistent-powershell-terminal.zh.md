# Agent Note: 持久 PowerShell 终端

Status: implemented

[English](2026-10-09-persistent-powershell-terminal.md) | 中文

## 问题

Windows 桌面任务需要 shell 变量、函数、cwd 和交互式 stdin 跨工具调用保留。仅分配 ConPTY 不会选择 shell 语法、初始化可用的提示符，也不会使桌面默认受限令牌沙箱中的取消操作安全。运行于 Windows 的 Harness 还可能使用远程 Linux 进程管理提供方，因此后端内部根据宿主平台猜测会选错 shell。

## 决策

`dsh-terminal-shell` 为显式选择的 Bash 与 PowerShell 负责共享持久会话实现。其 `shell` 配置默认使用 Bash，与宿主无关；本地桌面覆盖层显式为 Windows 选择 PowerShell。PowerShell 通过已挂载的进程管理提供方解析可执行文件，默认使用 Windows PowerShell 5.1（`powershell.exe`），并接受 `shellPath: pwsh` 以使用 PowerShell 7。省略参数会安装所选 shell 的受控启动参数；显式参数则替换它们。[持久 PTY 决策](2026-07-16-persistent-pty-sessions.md)继续负责所有权、输出限制、就绪层级和进程内生命周期。

PowerShell 启动移除 PSReadLine 与 profile，设置 UTF-8 管道输出，并通过核心字符串操作安装私有 OSC 标记。控制台编码设置仅在 FullLanguage 下运行。只读 [Windows 约束](2026-08-08-windows-acl-restricted-token-sandbox.md)可能因 AppLocker 启动探针无法写入临时文件而触发 ConstrainedLanguage；启动保留该限制，不授予临时目录写权限，也不改变语言模式。已记录的 MOTD 说明 PowerShell 语法和此限制。

ConPTY 不提供前台进程组事实。因此 PowerShell 输出静默返回 `inferred_idle`，而非 `stdin_read`，超时也不代表命令退出。取消会丢弃中断前的就绪证据，等待进行中的写入，并使用[原生中断操作](2026-10-09-terminal-interruption-results.md)。交付进行期间，被取消的 send 保留所有权。原生验收先观察新提示符，再证明可继续输入；仅有交付回执或子进程退出不足以证明这一点。

Windows ACL runner 通过 Node 的进程本地监听器消费自身 SIGINT，同时保留既有受限令牌、继承 stdio、Job 所有权与授权清理。它不设置 `SetConsoleCtrlHandler(NULL, TRUE)`：微软的[控制台控制文档](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler)规定，此忽略标志会被子进程继承。原生验收复现了该标志使受限前台子进程在 Ctrl+C 后存活，并证明使用进程本地监听器后，子进程退出且 shell 状态保留。

## 考虑过的替代方案

**在 PowerShell 专用包中复制 Bash 生命周期。** 否决，因为就绪轮询、有界输出、所有者保护、取消和 teardown 具有相同的归属与结算点。分开的副本会使安全修复产生分歧。

**在提供方内部根据 Harness 宿主选择 shell。** 否决，因为远程执行世界可能使用不同操作系统。本地桌面组合显式负责平台选择。

**在只读模式授予临时空间写权限或强制 FullLanguage。** 否决，因为终端启动不得扩大文件权限或覆盖宿主语言策略。仅使用核心操作构造提示符可保留可用的受限会话。

**每次取消都杀死整个终端。** 否决，因为这会破坏持久能力所需的状态。整个会话终止仍是输入被忽略或传输失败时的恢复方式。

## 验证

可移植测试固定 shell 专用默认值解析、显式参数替换、执行世界中的可执行文件查找、查找期间取消，以及无前台事实时的 PowerShell MOTD 与就绪状态。源码和构建后的 Loader transcript（文本记录）覆盖真实后端与终端工具，仅控制操作系统传输。原生 Windows PowerShell 5.1 与 7 验收覆盖 Unicode、带空格 cwd 的变更、多行状态、交互子进程输入、Ctrl+C、新提示符与后续命令。受限模式验收检查工作区写入、只读拒绝、工作区外拒绝、受限中断，以及所有者 dispose（资源释放）后的根和后代进程完全停稳。ACL runner 既有原生测试固定其不变的写入限制与失败行为。

## 后果

桌面 agent（智能体）可使用持久 PowerShell，不需要无约束回退，也不伪造前台身份。六个终端工具与有界单次工具共存；POSIX 信号操作在 Windows 上仍会拒绝。PowerShell 提示符覆盖与原生控制输入处理仍依赖应用，因此推断就绪不是命令完成回执。终端状态不会在 Host 丢失后保留，完整屏幕交互仍不支持。本实现不证明安装器签名、更新或完整桌面发布已经合格。
