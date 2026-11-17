# 本地存储部署

此分支基于 AlexXuz/Toonflow-app fork。项目、素材、插件和设置保存在部署服务器；自行配置的 AI 模型 API 仍允许联网。它不是完全离线版本。

移除了官方云账号/验证码/钱包/充值/模型渠道、官方插件市场和社区路由、首页广告、赞助推广、遥测上报和自动更新。保留自定义文本和媒体供应商、本地插件导入、项目画布与素材编辑。URL 插件安装、URL 供应商代码导入、外部 FFmpeg 下载和固定百度/阿里 DNS 探测已取消；FFmpeg 使用系统安装版。独立构建不携带网页搜索、网页抓取、浏览器和自动下载 SDK 的工具插件。供应商生成助手不抓取文档网页；用户粘贴文档内容或请求示例后，仍可调用自行配置的文本模型生成代码。本地文件导入与粘贴供应商代码保留。

设备互联和多租户公开监听不启动，对应启用接口已移除，避免绕过统一认证入口。保留的 multiTenant/user/session 接口只说明当前独立模式，不负责验证密码。

## 构建和运行

需要 Bun 1.4.3；系统安装 FFmpeg/ffprobe。原生文档解析依赖缺少 Linux 版本时会回退到随包 WASM。Node.js 供部分插件使用。

```sh
bun install --frozen-lockfile --registry https://registry.npmjs.org
bun run --cwd apps/server routes
bun run build:server
TOONFLOW_SERVER_HOST=127.0.0.1 \
TOONFLOW_SERVER_PORT=3000 \
TOONFLOW_PUBLIC_ORIGIN=https://toonflow.alexych.asia \
TOONFLOW_DATA_DIR=/var/lib/toonflow \
NODE_ENV=production bun build/server/index.js
```

部署完整 build 目录。数据目录与发行目录分离，并由运行服务的专用用户持有。仅单进程访问同一数据目录。

全部页面、HTTP API、SSE 和媒体下载必须位于 HTTPS 认证反向代理后面；公网 /mcp 与 /a2a 入口禁用；后端仅绑定回环地址。账号和密码哈希由独立登录服务的受限配置文件管理，禁止写入本仓库。代理保留原 Host，设置 X-Forwarded-Proto；服务器只信任回环代理，并严格匹配 TOONFLOW_PUBLIC_ORIGIN 才允许通过外部域名管理本地工作区和插件。不要把后端端口映射至公网。

网页使用独立的 Cookie 登录网关，由 Caddy forward_auth 验证会话。共享网关实现位于 [huobao-drama fork 的 deployment/webAuth](https://github.com/AlexXuz/huobao-drama/tree/alex/seoul-local-auth/deployment/webAuth)，其中不包含账号密码或会话秘密。网关提供 /auth/login、GET /auth/session 和 POST /auth/logout；会话接口返回 `{ authenticated: true, user: "账号名" }` 时，设置底部显示“退出登录”。未登录 API 返回 HTTP 401 和 `{ code: 401, error_code: "loginRequired", message: "请先登录" }`，前端才跳转登录页并携带当前相对页面地址。原生 SSE 断线时仅探测会话接口，须同时返回 HTTP 401、`authenticated: false` 和上述错误码才跳转；普通断网不跳转。模型 API 的普通 401 不触发登录跳转。桌面端和没有此网关的部署不显示网页登录退出入口。

当前部署通过 systemd 仅允许主服务 3000 和 MCP 内部 10588 端口，两者均监听 127.0.0.1。MCP 功能默认关闭，但初始化仍会建立本机 10588 监听；不要将其暴露至公网。运行用户只授予自身数据目录写权限。

所有文字模型统一提供“关闭、默认、低、中、高”，不再按本地模型目录或 Luna 特例过滤选项。关闭会按协议显式发送标准 Chat Completions 的 `reasoning_effort: "none"`、Responses 的 `reasoning: { effort: "none" }` 或 Anthropic 的 `thinking: { type: "disabled" }`；已知兼容供应商沿用 SDK 对应的原生关闭格式。默认不发送思考或强度参数，由上游决定。低中高保留已有接口映射，历史 minimal 归入低，xhigh/max 归入高。普通对话、子 Agent、临时助手和上下文摘要使用同一请求处理，未提供强度选择的文本节点使用默认。接口若不支持关闭或某个强度，原错误会返回，不静默换档。Luna 的 Chat Completions 工具调用若仍要求关闭，请在选择器明确选“关闭”。
