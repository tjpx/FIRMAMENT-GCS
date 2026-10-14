<!-- 电机测试：固件 act 控制台命令；不走 MAVLink MOTOR_TEST。 -->
<template>
  <div class="esc-calibrate-page">
    <TaskHeader
      eyebrow="MOTOR / SAFETY"
      title="电机测试"
      description="仅在拆桨、未解锁且链路安全条件满足时执行；断链不能当作紧急停止。"
    />
    <el-alert title="危险操作：必须拆除螺旋桨并确认电机区域无人" type="error" :closable="false" class="top-tip">
      <p>act set 会持续输出，直到发送停止字符。若链路断开，飞控可能继续输出；断链后不能把电机页当作紧急停止装置。</p>
    </el-alert>
    <PrototypeNotice title="本页通过控制台会话发送 act 命令，不是 MAVLink MOTOR_TEST" :items="noticeItems" />

    <div class="safety-checks">
      <el-checkbox v-model="propsRemoved">螺旋桨已拆除</el-checkbox
      ><el-checkbox v-model="mountSecured">电机座已固定</el-checkbox><span>仅本页本次有效，不持久化。</span>
    </div>
    <el-alert
      v-if="testState.uncertain"
      title="电机停止状态未知：请现场确认并独立切断动力；断链不是停止证据"
      type="error"
      :closable="false"
    />
    <el-card class="test-card" shadow="hover">
      <template #header>
        <div class="card-header">
          <span class="title">电机单独测试</span
          ><el-tag :type="sessionBusy ? 'warning' : 'info'">{{ sessionBusy ? '控制台占用中' : '控制台空闲' }}</el-tag>
        </div>
      </template>
      <div class="motor-grid">
        <div
          v-for="motor in motors"
          :key="motor.id"
          class="motor-item"
          :class="{ 'motor-running': runningMotor === motor.id }"
        >
          <div class="motor-label">
            <span class="motor-name">M{{ motor.id }}</span
            ><span class="live-pwm">{{ servoText(servoPwm(motor.id)) }}</span>
          </div>
          <el-slider
            v-model="motor.throttle"
            :min="0"
            :max="100"
            :step="1"
            :disabled="sessionBusy && runningMotor !== motor.id"
          />
          <div class="motor-actions">
            <el-input-number
              v-model="motor.throttle"
              :min="0"
              :max="100"
              size="small"
              class="throttle-input"
              :disabled="sessionBusy && runningMotor !== motor.id"
            />
            <el-button
              type="primary"
              size="small"
              :disabled="runningMotor === motor.id ? false : !canStart(motor.id)"
              @click="toggleMotor(motor.id)"
              >{{ runningMotor === motor.id ? '停止' : '运转' }}</el-button
            >
          </div>
        </div>
      </div>
      <el-divider content-position="left">全局控制（act set --all）</el-divider>
      <div class="all-test-bar">
        <el-slider v-model="allThrottle" :min="0" :max="100" :step="1" class="full-slider" :disabled="sessionBusy" />
        <el-button type="success" :disabled="!canStart()" @click="startAllMotor">全部启动</el-button>
      </div>
      <DangerZone
        title="停止全部电机"
        description="停止命令通过当前控制台会话发送；断链时不能保证立即停止。"
        disabled-reason="只有真实控制台会话占用时才可停止"
      >
        <el-button type="danger" :disabled="!sessionBusy" @click="stopAllMotor">停止（任意键）</el-button>
      </DangerZone>
    </el-card>

    <el-card class="dshot-card" shadow="hover" style="margin-top: 20px">
      <template #header>
        <div class="card-header">
          <span class="title">DShot 电调命令</span><el-tag type="warning" effect="plain">控制台命令</el-tag>
        </div>
      </template>
      <el-alert title="仅适用于固件已配置为 DShot 的 actuator 设备" type="warning" :closable="false">
        <p>这些操作要求飞控未解锁；固件会校验设备协议并返回真实结果。失败时保留原始回显。</p>
      </el-alert>
      <el-form label-width="100px" class="dshot-form">
        <el-form-item label="命令">
          <el-select v-model="dshotAction" style="width: 180px">
            <el-option v-for="item in dshotActions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="设备"><el-input v-model="dshotDevice" style="width: 180px" /></el-form-item>
        <el-form-item label="通道">
          <el-radio-group v-model="dshotScope"
            ><el-radio value="all">全部（-a）</el-radio><el-radio value="mask">掩码（-c）</el-radio></el-radio-group
          >
          <el-input
            v-if="dshotScope === 'mask'"
            v-model="dshotMask"
            style="width: 100px; margin-left: 12px"
            placeholder="f"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="warning" :disabled="!canSendDshot" @click="sendDshot">发送 DShot 命令</el-button>
          <span class="dshot-reply">{{ dshotReply || '尚未发送' }}</span>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="status-card" shadow="hover" style="margin-top: 20px">
      <template #header
        ><div class="card-header">
          <span class="title">控制台应答与实际输出</span
          ><el-tag size="small" :type="servos.online ? 'success' : 'info'">{{
            servos.online ? 'SERVO_OUTPUT_RAW 正常' : '无输出遥测'
          }}</el-tag>
        </div></template
      >
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="链路">{{ mav.connected.value ? '已连接' : '未连接' }}</el-descriptions-item>
        <el-descriptions-item label="解锁状态">{{
          mav.vehicle.armed ? '已解锁（禁止）' : '未解锁'
        }}</el-descriptions-item>
        <el-descriptions-item label="控制台状态">{{ sessionBusy ? '持续命令运行中' : '空闲' }}</el-descriptions-item>
        <el-descriptions-item label="最近回显"
          ><span class="text-muted">{{ lastReply || '—' }}</span></el-descriptions-item
        >
        <el-descriptions-item label="回读" :span="2"
          ><el-button size="small" :disabled="!mav.connected.value || sessionBusy" @click="readOutputs"
            >act get -d main_out -c f</el-button
          ><span class="readback">{{ readback || '未读取' }}</span></el-descriptions-item
        >
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onUnmounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { inject } from 'vue'
import PrototypeNotice from './PrototypeNotice.vue'
import TaskHeader from './task-header.vue'
import DangerZone from './danger-zone.vue'
import { actGetCommand, actSetCommand, dshotCommand, CONSOLE_REPLY } from '../utils/console-session.js'

