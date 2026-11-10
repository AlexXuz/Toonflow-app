<template>
  <div class="about">
    <img :src="logoUrl" alt="Toonflow Logo" width="64" height="64" />
    <h3>Toonflow 本地版</h3>
    <p v-if="currentVersion">v{{ currentVersion }}</p>
    <p>项目、素材和设置保存在本服务器。AI 生成仅使用你自行配置的模型服务。</p>
    <p>已移除官方账号、云市场、遥测、广告和自动更新。</p>
    <p>原项目：HBAI-Ltd / Toonflow-app · MIT License</p>
  </div>
</template>

<script setup lang="ts">
import logoUrl from "@toonflow/assets/logo.svg";
const currentVersion = import.meta.env.appVersion;
</script>

<style scoped>
.about { display: grid; gap: 12px; line-height: 1.7; }
.about p, .about h3 { margin: 0; }
</style>
