<template>
  <main class="preflight-page">
    <TaskHeader eyebrow="P0 · FLIGHT READINESS" title="准备飞行" description="按顺序确认设备、配置和安全状态。没有真实回报的项目不会被判定为通过。">
      <el-tag size="large" :type="evaluation.canTakeoff ? 'success' : 'danger'" effect="dark">{{ evaluation.summary }}</el-tag>
    </TaskHeader>
    <el-alert v-if="!online" type="warning" :closable="false" show-icon title="当前没有有效 HEARTBEAT，检查结果仅供参考，不能进入起飞状态。" />
    <section class="progress-card"><div class="progress-head"><strong>检查进度</strong><span>{{ passedCount }} / {{ evaluation.checks.length }} 通过</span></div><el-progress :percentage="progress" :status="evaluation.canTakeoff ? 'success' : undefined" /></section>
    <section class="check-list"><article v-for="item in evaluation.checks" :key="item.key" class="check-card" :class="`check-card--${item.status}`"><div class="check-icon">{{ icon(item.status) }}</div><div class="check-body"><div class="check-title"><strong>{{ item.label }}</strong><el-tag size="small" effect="plain" :type="levelType(item.level)">{{ levelLabel(item.level) }}</el-tag><el-tag size="small" effect="plain" :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag></div><p>{{ item.detail }}</p><small>{{ item.action }}</small></div><el-button v-if="item.route" size="small" plain @click="$router.push(item.route)">打开</el-button></article></section>
    <section class="report-actions"><el-button type="primary" @click="exportReport">导出起飞前检查报告</el-button><el-button plain @click="$router.push('/')">返回设备工作台</el-button></section>
  </main>
