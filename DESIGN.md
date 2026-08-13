# DeepSeek Harness Desktop Design System

## Product context

- **Product:** A desktop command center for supervising parallel coding agents across local projects while retaining access to DeepSeek Harness presets, plugins, tools, permissions, workflows, and event history.
- **Primary users:** Independent developers and small engineering teams that already use terminals or IDEs and want to delegate several long-running tasks without losing control.
- **Memorable outcome:** One window manages multiple parallel agents.
- **Primary surface:** A task-first desktop application. Chat, code, terminals, and diffs are task artifacts rather than top-level destinations.

## Aesthetic direction

- **Direction:** Industrial and utilitarian.
- **Decoration:** Minimal. Borders, spacing, typography, and state color establish hierarchy; ornamental gradients and decorative cards are excluded.
- **Mood:** Calm, dense, precise, and trustworthy. The interface resembles an engineering operations console without adopting terminal nostalgia or visual noise.
- **Category references:** [Codex desktop](https://openai.com/index/introducing-the-codex-app/), [Claude Code desktop](https://code.claude.com/docs/en/desktop), [VS Code Agents window](https://code.visualstudio.com/docs/agents/agents-window), and [Zed parallel agents](https://zed.dev/docs/ai/parallel-agents).

## Typography

- **UI and body:** Source Sans 3, locally bundled, for compact Chinese and Latin interface copy.
- **Data and code:** IBM Plex Mono, locally bundled, with tabular numerals for durations, counts, statuses, event names, branch names, and source code.
- **Scale:** 11px metadata, 12px compact UI, 14px body and controls, 16px page title, 20px section title, 28px empty-state heading.
- **Weights:** 400 body, 500 labels, 600 titles and data emphasis, 700 only for primary actions and critical counts.

## Color

The default dark theme uses restrained cool-charcoal neutrals and one mint accent. Semantic colors appear only when they communicate status or risk.

| Token | Dark | Light | Use |
|---|---|---|---|
| `background` | `#0D1210` | `#F5F6F3` | Application canvas |
| `rail` | `#0A0E0C` | `#E9ECE7` | Global navigation |
| `panel` | `#121916` | `#FFFFFF` | Primary panel |
| `panel-raised` | `#17211D` | `#F0F2EE` | Selected and raised regions |
| `border` | `#293730` | `#D4DAD4` | Structural dividers |
| `border-strong` | `#3A4B43` | `#AEB9B1` | Interactive borders |
| `text` | `#DCE4E0` | `#18201C` | Primary text |
| `text-muted` | `#82958C` | `#65736C` | Metadata |
| `accent` | `#6ED4A9` | `#167A58` | Selection, progress, primary action |
| `info` | `#8CA8FF` | `#365FC7` | Review and informational status |
| `warning` | `#E5B566` | `#9B6400` | Human attention required |
| `danger` | `#EF8C84` | `#B7352E` | Failure and destructive risk |

Status must never rely on color alone. Every colored status includes an icon, label, or both.

## Spacing and density

- **Base unit:** 4px.
- **Density:** Compact and comfortable. Primary surfaces use 8px and 12px gaps; page regions use 16px and 24px gaps.
- **Control heights:** 28px compact, 32px standard, 40px prominent composer actions.
- **Rows:** 36px default, 44px for task rows with secondary metadata.
- **Radius:** 3px chips, 5px controls, 7px selected navigation, 10px dialogs. Large uniform rounded cards are excluded.

## Layout

- **Approach:** Grid-disciplined.
- **Desktop frame:** 56px global rail, 220–260px task list, fluid central workspace, 260–320px inspector.
- **Minimum window:** 960×640. Below 1100px the inspector becomes a drawer; below 960px the app presents a supported-size message instead of collapsing into an unusable mobile layout.
- **Resizable regions:** Task list and inspector widths persist per device. Terminal, diff, preview, and file panes may be rearranged inside one task but do not change the global navigation.

## Motion

- **Approach:** Minimal and functional.
- **Durations:** 80ms hover, 140ms selection, 180ms panel transition, 240ms dialog transition.
- **Easing:** `cubic-bezier(0.2, 0, 0, 1)` for entry and movement; `ease-in` for dismissal.
- **Rules:** Streaming content does not animate vertically. Progress indicators use restrained indeterminate motion. Reduced-motion mode removes panel transitions and animated progress.

## Interaction rules

- The default screen answers which tasks are active, which need attention, and what changed.
- A task may show rich execution detail, but the attention queue is the only place that interrupts the user.
- Chat is a task control channel. Messages may target the whole task or an explicit agent.
- Completion requires success-criteria status, change summary, verification evidence, and unresolved-risk count.
- Advanced Harness data is summarized in the task inspector and expands into Harness Studio.
- Dangerous actions name the exact target, consequence, and recovery path before confirmation.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-14 | Task-first Mission Control plus progressive Harness Studio | It makes parallel supervision the product's memorable behavior while preserving the Harness runtime as a differentiator. |
| 2026-08-14 | Industrial, restrained visual system | Dense engineering state needs hierarchy and legibility, not decorative AI-product styling. |
| 2026-08-14 | Source Sans 3 plus IBM Plex Mono | The pair supports Chinese UI text, compact data, code, and tabular status values without converging on common AI-product fonts. |
