# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The Desktop profile overlay for the Web application. [`cordis.patch.yml`](cordis.patch.yml) preserves the invocation's `webStartup` host and port, requires `desktop-capability` before the Web server admits a request, keeps the settled URL line, suppresses Web-GUI model context, and inserts this plugin. The Electron launcher supplies its per-launch capability through `DSH_DESKTOP_CAPABILITY`; this package does not create windows or manage application tasks.

At activation, the plugin reads `DSH_DESKTOP_CAPABILITY` and `DSH_DESKTOP_APP_VERSION` once and deletes both environment entries immediately. A missing, empty, or non-base64url capability, or a missing, empty, or oversized application version, stops startup. The registered guard accepts exactly one string `Authorization` value in the form `Bearer <base64url capability>` and rejects missing, malformed, duplicate, or unequal values. It compares equal-length UTF-8 buffers with `timingSafeEqual`; differing lengths reject before comparison. `WebServer` fails closed for its complete lifetime when the required guard is missing or rejects.

While the API Proxy service is mounted, the plugin registers the exact authenticated `GET /.well-known/deepseek-harness-desktop/readiness` route. Its JSON response identifies `deepseek-harness-desktop`, reports the captured application version, and advertises the `host.describe` and `session.list` operations supplied by that service. Disposal releases the route and guard with the plugin fiber.

## Model Experience

Indirectly, through `dsh-web-app`: this overlay sets `web-runtime.surfaceContext` to `false`, removing its `app:web-surface` prompt section and managed `DSH_WEB_URL` shell context.

#### KV Cache effect

The omitted Web-surface fields leave the request prefix without that stable context; this overlay adds no replacement or turn-to-turn cache invalidation.

## Known Limitations and Deferred Work

- **Installer signing** — desktop installer signing and release provenance remain outside this overlay.
- **Task-aware background lifecycle** — background work is not yet coordinated with a desktop window's task lifecycle.
