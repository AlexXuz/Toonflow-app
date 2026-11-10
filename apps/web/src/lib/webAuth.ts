import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { ref } from "vue";
import { actualPlatform } from "./platform";

export const gatewayUser = ref("");
const nativeClient = actualPlatform.isDesktop || actualPlatform.isMobile;
let redirecting = false;
let sessionRequest: Promise<void> | undefined;

function isLoginRequired(data: unknown) {
  return !!data && typeof data === "object" && "error_code" in data && data.error_code === "loginRequired" && "code" in data && data.code === 401;
}

function redirectToLogin() {
  if (redirecting) return;
  redirecting = true;
  const next = window.location.pathname + window.location.search + window.location.hash;
  window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
}

async function handleLoginRequired(status: number, requestUrl: string, data: unknown) {
  if (nativeClient || redirecting || status !== 401) return;
  const url = new URL(requestUrl, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return;
  try {
    if (data instanceof Blob) data = await data.text();
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
    if (typeof data === "string") data = JSON.parse(data);
  } catch { return; }
  if (isLoginRequired(data)) redirectToLogin();
}

export function registerApiLogin(client: AxiosInstance) {
  if (nativeClient) return;
  const inspect = async (response: AxiosResponse) => {
    await handleLoginRequired(response.status, client.getUri(response.config), response.data);
  };
  client.interceptors.response.use(async response => {
    await inspect(response);
    return response;
  }, async error => {
    if (axios.isAxiosError(error) && error.response) await inspect(error.response);
    throw error;
  });
}

export function initializeWebAuth() {
  if (nativeClient) return;
  registerApiLogin(axios);
  const originalFetch = window.fetch.bind(window);
  // ACT: fetch 负责流式 API，Axios 负责普通及文件 API；仅识别本网关的登录错误码。
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (response.status === 401) {
      const data: unknown = await response.clone().json().catch(() => undefined);
      await handleLoginRequired(response.status, input instanceof Request ? input.url : String(input), data);
    }
    return response;
  }, window.fetch);
  void refreshWebSession();
}

export function refreshWebSession() {
  if (nativeClient || redirecting || sessionRequest) return sessionRequest;
  sessionRequest = fetch("/auth/session", { cache: "no-store", credentials: "same-origin" }).then(async response => {
    const session: unknown = await response.json();
    if (!session || typeof session !== "object" || !("authenticated" in session)) return;
    if (response.status === 200 && session.authenticated === true && "user" in session && typeof session.user === "string" && session.user.trim()) {
      gatewayUser.value = session.user;
    } else if (response.status === 401 && session.authenticated === false && isLoginRequired(session)) {
      gatewayUser.value = "";
      redirectToLogin();
    }
  }).catch(() => { /* 断网或未配置网页登录网关时不触发登录跳转。 */ }).finally(() => { sessionRequest = undefined; });
  return sessionRequest;
}

export async function logoutWebSession() {
  const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error("退出登录失败，请重试");
  gatewayUser.value = "";
  window.location.assign("/auth/login");
}
