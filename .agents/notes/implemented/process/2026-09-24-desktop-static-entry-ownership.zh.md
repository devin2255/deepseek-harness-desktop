# Agent Note: 桌面端静态入口归属

Status: implemented

[English](2026-09-24-desktop-static-entry-ownership.md) | 中文

## Problem

静态 import 检测无法发现桌面端的 Electron 验收测试入口、Cordis profile 加载的包，以及经包脚本和动态解析调用的构建工具。将它们视为无用文件或依赖，会使仓库静态检查失败，尽管已安装的应用仍需要这些内容。

## Decision

[Knip 配置](../../../../knip.json)中的桌面端工作区将 Electron 验收文件和脚本声明列为入口，并仅对已知的运行时与构建时动态依赖设例外。桌面 profile 组合包另行列出由配置加载的三个依赖。Windows 和 macOS 验收测试使用的系统命令名在全局声明。桌面端内部类型和函数不再仅为满足静态分析而导出，两个未使用的客户端测试依赖也从包清单中删除。

## Alternatives considered

**忽略整个桌面端工作区。** 这会掩盖静态分析本可准确识别的无用应用文件、直接依赖和导出。

**忽略桌面端所有 `@deepseek-ai` 依赖。** 宽泛模式会让无关的包声明悄然通过；显式列表使每项动态依赖都可供审查。

## Consequences

Knip 在考虑静态 import 图无法推断的入口路径与依赖后，仍会检查桌面端可达代码。增加由配置加载的包时，需要同步更新包清单和显式例外列表；真正无用的声明仍会被报告。
