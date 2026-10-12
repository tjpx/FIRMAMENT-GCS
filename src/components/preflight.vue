<template>
  <main class="preflight-page">
    <TaskHeader eyebrow="P0 · FLIGHT READINESS" title="准备飞行" description="按顺序确认设备、配置和安全状态。没有真实回报的项目不会被判定为通过。">
      <el-tag size="large" :type="evaluation.canTakeoff ? 'success' : 'danger'" effect="dark">{{ evaluation.summary }}</el-tag>
    </TaskHeader>
    <el-alert v-if="!online" type="warning" :closable="false" show-icon title="当前没有有效 HEARTBEAT，检查结果仅供参考，不能进入起飞状态。" />
    <section class="progress-card"><div class="progress-head"><strong>检查进度</strong><span>{{ passedCount }} / {{ evaluation.checks.length }} 通过</span></div><el-progress :percentage="progress" :status="evaluation.canTakeoff ? 'success' : undefined" /></section>
    <section class="check-list"><article v-for="item in evaluation.checks" :key="item.key" class="check-card" :class="`check-card--${item.status}`"><div class="check-icon">{{ icon(item.status) }}</div><div class="check-body"><div class="check-title"><strong>{{ item.label }}</strong><el-tag size="small" effect="plain" :type="levelType(item.level)">{{ levelLabel(item.level) }}</el-tag><el-tag size="small" effect="plain" :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag></div><p>{{ item.detail }}</p><small>{{ item.action }}</small></div><el-button v-if="item.route" size="small" plain @click="$router.push(item.route)">打开</el-button><el-button v-if="item.key === 'calibration'" size="small" type="primary" plain :loading="calibrationBusy" :disabled="calibrationBlocked" @click="readCalibration()">{{ calibrationEvidence ? '重新校验' : '校验校准' }}</el-button></article></section>

    <!-- 校准证据：原样列出读回的值与出厂默认值，页面不替飞控下结论 -->
    <section class="evidence-card">
      <div class="evidence-head">
        <strong>传感器校准证据（CALIB 参数组）</strong>
        <el-tag v-if="!calibrationEvidence" size="small" effect="plain" type="info">{{ online ? '正在自动校验' : '未读取' }}</el-tag>
        <el-tag v-else-if="!calibrationEvidence.complete" size="small" effect="plain" type="warning">读回不完整</el-tag>
        <el-tag v-else-if="calibrationStale" size="small" effect="plain" type="warning">读数已过期</el-tag>
        <el-tag v-else size="small" effect="plain" :type="calibrationEvidence.verified ? 'success' : 'danger'">{{ calibrationEvidence.verified ? '四类校准都有证据' : `缺少${calibrationEvidence.missingCalibrationLabels.join('、')}` }}</el-tag>
        <el-button size="small" plain :loading="calibrationBusy" :disabled="calibrationBlocked" @click="readCalibration()">立即重新校验</el-button>
        <span v-if="calibrationAgeLabel" class="evidence-age">读数时间：{{ calibrationAgeLabel }}</span>
      </div>
      <p>{{ calibrationSummary }}</p>
      <div class="calib-tiles">
        <div v-for="g in calibrationGroups" :key="g.key" class="calib-tile" :class="`calib-tile--${g.state}`">
          <span class="calib-name">{{ g.label }}</span>
          <span class="calib-state">{{ g.state === 'unknown' ? '未验证' : g.state === 'done' ? '查到位' : '无证据' }}</span>
          <span class="calib-count dsh-num">{{ g.read }}/{{ g.total }} 项 · 偏离默认 {{ g.changed }}</span>
        </div>
      </div>
      <p class="evidence-note">通过条件是<b>陀螺仪、加速度计、罗盘、水平四类各自都有偏离出厂默认的字段</b>（<code>GYRO0_*OFF</code>、<code>ACC0_*</code>、<code>MAG0_*</code>、<code>LEVEL_XOFF/YOFF</code>；默认值全部为 0，对角缩放为 1）。打开本页会在链路就绪时自动校验一次，读数超过 5 分钟会要求重新校验。</p>
      <p class="evidence-note">全部等于默认值只说明查不到这类校准写入的证据（可能从未校准，也可能被 <code>param restore</code> 或重刷固件抹掉）；有字段偏离默认值也只说明这些参数曾被写入，不证明当次校准的几何与水平方向正确，更不能替代现场检查与试飞前的人工确认。固件按 6 位小数落盘，零偏小于 5e-7 会被写成 0.000000，这种极端情况同样会判成「无证据」。</p>
      <p class="evidence-note">遥测、SYS_STATUS 的 health 位和 <code>[cal]</code> 播报都不能作为校准判据：固件把 health 恒写成 <code>enabled | present | PREARM_CHECK</code>（task_comm.c:253），而与校准有关的 <code>SENSOR_*_UNCALI / NEED_CALI</code> 播报（mavlink_status.h:91-105）定义了却从未发送；<code>[cal] calibration done</code> 只代表本次会话跑完过一次，重启后不保留。</p>
      <div v-if="calibrationEvidence" class="field-groups">
        <div v-for="g in calibrationFieldGroups" :key="`fields-${g.key}`" class="field-group">
          <div class="field-group-head"><span>{{ g.label }}</span><span>{{ g.read }}/{{ g.total }} 项</span></div>
          <div class="evidence-grid">
            <div v-for="f in g.fields" :key="f.name" class="evidence-row" :class="{ 'evidence-row--changed': f.changed === true, 'evidence-row--missing': f.changed === null }">
              <span class="evidence-name">{{ f.name }}</span>
              <span class="evidence-value dsh-num">{{ f.text }}</span>
              <span class="evidence-default">默认 {{ f.defaultText }}</span>
              <span class="evidence-flag">{{ f.changed === null ? '未读到' : f.changed ? '偏离默认' : '等于默认' }}</span>
            </div>
          </div>
        </div>
      </div>
      <p v-if="calibrationError" class="evidence-note">读取错误：{{ calibrationError }}</p>
      <p class="evidence-note">读取方式：按名字逐个请求（PARAM_REQUEST_READ）；飞控未回包的字段保持「未读到」，不会当成默认值。</p>
    </section>

    <section class="report-actions"><el-button type="primary" @click="exportReport">导出起飞前检查报告</el-button><el-button plain @click="$router.push('/')">返回设备工作台</el-button></section>
  </main>
