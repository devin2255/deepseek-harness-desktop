# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The Desktop profile overlay for the Web application. [`cordis.patch.yml`](cordis.patch.yml) preserves the invocation's `webStartup` host and port, requires `desktop-capability` before the Web server admits a request, keeps the settled URL line, suppresses Web-GUI model context, mounts the Session-backed Task Provider before Task-aware Host API activation, and inserts this plugin, the task overview, and read-only Harness Studio. It pins the in-app directory browser as the desktop Workspace chooser, with an editable absolute Host path and no native dialog worker; the Web profile keeps its adaptive chooser. The Electron launcher supplies its per-launch capability through `DSH_DESKTOP_CAPABILITY`; this package does not create windows or own Task state.

At activation, the plugin reads `DSH_DESKTOP_CAPABILITY` and `DSH_DESKTOP_APP_VERSION` once and deletes both environment entries immediately. A missing, empty, or non-base64url capability, or a missing, empty, or oversized application version, stops startup. The registered guard accepts exactly one string `Authorization` value in the form `Bearer <base64url capability>` and rejects missing, malformed, duplicate, or unequal values. It compares equal-length UTF-8 buffers with `timingSafeEqual`; differing lengths reject before comparison. `WebServer` fails closed for its complete lifetime when the required guard is missing or rejects.

While the API Proxy service is mounted, the plugin registers the exact authenticated `GET /.well-known/deepseek-harness-desktop/readiness` route. Its JSON response identifies `deepseek-harness-desktop`, reports the captured application version, and advertises the `host.describe` and `session.list` operations supplied by that service. Disposal releases the route and guard with the plugin fiber.

The overlay selects `sandbox-policy.delegationMode: read-only` without changing the root mode or workspace fallback. New in-process spawn, fork, and continuable children record that mode before publication; their existing sandbox context states read-only and their existing approval pin rejects escalation. Cold children replay their recorded mode. See the [desktop delegation decision](../../../.agents/notes/implemented/feature/2026-10-06-desktop-read-only-delegation.md).

## Model Experience

Indirectly, through `dsh-web-app` and `dsh-sandbox-policy`: this overlay removes Web-surface context and selects the read-only mode described by a new child's existing runtime-context snapshot.

#### KV Cache effect

The omitted Web-surface fields leave the request prefix without that stable context. The child's read-only fact uses the existing append-only runtime-context snapshot; root request prefixes are unaffected by the delegation setting.

## Known Limitations and Deferred Work

- **Installer signing** — desktop installer signing and release provenance remain outside this overlay.
- **Writing children** — child-writer worktrees and integration are not available; ordinary desktop children cannot modify shared task files.
- **Task-aware background lifecycle** — background work is not yet coordinated with a desktop window's task lifecycle.
