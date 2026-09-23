# Agent Note: 在原生 runner 上验收 Apple Silicon 桌面测试压缩包

Status: implemented

[English](2026-09-23-macos-arm64-desktop-package-qualification.md) | 中文

## 问题

从源码构建的 Electron 验收测试能够证明桌面入口可在 macOS arm64 上运行，但不能证明打包后的应用包含运行时文件，也不能证明压缩包可读取。Windows 构建的产物无法提供 Apple Silicon 的结果。

## 决策

[macOS arm64 工作流](../../../../.github/workflows/desktop-macos.yml)先运行真实的 Electron 验收测试，然后在 Apple Silicon runner 上构建未签名的 arm64 应用、DMG 和 ZIP。打包命令拒绝签名凭据，检查应用可执行文件的架构与必需的 Main/preload 文件，并在 CI 保留产物 30 天前验证两种压缩包。仓库生成的 1024 像素 PNG 用作应用图标；Windows 继续使用独立的 ICO 和 NSIS 构建目标。

这些压缩包是验收产物，不是发布物。工作流既不安装 DMG，也不检查 Gatekeeper、Developer ID 签名、公证或更新交付。生产分发还需要独立的凭据、已安装应用验收和发布检查。

## 曾考虑的替代方案

**在 Windows 上交叉构建 Mac 包。** 交叉构建不能运行 Apple Silicon Electron、原生模块或 macOS 压缩包工具，因此无法提供所需的平台证据。

**在拉取请求 CI 中签名。** 拉取请求代码不得获得 Developer ID 或公证凭据。未签名验收稳定后，签名与发布应由受保护的发布环境执行。

## 后果

原生 CI 通道可以在发布工作开始前发现打包文件缺失及压缩包损坏，同时避免让不受信任的拉取请求构建接触签名权限。保留的 DMG 和 ZIP 必须明确作为测试包使用；完整性检查不能证明可安装性或生产信任。