import { motorSafetyAllowed, motorResultState } from '../utils/operation-safety.js'
const emit = defineEmits(['motor-test-state'])
const propsRemoved = ref(false)
const mountSecured = ref(false)
const testState = ref({ active: false, uncertain: false, phase: 'idle', reason: '' })
let disposed = false
let motorCommandPending = false
let promptSeen = false
let stopRequested = false
let replyBuffer = ''
function publishState(state) {
  testState.value = state
  emit('motor-test-state', { ...state })
}
const mav = inject('mavlink')
const globalMotorSafety = inject('motorTestSafety', null)
function globalUncertain() {
  return !!(globalMotorSafety?.value?.uncertain ?? globalMotorSafety?.uncertain)
}
const motors = reactive([1, 2, 3, 4].map((id) => ({ id, throttle: 0 })))
const allThrottle = ref(0)
const runningMotor = ref(null)
const lastReply = ref('')
const readback = ref('')
const activeTimer = ref(null)
const dshotAction = ref('reverse')
const dshotDevice = ref('main_out')
const dshotScope = ref('all')
const dshotMask = ref('f')
const dshotReply = ref('')
const dshotActions = [
  { value: 'reverse', label: '反转方向' },
  { value: 'normal', label: '正常方向' },
  { value: 'save', label: '保存到电调' },
  { value: 'beep1', label: '蜂鸣 1' },
  { value: 'beep2', label: '蜂鸣 2' },
  { value: 'beep3', label: '蜂鸣 3' },
  { value: 'beep4', label: '蜂鸣 4' },
  { value: 'beep5', label: '蜂鸣 5' },
]
const servos = mav.data.servos
const sessionBusy = ref(mav.session.state.busy)
const unsubscribeSession = mav.session.subscribe((event) => {
  if (event.type === 'state') sessionBusy.value = event.state.busy
  if (event.type === 'cancel' && motorCommandPending) stopRequested = true
  if (event.type === 'rx' && motorCommandPending) {
    replyBuffer += event.text
    if (CONSOLE_REPLY.actRunning.test(replyBuffer) && !stopRequested)
      publishState({ active: true, uncertain: false, phase: 'running', reason: '收到持续输出回显' })
    if (CONSOLE_REPLY.prompt.test(replyBuffer)) {
      promptSeen = true
      publishState(motorResultState({ promptSeen: true, connected: mav.connected.value }))
    }
  }
})
watch(
  () => mav.connected.value,
  (connected) => {
    if (!connected && (motorCommandPending || testState.value.active))
      publishState(motorResultState({ reason: '测试期间断链，无法确认停止' }))
  }
)
const noticeItems = [
  '仅允许飞控未解锁时操作；固件也会再次拒绝已解锁命令，拒绝回显原样保留。',
  '开始前显式发送 mcn suspend control_output；act set 停止后由固件恢复控制输出。',
  '收到 Press any key to stop... 只证明 act 会话已进入持续输出，不等于电机安全或转速已达目标。',
  '自动限时停止、停止按钮和 Ctrl+C 都只是向控制台发送停止字符；链路断开时飞控可能继续输出。',
]
function servoPwm(id) {
  if (!servos.online) return null
  const v = servos.raw[id - 1]
  return v > 0 ? v : null
}
function servoText(v) {
  return v == null ? '--' : `${v} μs`
}
function throttleValue(percent) {
  return Math.round(1000 + Number(percent || 0) * 10)
}
function safetyAllowed() {
  return motorSafetyAllowed({
    canWrite: mav.canWrite.value,
    armed: mav.vehicle.armed,
    propsRemoved: propsRemoved.value,
    mountSecured: mountSecured.value,
  })
}
function canStart(id) {
  return (
    safetyAllowed() &&
    !globalUncertain() &&
    !testState.value.uncertain &&
    !sessionBusy.value &&
    !starting.value &&
    (id == null || motors.some((motor) => motor.id === id))
  )
}
const starting = ref(false)
function assertSafety() {
  if (disposed || globalUncertain() || !safetyAllowed())
    throw new Error('必须满足安全写入、未解锁、桨已拆除、电机座已固定')
}
async function prepare() {
  if (!mav.canOperate.value) throw new Error('飞控链路未确认在线')
  assertSafety()
  const r = await mav.session.run('mcn suspend control_output', {
    until: CONSOLE_REPLY.prompt,
    timeoutMs: 2500,
    idleMs: 0,
  })
  if (!r.ok) throw new Error(`未确认控制输出已暂停：${r.reason}`)
}
async function start(command, id = null) {
  if (!canStart(id)) return
  starting.value = true
  try {
    await prepare()
    assertSafety()
    motorCommandPending = true
    promptSeen = false
    stopRequested = false
    replyBuffer = ''
    publishState({ active: false, uncertain: true, phase: 'awaiting-output', reason: '已请求输出，等待真实回显' })
    const p = mav.session.hold(command, { until: CONSOLE_REPLY.actRunning, timeoutMs: 12000, idleMs: 0 })
    runningMotor.value = id
    activeTimer.value = setTimeout(() => mav.session.cancel('auto-stop'), 10000)
    const result = await p
    lastReply.value = result.text || result.reason
    publishState(
      motorResultState({ promptSeen, connected: mav.connected.value, reason: `停止未确认：${result.reason}` })
    )
  } catch (e) {
    ElMessage.error(e.message || String(e))
    if (motorCommandPending) publishState(motorResultState({ reason: e.message }))
  } finally {
    if (activeTimer.value) clearTimeout(activeTimer.value)
    activeTimer.value = null
    runningMotor.value = null
    motorCommandPending = false
    starting.value = false
  }
}
function toggleMotor(id) {
  if (runningMotor.value === id) {
    mav.session.cancel('operator-stop')
    return
  }
  const value = throttleValue(motors.find((m) => m.id === id).throttle)
  void start(actSetCommand({ device: 'main_out', mask: 1 << (id - 1), channels: [value], values: [value] }), id)
}
function startAllMotor() {
  void start(actSetCommand({ device: 'main_out', all: throttleValue(allThrottle.value) }))
}
function stopAllMotor() {
  mav.session.cancel('operator-stop')
}
const canSendDshot = computed(
  () =>
    safetyAllowed() &&
    !globalUncertain() &&
    !testState.value.uncertain &&
    !starting.value &&
    !sessionBusy.value &&
    /^[a-z0-9_]+$/i.test(dshotDevice.value) &&
    (dshotScope.value === 'all' || /^[0-9a-f]+$/i.test(dshotMask.value))
)
async function sendDshot() {
  if (!canSendDshot.value) return
  try {
    const command = dshotCommand({
      command: dshotAction.value,
      device: dshotDevice.value,
      all: dshotScope.value === 'all',
      mask: dshotMask.value,
    })
    assertSafety()
    const result = await mav.session.run(command, { until: CONSOLE_REPLY.dshotSent, timeoutMs: 3500, idleMs: 0 })
    dshotReply.value = result.text || result.reason
    lastReply.value = dshotReply.value
    if (!result.ok) ElMessage.warning(`DShot 未确认成功：${result.reason}`)
  } catch (e) {
    dshotReply.value = e.message || String(e)
    ElMessage.error(dshotReply.value)
  }
}
async function readOutputs() {
  try {
    const r = await mav.session.run(actGetCommand(), { until: CONSOLE_REPLY.prompt })
    readback.value = r.text || r.reason
    lastReply.value = r.text || r.reason
  } catch (e) {
    ElMessage.error(e.message || String(e))
  }
}
onUnmounted(() => {
  disposed = true
  if (activeTimer.value) clearTimeout(activeTimer.value)
  if (motorCommandPending) {
    publishState(motorResultState({ reason: '离开电机页，停止仍须现场确认' }))
    mav.session.cancel('page-unmount')
  }
  unsubscribeSession()
})
</script>

