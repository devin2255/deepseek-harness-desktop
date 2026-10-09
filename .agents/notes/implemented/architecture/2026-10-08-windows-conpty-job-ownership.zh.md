# Agent Note: Windows ConPTY Job 所有权

Status: implemented

[English](2026-10-08-windows-conpty-job-ownership.md) | 中文

## 问题

桌面端通过单次 PowerShell 执行 Windows 命令，但持久终端分配会在启动进程前拒绝 Windows。Windows 实现还需要在 shell 或 Harness 退出后停止后代进程，且不能把清理指向复用后的 PID。POSIX 前台进程组与信号无法描述该平台。

## 决策

本地子进程提供方通过 Windows ConPTY 和未命名、不可继承且关闭即终止的 Job 实现已有终端原语。根进程以暂停状态创建，精确进程句柄加入 Job 且成功后才恢复执行。分配失败时通过精确句柄终止暂停的根进程，并在释放该句柄前确认退出；观察失败或超时会拒绝回滚。正常创建的后代继承 Job 成员关系，不设置脱离标记。Job 管理生命周期，不是沙箱，也不包含由 WMI 或服务等外部代理创建的进程。[持久 PTY 决策](../feature/2026-07-16-persistent-pty-sessions.md)仍负责上层终端能力和 POSIX 后端。

原生同步管道客户端连接到独立读取的 Node socket。提供方传入显式清理后、按 Windows 序数名称排序的 UTF-16 环境块，不修改宿主环境。ConPTY 连接前会清空 Windows 标准句柄，避免子进程输出继承 Harness 控制台。清理先禁止新输入，再终止 Job，观察成员归零与根进程退出，读取最终输出的同时关闭 ConPTY，最后等待未完成写入。尚未发布的分配在取消和提供方 dispose（资源释放）期间仍保持所有权；原生回滚失败会保留在分配注册表中，直到 dispose 报告该失败，而调用方取消仍保留其确切原因。

`ClosePseudoConsole` 在独立 Node 工作线程内同步执行。通过 Koffi 异步调用可稳定复现宿主进程以访问冲突 `0xc0000005` 退出，而同步绑定和独立工作线程均能正常完成。不能在主事件循环执行同步调用，因为旧版 ConPTY 可能在输出最终内容时阻塞。资源释放以工作线程退出为完成依据，而不是只收到一条消息。

输出或工作线程失败时仍会释放传输通道与进程／Job 句柄、等待未完成输入，并拒绝清理操作；不会重复结果不确定的 ConPTY 关闭。分配回滚会同时报告原始失败与关闭失败，而不是放弃其余资源或替换原始原因。

前台检查返回 undefined，POSIX 信号直接拒绝且不发送控制字节。键盘 Ctrl+C 不等于已交付的 POSIX 信号，也无法产生真实的 `targetPgid`。独立的[原生中断操作](../feature/2026-10-09-terminal-interruption-results.md)报告已写入 Ctrl+C 输入，不声称命令已经退出。具有就绪检测的 Windows 原生持久 shell 消费方仍是独立工作；该提供方不会在桌面默认配置中启用 Bash 后端。

## 考虑过的替代方案

**在普通 `node-pty.spawn` 后分配 shell。** 否决，因为 Windows 分配是异步的，用户代码可能在 Job 分配前创建后代。库的终止路径还包含按数值 PID 终止控制台成员的操作，不适合在根进程退出后使用。

**使用 `taskkill /T` 或 POSIX 进程组标识。** 对持久 Windows 终端否决，因为根进程退出和 PID 复用会破坏数值进程树所有权，而 ConPTY 没有 POSIX 前台进程组。

**在主线程或通过 Koffi 异步调用关闭 ConPTY。** 否决，因为前者可能阻塞输出读取，后者在已验证的原生路径中发生访问冲突。独立 Node 工作线程同时保持事件循环可运行，并使用已验证的同步绑定。

## 验证

原生 PowerShell 验收检查变量、函数、中文及带空格工作目录的持久状态、真实前台子进程、输出 EOF，以及清理后的进程消失。宿主进程测试从外部观察正常 dispose、直接退出、未处理故障，以及不执行 JavaScript 回调的强制终止之后，根进程和后代都退出。可移植生命周期测试覆盖并发关闭、存活成员超时、重试、传输与写入失败、分配取消和 dispose。真实 Loader 驱动的无密钥终端 transcript（文本记录）通过可运行示例验证持久行输入与整棵进程树清理；构建模式回放检查发布的提供方。

## 结果与影响

Windows 终端进程在用户代码执行前取得 OS 生命周期所有权，即使 Harness 无法执行[同步退出回调](../bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md)也保留该所有权。POSIX 终端保留原有进程检查限制。Host 丢失仍会销毁终端状态；完整 Windows 持久 shell 交互仍需实现并验收消费方。
