# Agent Note: 经用户确认的 Windows 桌面端更新

Status: implemented

[English](2026-09-24-desktop-consented-update-installation.md) | 中文

## Problem

有已签名安装器和正确发布源并不代表已安装应用能够升级。在 Harness 或应用 mutex 仍被占用时启动更新安装程序，可能中断 Task，或让文件替换与运行中的可执行文件发生竞争。

## Decision

只有更新源指向经审查的 GitHub 仓库且记录了签名发布者的已打包 Windows 构建才启用 `electron-updater`。Main 在启动后和运行期间定期检查，也允许从托盘手动检查；下载完整 NSIS 安装器并验证代码签名。它禁用 Web 安装器、降级和普通退出时自动安装。下载完成的版本出现在托盘和原生通知中。安装须经过单独确认，默认选择“稍后”，并展示实时 Task 活动情况，或说明状态不可用。生命周期先释放后台驻留、停止 Harness、释放 mutex，之后才调用 `quitAndInstall`；清理未完成时绝不启动安装器。更新错误写入日志，可重试且不修改 Task 状态。

## Alternatives considered

**用户退出时自动安装。** 普通退出可能发生在用户决定让 Task 继续运行之后，也可能只是暂时关闭窗口，因此不能据此授权替换。

**生命周期清理前启动安装器。** `electron-updater` 通常先启动安装器再请求退出；这种顺序可能让应用文件和 mutex 仍被占用。

## Consequences

下载不会中断并行 Agent，安装须经过明确的中断确认。未签名测试包没有更新操作。单元与 Main 入口测试覆盖配置、下载状态、确认、清理顺序和重试；生产网络与安装程序路径仍须通过分别构建的较旧和较新签名版本验证。
