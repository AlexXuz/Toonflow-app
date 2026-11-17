import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { type KnownApi, type Model, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { defaultThinkingLevels, thinkingLevels, type ThinkingLevel } from "@/lib/modelReasoning";
import conf from "@/utils/conf";
import { findModelContextLimits } from "@/utils/ai/modelContextLimits";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { z } from "zod";

export const providerHeadersSchema = z.record(
  z.string().refine(name => {
    try { validateHeaderName(name); return true; } catch { return false; }
  }, "请求头名称无效"),
  z.string().refine(value => {
    try { validateHeaderValue("header", value); return true; } catch { return false; }
  }, "请求头值包含无效字符"),
).refine(headers => new Set(Object.keys(headers).map(name => name.toLowerCase())).size === Object.keys(headers).length,
  "请求头名称不能重复（不区分大小写）");

export function getProviderBaseUrl(apiUrl: string, protocol: string) {
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  // Anthropic SDK 自带 /v1/messages；兼容旧配置中的 /v1，同时保留网关路径前缀。
  if (protocol === "anthropic-messages") url.pathname = url.pathname.replace(/\/v1$/, "") || "/";
  else if (url.pathname === "/") url.pathname = "/v1";
  return url.href.replace(/\/+$/, "");
}

export const reasoningEffortsSchema = z.union([
  z.literal(false),
  z.partialRecord(z.enum(thinkingLevels), z.string().min(1).refine(value => value.trim() === value, "接口值不能包含首尾空白").nullable())
    .refine(value => Object.entries(value).every(([level, wire]) => level === "off" || typeof wire === "string"), "仅关闭档位可省略接口值")
    .refine(value => Object.keys(value).some(level => level !== "off"), "请至少声明一个推理档位"),
]);

export const providerSchema = z.object({
  apiUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.string(),
  headers: providerHeadersSchema.optional(),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  maxRequestImageBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxRequestBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  models: z.array(z.object({
    id: z.string(), label: z.string(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoningEfforts: reasoningEffortsSchema.optional(),
  })),
});

export const accountProviderSchema = providerSchema.extend({
  id: z.enum(["Toonflow", "toonflow"]), label: z.string().min(1), apiKey: z.literal(""),
  token: z.string().trim().min(1).max(16384).optional(),
  icon: z.string().optional(), version: z.string().optional(),
});

export function getAccountToken() {
  return "";
}

export function getAccountProvider(): (z.infer<typeof accountProviderSchema> & { apiKey: string }) | undefined {
  return undefined;
}

export function getConfiguredProviders() {
  const providers = conf.get("settings", {}).customProviders;
  const account = getAccountProvider();
  return [...(account ? [account] : []), ...(Array.isArray(providers) ? providers.filter(item => typeof item?.id !== "string" || item.id.toLowerCase() !== "toonflow") : [])];
}

const builtinModels: Model<KnownApi>[] = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider));

export function applyModelRequestCompatibility(payload: unknown, protocol: string, thinkingLevel?: ThinkingLevel) {
  if (!payload || typeof payload !== "object" || (thinkingLevel !== undefined && thinkingLevel !== "off")) return;
  const body = payload as Record<string, unknown>;
  // ACT: SDK 的内部 off 同时承载默认与关闭；最终请求按用户选择区分，不能按模型名强制覆盖。
  if (thinkingLevel === "off" && protocol === "openai-completions") {
    // ACT: 已知兼容协议由 SDK 生成原生关闭格式；标准 OpenAI 或未知模型补齐明确 none。
    if (!["thinking", "enable_thinking", "chat_template_kwargs", "chat_template_args", "reasoning"].some(key => Object.hasOwn(body, key))) {
      body.reasoning_effort = "none";
    }
    return;
  }
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinking;
  delete body.enable_thinking;
  delete body.thinking_token_budget;
  delete body.thinking_budget;
  delete body.thinking_budget_tokens;
  delete body.chat_template_kwargs;
  delete body.chat_template_args;
  if (body.output_config && typeof body.output_config === "object") {
    const output = { ...body.output_config } as Record<string, unknown>;
    delete output.effort;
    if (Object.keys(output).length) body.output_config = output;
    else delete body.output_config;
  }
  if (thinkingLevel !== "off") return;
  if (protocol === "openai-responses") body.reasoning = { effort: "none" };
  else if (protocol === "anthropic-messages") body.thinking = { type: "disabled" };
}

export function getModelReasoning(providerId: string, model: z.infer<typeof providerSchema>["models"][number], protocol: string) {
  const matches = builtinModels.filter(item => item.id === model.id);
  const base = matches.find(item => item.provider.toLowerCase() === providerId.toLowerCase() && item.api === protocol);
  const candidates = base ? [base] : matches;
  const efforts = model.reasoningEfforts;
  // ACT: 统一提供关闭与低中高，不用本地目录过滤中转站模型；实际能力由配置的接口校验。
  const reasoningLevels: ThinkingLevel[] = [...defaultThinkingLevels];
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const level of thinkingLevels) {
    if (!reasoningLevels.includes(level)) { thinkingLevelMap[level] = null; continue; }
    const inherited = candidates[0]?.thinkingLevelMap?.[level];
    const common = candidates.every(item => item.thinkingLevelMap?.[level] === inherited) ? inherited : undefined;
    thinkingLevelMap[level] = level === "off" ? "none" : (efforts && efforts[level]) || (efforts === false ? undefined : common) || level;
  }
  // ACT: 显式接口值声明使用 Anthropic effort 协议，避免 SDK 将映射值改为 token 预算。
  const compat = protocol === "anthropic-messages" && efforts
    ? { ...base?.compat, forceAdaptiveThinking: true, supportsMidConvoEffort: false }
    : protocol === "openai-completions" ? { ...base?.compat, supportsReasoningEffort: true } : base?.compat;
  return { reasoning: true, thinkingLevelMap, reasoningLevels, compat };
}

export function getModelLimits(providerId: string, model: z.infer<typeof providerSchema>["models"][number]) {
  const limits = findModelContextLimits(model.id);
  if (limits) return { contextWindow: limits.contextWindow, maxTokens: limits.maxTokens };
  if (model.contextWindow != null && model.maxOutputTokens != null) {
    return { contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens };
  }
  const matches = builtinModels.filter(item => item.id === model.id);
  const exact = matches.find(item => item.provider === providerId);
  const candidates = exact ? [exact] : matches;
  // ACT: 只精确匹配 ID；跨供应商同名参数逐项一致才采用，不猜别名。
  const contextWindow = candidates.every(item => item.contextWindow === candidates[0]?.contextWindow) ? candidates[0]?.contextWindow : undefined;
  const maxTokens = candidates.every(item => item.maxTokens === candidates[0]?.maxTokens) ? candidates[0]?.maxTokens : undefined;
  return {
    contextWindow: model.contextWindow ?? contextWindow ?? 262144,
    maxTokens: model.maxOutputTokens ?? maxTokens ?? 32768,
  };
}
