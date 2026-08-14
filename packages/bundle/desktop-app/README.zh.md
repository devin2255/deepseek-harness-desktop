# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

桌面 Web 应用的 profile 覆盖层。[`cordis.patch.yml`](cordis.patch.yml) 保留调用方的 `webStartup` host 和 port，在 Web server 接受请求前要求 `desktop-capability`，保留完成结算后的 URL 输出，关闭 Web GUI 模型上下文，并插入本插件。Electron 启动器通过 `DSH_DESKTOP_CAPABILITY` 提供每次启动专用 capability；本包不创建窗口，也不管理应用任务。

激活时，插件只读取一次 `DSH_DESKTOP_CAPABILITY`，随后立即删除该环境变量。值缺失、为空或不是 base64url 时，会以 `desktop-app: DSH_DESKTOP_CAPABILITY must contain a per-launch capability` 停止启动。已注册的 guard 只接受一个形式为 `Bearer <base64url capability>` 的字符串 `Authorization` 值，拒绝缺失、格式错误、重复或不相等的值。它只在 UTF-8 buffer 长度相等时调用 `timingSafeEqual`；长度不同会在比较前拒绝。释放插件 fiber 时会同时释放该 guard。所需 guard 缺失或拒绝时，`WebServer` 在完整生命周期内保持 fail-closed。

## 模型体验

间接地，通过 `dsh-web-app`：此覆盖层将 `web-runtime.surfaceContext` 设为 `false`，移除其 `app:web-surface` prompt section 和受管理的 `DSH_WEB_URL` shell context。

#### KV Cache 影响

省去的 Web 表层字段使请求前缀不再包含该稳定上下文；此覆盖层不添加替代内容，也不会造成逐轮 cache 失效。

## 已知限制与延后工作

- **安装程序签名** — 桌面安装程序签名和发布来源证明仍在此覆盖层之外。
- **感知任务的后台生命周期** — 后台工作尚未与桌面窗口的任务生命周期协调。
