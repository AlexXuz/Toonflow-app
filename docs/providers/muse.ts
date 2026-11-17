/// <reference path="../../packages/providers/types.d.ts" />
// ToonFlow 自定义媒体供应商；在设置的媒体模型中导入本文件。
// 密钥只填写在配置表单中；修改已有供应商时保留 muse ID。

const rules = [
  { type: "input", field: "apiKey", title: "API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl", title: "请求地址", value: "https://alexych.asia/muse/v1", props: { placeholder: "https://alexych.asia/muse/v1" } },
] as const;

type MuseVideoRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};
type MuseTask = { id?: string; status?: string; result?: { url?: string }; error?: unknown };
const pollTimeout = 15 * 60_000;

function apiBase(value: string) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("请求地址需为 HTTP(S) 网关地址，不要包含密钥、查询参数或片段");
  }
  // 根地址和以 /v1 结尾的地址都可填写，保留 /muse 等部署子路径。
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/(?:\/v1)+$/, "") + "/v1";
  return url.href.replace(/\/$/, "");
}

function mediaUrl(input: MediaInput) {
  if (input.type === "url") {
    if (!/^(https?:\/\/|data:)/i.test(input.url.trim())) throw new Error("参考素材必须是 HTTP(S) 地址或 Data URL，不能使用本地文件路径");
    return input.url.trim();
  }
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  if (!data) throw new Error("参考素材为空，请重新选择素材");
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function videoPrompt(request: MuseVideoRequest) {
  return request.prompt.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    if (!reference) throw new Error(`引用标记 ${marker} 缺少素材映射，请更新 ToonFlow 后重新选择引用`);
    if (reference.type === "text") return `参考 ${Number(number)}`;
    if (!("index" in reference)) throw new Error("Muse 不支持首尾帧强约束，请将素材作为普通参考图引用");
    const media = { image: request.images, video: request.videos, audio: request.audios };
    if (!Number.isSafeInteger(reference.index) || reference.index < 0 || !media[reference.type]?.[reference.index]) {
      throw new Error(`引用标记 ${marker} 对应的素材未提交，请重新选择引用`);
    }
    const labels = { image: "图", video: "视频", audio: "音频" };
    return `[${labels[reference.type]}${reference.index + 1}]`;
  });
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function requestSignal(context: ProviderContext, timeout: number) {
  return AbortSignal.any([AbortSignal.timeout(timeout), ...(context.signal ? [context.signal] : [])]);
}

async function responseData(context: ProviderContext, response: Response, operation: string): Promise<MuseTask> {
  const body = await response.text();
  let data: unknown;
  try { data = JSON.parse(body); }
  catch { throw new Error(`${operation}失败：HTTP ${response.status}，网关返回非 JSON 内容，请检查请求地址`); }
  if (!response.ok) {
    const detail = context.tool.errorMessage(data);
    throw new Error(`${operation}失败：HTTP ${response.status}${detail ? `，${detail}` : ""}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${operation}返回格式无效`);
  return data as MuseTask;
}

function resultUrl(value: string, baseUrl: string) {
  const base = new URL(baseUrl);
  // 兼容旧网关返回的 /v1/media/...，不能丢掉部署子路径 /muse。
  const url = value.startsWith("/v1/")
    ? new URL(base.pathname.replace(/\/v1$/, "") + value, base.origin)
    : new URL(value, `${baseUrl}/`);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Muse 返回的视频地址不是 HTTP(S) 地址");
  return url.href;
}

async function pollVideo(context: ProviderContext, baseUrl: string, apiKey: string, taskId: string): Promise<MediaAsset[]> {
  const signal = requestSignal(context, pollTimeout);
  try {
    while (true) {
      let data: MuseTask;
      try {
        const response = await context.tool.fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          await wait(signal, 5000);
          continue;
        }
        data = await responseData(context, response, "查询任务");
      } catch (error) {
        signal.throwIfAborted();
        // 查询断线只重查原任务，绝不重新 POST 生成。
        const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
        if (!["TypeError", "TimeoutError", "AbortError"].includes(name)) throw error;
        await wait(signal, 5000);
        continue;
      }
      if (data.status === "completed" || data.status === "succeeded") {
        if (!data.result?.url) throw new Error(`任务 ${taskId} 已完成但未返回视频地址，请查询原任务`);
        return [{ mediaType: "video", type: "url", url: resultUrl(data.result.url, baseUrl) }];
      }
      if (data.status === "failed" || data.status === "cancelled") {
        throw Object.assign(new Error(context.tool.errorMessage(data) || `Muse 视频任务 ${data.status}`), { code: "MEDIA_TASK_FAILED" });
      }
      if (!["queued", "processing", "pending", "running"].includes(data.status ?? "")) {
        throw new Error(`任务 ${taskId} 返回未知状态，请查询原任务，不要重复提交`);
      }
      await wait(signal, 5000);
    }
  } catch (error) {
    if (signal.aborted && !context.signal?.aborted) throw new Error(`等待任务 ${taskId} 超时，请恢复查询原任务；未重新提交生成`);
    throw error;
  }
}

