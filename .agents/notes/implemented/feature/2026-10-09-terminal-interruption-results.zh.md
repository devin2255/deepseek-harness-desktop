# Agent Note: 终端中断交付结果

Status: implemented

[English](2026-10-09-terminal-interruption-results.md) | 中文

## 问题

持久终端取消需要在不销毁 shell 状态的前提下中断前台命令。POSIX 前台信号与 Windows 控制台输入是不同操作：ConPTY 无法返回 POSIX 进程组身份，写入 Ctrl+C 也不能证明应用已经停止。重复取消或超出清理生命周期的信号发送还可能中断后继操作。

## 决策

`SubprocessTerminalHandle.interrupt()` 返回可判别的交付结果。本地 POSIX 与 E2B 提供方发送真正的前台 `SIGINT`，并返回观察到的进程组。Windows 提供方通过受追踪的输入操作写入 Ctrl+C，返回 `control-input`，不虚构进程组或信号。Windows 控制台输入模式决定 Ctrl+C 是调用控制处理程序还是到达原始输入读取器。POSIX `signalForeground()` 保留原有含义，在 Windows 上拒绝。[子进程 seam](../architecture/2026-07-26-subprocess-seam.md)仍负责进程分配、传输与终止；[Windows Job 所有权](../architecture/2026-10-08-windows-conpty-job-ownership.md)仍负责 ConPTY 清理。

交付不等于命令退出或就绪。应用可能忽略中断。特别是，PowerShell 可能在前台子进程退出后重置输入缓冲；消费方必须观察 shell 重新就绪后再提交下一条命令，不能从子进程死亡或输入写入回调推断就绪。

[持久 shell 后端](2026-07-16-persistent-pty-sessions.md)通过此操作取消发送，仍然交付真正的 POSIX `SIGINT`。一次发送只接受首次取消，并保留预留直至输入写入与中断都结算。POSIX 本地清理立即关闭输入与前台操作，等待在途信号发送，并在异步前台检查之后重新检查关闭状态。Windows 在 Job 清理期间等待中断写入；E2B 保留其中止并等待信号发送的生命周期。

## 考虑过的替代方案

**将 Windows `signalForeground('SIGINT')` 作为控制字节的别名。** 否决，因为既有结果承诺信号已经交付且进程组身份真实。带判别标记的中断回执保留两类事实，不削弱 POSIX 调用方的约定。

**每次中断都终止所属 Job。** 否决，因为杀死 shell 会销毁持久变量、函数与交互状态。完整会话终止仍是显式清理操作。

**将输入已接受或前台子进程退出视为命令就绪。** 否决，因为两者都没有观察 shell 何时恢复接受输入。原生 PowerShell 验收复现了中断后的输入缓冲重置。

## 验证

可移植测试固定交付判别标记、写入失败、关闭后的拒绝、清理开始后不再发送延迟前台信号，以及信号等待期间的重复取消。原生 Windows PowerShell 5.1 与 PowerShell 7 测试观察真实前台子进程退出、shell 保持存活、新提示符，以及后续命令中的变量与函数保留。Loader 驱动的无密钥原生终端 transcript（文本记录）观察中断、后续输入及最终根进程和后代清理；构建回放验证导出的提供方。其后代在发布前确认已安装 SIGINT 处理程序，因此前台进程组中断会保留最终清理断言所检查的进程。按范围执行的逐文件覆盖包括两个本地实现、E2B 信号发送和 Bash 发送所有权。这些无密钥测试不构成真实 E2B 中断验收。

## 后果

消费方可以请求中断，不必虚报 Windows 信号或销毁持久 shell。就绪、超时、升级终止与用户可见的完成状态仍由消费方负责。[PowerShell 消费方](2026-10-09-persistent-powershell-terminal.md)负责 Windows 启动和显式本地桌面组合；仅有此原语不提供这些功能。终端状态仍在进程本地，无法跨 Host 丢失保留。
