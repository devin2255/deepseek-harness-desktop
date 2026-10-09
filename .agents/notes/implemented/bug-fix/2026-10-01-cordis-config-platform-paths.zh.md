# Agent Note：在 Cordis 配置归属检查前统一路径

状态：已实现

[English](2026-10-01-cordis-config-platform-paths.md) | 中文

## 问题

静态 CI 门禁发现 `examples/package.json` 漏声明两个已配置插件：`dsh-task-session` 和 `dsh-client-ui-task-overview`。同一验证器此前却在 Windows 本地通过，因为 `globSync` 在 Windows 返回反斜杠分隔的路径，而归属过滤器使用正斜杠前缀 `examples/`。因此 Windows 运行跳过了示例依赖检查，无法发现漏声明。

## 决策

`cordisConfigFiles` 在所有主机上都返回以 `/` 分隔的仓库相对路径。应用覆盖配置的 glob 使用同一个规范化函数，避免 Windows 将 MCP-memory 覆盖配置误判为示例自有配置。测试不再依赖主机的路径分隔符，而是明确断言这一表示。在示例清单中声明两个已配置的工作区包，并重新生成锁文件。验证器使用统一后的路径进行归属分类和诊断。

## 考虑过的替代方案

在每个验证器过滤器中加入 Windows 特判。未采用：共享发现函数的其他调用方仍会收到因平台而异的路径。因本地工作区能解析包而忽略漏声明。未采用：干净安装和发布产物按声明的清单解析，而不是依赖开发者工作区中的偶然链接。

## 结果

Windows 与 Linux 现在执行相同的示例清单检查。聚焦的发现测试、Windows 上的 `verify-cordis-config` 和 Linux 静态 CI 门禁覆盖了改动路径。现有诊断在两种系统上都使用正斜杠形式的仓库路径。
