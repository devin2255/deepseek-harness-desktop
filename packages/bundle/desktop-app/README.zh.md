# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

桌面 Web 应用的 profile 覆盖层。[`cordis.patch.yml`](cordis.patch.yml) 保留调用方的 `webStartup` host 和 port，在 Web server 接受请求前要求 `desktop-capability`，保留完成结算后的 URL 输出，关闭 Web GUI 模型上下文，在感知 Task 的 Host API 激活前挂载基于 Session 的 Task Provider，并插入本插件、任务总览及只读 Harness Studio。它将应用内目录浏览器固定为桌面工作区选择器，允许编辑完整的 Host 绝对路径，且不启动原生对话框工作进程；Web profile 继续使用自适应选择器。Electron 启动器通过 `DSH_DESKTOP_CAPABILITY` 提供每次启动专用 capability；本包不创建窗口，也不拥有 Task 状态。

激活时，插件只读取一次 `DSH_DESKTOP_CAPABILITY` 和 `DSH_DESKTOP_APP_VERSION`，随后立即删除这两个环境变量。capability 缺失、为空或不是 base64url，或者应用版本缺失、为空或超长时，启动会停止。已注册的 guard 只接受一个形式为 `Bearer <base64url capability>` 的字符串 `Authorization` 值，拒绝缺失、格式错误、重复或不相等的值。它只在 UTF-8 buffer 长度相等时调用 `timingSafeEqual`；长度不同会在比较前拒绝。所需 guard 缺失或拒绝时，`WebServer` 在完整生命周期内保持 fail-closed。

API Proxy 服务挂载期间，插件注册精确的已认证 `GET /.well-known/deepseek-harness-desktop/readiness` 路由。其 JSON 响应标识 `deepseek-harness-desktop`，报告已捕获的应用版本，并声明该服务提供的 `host.describe` 和 `session.list` 操作。释放插件 fiber 时会同时释放该路由和 guard。

覆盖层选择 `sandbox-policy.delegationMode: read-only`，不改变根模式或工作区回退值。新的进程内 spawn、fork 与可继续子级会在发布前记录该模式；其既有沙箱上下文说明只读状态，既有审批钉定会拒绝升权。冷态子级重放已记录的模式。参见[桌面委派决策](../../../.agents/notes/implemented/feature/2026-10-06-desktop-read-only-delegation.md)。

## 模型体验

间接地，通过 `dsh-web-app`、`dsh-sandbox-policy` 与 `dsh-tool-terminal`：此覆盖层移除 Web 表层上下文，选择由新子级既有运行时上下文快照说明的只读模式，并公开六个持久终端工具及其常驻使用指导。本地桌面组合显式为 Windows 选择 PowerShell，为其他平台选择 Bash，不改变远程执行世界的默认值。创建 PowerShell 会话时，已记录的 MOTD 返回语法和语言模式指导。参见[终端后端](../../terminal/terminal-shell/README.md)。

#### KV Cache 影响

省去的 Web 表层字段使请求前缀不再包含该稳定上下文；终端 schema 与使用指导加入已配置的前缀。子级的只读事实使用既有的仅追加运行时上下文快照；根请求前缀不受委派设置影响。只有请求终端结果时，它们才会追加到历史中。

## 已知限制与延后工作

- **安装程序签名** — 桌面安装程序签名和发布来源证明仍在此覆盖层之外。
- **写入子级** — 子写入者 worktree 与集成尚不可用；普通桌面子级不能修改共享任务文件。
- **感知任务的后台生命周期** — 后台工作尚未与桌面窗口的任务生命周期协调。