</template>
<script setup>
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import TaskHeader from './task-header.vue'
import { evaluatePreflight, preflightReport, CHECK_LEVEL, CALIBRATION_EVIDENCE_TTL_MS } from '../utils/preflight-checks.js'
import { CALIBRATION_FIELDS, CALIBRATION_SENSORS, CALIBRATION_SENSOR_LABEL, calibrationFieldLines, calibrationReadSummary, evaluateCalibrationRead } from '../utils/calibration-read.js'
const mav = inject('mavlink')
const fc = inject('fcconfig')
const online = computed(() => mav.deviceState.phase === 'online' && mav.deviceState.heartbeat.healthy)

/* 校准证据：本页唯一的「校准过没有」判据。
   只认按名字读回的 CALIB 参数（固件 param_get_by_name 用裸名匹配，见 calibration-read.js 顶部说明），
   遥测、SYS_STATUS 位图和 [cal] 播报都不能代替它。 */
const calibrationEvidence = ref(null)
const calibrationBusy = ref(false)
const calibrationError = ref('')
const calibrationTried = ref(0)
let autoTimer = null
const CALIBRATION_AUTO_RETRY_MAX = 4
const CALIBRATION_RETRY_DELAY_MS = 4000
const calibrationAgeMs = computed(() => calibrationEvidence.value ? Date.now() - calibrationEvidence.value.at : null)
const calibrationFields = computed(() => calibrationFieldLines(calibrationEvidence.value))
const calibrationSummary = computed(() => calibrationReadSummary(calibrationEvidence.value))
const calibrationGroups = computed(() => CALIBRATION_SENSORS.map((sensor) => {
  const s = calibrationEvidence.value?.sensors?.[sensor]
  const total = s?.total ?? 0
  const read = s?.read ?? 0
  const changed = s?.changed?.length ?? 0
  const state = !calibrationEvidence.value ? 'unknown' : read !== total ? 'unknown' : changed ? 'done' : 'missing'
  return { key: sensor, label: CALIBRATION_SENSOR_LABEL[sensor] || sensor, total, read, changed, state }
}))

