<template>
  <div class="ffmpegPanel">
    <div class="statusHeader"><h3>FFmpeg</h3><el-button :loading="loading" @click="refreshStatus">重新检测</el-button></div>
    <p>使用本服务器安装的 FFmpeg 和 ffprobe。若缺失，请由服务器管理员安装后重试。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-for="name in toolNames" :key="name" class="toolStatus">
      <strong>{{ name }}</strong>
      <p>{{ status?.tools[name].version || status?.tools[name].error || '尚未检测' }}</p>
      <code v-if="status?.tools[name].path">{{ status.tools[name].path }}</code>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import axios from "axios";
const props = withDefaults(defineProps<{ visible?: boolean }>(), { visible: true });
const toolNames = ["ffmpeg", "ffprobe"] as const;
type ToolStatus = { path: string | null; version: string | null; error: string | null };
const status = ref<{ tools: Record<typeof toolNames[number], ToolStatus> }>();
const loading = ref(false);
const error = ref("");
let controller: AbortController | undefined;
async function refreshStatus() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  loading.value = true;
  error.value = "";
  try {
    const { data } = await axios.get("/api/ffmpeg/status", { headers: { "x-toonflow-workspace": "1" }, signal: request.signal });
    if (data.code !== 200) throw new Error(data.message || "读取 FFmpeg 状态失败");
    if (!request.signal.aborted) status.value = data.data;
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : "读取 FFmpeg 状态失败";
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}
watch(() => props.visible, visible => { if (visible) void refreshStatus(); else controller?.abort(); }, { immediate: true });
onBeforeUnmount(() => controller?.abort());
</script>

<style scoped>
.ffmpegPanel { line-height: 1.7; }
.statusHeader { display: flex; align-items: center; justify-content: space-between; }
.toolStatus { margin-top: 16px; overflow-wrap: anywhere; }
</style>
