<template>
  <main class="flight-log-page">
    <section class="flight-log-card">
      <p class="eyebrow">FMT · 飞行日志</p>
      <h1>飞行日志</h1>
      <p class="lead">使用 FMT-FlightLog 分析飞行日志。下载原始日志后，在外部工具中导入并查看记录。</p>
      <div class="log-boundary">
        <span class="boundary-label">外部日志系统</span>
        <code>{{ FLIGHT_LOG_URL }}</code>
      </div>
      <div class="actions">
        <el-button type="primary" tag="a" :href="FLIGHT_LOG_URL" target="_blank" rel="noopener noreferrer">打开 FMT-FlightLog</el-button>
        <el-button plain @click="copyLink">复制日志系统地址</el-button>
      </div>
      <el-alert type="info" :closable="false" show-icon title="使用说明" description="请先在 FGC 的文件页下载原始日志，再打开 FMT-FlightLog 手动导入。文件不会自动传送到外部页面。" />
    </section>
  </main>
</template>

<script setup>
import { ElMessage } from 'element-plus'

const FLIGHT_LOG_URL = 'https://pan-chenliang.github.io/FMT-FlightLog/'

async function copyLink() {
  try {
    await navigator.clipboard.writeText(FLIGHT_LOG_URL)
    ElMessage.success('日志系统地址已复制')
  } catch {
    ElMessage.warning(FLIGHT_LOG_URL)
  }
}
</script>

<style scoped>
.flight-log-page{min-height:100%;padding:clamp(18px,4vw,48px);background:var(--dsh-canvas)}.flight-log-card{max-width:820px;margin:0 auto;padding:28px;border:1px solid var(--dsh-border);border-radius:8px;background:var(--dsh-surface)}.eyebrow{margin:0 0 8px;color:var(--dsh-accent);font:11px monospace;letter-spacing:.14em}.flight-log-card h1{margin:0;font-size:34px}.lead{max-width:680px;color:var(--dsh-text-2);line-height:1.7}.log-boundary{display:flex;flex-direction:column;gap:7px;margin:22px 0;padding:14px;border:1px dashed var(--dsh-border-strong);border-radius:6px;background:var(--dsh-surface-2)}.boundary-label{color:var(--dsh-text-3);font-size:12px}.log-boundary code{color:var(--dsh-accent);word-break:break-all}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
</style>
