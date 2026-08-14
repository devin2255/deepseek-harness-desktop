# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The Desktop profile overlay for the Web application. [`cordis.patch.yml`](cordis.patch.yml) preserves the invocation's `webStartup` host and port, requires `desktop-capability` before the Web server admits a request, keeps the settled URL line, suppresses Web-GUI model context, and inserts this plugin. The Electron launcher supplies its per-launch capability through `DSH_DESKTOP_CAPABILITY`; this package does not create windows or manage application tasks.

At activation, the plugin reads `DSH_DESKTOP_CAPABILITY` once and deletes the environment entry immediately. An absent or empty value stops startup with `desktop-app: DSH_DESKTOP_CAPABILITY must contain a per-launch capability`. The registered guard accepts exactly one string `Authorization` value in the form `Bearer <base64url capability>` and rejects missing, malformed, duplicate, or unequal values. It compares equal-length UTF-8 buffers with `timingSafeEqual`; differing lengths reject before comparison. Disposal releases the guard with its plugin fiber. `WebServer` fails closed for its complete lifetime when the required guard is missing or rejects.

## Model Experience

None, as this package only authorizes local HTTP and upgrade requests before their owners run.

#### KV Cache effect

None; the package adds no prompt section, tool, message, or model-visible environment entry.

## Known Limitations and Deferred Work

- **Installer signing** — desktop installer signing and release provenance remain outside this overlay.
- **Task-aware background lifecycle** — background work is not yet coordinated with a desktop window's task lifecycle.