/** 逐字段回显按四类分组；读数四舍五入到 3 位小数，只影响显示，判定用原值 */
const calibrationFieldGroups = computed(() => calibrationGroups.value.map((g) => ({
  ...g,
  fields: calibrationFields.value.filter((f) => f.sensor === g.key).map((f) => ({ ...f, text: typeof f.changed === 'boolean' && f.text !== '未读到' ? Number(f.text).toFixed(3) : f.text })),
})))
const calibrationAgeLabel = computed(() => {
  if (calibrationAgeMs.value == null) return ''
  const s = Math.max(0, Math.round(calibrationAgeMs.value / 1000))
  return s < 90 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`
})
const calibrationStale = computed(() => calibrationAgeMs.value != null && calibrationAgeMs.value > CALIBRATION_EVIDENCE_TTL_MS)
/* 自动校验的准入条件：链路在线、未解锁、配置不忙、且此刻没有别的参数任务在跑。
   打开页面自动来一次；条件暂时不满足就等 ready，没读全最多自动重试 4 次，之后交给手动按钮。 */
const paramQueueFree = computed(() => !mav.param.state.fetching && !mav.session.state.busy)
const calibrationReady = computed(() =>
  online.value && !mav.vehicle.armed && mav.connected.value && !fc.busy && paramQueueFree.value)
const calibrationBlocked = computed(() => !calibrationReady.value || calibrationBusy.value)

async function readCalibration(options = {}) {
  if (calibrationBusy.value) return
  if (!mav.connected.value) {
    if (!options.silent) ElMessage.warning('未连接飞控，读不到 CALIB 参数')
    return
  }
  if (mav.vehicle.armed) {
    if (!options.silent) ElMessage.warning('飞控已解锁时不做校准参数读取')
    return
  }
  if (fc.busy) {
    if (!options.silent) ElMessage.warning('配置传输进行中，稍后再读 CALIB 参数')
    return
  }
  if (!paramQueueFree.value) {
    if (!options.silent) ElMessage.warning('已有参数任务在跑，稍后再读 CALIB 参数')
    return
  }
  calibrationBusy.value = true
  calibrationError.value = ''
  const readings = []
  try {
    for (const field of CALIBRATION_FIELDS) {
      try {
        readings.push(await mav.param.read(field.name, { timeout: 2000 }))
      } catch (e) {
        readings.push({ ok: false, name: field.name, reason: 'error', error: String(e?.message || e) })
      }
    }
    calibrationEvidence.value = evaluateCalibrationRead(readings)
    calibrationTried.value += 1
    const ev = calibrationEvidence.value
    if (!options.silent) {
      if (!ev.complete) ElMessage.warning(`CALIB 有 ${ev.missingNames.length} 项没回包，未判定校准状态`)
      else ElMessage.success(ev.verified ? '四类校准都查到了写入证据' : `缺少校准证据：${ev.missingCalibrationLabels.join('、')}`)
    }
  } catch (e) {
    calibrationError.value = String(e?.message || e)
    calibrationEvidence.value = null
    if (!options.silent) ElMessage.error(`读取 CALIB 参数失败：${calibrationError.value}`)
  } finally {
    calibrationBusy.value = false
  }
}

/* 打开页面自动验证一次：ready 时触发；没读全（含超时）在限次内自动重试，其余情况等手动按钮。 */
watch(calibrationReady, (ready) => {
  if (!ready) return
  if (calibrationEvidence.value?.complete) return
  if (calibrationTried.value >= CALIBRATION_AUTO_RETRY_MAX) return
  if (calibrationBusy.value || autoTimer) return
  autoTimer = setTimeout(() => { autoTimer = null; readCalibration({ silent: true }) }, 300)
}, { immediate: true })

watch(calibrationEvidence, (ev) => {
  if (ev?.complete || calibrationTried.value >= CALIBRATION_AUTO_RETRY_MAX) return
  if (calibrationBusy.value || autoTimer) return
  autoTimer = setTimeout(() => { autoTimer = null; readCalibration({ silent: true }) }, CALIBRATION_RETRY_DELAY_MS)
})

/* 设备会话变了（断开/重连到另一台）旧读数一律作废 */
watch(() => mav.deviceState.sessionId, () => {
  calibrationEvidence.value = null
  calibrationTried.value = 0
  calibrationError.value = ''
})

/* 屏幕与导出报告必须用同一份快照：以前导出路径把 sensorsHealthy 写成 sensorsReported，
   同一个检查项在页面上和 JSON 里可以结论相反。 */
const snapshot = computed(() => ({
  phase: mav.deviceState.phase,
  heartbeatHealthy: mav.deviceState.heartbeat.healthy,
  identityDetected: mav.deviceState.identity.detected,
  modelRecognized: mav.deviceState.identity.detected && mav.deviceState.identity.type != null && mav.deviceState.identity.autopilot != null,
  sysid: mav.deviceState.identity.sysid,
  compid: mav.deviceState.identity.compid,
  configLoaded: fc.loaded,
  configDirty: fc.hasChanges,
  configurationConfirmed: fc.loaded && !fc.hasChanges && !!fc.lastPullAt,
  calibrationEvidence: calibrationEvidence.value,
  calibrationAgeMs: calibrationAgeMs.value,
  receiverReported: mav.deviceState.valid.rc,
  receiverHealthy: mav.deviceState.valid.rc && mav.data.rcChannels.chancount > 0 && mav.data.rcChannels.rssi !== 255,
  receiverAgeMs: mav.deviceState.freshness.rc ? Date.now() - mav.deviceState.freshness.rc : null,
  batteryReported: mav.deviceState.valid.battery,
  batteryHealthy: mav.deviceState.valid.battery && mav.data.battery.voltage > 0,
  batteryAgeMs: mav.deviceState.freshness.battery ? Date.now() - mav.deviceState.freshness.battery : null,
  armed: mav.vehicle.armed,
  motorOutputConfirmed: mav.deviceState.valid.servos && mav.data.servos.online,
}))
const evaluation = computed(() => evaluatePreflight(snapshot.value))
const passedCount = computed(() => evaluation.value.checks.filter((item) => item.status === 'pass').length)
const progress = computed(() => Math.round((passedCount.value / evaluation.value.checks.length) * 100))
const levelLabel = (level) => ({ [CHECK_LEVEL.BLOCK]: '阻断项', [CHECK_LEVEL.WARN]: '警告项', [CHECK_LEVEL.INFO]: '信息项' })[level]
const levelType = (level) => level === CHECK_LEVEL.BLOCK ? 'danger' : level === CHECK_LEVEL.WARN ? 'warning' : 'info'
const statusLabel = (status) => ({ pass: '通过', block: '未通过', unknown: '未验证' })[status] || status
const statusType = (status) => status === 'pass' ? 'success' : status === 'block' ? 'danger' : 'info'
const icon = (status) => status === 'pass' ? '✓' : status === 'block' ? '!' : '?'
function exportReport() {
  const blob = new Blob([JSON.stringify(preflightReport(snapshot.value, evaluation.value), null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `fmt-preflight-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); URL.revokeObjectURL(url)
}
onUnmounted(() => { if (autoTimer) clearTimeout(autoTimer); autoTimer = null; calibrationBusy.value = false })
</script>
<style scoped>
.preflight-page{min-height:100%;padding:clamp(18px,4vw,48px);background:var(--dsh-canvas)}.preflight-hero{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;max-width:980px;margin:0 auto 16px;padding-bottom:18px;border-bottom:1px solid var(--dsh-border)}.eyebrow{margin:0 0 7px;color:var(--dsh-accent);font:11px monospace;letter-spacing:.13em}.preflight-hero h1{margin:0;font-size:34px}.preflight-hero p{color:var(--dsh-text-2);line-height:1.6}.progress-card,.check-list,.report-actions{max-width:980px;margin:0 auto}.progress-card{padding:14px 16px;margin-bottom:10px;border:1px solid var(--dsh-border);border-radius:8px;background:var(--dsh-surface)}.progress-head{display:flex;justify-content:space-between;margin-bottom:8px}.progress-head span{color:var(--dsh-text-3);font:12px monospace}.check-list{display:grid;gap:8px}.check-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--dsh-border);border-left:4px solid var(--dsh-placeholder);border-radius:7px;background:var(--dsh-surface)}.check-card--pass{border-left-color:var(--dsh-success)}.check-card--block{border-left-color:var(--dsh-danger-vivid)}.check-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--dsh-surface-2);font-weight:700}.check-card--pass .check-icon{background:var(--dsh-success);color:var(--dsh-ink-on-accent)}.check-card--block .check-icon{background:var(--dsh-danger-vivid);color:var(--dsh-ink-on-fill)}.check-body{flex:1}.check-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.check-title strong{margin-right:4px}.check-body p{margin:5px 0;color:var(--dsh-text-2)}.check-body small{color:var(--dsh-text-3)}.report-actions{display:flex;gap:8px;margin-top:14px}.evidence-card{max-width:980px;margin:14px auto 0;padding:14px 16px;border:1px solid var(--dsh-border);border-radius:8px;background:var(--dsh-surface)}.evidence-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.evidence-age{margin-left:auto;color:var(--dsh-text-3);font:12px monospace}.evidence-card p{margin:8px 0 0;color:var(--dsh-text-2);line-height:1.6}.evidence-note{color:var(--dsh-text-3);font-size:12px}.evidence-card code{font-family:var(--dsh-font-mono,monospace);font-size:12px}.calib-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:12px}.calib-tile{display:grid;gap:4px;padding:9px 11px;border:1px solid var(--dsh-border);border-left:4px solid var(--dsh-placeholder);border-radius:6px;background:var(--dsh-surface-2)}.calib-tile--done{border-left-color:var(--dsh-success)}.calib-tile--missing{border-left-color:var(--dsh-danger-vivid)}.calib-name{font-weight:600}.calib-state{font-size:12px;color:var(--dsh-text-2)}.calib-tile--done .calib-state{color:var(--dsh-success)}.calib-tile--missing .calib-state{color:var(--dsh-danger-vivid)}.calib-count{color:var(--dsh-text-3);font:11px var(--dsh-font-mono,monospace)}.field-groups{display:grid;gap:10px;margin-top:12px}.field-group-head{display:flex;justify-content:space-between;color:var(--dsh-text-3);font:11px var(--dsh-font-mono,monospace);letter-spacing:.06em}.field-group-head span:first-child{color:var(--dsh-text-2)}.evidence-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:4px;margin-top:6px}.evidence-row{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-radius:5px;background:var(--dsh-surface-2);font-size:12px}.evidence-name{flex:1;font-family:var(--dsh-font-mono,monospace)}.evidence-value{font-weight:600}.evidence-default{color:var(--dsh-text-3)}.evidence-flag{color:var(--dsh-text-3)}.evidence-row--changed .evidence-flag{color:var(--dsh-success)}.evidence-row--missing{opacity:.7}.evidence-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}@media(max-width:650px){.preflight-hero{align-items:flex-start;flex-direction:column}.check-card{align-items:flex-start}.check-card>.el-button{align-self:center}}
</style>
