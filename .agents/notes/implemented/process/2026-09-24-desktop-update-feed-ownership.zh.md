# Agent Note: 桌面端更新源归属

Status: implemented

[English](2026-09-24-desktop-update-feed-ownership.md) | 中文

## Problem

桌面包的仓库元数据指向上游项目，而这个 fork 发布自己的安装器。若让构建器推断更新提供方，已安装应用就可能指向本产品无权控制的发布仓库。两阶段 Windows 构建也不会自动保留应用内的 `app-update.yml`，且会丢弃 `latest.yml`；打包流程必须明确拥有这两个文件。

## Decision

[构建器配置](../../../../apps/desktop/electron-builder.yml)将 GitHub 更新源固定到 `devin2255/deepseek-harness-desktop`。Windows 打包在目录构建后将经审查的提供方和更新缓存目录写入 `resources/app-update.yml`，若构建器已写入不同值则拒绝继续。对已签名应用，还会将通过 Authenticode 信任校验的证书通用名称记录为 `publisherName`；否则 `electron-updater` 会跳过安装器签名验证。打包保留 `latest.yml`，并将其版本、安装器名称与 SHA-512 对照最终 EXE。包验证和受保护的发布工作流在发布前重复这些校验；工作流还要求安装器与应用使用同一个签名发布者，并将清单与已签名安装器一同发布。桌面发布使用能被更新器识别为语义化版本的 `v<version>` 标签，与 npm 的 `dsh-v<version>` 标签区分开。[桌面端更新决策](../feature/2026-09-24-desktop-consented-update-installation.md)负责应用内检查与安装确认。

## Alternatives considered

**从仓库元数据推断提供方。** 该元数据标识上游项目，不能证明此 fork 的发布资产归属。

**手工编写独立更新清单。** 手工填写的摘要可能偏离已签名安装器；这里校验构建器生成的清单与最终字节一致。

## Consequences

已安装的 Windows 包包含明确的更新源，发布清单不能静默指向其他安装器字节。创建发布时必须将 `latest.yml` 与 EXE 一同提供。从旧版本升级到新签名版本的验收及已签名 macOS 发布仍是独立工作；仅有这些文件不会让应用自动更新。
