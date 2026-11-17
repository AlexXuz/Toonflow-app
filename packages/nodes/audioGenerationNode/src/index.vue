<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    :bottomVisible="node.selected"
    :bottomWidth="actions?.mode === 'speed' ? 440 : 660"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    :fullscreenVisible="false"
    style="width: 360px">
    <template #topActions>
      <el-button :icon="IconTextRecognition" :loading="transcribing" :disabled="busy || !outputFile" text title="音频转文本" aria-label="音频转文本" @click.stop="transcribe">转文本</el-button>
      <el-button v-if="transcribing" :icon="IconPlayerStop" text title="取消转文本" aria-label="取消转文本" @click.stop="cancelTranscription">取消</el-button>
      <el-button :icon="IconScissors" :disabled="busy || !previewUrl" text title="截取音频" aria-label="截取音频" @click.stop="actions?.open('clip')">截取</el-button>
      <el-button :icon="IconGauge" :disabled="busy || !previewUrl" text title="音频变速" aria-label="音频变速" @click.stop="actions?.open('speed')">变速</el-button>
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="busy" text title="替换音频" aria-label="替换音频" @click.stop="fileInput?.click()">替换音频</el-button>
      <input ref="fileInput" type="file" accept="audio/*" hidden aria-label="选择替换音频" :disabled="busy" @change="replaceOutput" />
    </template>
    <div v-loading="generating || uploading" class="audioContent nopan" :aria-busy="generating || uploading">
      <audioPlayer v-if="previewUrl" ref="player" v-model:pcmOptions="pcmOptions" class="audioPreview" :src="previewUrl" :mimeType="outputFile?.mimeType" @loadedmetadata="updateNodeInternals" />
      <div v-else class="audioEmpty" role="img" aria-label="暂无生成音频"><icon-music-bolt :size="48" stroke="1.25" aria-hidden="true" /></div>
    </div>
    <template #bottom>
      <div v-if="actions?.mode === 'speed'" ref="speedTarget" />
      <el-card v-else class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
        <promptInput v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" :materials="materialMentions" :selectMaterial="selectMaterialReference" :selectAsset="selectAssetReference" placeholder="描述您想要的音频效果或输入待朗读文本" expandable />
        <div class="promptFooter">
          <el-select
            :modelValue="selectedModel ? data.model : ''"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="busy"
            placeholder="选择模型"
            aria-label="音频生成模型"
            noDataText="请先在设置中添加音频模型"
            placement="top-start"
            @update:modelValue="selectModel"
            @visible-change="visible => visible && loadModels().catch(error => showNodeError(error, '模型读取失败'))">
            <template v-if="!selectedModel" #prefix><icon-music-bolt :size="17" /></template>
            <template #label="{ label }"><modelLabel :label="label" :providerId="selectedModel?.providerId" :modelId="selectedModel?.modelId" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="getNodeModelKey(item)">
                <modelLabel :label="item.label" :providerId="item.providerId" :modelId="item.modelId" />
              </el-option>
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:voice="data.voice"
            v-model:speed="data.speed"
            v-model:language="data.language"
            v-model:sampleRate="data.sampleRate"
            v-model:format="data.format"
            v-model:other="data.other"
            :model="selectedModel"
            :disabled="busy || !selectedModel" />
          <div class="generationActions">
            <mediaPrice v-if="generationInput" :input="{ ...generationInput, mediaType: 'audio' }" :supported="selectedModel?.supportsPrice === true" />
            <el-button v-if="pendingRecovery" class="sendButton" :icon="IconPlayerStop" :loading="cancelling" :disabled="deleting || uploading || transcribing || actions?.processing" title="放弃任务" aria-label="放弃任务" @click="generationState.cancel().catch(error => showNodeError(error, '停止生成失败'))" />
            <el-button
              class="sendButton"
              :icon="generating ? IconPlayerStop : IconArrowUp"
              :disabled="cancelling || deleting || uploading || transcribing || actions?.processing || (!generating && !pendingRecovery && (!generationPrompt || !selectedModel))"
              :title="generating ? '停止生成' : pendingRecovery ? '复查任务' : '生成音频'"
              :aria-label="generating ? '停止生成' : pendingRecovery ? '复查任务' : '生成音频'"
              @click="generating ? generationState.cancel().catch(error => showNodeError(error, '停止生成失败')) : startGeneration().catch(error => showNodeError(error, '音频生成失败'))" />
          </div>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <audioActions ref="actions" v-model:pcmOptions="pcmOptions" :file="outputFile" :src="previewUrl" :target="speedTarget" :disabled="generating || deleting || uploading || transcribing" @pause="player?.pause()" />
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from "vue";
import { ElButton, ElCard, ElLoading, ElOption, ElOptionGroup, ElSelect } from "element-plus";
import { IconArrowUp, IconGauge, IconMusicBolt, IconPlayerStop, IconScissors, IconTransfer, IconTextRecognition } from "@tabler/icons-vue";
import { findNodeModel, getNodeModelIdentity, getNodeModelKey, getTargetValues, isTypeCompatible, nodeSkeleton, nodeTools, useNode, useNodeModelSelection, z, type NodeAudioRequest, type NodeHandle, type NodeInputValue, type NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import modelLabel from "@toonflow/node-shared/modelLabel";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { useAudioTranscription } from "@toonflow/node-shared/useAudioTranscription";
import { getMediaMimeType } from "@toonflow/node-shared/mediaTypes";
import type { PcmOptions } from "@toonflow/node-shared/pcmPreview";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import { getModelFormValues, useModelForm } from "@toonflow/node-shared/useModelForm";
import audioPlayer from "@toonflow/node-audio/audioPlayer";
import audioActions from "@toonflow/node-audio/audioActions";
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import mediaPrice from "@toonflow/node-shared/mediaPrice";
import generationSettings from "./components/generationSettings.vue";
import { formatOptions, languageOptions, sampleRateOptions } from "./audioSettings";

defineOptions({
  inheritAttrs: false,
  icon: IconMusicBolt,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "AUDIO", "STRING"], label: "图片或音频限1个，文本不限" },
    { id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({ label: "音频生成", onModelsChanged: () => void refreshProviderModels() });
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; voice?: string; speed?: number; language: string; sampleRate: number; format: string; other: Record<string, unknown> });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.language ??= "zh-CN";
data.value.sampleRate ??= 24000;
data.value.format ??= "wav";
data.value.other ??= {};
const { refList, referenceMentions, materialMentions, selectMaterialReference, selectAssetReference, setReferencePreview, removeReference } = useNodeReferences();
const models = shallowRef<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const deleting = ref(false);
const fileInput = ref<HTMLInputElement>();
const player = ref<InstanceType<typeof audioPlayer>>();
const actions = ref<InstanceType<typeof audioActions>>();
const speedTarget = ref<HTMLElement>();
const outputFile = computed(() => outputs.value.audio?.dataType === "AUDIO" ? outputs.value.audio.value : undefined);
const pcmOptions = ref<Partial<PcmOptions>>({});
watch(() => outputFile.value?.url, () => { pcmOptions.value = {}; }, { flush: "sync" });
const { processing: transcribing, transcribe, cancel: cancelTranscription, cancelAndWait: cancelTranscriptionAndWait } = useAudioTranscription(outputFile);
let disposed = false;
let generationController: AbortController | undefined;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
let modelsRefreshPending = false;
const generationState = useNodeGeneration(outputs, () => generationController?.abort(), { ai });
const { generating, pendingRecovery, cancelling } = generationState;
const busy = computed(() => generating.value || uploading.value || deleting.value || transcribing.value || !!actions.value?.processing);
watch(busy, value => { if (!value && modelsRefreshPending) void refreshProviderModels(); });
const selectedModel = useNodeModelSelection(models, computed({ get: () => data.value.model, set: value => { data.value.model = value; } }));
useModelForm(data, selectedModel);
const voiceSchema = z.string().trim().min(1).max(256).nullable();
const speedSchema = z.number().finite().positive().nullable();
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() => [data.value.prompt.trim(), ...refList.value.flatMap((item, index) =>
  item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])].filter(Boolean).join("\n\n"));
