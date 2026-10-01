# Agent Note: 打包安装中原生可选包的验证

Status: implemented

[English](2026-10-01-packed-install-native-optionals.md) | 中文

## Problem

打包后的 dsh 消费方曾略去所有 npm 可选依赖，以验证缺少 Landlock 平台包时仍能启动。Koffi 也把 Linux 原生二进制文件作为可选包分发。略去它会迫使 npm 从源码编译 Koffi；即使普通消费方安装可以成功，这次编译也可能失败。发布检查因此到不了已安装的可执行文件，也不能代表用户默认的安装路径。

## Decision

打包消费方检查执行 npm 默认安装，保留包脚本和可选依赖。它先运行已安装的 `dsh --version`，再在 Linux Landlock 平台包对 Landlock entry 不可用时运行一次。第二次探针在一次性消费方内临时移走已解析的平台包的每个副本，并在 `finally` 中恢复；若 npm 本就没有安装该可选包，探针直接在缺包状态下运行。打包的 dsh、vendored 和 Landlock entry tarball 仍来自该 job 的本地产物。此 runner 不构建 Landlock 平台二进制文件；该可选包可能从 registry 解析，也可能缺失。

## Alternatives considered

**升级 Koffi，使强制源码编译通过。** 即使源码编译成功，略去全部可选包的安装仍不能代表普通消费方安装，而且原生依赖升级会影响所有 Windows 调用方。

**略去可选依赖时忽略 npm 包脚本。** 这样虽能完成安装，却无法检查原生包安装失败。

**在 dsh job 中构建并加入全部 Landlock 平台 tarball。** 平台二进制文件需要 musl 工具链和按架构构建，由独立的 native 发布序列负责。

## Consequences

默认探针覆盖原生预构建包安装和内部 tarball 解析；独立的缺包探针在不移除其他可选二进制文件的前提下保留 Landlock 启动保证。可选 Landlock 平台包可能从 registry 获取，因此探针不宣称安装完全不依赖 registry。`dsh --version` 证明可以启动，不证明每种沙箱后端均已执行。
