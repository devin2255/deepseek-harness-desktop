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

Main 在应用就绪前启用 Chromium 沙箱并获取 Electron 单实例锁。持有锁的实例等待 `app.whenReady()`，使用 `desktop` profile 在随机 loopback 端口启动且仅启动一个 Harness，等待其规范就绪行，然后创建一个已授权窗口。第二次启动只会恢复并聚焦该窗口，不会再启动 Harness。

第一次显式退出会中止尚未完成的 Harness 启动，等待启动资源归属完成结算，停止一次已就绪的 Harness，然后在退出锁存状态下再次调用 `app.quit()`。即使关闭失败被报告，应用仍会最终退出。在 Windows 和 Linux 上关闭最后一个窗口会退出；在 macOS 上激活应用会使用现有 Harness 授权重新创建缺失的窗口。

## 安全

- Main 为每次启动生成 32 字节 capability，并且只将其交给 Harness 进程和隔离的 Electron session。该 session 仅针对完成结算后的确切 HTTP 与 WebSocket origin，且仅为其拥有的 renderer 添加 `Authorization: Bearer <capability>`。
- renderer 与 preload API、URL、DOM 状态、Web 存储、日志、设置和会话事件均不包含 capability。没有该 header 的直接 loopback 客户端会收到 `401`。
- renderer 使用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和 `webSecurity: true`。冻结的 preload bridge 只公开 `deepseekDesktop.platform`，不公开通用 IPC、进程、文件系统、shell、环境或 capability 访问权。
- 导航与重定向仅限于完成结算后的 origin，所有新窗口请求都会被拒绝，renderer 权限检查与权限请求也默认拒绝。

## 失败

Harness 启动错误、就绪超时或初始窗口故障会被报告；应用会清理已拥有的 Harness 或部分窗口状态，然后退出。启动取消和 Harness 关闭都有有界的进程等待。窗口关闭后的 session handler 清理故障会被报告，但不会逃逸 Electron 回调；诊断报告自身的故障也会被隔离。

## 模型体验

Electron 应用不添加模型可见内容。桌面 profile 的 [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md) 覆盖层会禁用 Web 表层提示词段，并负责 loopback 授权 guard。

## 已知限制

- **源码检出运行** — 此阶段不提供打包安装程序、代码签名、发布来源证明或自动更新。
- **前台窗口生命周期** — 当前没有托盘驻留或感知任务的后台策略；在 Windows 和 Linux 上关闭最后一个窗口会退出。
- **基础 UI** — renderer 仍是现有 Web 客户端，并非计划中的 Mission Control 任务概览、审查模式或 Harness Studio。
- **原生集成** — 尚未实现深层链接、原生通知、外部链接处理和窗口位置持久化。
- **崩溃恢复** — Main 会报告启动与关闭故障，但尚未提供感知任务的恢复，也不会在 Harness 运行时异常退出后将其重启。