const generationInput = computed<Omit<NodeAudioRequest, "directory"> | undefined>(() => {
  const choice = selectedModel.value;
  if (!choice) return;
  return {
    ...getNodeModelIdentity(choice),
    prompt: generationPrompt.value,
    voice: data.value.voice,
    speed: data.value.speed,
    language: data.value.language,
    sampleRate: data.value.sampleRate,
    format: data.value.format,
    other: Object.keys(data.value.other).length ? { ...data.value.other } : undefined,
    outputDirectory: `assets/${id}`,
    images: refList.value.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    audios: refList.value.flatMap(item => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
  };
});
const previewUrl = files.useFileUrl(outputFile, error => showNodeError(error, "音频读取失败"));

function selectModel(key: string) {
  if (key !== data.value.model) {
    data.value.voice = undefined;
    data.value.speed = undefined;
  }
  data.value.model = key;
}

function validateVoice(model: NodeMediaModel, voice?: string) {
  if (!voice) return;
  if (!voiceSchema.safeParse(voice).success || (model.voices?.length && !model.voices.some(item => item.voice === voice))) {
    throw new Error("请选择当前模型支持的音色，或使用模型默认音色");
  }
}

function speechSetting<T>(field: "voice" | "speed", value: T | undefined, schema: z.ZodType<T>, other: Record<string, unknown>, modelOptions: Record<string, unknown>) {
  // ACT: 兼容误放进 other 的标准字段；供应商已声明的同名自定义字段保留原语义。
  if (!Object.hasOwn(other, field) || Object.hasOwn(modelOptions, field)) return value;
  const parsed = schema.safeParse(other[field]);
  if (!parsed.success) throw new Error(`other.${field} 的值无效，请按 setConfig 的顶层 ${field} 参数填写`);
  if (value !== undefined && value !== parsed.data) throw new Error(`${field} 与 other.${field} 不一致，请只传一个值`);
  delete other[field];
  return parsed.data;
}

function referencesAllowed(values: NodeInputValue[]) {
  return values.filter(item => isTypeCompatible(item.dataType, ["IMAGE", "AUDIO"])).length <= 1;
}

nodeEvent.on("canConnect", (connection, context) => {
  // ACT: 重验已有连线时不重复计数；未产出内容的来源仍按声明类型占位。
  const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle
    || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
  return referencesAllowed(getTargetValues(id, "in", context.nodes, [...edges, connection]));
});

onMounted(() => {
  window.addEventListener("toonflow:plugin-installed", refreshProviderModels);
  window.addEventListener("toonflow:provider-config-changed", refreshProviderModels);
  void refreshProviderModels();
});
onScopeDispose(() => {
  disposed = true;
  window.removeEventListener("toonflow:plugin-installed", refreshProviderModels);
  window.removeEventListener("toonflow:provider-config-changed", refreshProviderModels);
  generationController?.abort();
});

async function refreshProviderModels(event?: Event) {
  if (event?.type === "toonflow:plugin-installed" && (event as CustomEvent<{ type?: string }>).detail?.type !== "provider") return;
  modelsRefreshPending = true;
  if (disposed || busy.value) return;
  try {
    await modelsRequest;
    if (disposed || busy.value) return;
    modelsRefreshPending = false;
    await loadModels();
  } catch (error) {
    if (!disposed) showNodeError(error, "模型读取失败");
  }
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then(items => {
    if (disposed) return;
    if (busy.value) {
      modelsRefreshPending = true;
      return;
    }
    models.value = items.filter(item => item.type === "audio");
    // ACT: 仅空配置选择默认模型，临时不可用的模型保持原选择，避免静默换供应商。
    if (!data.value.model) {
      const first = modelGroups.value[0]?.models[0];
      data.value.model = first ? getNodeModelKey(first) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration() {
  if (cancelling.value) throw new Error("任务正在取消，请稍后重试");
  if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后重试");
  if (pendingRecovery.value) {
    generation = generationState.resume().catch(error => showNodeError(error, "音频任务复查失败"));
    return { status: "generating" };
  }
  const input = generationInput.value;
  const choice = selectedModel.value;
  if (!input || !choice) throw new Error("请先选择音频模型");
  if (!generationPrompt.value) throw new Error("请输入生成提示词或待朗读文本");
  validateVoice(choice, input.voice);
  if (input.speed !== undefined && !speedSchema.safeParse(input.speed).success) throw new Error("语速必须为正数");
  if (!referencesAllowed(refList.value)) throw new Error("图片和音频不能同时引用，且合计最多引用一个；文本数量不限");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  if (!languageOptions.some(item => item.value === data.value.language) || !sampleRateOptions.includes(data.value.sampleRate) || !formatOptions.includes(data.value.format)) throw new Error("请重新选择有效的语种、采样率和输出格式");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  generationController = controller;
  generation = generationState.run(async () => {
    const { directory } = await workspace.list();
    controller.signal.throwIfAborted();
    const [result] = await generationState.generate("audio", { ...input, directory }, controller.signal);
    controller.signal.throwIfAborted();
    if (!result) throw new Error("供应商未返回音频");
    outputs.value.audio = { dataType: "AUDIO", value: { url: result.path, mimeType: result.mimeType } };
  }).catch(error => showNodeError(error, "音频生成失败")).finally(() => {
    generationController = undefined;
  });
  return { status: "generating" };
}

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value || disposed) return;
  const mimeType = getMediaMimeType(file);
  if (!mimeType.startsWith("audio/")) return void showNodeError("请选择音频文件", "音频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("音频不能为空且不能超过 100 MB", "音频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 替换不删除旧音频，保留复制节点与撤销记录的文件引用。
    outputs.value.audio = { dataType: "AUDIO", value: { url, mimeType } };
  } catch (error) {
    showNodeError(error, "音频替换失败");
  } finally {
    uploading.value = false;
  }
}

nodeEvent.on("save", reason => {
  if (uploading.value || (reason === "reload" && busy.value)) throw new Error("音频处理中，请完成或取消后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("音频正在替换，请稍后删除节点");
  deleting.value = true;
  try {
    await generationState.cancel(false);
    await Promise.all([generation, actions.value?.cancelAndWait(), cancelTranscriptionAndWait()]);
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

function getConfig() {
  const choice = selectedModel.value;
  return {
    config: {
      providerId: choice?.providerId ?? "", modelId: choice?.modelId ?? "", voice: data.value.voice ?? null,
      speed: data.value.speed ?? null, language: data.value.language, sampleRate: data.value.sampleRate,
      format: data.value.format, other: { ...data.value.other },
    },
    voices: choice?.voices ?? [],
    models: models.value,
    languages: languageOptions,
    sampleRates: sampleRateOptions,
    formats: formatOptions,
    inputLimits: { text: "unlimited", imageOrAudio: 1 },
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取音频节点设置和模型能力。voices 是当前模型列出的音色，config.voice 和 config.speed 为 null 时使用模型默认值。模型的 rules 只声明 other 中的自定义字段。模型相关的音色、语速和参考输入限制由供应商校验。",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});
nodeTools.register({
  name: "setConfig",
    description: "修改音频节点设置。先用 getConfig 查询能力，只传要改的字段。音色 voice 和语速 speed 是 args 的顶层参数，例如 {voice:'echo',speed:0.95}，null 恢复模型默认值。按目标模型的 voices 取音色，other 仅填模型 rules 声明的自定义字段。切换模型须同时传 providerId/modelId。只保存设置，不启动生成。",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
      voice: voiceSchema.optional(),
      speed: speedSchema.optional(),
    language: z.string().optional(),
    sampleRate: z.number().int().positive().optional(),
    format: z.string().optional(),
    other: z.record(z.string(), z.json()).optional(),
  }).refine(args => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value : findNodeModel(models.value, { providerId: args.providerId ?? "", modelId: args.modelId });
    if (!choice) throw new Error("请选择 getConfig 返回的有效音频模型");
    if (args.language !== undefined && !languageOptions.some(item => item.value === args.language)) throw new Error("请选择 getConfig 返回的有效语种");
    if (args.sampleRate !== undefined && !sampleRateOptions.includes(args.sampleRate)) throw new Error("请选择 getConfig 返回的有效采样率");
    if (args.format !== undefined && !formatOptions.includes(args.format)) throw new Error("请选择 getConfig 返回的有效输出格式");
      const sameModel = choice === selectedModel.value;
      const modelOptions = getModelFormValues(choice, sameModel ? data.value.other : {});
      const otherUpdates = { ...args.other };
      const voiceUpdate = speechSetting("voice", args.voice, voiceSchema, otherUpdates, modelOptions);
      const speedUpdate = speechSetting("speed", args.speed, speedSchema, otherUpdates, modelOptions);
      const voice = voiceUpdate === undefined && sameModel ? data.value.voice : voiceUpdate ?? undefined;
      const speed = speedUpdate === undefined && sameModel ? data.value.speed : speedUpdate ?? undefined;
      if (voiceUpdate !== undefined) validateVoice(choice, voice);
      const other = getModelFormValues(choice, modelOptions, otherUpdates);
    data.value.model = getNodeModelKey(choice);
      data.value.voice = voice;
      data.value.speed = speed;
    if (args.language !== undefined) data.value.language = args.language;
    if (args.sampleRate !== undefined) data.value.sampleRate = args.sampleRate;
    if (args.format !== undefined) data.value.format = args.format;
    data.value.other = other;
    return getConfig();
  },
});
nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的音频生成提示词或待朗读文本，仅接收 prompt，支持 {{ref 1}} 等参考标记；语种 language、采样率 sampleRate、格式 format 等配置须先用 node:getConfig 查询能力，再单独调用 node:setConfig；不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt }) {
    if (deleting.value || disposed) throw new Error("节点正在删除或已关闭，请稍后修改");
    data.value.prompt = prompt;
    data.value.promptModel = prompt.split("\n").map(text => [{ type: "Write", text }]);
    return { prompt };
  },
});
nodeTools.register({
  name: "generateAudio",
    description: "使用当前提示词、模型、音色、语速、语种、采样率、格式和可选参考图片或音频启动后台生成。图片与音频互斥且合计最多一个。立即返回已开始，用 getGenerationStatus 查询结果，cancelGeneration 停止。",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.audioContent {
  position: relative;
  min-height: 144px;
  display: flex;
  align-items: center;

  .nodeSkeleton.resized & {
    height: 100%;
    min-height: 0;
    align-items: flex-start;

    .audioEmpty { height: 100%; min-height: 0; }
  }

  .audioPreview { display: block; width: 100%; border-radius: var(--el-border-radius-base); }
  .audioEmpty { display: grid; place-items: center; width: 100%; min-height: 144px; color: var(--el-text-color-placeholder); }
  :deep(.el-loading-mask) { pointer-events: none; }
}
.promptCard {
  .promptFooter {
    display: flex;
    align-items: center;
    gap: 12px;

    .modelSelect {
      width: 280px;
      min-width: 0;
      &:deep(.el-select__wrapper) { gap: 6px; padding: 0; box-shadow: none; background: transparent; }
    }
    .generationActions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;

      .sendButton {
        width: 32px;
        height: 32px;
        margin-left: 0;
        padding: 0;
        --el-button-bg-color: var(--el-text-color-primary);
        --el-button-border-color: transparent;
        --el-button-text-color: var(--el-bg-color);
        --el-button-hover-bg-color: var(--el-text-color-regular);
        --el-button-hover-border-color: transparent;
        --el-button-hover-text-color: var(--el-bg-color);
      }
    }
  }
}
</style>
