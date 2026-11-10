import { Router } from "express";
import { success } from "@/lib/responseFormat";

// ACT: 本地部署的身份验证统一由 HTTPS 入口负责，不启动另一套公开账号服务。
export default Router().get("/", (_req, res) => {
  res.set("Cache-Control", "no-store").json(success({ user: null, enabled: false, publicWeb: false, host: false, registrationEnabled: false }));
});