export default {
  id: "muse",
  label: "Muse 视频",
  version: "2.2.1",
  readme: "Muse2API 异步视频适配器。请求地址可填写服务根地址或以 /v1 结尾的 Base URL。API Key 在配置表单填写。\n\n支持纯文字，以及图片、视频、音频参考，合计最多 10 个；保持素材顺序，超限会明确提示。引用标记自动转换为 [图1]、[视频1]、[音频1]。本地素材以 Data URL 发送。\n\n画布的「视频生成设置」可选目标时长 3、4、5、6、8、10 秒，默认 6 秒。时长、比例、分辨率作为生成提示，实际结果由 Muse 决定。提交后保存任务编号，最多等待 15 分钟；恢复和查询重试只查询原任务，不重复生成。",
  rules,
  models: [{
    id: "muse-video",
    label: "muse-video",
    type: "video",
    mode: ["text", ["imageReference:10", "videoReference:10", "audioReference:10"]],
    defaultDuration: 6,
    durationResolutionMap: [{ duration: [3, 4, 5, 6, 8, 10], resolution: [] }],
  }],
  async generateVideo(request: MuseVideoRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const baseUrl = apiBase(this.config.baseUrl);
    if (request.model !== "muse-video") throw new Error("此供应商仅支持 muse-video");
    if (!request.prompt.trim()) throw new Error("请填写视频提示词");
    if (request.firstFrame || request.lastFrame) throw new Error("Muse 不支持首尾帧强约束，请将素材作为普通参考图引用");
    const count = (request.images?.length ?? 0) + (request.videos?.length ?? 0) + (request.audios?.length ?? 0);
    if (count > 10) throw new Error(`Muse 最多支持 10 个参考素材，当前 ${count} 个；请调整引用`);
    if (request.duration !== undefined && (!Number.isSafeInteger(request.duration) || request.duration <= 0)) {
      throw new Error("Muse 视频时长必须为正整数秒");
    }
    const body = {
      model: request.model,
      prompt: videoPrompt(request),
      images: request.images?.map(mediaUrl), videos: request.videos?.map(mediaUrl), audios: request.audios?.map(mediaUrl),
      duration: request.duration, aspect_ratio: request.ratio, resolution: request.resolution,
    };
    // POST 不自动重试，避免在接单结果不明时额外计费。
    const response = await this.tool.fetch(`${baseUrl}/videos`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: requestSignal(this, 60_000),
    });
    const data = await responseData(this, response, "提交任务");
    if (typeof data.id !== "string" || !data.id.trim()) throw new Error("提交任务未返回任务编号，请先检查 Muse 任务记录，不要直接重复提交");
    await this.saveTaskData?.({ kind: "video", taskId: data.id, model: request.model, baseUrlHash: String(this.tool.hash(baseUrl)), deadline: Date.now() + pollTimeout });
    return pollVideo(this, baseUrl, apiKey, data.id);
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const baseUrl = apiBase(this.config.baseUrl);
    const hashes = [baseUrl, this.config.baseUrl.trim().replace(/\/$/, "")].map(value => String(this.tool.hash(value)));
    if (data.kind !== "video" || data.model !== "muse-video" || typeof data.taskId !== "string" || !data.taskId.trim()
      || typeof data.baseUrlHash !== "string" || !hashes.includes(data.baseUrlHash)) {
      throw new Error("视频任务恢复数据无效或请求地址已变更");
    }
    return pollVideo(this, baseUrl, apiKey, data.taskId);
  },
} satisfies ProviderDefinition<typeof rules>;
