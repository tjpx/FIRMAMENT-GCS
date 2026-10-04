<template>
  <div class="sensor-page" :class="{ 'focus-mode': calibrationBusy }">
    <div v-if="calibrationBusy" class="focus-banner"><strong>校准聚焦模式</strong><span>请只按飞控提示保持姿态；其他页面操作暂时隐藏。</span></div>
    <TaskHeader eyebrow="SENSOR / CALIBRATION" title="传感器" description="实时观察 IMU 和校准回显；校准状态只由飞控真实播报推进。" />
    <el-alert title="传感器校准前请拆桨、保持飞控未解锁" type="warning" :closable="false" />
    <PrototypeNotice title="校准入口按固件实际能力接线" :items="noticeItems" />

    <el-row :gutter="16">
      <el-col :xs="24" :lg="14">
        <el-card class="card">
          <template #header><div class="card-header"><span>传感器波形</span><el-tag :type="waveBusy ? 'warning' : 'info'">{{ waveBusy ? '采集中' : '空闲' }}</el-tag></div></template>
          <div class="control-strip">
            <div class="control-group"><span class="control-label">数据源</span><el-radio-group v-model="waveTopic" size="small"><el-radio-button label="sensor_imu0">IMU</el-radio-button><el-radio-button label="sensor_mag0">磁力计</el-radio-button></el-radio-group></div>
            <div class="control-group control-group--wide"><span class="control-label">样本数 <span class="dsh-num">{{ waveCount }}</span></span><el-slider v-model="waveCount" :min="5" :max="100" :step="5" :show-tooltip="false" /></div>
            <div class="control-group control-switch"><span class="control-label">原始文本</span><el-switch v-model="showRawWave" size="small" /></div>
            <el-button type="primary" size="small" :disabled="waveBusy || !mav.connected.value" @click="collectWave">采集波形</el-button>
           <el-tag size="small" :type="waveStreaming ? 'success' : 'info'">{{ waveStreaming ? `实时流入 · ${waveSamples.length} 点` : '等待采集' }}</el-tag>
           <el-tag size="small" :type="mav.data.imu.lastAt && liveNow - mav.data.imu.lastAt < 1500 ? 'success' : 'info'">实时 IMU：{{ mav.data.imu.source || '未上报' }}</el-tag>
            <el-button size="small" :disabled="!waveBusy" @click="stopWave">停止</el-button>
          </div>
          <div v-if="waveTopic === 'sensor_imu0'" class="charts">
            <div v-for="chart in imuCharts" :key="chart.key" class="chart-row">
              <span>{{ chart.label }}</span><svg viewBox="0 0 600 90" preserveAspectRatio="none"><polyline v-for="(line, i) in chart.lines" :key="i" :points="line" fill="none" :stroke="chart.colors[i]" stroke-width="2" /></svg>
            </div>
            <div class="legend"><span v-for="(name, i) in ['X','Y','Z']" :key="name" :style="{ color: axisColors[i] }">● {{ name }}</span></div>
          </div>
          <div v-else class="charts">
            <div class="chart-row"><span>MAG</span><svg viewBox="0 0 600 90" preserveAspectRatio="none"><polyline v-for="(line, i) in magLines" :key="i" :points="line" fill="none" :stroke="axisColors[i]" stroke-width="2" /></svg></div>
            <div class="legend"><span>样本 <span class="dsh-num">{{ magSamples.length }}</span></span></div>
          </div>
          <EmptyStateAction v-if="!waveSamples.length" title="尚未收到传感器波形" description="先确认实时 IMU 正在更新，再开始采集控制台样本。空状态不代表传感器为零。" evidence="控制台样本尚未返回" action-label="采集波形" @action="collectWave" />
           <pre v-if="showRawWave && rawWaveText" class="reply raw-wave">{{ rawWaveText }}</pre>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="10">
        <el-card class="card">
          <template #header><div class="card-header"><span>校准引导</span><el-tag :type="calibrationPhase === 'done' ? 'success' : calibrationPhase === 'idle' ? 'info' : 'warning'">{{ calibrationStateLabel }}</el-tag></div></template>
          <div class="mode-selector"><span class="control-label">校准模式</span><el-radio-group v-model="calibrationType" :disabled="calibrationBusy || diagnosticBusy" size="small"><el-radio-button v-for="item in calibrationItems" :key="item.key" :label="item.key">{{ item.label }}</el-radio-button></el-radio-group></div>
            
          
          <div v-if="calibrationType === 'accel'" class="calib-visual" :class="{ 'calib-visual--active': calibrationBusy }">
            <div class="airframe-diagram" aria-label="六面姿态校准指示图">
              <div v-for="face in calibrationFaces" :key="face.key" class="face-cell" :class="[`face-cell--${faceStates[face.key].state}`, { 'face-cell--current': currentFace === face.key }]">
                <div class="face-signal" :class="faceStates[face.key].state === 'done' ? 'face-signal--green' : faceStates[face.key].state === 'active' ? 'face-signal--red' : 'face-signal--idle'" />
                <div class="face-glyph">{{ face.glyph }}</div>
                <div class="face-name">{{ face.label }}</div>
                <div class="face-status">{{ faceStateLabel(faceStates[face.key].state) }}</div>
              </div>
            </div>
            <div class="calib-signal-line"><span class="signal-box" :class="currentFace ? (faceStates[currentFace].state === 'done' ? 'signal-box--green' : 'signal-box--red') : 'signal-box--idle'" />{{ currentFace ? `当前姿态：${faceLabel(currentFace)}` : '等待飞控识别姿态' }}</div>
          </div>
          <div v-if="calibrationType === 'mag'" class="mag-visual">
            <div class="mag-compass" :class="{ 'mag-compass--active': calibrationBusy }"><span class="mag-compass-arrow">↻</span><span>旋转</span></div>
            <div class="calib-signal-line"><span class="signal-box" :class="magSignalClass" />{{ magGuide }}</div>
          </div>
          <template v-if="calibrationType === 'accel'">
            <div class="calib-progress-heading"><span>当前面采样进度</span><strong class="dsh-num">{{ calibProgress === null ? '—' : `${Math.min(calibProgress, 100)}%` }}</strong></div>
            <el-progress :percentage="calibProgress === null ? 0 : Math.min(calibProgress, 100)" :status="calibrationPhase === 'failed' ? 'exception' : calibrationPhase === 'done' ? 'success' : undefined" :show-text="false" class="calib-progress" />
            <div class="calib-progress-heading"><span>六面完成度</span><strong class="dsh-num">{{ completedFaceCount }}/6</strong></div>
            <el-progress :percentage="faceOverallProgress" :status="calibrationPhase === 'failed' ? 'exception' : calibrationPhase === 'done' ? 'success' : undefined" :show-text="false" class="calib-progress calib-progress--overall" />
          </template>
          <template v-else>
            <div class="calib-progress-heading"><span>飞控校准进度</span><strong class="dsh-num">{{ calibProgress === null ? '等待真实播报' : `${Math.min(calibProgress, 100)}%` }}</strong></div>
            <el-progress :percentage="calibProgress === null ? 0 : Math.min(calibProgress, 100)" :status="calibrationPhase === 'failed' ? 'exception' : calibrationPhase === 'done' ? 'success' : undefined" :show-text="false" class="calib-progress" />
          </template>
          <el-steps direction="vertical" :active="calibrationStep" class="steps">
            <el-step v-for="step in selectedCalibration.steps" :key="step" :title="step" />
          </el-steps>
          <div class="calib-actions">
            <el-button type="warning" :disabled="calibrationBusy || !mav.canWrite.value" @click="startCalibration">开始校准</el-button>
            <el-button :disabled="!calibrationBusy" @click="cancelCalibration">取消</el-button>
            <el-button :disabled="!mav.connected.value || calibrationBusy" @click="saveCalibration">保存参数</el-button>
            <el-button size="small" @click="troubleshoot">无回显排查提示</el-button>
            <el-button size="small" :loading="diagnosticBusy" :disabled="!mav.connected.value || calibrationBusy || waveBusy || mav.session.state.busy" @click="diagnoseImu">读取 IMU 采样诊断</el-button>
          </div>
          <pre v-if="diagnosticText" class="reply">{{ diagnosticText }}</pre>
          <div class="live-imu" v-if="mav.data.imu.lastAt"><span>实时加速度 <strong class="dsh-num">{{ mav.data.imu.accel.map((v) => v == null ? '—' : v.toFixed(3)).join(' / ') }}</strong></span><span>实时陀螺 <strong class="dsh-num">{{ mav.data.imu.gyro.map((v) => v == null ? '—' : v.toFixed(3)).join(' / ') }}</strong></span><small>{{ mav.data.imu.source }} · <span class="dsh-num">{{ liveNow - mav.data.imu.lastAt }}</span> ms 前</small></div>
          <pre class="reply">{{ calibrationReply || '等待校准回显' }}</pre>
          <div v-if="mav.data.imu.lastAt" class="diag-line" :class="{ 'diag-line--ok': localPoseCheck.ok }">{{ localPoseCheck.text }}</div>
          <div v-if="calibFeed.length" class="calib-feed">
            <div v-for="(line, i) in calibFeed" :key="i" class="feed-line">{{ line }}</div>
          </div>
          <div class="diag-line">接收审计：STATUSTEXT 原始 {{ statusAudit.raw }} / 具名 {{ statusAudit.named }}；[cal] {{ statusAudit.cal }} / 未识别 {{ statusAudit.unknown }}；CRC 增量 {{ Math.max(0, (mav.stats?.crcErrors || 0) - statusAudit.crcStart) }}；原始最新：{{ statusAudit.lastRaw || '无' }}</div>
          <div class="diag-line">目标：sysid={{ mav.vehicle.sysid }} / compid={{ mav.vehicle.compid }}；最近 ACK：{{ lastAck || '无' }}；帧：{{ lastAckFrame || '无' }}；最近 [cal]：{{ lastCalib || '无' }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="card result-card">
      <template #header><div class="card-header"><span>校准结果</span><el-button size="small" :disabled="!mav.connected.value || calibrationBusy" @click="listCalibration">控制台 param list CALIB</el-button></div></template>
      <pre class="reply">{{ resultText || '未读取 CALIB 参数' }}</pre>
    </el-card>
  </div>
</template>

<script setup>
import { computed, inject, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import PrototypeNotice from './PrototypeNotice.vue'
import TaskHeader from './task-header.vue'
import EmptyStateAction from './empty-state-action.vue'
import { MAVLINK_MSG_ID } from '../utils/mavlink-protocol.js'
import { decodeMessage, encodeFields } from '../protocol/mav-decoder.js'
import { calibrationListCommand, calibrationSaveCommand } from '../utils/console-session.js'
import { parseImuEcho, summarizeImu, sixFaceProgress } from '../utils/calibration-diagnostics.js'
import { describeCalibEvent, isCalibTerminal, parseCalibStatus } from '../utils/calibration-feed.js'

const mav = inject('mavlink')
const fc = inject('fcconfig', null)
const statusAudit = reactive({ raw: 0, named: 0, cal: 0, unknown: 0, lastRaw: '', crcStart: 0 })
let statusRawStop = null
let lastStatusDelivery = null
const axisColors = ['var(--dsh-accent)', 'var(--dsh-warning-fill)', 'var(--dsh-success)']
const liveNow = ref(Date.now())
let liveTimer = setInterval(() => { liveNow.value = Date.now() }, 250)
const noticeItems = [
  '网页说明陀螺仪、加速度计、罗盘、水平校准遵循 QGroundControl 流程；本页按固件 MAV_CMD_PREFLIGHT_CALIBRATION 接入。',
  '控制台 calib 命令并不提供 gyro/accel/mag/level；不要发送不存在的 calib 子命令。',
  '固件用 STATUSTEXT 的 [cal] 播报推进校准（started/progress/orientation/done/failed），本页以它为主判据，COMMAND_ACK 只表示请求被接受。',
  '结果查看使用 param list CALIB，持久化使用 param save；没有 [cal] calibration done 不显示成功。',
]
const calibrationItems = [
  { key: 'gyro', label: '陀螺仪', command: 1, params: { param1: 1 }, steps: ['机体水平放置并保持静止', '点击开始，等待 [cal] calibration started: 2 gyro', '保持不动直到 [cal] calibration done'] },
  { key: 'accel', label: '加速度计', command: 1, params: { param5: 1 }, steps: ['点击开始校准', '按 [cal] 提示依次放置 up/down/left/right/front/back', '每个姿态静止到 side done'] },
  { key: 'mag', label: '罗盘', command: 1, params: { param2: 1 }, steps: ['点击开始校准', '按 [cal] 播报旋转各个轴向', '等待 calibration done 播报'] },
  { key: 'level', label: '水平校准', command: 1, params: { param5: 2 }, steps: ['将机体按水平飞行方向放在平面上', '点击开始校准', '保持不动直到 [cal] calibration done: level'] },
]
const calibrationFaces = [
  { key: 'up', label: '朝上', glyph: '↑' }, { key: 'down', label: '朝下', glyph: '↓' },
  { key: 'left', label: '朝左', glyph: '←' }, { key: 'right', label: '朝右', glyph: '→' },
  { key: 'front', label: '朝前', glyph: '↗' }, { key: 'back', label: '朝后', glyph: '↙' },
]
const calibrationType = ref('gyro')
const selectedCalibration = computed(() => calibrationItems.find((x) => x.key === calibrationType.value) || calibrationItems[0])
const faceStates = reactive(Object.fromEntries(calibrationFaces.map((face) => [face.key, { state: 'idle' }])))
const currentFace = ref('')
const completedFaceCount = computed(() => calibrationFaces.filter((face) => faceStates[face.key].state === 'done').length)
const faceOverallProgress = computed(() => sixFaceProgress(faceStates, currentFace.value, calibProgress.value))
const magGuide = computed(() => currentFace.value ? `已识别${faceLabel(currentFace.value)}，请沿该姿态旋转机体` : calibrationBusy.value ? '等待飞控识别姿态后开始旋转' : '开始后按飞控提示旋转机体')
const magSignalClass = computed(() => calibrationPhase.value === 'done' ? 'signal-box--green' : calibrationBusy.value && currentFace.value ? 'signal-box--red' : 'signal-box--idle')
function faceLabel(key) { return calibrationFaces.find((face) => face.key === key)?.label || key }
function faceStateLabel(state) { return state === 'done' ? '已完成' : state === 'active' ? '保持不动' : '待校准' }
// 本地姿态判定：用实时加速度估计机体当前倒向哪一面，并对照固件采样阈值
// （S5_SENSOR_CALIBRATION 文档：目标轴绝对值 ≥8.8 m/s²、其余两轴 ≤2.0 m/s²）。
// accel 单位随消息不同（SCALED_IMU/RAW_IMU 为 mG、HIGHRES_IMU 为 m/s²），按量级换算。
// 它只辅助摆放姿势，不构成校准结论——完成与否仍以 [cal] orientation detected / side done 为准。
const localPoseCheck = computed(() => {
  const imu = mav.data.imu
  const acc = imu?.accel
  if (!acc || acc.length < 3 || acc.some((v) => v == null || !Number.isFinite(v)) || !imu.lastAt || liveNow.value - imu.lastAt > 1500) {
    return { ok: false, face: '', text: '本地姿态判定：等待实时加速度数据' }
  }
  // SCALED_IMU/RAW_IMU 的 si 值为 g（mG × 0.001）；HIGHRES_IMU 的 si 值为 m/s²。
  const toMs2 = imu.source === 'HIGHRES_IMU' ? 1 : 9.80665
  const axes = acc.map((v) => Number(v) * toMs2)
  const abs = axes.map(Math.abs)
  const maxIdx = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2
  const face = maxIdx === 0 ? (axes[0] < 0 ? 'front' : 'back') : maxIdx === 1 ? (axes[1] < 0 ? 'right' : 'left') : (axes[2] > 0 ? 'up' : 'down')
  const others = abs.filter((_, i) => i !== maxIdx)
  const ok = abs[maxIdx] > 8.8 && others.every((v) => v < 2.0)
  return { ok, face, text: `本地辅助判定：${faceLabel(face)} · 目标轴 ${abs[maxIdx].toFixed(2)} m/s²、余轴 ${others.map((v) => v.toFixed(2)).join('/')} m/s² → ${ok ? '满足姿态幅值阈值；仍需持续静止和原始 IMU 采样，等待飞控进度' : '未达标（目标轴>8.8、余轴<2.0），请把该面摆平并保持静止'}` }
})
const calibrationBusy = ref(false)
const calibrationStep = ref(0)
const calibrationReply = ref('')
const calibrationPhase = ref('idle')
const lastAck = ref('')
const ackSeen = ref(false)
const lastAckFrame = ref('')
const lastAckRaw = ref('')
const lastCalib = ref('')
const calibFeed = ref([])
const calibProgress = ref(null)
const resultText = ref('')
let ackStop = null
let ackRawStop = null
let calibStop = null
let ackTimer = null
let overallTimer = null
let faceStallTimer = null
const CALIB_STATE_LABEL = { cancelling: '等待取消确认', idle: '未开始', sending: '等待飞控', running: '校准中', done: '已完成', failed: '失败', cancelled: '已取消', denied: '被拒绝', silent: '无回显' }
const calibrationStateLabel = computed(() => CALIB_STATE_LABEL[calibrationPhase.value] || calibrationPhase.value)

const waveTopic = ref('sensor_imu0')
const waveCount = ref(30)
const showRawWave = ref(false)
const waveSamples = ref([])
const rawWaveText = ref('')
const waveBusy = ref(false)
const waveStreaming = ref(false)
const waveLiveTimer = ref(0)
let waveStop = null
let wavePromise = null
const imuCharts = computed(() => [
  { key: 'gyr', label: 'GYR', colors: axisColors, lines: [0, 1, 2].map((i) => polyline(waveSamples.value.map((x) => x.gyr?.[i] ?? 0))) },
  { key: 'acc', label: 'ACC', colors: axisColors, lines: [0, 1, 2].map((i) => polyline(waveSamples.value.map((x) => x.acc?.[i] ?? 0))) },
])
const magSamples = computed(() => waveSamples.value.map((x) => x.mag || [0, 0, 0]))
const magLines = computed(() => [0, 1, 2].map((i) => polyline(magSamples.value.map((x) => x[i] ?? 0))))
function polyline(values) {
  if (!values.length) return ''
  const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1
  return values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 600},${82 - ((v - min) / span) * 70}`).join(' ')
}
function parseSamples(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/gyr:\s*([-+.\deE]+)\s+([-+.\deE]+)\s+([-+.\deE]+)\s+acc:\s*([-+.\deE]+)\s+([-+.\deE]+)\s+([-+.\deE]+)/i)
    if (m) rows.push({ gyr: m.slice(1, 4).map(Number), acc: m.slice(4, 7).map(Number) })
    const mag = line.match(/(?:mag|MAG):\s*([-+.\deE]+)\s+([-+.\deE]+)\s+([-+.\deE]+)/i)
    if (mag) rows.push({ mag: mag.slice(1, 4).map(Number) })
  }
  return rows.filter((x) => Object.values(x).flat().every((v) => Number.isFinite(v)))
}
function appendLiveImu() {
  waveLiveTimer.value = Date.now()
  const imu = mav.data.imu
  const live = imu?.lastAt && Date.now() - imu.lastAt < 1500
  if (!live) return
  const sample = { gyr: [...(imu.gyro || [])], acc: [...(imu.accel || [])], mag: [...(imu.mag || [])], at: imu.lastAt }
  if (sample.gyr.concat(sample.acc, sample.mag).some((v) => v != null && !Number.isFinite(v))) return
  waveSamples.value = [...waveSamples.value, sample].slice(-Math.max(5, waveCount.value))
  waveStreaming.value = true
}
async function collectWave() {
  if (calibrationBusy.value || diagnosticBusy.value || fc?.busy || mav.session.state.busy) return ElMessage.warning('校准或配置传输期间不能启动波形采集')
  waveBusy.value = true; waveStreaming.value = false; waveSamples.value = []; rawWaveText.value = ''
  if (waveStop) waveStop()
  waveStop = mav.on('SCALED_IMU', appendLiveImu)
  const rawStop = mav.on('RAW_IMU', appendLiveImu)
  const highStop = mav.on('HIGHRES_IMU', appendLiveImu)
  let consoleStop = null
  try {
    // 按用户动作启动 mcn echo；订阅控制台分片回显，样本到达即增量绘图，不等整条命令结束。
    consoleStop = mav.session.subscribe((event) => {
      if (event.type !== 'rx' || !event.text) return
      rawWaveText.value += event.text
      const parsed = parseSamples(rawWaveText.value)
      if (parsed.length) { waveSamples.value = parsed.slice(-Math.max(5, waveCount.value)); waveStreaming.value = true }
    })
    wavePromise = mav.session.run(`mcn echo ${waveTopic.value} -n ${waveCount.value} -p 100`, { until: /(?:msh\s[^\r\n>]*>\s*)$/i, timeoutMs: Math.max(6000, waveCount.value * 180) })
    const result = await wavePromise
    rawWaveText.value = result.text || rawWaveText.value
    const parsed = parseSamples(rawWaveText.value)
    waveSamples.value = parsed.slice(-Math.max(5, waveCount.value))
    if (!waveSamples.value.length) ElMessage.warning('控制台有 mcn echo 回显，但没有识别到波形样本；原始回显已保留')
  } catch (e) { ElMessage.error(e.message || String(e)) }
  finally { consoleStop?.(); clearTimeout(wavePromise); wavePromise = null; rawStop(); highStop(); if (waveStop) { waveStop(); waveStop = null }; waveBusy.value = false; waveStreaming.value = waveSamples.value.length > 0 }
}
function stopWave() { if (waveBusy.value) { mav.session.cancel('wave-stop'); waveStreaming.value = false } }
const ACK_RESULT_LABELS = { 0: '接受', 1: '暂时拒绝', 2: '拒绝', 3: '不支持', 4: '失败', 5: '进行中', 6: '已取消' }
function sendCalibration(params) {
  // QGroundControl 的校准请求固定发给 MAV_COMP_ID_AUTOPILOT1(1)，不能把 HEARTBEAT 的 compid 当成命令目标；两者在多组件飞控上可能不同。
  const values = { target_system: mav.vehicle.sysid, target_component: 1, command: 241, confirmation: 0, param1: 0, param2: 0, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0, ...params }
  mav.sendMessage(MAVLINK_MSG_ID.COMMAND_LONG, encodeFields(MAVLINK_MSG_ID.COMMAND_LONG, values))
}
function clearTimers() {
  if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
  if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
  if (faceStallTimer) { clearTimeout(faceStallTimer); faceStallTimer = null }
}
function stopListening() { statusRawStop?.(); statusRawStop = null; ackStop?.(); ackStop = null; ackRawStop?.(); ackRawStop = null; calibStop?.(); calibStop = null; clearTimers() }
/** 取当前链路上 msgid 的接收计数与 CRC 错误数（解析器自己维护，页面不留副本） */
function ackEvidence() {
  const row = (typeof mav.msgCensus === 'function' ? mav.msgCensus() : []).find((x) => x.msgid === MAVLINK_MSG_ID.COMMAND_ACK)
  return { rx: row ? row.rx : 0, bad: row ? row.bad : 0, crc: mav.stats ? mav.stats.crcErrors : 0 }
}
function recordCalibText(text) {
  const line = String(text || '').replace(/\0+$/g, '').trim()
  if (!line) return
  const evt = parseCalibStatus(line)
  if (!evt) {
    // 校准窗口内也留档非 [cal] 播报：飞控说了别的（报错/提示）同样是证据。
    if (calibrationBusy.value) calibFeed.value = [...calibFeed.value, `非校准播报：${line}`].slice(-40)
    return
  }
  lastCalib.value = evt.raw
  calibFeed.value = [...calibFeed.value, evt.raw].slice(-40)
  calibrationReply.value = describeCalibEvent(evt)
  if (evt.kind === 'progress') calibProgress.value = evt.progress
  if (evt.kind === 'started') {
    calibrationFaces.forEach((face) => { faceStates[face.key].state = 'idle' })
    currentFace.value = ''
    calibProgress.value = 0
    calibrationPhase.value = 'running'
    calibrationStep.value = 1
    calibrationBusy.value = true
    // 校准已开始 = 命令确实被飞控执行了，此刻不能再拿 ACK 当唯一证据
    if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
  }
  if (evt.kind === 'orientation') {
    currentFace.value = evt.orientation
    if (calibrationType.value !== 'accel' && calibrationType.value !== 'mag') return
    calibrationFaces.forEach((face) => { if (face.key !== evt.orientation && faceStates[face.key].state === 'active') faceStates[face.key].state = 'idle' })
    if (faceStates[evt.orientation]) faceStates[evt.orientation].state = 'active'
    calibProgress.value = 0
    calibrationStep.value = 2
    if (faceStallTimer) clearTimeout(faceStallTimer)
    // 固件每 20ms 取样、每面需要 200 点；没有 side done 说明飞控仍在等稳定数据。
    faceStallTimer = setTimeout(() => {
      if (calibrationBusy.value && lastCalib.value === evt.raw) {
        calibrationReply.value = calibrationType.value === 'accel'
          ? `${describeCalibEvent(evt)}；8 秒内没有后续校准播报。固件每面采 200 点、每 20 ms 执行一次，但仅在姿态持续达标且抖动检测通过时采样；前 20 点才播报 10%。姿态识别使用 sensor_imu0，实际采样使用 sensor_imu0_0，后者读取失败会直接返回而不报错。请先拆桨，把机体放稳；若仍无进度，点击取消并等待飞控确认，再点击「读取 IMU 采样诊断」。该诊断直接读取两个主题，不依赖 MAVLink 实时 IMU 遥测。${localPoseCheck.value.text}`
          : describeCalibEvent(evt)
      }
    }, 8000)
  }
  if (evt.kind === 'progress' && calibrationType.value === 'accel') {
    if (currentFace.value && faceStates[currentFace.value]) faceStates[currentFace.value].state = 'active'
  }
  if (evt.kind === 'sideDone' && (calibrationType.value === 'accel' || calibrationType.value === 'mag')) {
    if (faceStallTimer) { clearTimeout(faceStallTimer); faceStallTimer = null }
    if (faceStates[evt.orientation]) faceStates[evt.orientation].state = 'done'
    currentFace.value = evt.orientation
    calibrationStep.value = 2
    calibProgress.value = 100
  }
  if (isCalibTerminal(evt)) {
    calibrationBusy.value = false
    calibrationPhase.value = evt.kind
    if (evt.kind === 'done' && calibrationType.value === 'accel') calibrationFaces.forEach((face) => { faceStates[face.key].state = 'done' })
    if (evt.kind === 'failed' || evt.kind === 'cancelled') calibrationFaces.forEach((face) => { if (faceStates[face.key].state === 'active') faceStates[face.key].state = 'idle' })
    if (evt.kind === 'done') { calibProgress.value = 100; calibrationStep.value = 3 }
    stopListening()
  }
}
function handleAck(raw, frame = null) {
  if (raw && raw.command !== undefined) {
    ackSeen.value = true
    lastAck.value = `command=${raw.command}, result=${raw.result}${ACK_RESULT_LABELS[raw.result] ? `（${ACK_RESULT_LABELS[raw.result]}）` : ''}`
    lastAckFrame.value = `src=${frame?.sysid ?? '?'}/${frame?.compid ?? '?'} command=${raw.command} result=${raw.result} payload=${frame?.payload?.length ?? '?'}B`
    lastAckRaw.value = JSON.stringify(raw)
  }
  if (Number(raw?.command) !== 241) return
  if (calibrationPhase.value === 'cancelling') return
  if (raw.result === 0 || raw.result === 5) {
    if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
    if (calibrationPhase.value === 'sending' || calibrationPhase.value === 'silent') calibrationPhase.value = 'running'
    calibrationBusy.value = true
    if (!lastCalib.value) calibrationReply.value = '已收到 COMMAND_ACK（请求接受/进行中）。完成与否以飞控 [cal] calibration done/failed 播报为准。'
    return
  }
  calibrationBusy.value = false
  calibrationPhase.value = raw.result === 1 ? 'denied' : 'failed'
  calibrationReply.value = `已收到飞控 COMMAND_ACK：result=${raw.result}（${ACK_RESULT_LABELS[raw.result] || '未接受'}）`
  ElMessage.warning('飞控未接受校准请求，具体结果已保留')
  stopListening()
}
async function startCalibration() {
  if (diagnosticBusy.value || waveBusy.value || calibrationBusy.value) return ElMessage.warning('已有校准或采样任务，请先结束当前任务')
  if (!mav.canWrite.value) return ElMessage.warning('链路未确认在线或飞控已解锁，禁止校准')
  if (fc?.busy || mav.session.state.busy) return ElMessage.warning('配置或控制台正在传输，请等待完成后再校准')
  stopListening()
  Object.assign(statusAudit, { raw: 0, named: 0, cal: 0, unknown: 0, lastRaw: '', crcStart: mav.stats?.crcErrors || 0 })
  lastStatusDelivery = null
  calibFeed.value = []; calibProgress.value = null; currentFace.value = ''; calibrationFaces.forEach((face) => { faceStates[face.key].state = 'idle' }); lastAck.value = '等待中'; ackSeen.value = false; lastAckFrame.value = ''; lastAckRaw.value = ''; lastCalib.value = ''
  calibrationBusy.value = true; calibrationStep.value = 0; calibrationPhase.value = 'sending'
  calibrationReply.value = `正在发送 COMMAND_LONG(241)，目标 sysid=${mav.vehicle.sysid} compid=1（自动驾驶组件）…`
  ackStop = mav.on('COMMAND_ACK', (d) => handleAck(d?.raw || d, d))
  statusRawStop = mav.on(MAVLINK_MSG_ID.STATUSTEXT, () => { statusAudit.raw++ })
  calibStop = mav.on('STATUSTEXT', (d) => {
    statusAudit.named++
    const text = d?.raw?.text ?? d?.text ?? ''
    statusAudit.lastRaw = text
    const evt = parseCalibStatus(text)
    if (evt) { statusAudit.cal++; if (evt.kind === 'unknown') statusAudit.unknown++ }
    recordCalibText(text)
  })
  const before = ackEvidence()
  try {
    sendCalibration(selectedCalibration.value.params)
    calibrationReply.value = 'COMMAND_LONG 已发送，等待飞控 COMMAND_ACK 或 [cal] 播报。'
    ackTimer = setTimeout(() => {
      if (!calibrationBusy.value || lastCalib.value) return
      const now = ackEvidence()
      calibrationPhase.value = mav.connected.value ? 'silent' : 'failed'
      calibrationReply.value = mav.connected.value
        ? [
          ackSeen.value ? '5 秒内收到 COMMAND_ACK，但没有收到 [cal] 播报；请看下方最近 ACK 的 command/result 与源地址。' : '链路仍连接，但 5 秒内没有被页面判定的 COMMAND_ACK，也没有 [cal] 播报。',
          `等待窗口内解析器看到的 ACK 帧：rx=${now.rx - before.rx}，crcErrors 变化=${now.crc - before.crc}。`,
          'rx>0 说明飞控回了而我们没判定；rx=0 且 crcErrors 上升说明帧到了但校验没过（方言/crc_extra 不符）；',
          '两者都是 0 说明命令很可能没到达飞控的校准入口——控制台能用不代表这条命令能到，二者路由不同。',
          'QGC 校准确实有效，所以优先核对本页链路接的是不是 QGC 用的那条 mavproxy 设备。',
        ].join('\n')
        : '发送后链路已断开，未收到任何回显：优先检查通信链路；未判定校准成功。'
    }, 5000)
    overallTimer = setTimeout(() => {
      if (!calibrationBusy.value) return
      calibrationPhase.value = 'silent'
      calibrationReply.value = '5分钟未收到完成/失败播报；飞控可能仍在校准，请点击取消并等待确认，未判定成功或停止。'
    }, 300000)
  } catch (e) {
    calibrationBusy.value = false; calibrationPhase.value = 'failed'; calibrationReply.value = `命令未发送：${e.message || e}`
    stopListening()
  }
}
function cancelCalibration() {
  if (!calibrationBusy.value || calibrationPhase.value === 'cancelling') return
  clearTimers()
  calibrationPhase.value = 'cancelling'
  try {
    sendCalibration({})
    calibrationReply.value = '已发送全零参数取消请求，等待飞控 [cal] calibration cancelled；尚未确认停止。'
    overallTimer = setTimeout(() => {
      calibrationReply.value = '取消请求5秒内没有确认；仍按校准可能运行处理，请检查链路，不允许直接开始另一项校准。可再次点击取消。'
      calibrationPhase.value = 'silent'
    }, 5000)
  } catch (e) { calibrationPhase.value = 'silent'; calibrationReply.value = `取消未确认：${e.message || e}` }
}
function troubleshoot() {
  const e = ackEvidence()
  const long = (typeof mav.msgCensus === 'function' ? mav.msgCensus() : []).find((x) => x.msgid === MAVLINK_MSG_ID.COMMAND_LONG)
  calibrationReply.value = [
    `目标：sysid=${mav.vehicle.sysid} compid=1（校准命令目标）`,
    `解析器累计：COMMAND_ACK(77) rx=${e.rx} bad=${e.bad}，COMMAND_LONG(76) rx=${long ? long.rx : 0}，CRC 错误=${e.crc}；最近 ACK 原始=${lastAckRaw.value || '无'}`,
    '固件校准入口：mavgcs.c 的 MAV_CMD_PREFLIGHT_CALIBRATION(241) → mavproxy_cmd_set(MAVCMD_CALIBRATION_*)',
    '回显通道：ACK 与 [cal] 播报都由 mavproxy_send_immediate_msg(MAVPROXY_GCS_CHAN) 发出，'
    + '而控制台 SERIAL_CONTROL 走 mav_console 那条设备；两者路由不同，控制台能用不代表这条命令的 ACK 能回来',
    'rx>0 而界面无 ACK：本页监听或判定有问题，把上面数字告诉我',
    'rx=0 且 CRC 错误在涨：帧到了但没过校验（方言/crc_extra 不符）',
    'rx=0 且 CRC 错误不动：命令没进飞控校准入口，核对本页链路是否接在 QGC 用的那台 mavproxy 设备上',
  ].join('\n')
}
const diagnosticBusy = ref(false)
const diagnosticText = ref('')
async function diagnoseImu() {
  if (calibrationBusy.value || waveBusy.value || diagnosticBusy.value || mav.session.state.busy || !mav.canWrite.value) return ElMessage.warning('请先取消校准并等待确认，拆桨、保持未解锁，再读取诊断')
  diagnosticBusy.value = true
  diagnosticText.value = '正在读取真实控制台样本；不修改参数、不触发校准。保持刚才的姿态并放稳机体。'
  const output = []
  try {
    for (const topic of ['sensor_imu0', 'sensor_imu0_0']) {
      const result = await mav.session.run(`mcn echo ${topic} -n 60 -p 20`, { until: /(?:msh\s[^\r\n>]*>\s*)$/i, timeoutMs: 10000 })
      const text = String(result.text || '')
      const summary = summarizeImu(parseImuEcho(text))
      output.push(`${topic}：收到 ${summary.count}/60 个可解析样本；姿态分布 ${JSON.stringify(summary.faces)}；相邻陀螺变化>0.8 rad/s 共 ${summary.jumps} 次。\n${text || '无样本回显'}\n会话结果：${result.reason || '结束'}`)
      diagnosticText.value = output.join('\n\n')
    }
    diagnosticText.value += '\n\n以上是控制台20 ms间隔的观察，不是固件内部抖动窗口或采样计数；不能据此判定校准成功。sensor_imu0用于姿态/抖动门槛，sensor_imu0_0用于实际拟合。idle说明该样本未满足严格姿态阈值；无回显也可能是控制台传输问题。'
  } catch (e) {
    diagnosticText.value = `${output.join('\n\n')}\n诊断未完成：${e.message || e}`
  } finally { diagnosticBusy.value = false }
}
async function listCalibration() { try { const r = await mav.session.run(calibrationListCommand(), { until: /(?:msh\s[^\r\n>]*>\s*)$/i }); resultText.value = r.text || r.reason } catch (e) { ElMessage.error(e.message || String(e)) } }
async function saveCalibration() {
  try {
    const r = await mav.session.run(calibrationSaveCommand(), { until: /(?:msh\s[^\r\n>]*>\s*)$/i })
    const text = String(r.text || '')
    if (/parameter save to\s+\S+/i.test(text)) {
      calibrationReply.value = `参数保存已由飞控确认：${text.trim()}`
      ElMessage.success('参数保存已由飞控回显确认')
    } else if (/parameter save fail|error|failed/i.test(text)) {
      calibrationReply.value = `参数保存失败：${text.trim() || r.reason}`
      ElMessage.error('飞控报告参数保存失败')
    } else {
      calibrationReply.value = `未收到明确的保存成功回显，未判定保存成功：${text.trim() || r.reason}`
    }
  } catch (e) { ElMessage.error(e.message || String(e)) }
}
onUnmounted(() => { clearInterval(liveTimer); stopListening(); if (waveBusy.value) stopWave(); if (mav.session.state.busy) mav.session.cancel('sensor-page-unmount') })
</script>

<style scoped>
.focus-banner{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;margin-bottom:12px;border:1px solid var(--dsh-warning);border-radius:6px;background:var(--dsh-warning-soft);font-size:12px}.focus-banner span{color:var(--dsh-text-2)}
.live-imu{display:flex;gap:12px;flex-wrap:wrap;padding:8px;margin:8px 0;border:1px solid var(--dsh-border);border-radius:6px;background:var(--dsh-surface-2);font-size:var(--dsh-font)}.live-imu strong{font-weight:600}.live-imu small{color:var(--dsh-text-3)}
.sensor-page { padding:20px; max-width:1400px; margin:0 auto }
.card { margin-top:16px }
.card-header { display:flex; justify-content:space-between; align-items:center }
.wave-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:14px }
.control-strip { display:flex; flex-wrap:wrap; align-items:end; gap:12px; padding:10px; margin-bottom:14px; border:1px solid var(--dsh-border); background:var(--dsh-surface-2); border-radius:6px }
.control-group { display:flex; flex-direction:column; gap:5px; min-width:130px }
.control-group--wide { flex:1 1 160px; max-width:260px }
.control-switch { min-width:72px; align-items:flex-start }
.control-label { color:var(--dsh-text-2); font-size:12px }
.chart-row { display:grid; grid-template-columns:48px 1fr; align-items:center; gap:8px; margin:8px 0; color:var(--dsh-text-2); font:12px monospace }
.chart-row svg { width:100%; height:90px; border:1px solid var(--dsh-border); background:var(--dsh-surface-2) }
.legend { display:flex; gap:14px; font:12px monospace; margin:5px 0 12px 56px }
.calib-select { width:100%; margin-bottom:16px }
.mode-selector { display:flex; flex-direction:column; gap:6px; padding:10px; margin-bottom:12px; border:1px solid var(--dsh-border); background:var(--dsh-surface-2); border-radius:6px }
.raw-wave { margin-top:10px; max-height:180px }
.steps { min-height:220px }
.calib-actions { display:flex; flex-wrap:wrap; gap:8px }
.reply { min-height:48px; max-height:220px; overflow:auto; padding:10px; background:var(--dsh-surface-2); color:var(--dsh-text-2); white-space:pre-wrap; font:12px monospace }
.diag-line { margin-top:8px; color:var(--dsh-text-2); font:12px monospace }.diag-line--ok { color:var(--dsh-success) }
.calib-visual { margin:10px 0 14px; padding:12px; border:1px solid var(--dsh-border); background:var(--dsh-surface-2); border-radius:6px }
.airframe-diagram { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px }
.face-cell { position:relative; min-height:76px; padding:8px 6px; text-align:center; border:1px solid var(--dsh-border); border-radius:6px; background:var(--dsh-surface); transition:border-color .15s, background .15s }
.face-cell--current { border-color:var(--dsh-warning-fill); box-shadow:0 0 0 1px var(--dsh-warning-fill) inset }
.face-cell--active { background:color-mix(in srgb, var(--dsh-danger) 12%, var(--dsh-surface)); border-color:var(--dsh-danger) }
.face-cell--done { background:color-mix(in srgb, var(--dsh-success) 12%, var(--dsh-surface)); border-color:var(--dsh-success) }
.face-signal { width:10px; height:10px; margin:0 auto 3px; border-radius:50%; background:var(--dsh-text-3) }
.face-signal--red { background:var(--dsh-danger); box-shadow:0 0 8px color-mix(in srgb, var(--dsh-danger) 70%, transparent) }
.face-signal--green { background:var(--dsh-success); box-shadow:0 0 8px color-mix(in srgb, var(--dsh-success) 70%, transparent) }
.face-glyph { font-size:22px; line-height:24px; color:var(--dsh-text-1) }
.face-name { font-size:12px; color:var(--dsh-text-1) }
.face-status { margin-top:2px; font-size:11px; color:var(--dsh-text-2) }
.calib-signal-line { display:flex; align-items:center; gap:7px; margin-top:10px; font:12px monospace; color:var(--dsh-text-2) }
.signal-box { width:12px; height:12px; border-radius:3px; background:var(--dsh-text-3) }
.signal-box--red { background:var(--dsh-danger) }
.signal-box--green { background:var(--dsh-success) }
.mag-visual { display:flex; align-items:center; gap:14px; margin:10px 0 14px; padding:12px; border:1px solid var(--dsh-border); background:var(--dsh-surface-2); border-radius:6px }
.mag-compass { display:flex; flex-direction:column; align-items:center; justify-content:center; width:82px; height:82px; border:2px solid var(--dsh-border); border-radius:50%; color:var(--dsh-text-2); font-size:12px }
.mag-compass--active { border-color:var(--dsh-danger); color:var(--dsh-danger); box-shadow:0 0 10px color-mix(in srgb, var(--dsh-danger) 55%, transparent) }
.mag-compass-arrow { font-size:36px; line-height:38px }
.calib-progress-heading { display:flex; justify-content:space-between; margin:8px 0 4px; color:var(--dsh-text-2); font-size:12px }
.calib-progress-heading strong { color:var(--dsh-text-1); font-size:var(--dsh-font); font-weight:600 }
.calib-progress { margin-bottom:10px }
.calib-progress--overall { margin-bottom:14px }
.calib-feed { margin-top:10px; padding:8px; border:1px solid var(--dsh-border); background:var(--dsh-surface-2); max-height:150px; overflow:auto }
.feed-line { color:var(--dsh-text-2); font:12px monospace; white-space:pre-wrap }
.result-card { margin-bottom:20px }
@media (max-width:768px) { .sensor-page { padding:10px } }
</style>
