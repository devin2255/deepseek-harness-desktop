# Agent Note：fork 使用可用的 CI runner

状态：已实现

[English](2026-10-01-fork-ci-runners.md) | 中文

## 问题

[CI 工作流](../../../../.github/workflows/ci.yml) 为主要 PR 任务选择了上游项目命名的企业 Linux 和 Windows runner。这个公开 fork 既没有这些大规格 runner 标签，也没有上游的自托管池，因此静态检查、覆盖率、快照和原生 Windows 任务一直排队。[上游故障切换手册](2026-07-26-ci-failover-runbook.md) 处理的是现有池故障，而不是 fork 无权使用任何一个池的情况。

## 决策

只有 `deepseek-harness/deepseek-harness` 保留企业 runner 默认配置及原有的 Linux、Windows 独立故障切换开关。其他仓库的三个主要 Linux 任务和汇总判定使用标准 `ubuntu-24.04`，原生 Windows 任务使用 `windows-2025`。此前按大规格 Linux runner 设置的门禁并发、覆盖率 worker、快照进程、lint 线程和 publint 并发，在 fork 中限制为 2；原生 Windows 的 publint 并发也限制为 2。上游的取值不变。仅上游仓库运行 master push 触发的自托管备用池演练，因为 fork 无法执行这些任务。

fork 选择器先于上游故障切换选择器。因此，fork 的仓库变量不会意外把 PR 派发到上游 VM 标签。已有的专用 runner 基准测试任务仍是手动触发的上游诊断，不属于 PR 汇总判定。

## 考虑过的替代方案

在 fork 中配置与上游相同的企业和自托管 runner 池。未采用：fork 并不拥有这些机器，要求公开 PR 检查依赖私有基础设施会持续阻塞贡献者。移除完整的原生 Windows 任务。未采用：Wine 任务只覆盖阻断发布的构建子集，并不覆盖完整的原生内核检查清单。

## 结果

fork 无需配置私有 runner 池即可启动必需任务，代价是在较小机器上运行时间可能增加。`all checks passed` 仍要求相同的 Linux、兼容性、Python 和 Wine 任务；原生 Windows 结果仍是独立可见的信号。CI 工作流测试固定了可用 runner 标签、fork worker 上限、上游故障切换引用和仅上游运行的备用池条件。仍需在 fork 上取得绿色 CI 结果，才能证明降低并发足以运行完整测试集。