</template>
<script setup>
import { computed, inject } from 'vue'
import TaskHeader from './task-header.vue'
import { evaluatePreflight, preflightReport, CHECK_LEVEL } from '../utils/preflight-checks.js'
const mav = inject('mavlink')
const fc = inject('fcconfig')
const online = computed(() => mav.deviceState.phase === 'online' && mav.deviceState.heartbeat.healthy)
const evaluation = computed(() => evaluatePreflight({
  phase: mav.deviceState.phase,
  heartbeatHealthy: mav.deviceState.heartbeat.healthy,
  identityDetected: mav.deviceState.identity.detected,
  modelRecognized: mav.deviceState.identity.detected && mav.deviceState.identity.type != null && mav.deviceState.identity.autopilot != null,
  sysid: mav.deviceState.identity.sysid,
  compid: mav.deviceState.identity.compid,
  configLoaded: fc.loaded,
  configDirty: fc.hasChanges,
  configurationConfirmed: fc.loaded && !fc.hasChanges && !!fc.lastPullAt,
  sensorsReported: mav.deviceState.valid.sysStatus,
  sensorsHealthy: mav.deviceState.valid.sysStatus && ((mav.data.sysStatus.onboardControlSensorsHealth >>> 0) === (mav.data.sysStatus.onboardControlSensorsEnabled >>> 0)),
  sensorsAgeMs: mav.deviceState.freshness.sysStatus ? Date.now() - mav.deviceState.freshness.sysStatus : null,
  receiverReported: mav.deviceState.valid.rc,
  receiverHealthy: mav.deviceState.valid.rc && mav.data.rcChannels.chancount > 0 && mav.data.rcChannels.rssi !== 255,
  receiverAgeMs: mav.deviceState.freshness.rc ? Date.now() - mav.deviceState.freshness.rc : null,
  batteryReported: mav.deviceState.valid.battery,
  batteryHealthy: mav.deviceState.valid.battery && mav.data.battery.voltage > 0,
  batteryAgeMs: mav.deviceState.freshness.battery ? Date.now() - mav.deviceState.freshness.battery : null,
  armed: mav.vehicle.armed,
  motorOutputConfirmed: mav.deviceState.valid.servos && mav.data.servos.online,
}))
const passedCount = computed(() => evaluation.value.checks.filter((item) => item.status === 'pass').length)
const progress = computed(() => Math.round((passedCount.value / evaluation.value.checks.length) * 100))
const levelLabel = (level) => ({ [CHECK_LEVEL.BLOCK]: '阻断项', [CHECK_LEVEL.WARN]: '警告项', [CHECK_LEVEL.INFO]: '信息项' })[level]
const levelType = (level) => level === CHECK_LEVEL.BLOCK ? 'danger' : level === CHECK_LEVEL.WARN ? 'warning' : 'info'
const statusLabel = (status) => ({ pass: '通过', block: '未通过', unknown: '未验证' })[status] || status
const statusType = (status) => status === 'pass' ? 'success' : status === 'block' ? 'danger' : 'info'
const icon = (status) => status === 'pass' ? '✓' : status === 'block' ? '!' : '?'
function exportReport() {
  const snapshot = { phase: mav.deviceState.phase, heartbeatHealthy: mav.deviceState.heartbeat.healthy, identityDetected: mav.deviceState.identity.detected, modelRecognized: mav.deviceState.identity.detected && mav.deviceState.identity.type != null && mav.deviceState.identity.autopilot != null, sysid: mav.deviceState.identity.sysid, compid: mav.deviceState.identity.compid, configLoaded: fc.loaded, configurationConfirmed: fc.loaded && !fc.hasChanges && !!fc.lastPullAt, configDirty: fc.hasChanges, sensorsReported: mav.deviceState.valid.sysStatus, sensorsHealthy: mav.deviceState.valid.sysStatus, sensorsAgeMs: mav.deviceState.freshness.sysStatus ? Date.now() - mav.deviceState.freshness.sysStatus : null, receiverReported: mav.deviceState.valid.rc, receiverHealthy: mav.deviceState.valid.rc && mav.data.rcChannels.chancount > 0 && mav.data.rcChannels.rssi !== 255, receiverAgeMs: mav.deviceState.freshness.rc ? Date.now() - mav.deviceState.freshness.rc : null, batteryReported: mav.deviceState.valid.battery, batteryHealthy: mav.deviceState.valid.battery && mav.data.battery.voltage > 0, batteryAgeMs: mav.deviceState.freshness.battery ? Date.now() - mav.deviceState.freshness.battery : null, armed: mav.vehicle.armed, motorOutputConfirmed: mav.deviceState.valid.servos && mav.data.servos.online }
  const blob = new Blob([JSON.stringify(preflightReport(snapshot, evaluation.value), null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `fmt-preflight-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); URL.revokeObjectURL(url)
}
</script>
<style scoped>
.preflight-page{min-height:100%;padding:clamp(18px,4vw,48px);background:var(--dsh-canvas)}.preflight-hero{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;max-width:980px;margin:0 auto 16px;padding-bottom:18px;border-bottom:1px solid var(--dsh-border)}.eyebrow{margin:0 0 7px;color:var(--dsh-accent);font:11px monospace;letter-spacing:.13em}.preflight-hero h1{margin:0;font-size:34px}.preflight-hero p{color:var(--dsh-text-2);line-height:1.6}.progress-card,.check-list,.report-actions{max-width:980px;margin:0 auto}.progress-card{padding:14px 16px;margin-bottom:10px;border:1px solid var(--dsh-border);border-radius:8px;background:var(--dsh-surface)}.progress-head{display:flex;justify-content:space-between;margin-bottom:8px}.progress-head span{color:var(--dsh-text-3);font:12px monospace}.check-list{display:grid;gap:8px}.check-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--dsh-border);border-left:4px solid var(--dsh-placeholder);border-radius:7px;background:var(--dsh-surface)}.check-card--pass{border-left-color:var(--dsh-success)}.check-card--block{border-left-color:var(--dsh-danger-vivid)}.check-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--dsh-surface-2);font-weight:700}.check-card--pass .check-icon{background:var(--dsh-success);color:var(--dsh-ink-on-accent)}.check-card--block .check-icon{background:var(--dsh-danger-vivid);color:var(--dsh-ink-on-fill)}.check-body{flex:1}.check-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.check-title strong{margin-right:4px}.check-body p{margin:5px 0;color:var(--dsh-text-2)}.check-body small{color:var(--dsh-text-3)}.report-actions{display:flex;gap:8px;margin-top:14px}@media(max-width:650px){.preflight-hero{align-items:flex-start;flex-direction:column}.check-card{align-items:flex-start}.check-card>.el-button{align-self:center}}
</style>
