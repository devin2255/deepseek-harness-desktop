# Agent Note：从发行版软件源安装 CI Bubblewrap

状态：已实现

[English](2026-10-01-ci-bubblewrap-archive-rotation.md) | 中文

## 问题

Linux CI 准备脚本曾直接从 Ubuntu 24.04 归档池下载一个固定版本的 Bubblewrap `.deb`。2026-10-01，Ubuntu 发布后续修订版后，原先固定的 `0.9.0-1ubuntu0.1` URL 返回 HTTP 404。覆盖率和产物消费任务在运行门禁前就因沙箱准备失败。[Ubuntu 归档索引](https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/) 确认旧文件已不存在，而较新的修订版仍在。

## 决策

在 Linux x64 上，若已有 `bwrap` 就直接使用；否则更新发行版软件包索引，并通过 apt 安装 `bubblewrap`，不安装推荐依赖。保留 AppArmor 配置尝试和实际隔离探针。CI 工作流仍让软件包安装与不可变的 pnpm 安装并行进行。软件包版本与真实性改由 runner 配置的 Ubuntu 软件源负责，不再依赖归档池文件名和手工固定的哈希值。

## 考虑过的替代方案

固定最新 `.deb` 及 SHA-256。未采用：后续安全修订可能再次移除该文件，重现同一 CI 故障。将可执行文件纳入仓库。未采用：runner 已有维护中的 Ubuntu 软件源，而内置可执行文件意味着项目必须自己维护更新与平台链接。

## 结果

首次准备可能比解压小型 `.deb` 更慢，但 CI 任务不再依赖某个归档池修订版长期存在。静态工作流测试固定 apt 路径和功能探针；Linux CI 任务提供实际执行验证。若 apt 或探针失败，准备步骤仍会在测试前失败，不会静默关闭沙箱。