<style scoped>
.esc-calibrate-page {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}
.top-tip {
  margin-bottom: 12px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.title {
  font-weight: bold;
  font-size: 15px;
  color: var(--dsh-text-1);
}
.motor-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 10px 0;
}
.motor-item {
  padding: 12px;
  border: 1px solid var(--dsh-border);
  border-radius: 6px;
  background: var(--dsh-surface-2);
}
.safety-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px;
  color: var(--dsh-text-2);
}
.motor-running {
  border-color: var(--dsh-accent);
  box-shadow: 0 0 0 2px var(--dsh-accent-soft);
}
.motor-label {
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
}
.motor-name {
  font-weight: bold;
  font-size: 16px;
  color: var(--dsh-text-1);
}
.live-pwm,
.readback {
  font: 12px monospace;
  color: var(--dsh-success);
  margin-left: 12px;
  white-space: pre-wrap;
}
.motor-actions {
  display: flex;
  margin-top: 10px;
  gap: 8px;
}
.throttle-input {
  flex: 1;
}
.all-test-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.full-slider {
  flex: 1;
}
.dshot-form {
  margin-top: 16px;
}
.dshot-reply {
  margin-left: 12px;
  color: var(--dsh-text-2);
  font: 12px monospace;
  white-space: pre-wrap;
}
.text-muted {
  color: var(--dsh-text-2);
  white-space: pre-wrap;
}
@media (max-width: 768px) {
  .motor-grid {
    grid-template-columns: 1fr;
  }
  .esc-calibrate-page {
    padding: 10px;
  }
  .all-test-bar {
    flex-wrap: wrap;
  }
}
</style>
