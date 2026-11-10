import type { Channel } from "./types";

export function getChannel(): Channel {
  throw Object.assign(new Error("此部署仅使用本地功能和自定义 AI API，官方云服务已移除"), { status: 410 });
}
