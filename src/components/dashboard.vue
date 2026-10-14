<template>
  <div class="dashboard">
    <div class="dashboard-hero">
      <div>
        <div class="dashboard-kicker">FLIGHT CONTROL CENTER</div>
        <h1>飞控状态总览</h1>
        <p>实时姿态、电池、定位与链路健康</p>
      </div>
      <el-tag size="large" effect="dark" :type="mav.connected.value ? 'success' : 'info'">{{
        mav.connected.value ? 'ONLINE' : 'OFFLINE'
      }}</el-tag>
    </div>
    <div class="dashboard-grid">
      <div class="drone-viewer">
        <Aircraft3D
          :roll="mav.data.attitude.roll"
          :pitch="mav.data.attitude.pitch"
          :yaw="mav.data.attitude.yaw"
          :throttle="mav.data.vfrHud.throttle"
        />
        <!-- 两块仪表同半径：罗盘贴左边、姿态盘贴右边，各自垂直居中在模型两侧 -->
        <div class="instruments">
          <div class="instrument instrument--left"><CompassDial :heading="headingValue" :valid="headingValid" /></div>
          <div class="instrument instrument--right">
            <AttitudeInstrument :roll="mav.data.attitude.roll" :pitch="mav.data.attitude.pitch" :valid="attitudeEver" />
          </div>
        </div>
      </div>
      <div class="dashboard-summary">
        <el-card class="stat-card"
          ><div class="stat-label">
            姿态<span class="attitude-note">{{ attitudeNote }}</span>
          </div>
          <div class="stat-row">
            <span>Roll / Pitch</span
            ><span
              class="stat-val dsh-num"
              v-flash-on-change="flash('attitude', `${mav.data.attitude.roll}/${mav.data.attitude.pitch}`)"
              >{{ deg(mav.data.attitude.roll) }} / {{ deg(mav.data.attitude.pitch) }}</span
            >
          </div>
          <div class="stat-row">
            <span>Yaw</span
            ><span class="stat-val dsh-num" v-flash-on-change="flash('attitude', mav.data.attitude.yaw)">{{
              deg(mav.data.attitude.yaw)
            }}</span>
          </div>
          <div class="stat-row">
            <span>角速度 P/Q/R</span
            ><span class="stat-val dsh-num" :title="`来自 ${mav.attitudeSource.label}`">{{
              attitudeEver
                ? `${rate(mav.data.attitude.rollspeed)} / ${rate(mav.data.attitude.pitchspeed)} / ${rate(mav.data.attitude.yawspeed)} °/s`
                : '—'
            }}</span>
          </div></el-card
        >
      </div>
    </div>
    <el-row :gutter="8" class="dashboard-row">
      <el-col :span="8"
        ><el-card class="stat-card"
          ><div class="stat-label">电池</div>
          <div class="stat-row">
            <span>电压</span
            ><span class="stat-val dsh-num" v-flash-on-change="flash('battery', mav.data.battery.voltage)"
              >{{ mav.data.battery.voltage.toFixed(2) }} V</span
            >
          </div>
          <div class="stat-row">
            <span>电流</span
            ><span class="stat-val dsh-num" v-flash-on-change="flash('battery', mav.data.battery.current)"
              >{{ mav.data.battery.current.toFixed(2) }} A</span
            >
          </div>
          <div class="stat-row">
            <span>电量</span
            ><span class="stat-val dsh-num" v-flash-on-change="flash('battery', mav.data.battery.percent)">{{
              mav.data.battery.percent >= 0 ? mav.data.battery.percent + '%' : '未知'
            }}</span>
          </div>
          <el-progress :percentage="batteryPct" :color="batteryColor" /></el-card
      ></el-col>
      <el-col :span="8"
        ><el-card class="stat-card"
          ><div class="stat-label">GPS</div>
          <div class="stat-row">
            <span>定位</span><span class="stat-val">{{ mav.data.gps.fixLabel }}</span>
          </div>
          <div class="stat-row">
            <span>卫星</span
            ><span class="stat-val dsh-num" v-flash-on-change="flash('gps', mav.data.gps.satellitesVisible)">{{
              mav.data.gps.satellitesVisible
            }}</span>
          </div>
          <div class="stat-row">
            <span>HDOP</span
            ><span class="stat-val dsh-num" v-flash-on-change="flash('gps', mav.data.gps.hdop)">{{
              mav.data.gps.hdop.toFixed(2)
            }}</span>
          </div>
          <div class="stat-row">
            <span>相对高度</span><span class="stat-val dsh-num">{{ relAlt }} m</span>
          </div></el-card
        ></el-col
      >
      <el-col :span="8"
        ><el-card class="stat-card"
          ><div class="stat-label">连接</div>
          <div class="stat-row">
            <span>状态</span
            ><el-tag size="small" :type="mav.connected.value ? 'success' : 'info'">{{
              mav.connected.value ? '已连接' : '未连接'
            }}</el-tag>
          </div>
          <div class="stat-row">
            <span>SYS / COMP</span
            ><span class="stat-val dsh-num">{{ mav.vehicle.sysid }} / {{ mav.vehicle.compid }}</span>
          </div>
          <div class="stat-row">
            <span>波特率</span><span class="stat-val dsh-num">{{ mav.baudRate }}</span>
          </div></el-card
        ></el-col
      >
    </el-row>
  </div>
</template>
<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Aircraft3D from './aircraft-3d.vue'
import AttitudeInstrument from './attitude-instrument.vue'
import CompassDial from './compass-dial.vue'
import { freshnessState } from '../utils/safety-page-state.js'
const mav = inject('mavlink')
// 姿态读数优先走 ATTITUDE_QUATERNION（msgid 31，本固件数传推的就是它），只有飞控不推四元数时
// 才降级到 ATTITUDE（msgid 30）——优先级与转换都在 useMavlink 里（utils/attitude-quat.js）。
// 数传帧率低、丢帧多，所以这里做「永久保留」：本页面只要收到过至少一帧姿态，就一直显示最后一帧数值，
// 不再因为超过 3 秒、或链路短暂掉线重连而退回「—」——data.attitude 从不被清空，resetDeviceState 也不清它。
// 「—」只留给整个访问期间从未收到过姿态这一种情况（用 attitudeEver 闩锁判定，绝不把初值 0 冒充平飞）。
// 徽标仍诚实区分实时/上一帧：now 由本地秒级 tick 推进（设备 ticker 只动 heartbeat.ageMs），
// freshnessState 用 safety-page-state 的 3 秒口径判是否「实时」，仅影响这一行文字、不影响数值显隐。
const now = ref(Date.now())
let attitudeTicker = null
onMounted(() => {
  attitudeTicker = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (attitudeTicker) window.clearInterval(attitudeTicker)
})
// 闩锁：本页面存活期间收到过姿态就永久为真（immediate 让切回本页时已连上的会话也能立刻点着）。
const attitudeEver = ref(false)
watch(
  () => mav.deviceState.valid.attitude,
  (v) => {
    if (v === true) attitudeEver.value = true
  },
  { immediate: true }
)
const attitudeLive = computed(() =>
  freshnessState(
    mav.deviceState.freshness.attitude,
    now.value,
    mav.deviceState.valid.attitude === true,
    mav.connected.value === true
  )
)
// 来源标注：告诉用户这份姿态到底来自哪条消息、以及权威源是不是还在推
const attitudeNote = computed(() => {
  const src = mav.attitudeSource
  if (src.authority === 'none') return attitudeEver.value ? `上一帧 · ${src.label}` : '未收到姿态数据'
  if (src.stale) return `最后已知 · ${src.label}（已静默）`
  if (attitudeLive.value.fresh) return `实时 · ${src.label}`
  return `上一帧 · ${src.label}`
})
// 一旦收到过就永久显示最后一帧；只有整个访问期间从未收到姿态才回到「—」。
const deg = (value) => (attitudeEver.value ? `${Number(value ?? 0).toFixed(1)}°` : '—')
// 角速度三轴：四元数与欧拉角两条通道都带 rollspeed/pitchspeed/yawspeed，单位已在链路层换成 °/s
const rate = (value) => Number(value ?? 0).toFixed(1)
/* 姿态盘上的航向：优先 VFR_HUD 的 heading（本固件周期发送），没有就退回 GPS 航向，
   再没有就用姿态偏航角；三者都没有时给占位符，不拿初值 0 冒充正北。 */
const headingValue = computed(() => {
  if (mav.deviceState.valid.vfrHud) return mav.data.vfrHud.heading
  if (mav.deviceState.valid.gps) return mav.data.gps.heading
  return mav.data.attitude.yaw
})
const headingValid = computed(() => mav.deviceState.valid.vfrHud || mav.deviceState.valid.gps || attitudeEver.value)
function flash(key, value) {
  return {
    value,
    enabled: mav.canOperate.value && mav.deviceState.valid[key] === true,
    stamp: mav.deviceState.freshness[key],
    session: mav.deviceState.sessionId,
  }
}
const relAlt = computed(() => (mav.data.gps.relAlt || mav.data.altitude.relative || 0).toFixed(1))
const batteryPct = computed(() => Math.max(0, mav.data.battery.percent))
const batteryColor = computed(() => {
  const p = mav.data.battery.percent
  return p < 0 ? 'var(--dsh-placeholder)' : p > 20 ? 'var(--dsh-success)' : 'var(--dsh-danger-vivid)'
})
</script>
<style scoped>
.dashboard {
  padding: 10px;
  background: linear-gradient(135deg, var(--dsh-canvas), color-mix(in srgb, var(--dsh-accent) 4%, var(--dsh-canvas)));
}
.dashboard-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding: 14px 18px;
  border: 1px solid var(--dsh-border);
  border-radius: 10px;
  background: var(--dsh-surface);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--dsh-text-1) 5%, transparent);
}
.dashboard-kicker {
  font: 11px var(--dsh-font-mono);
  letter-spacing: 0.16em;
  color: var(--dsh-accent);
}
.dashboard-hero h1 {
  margin: 3px 0;
  font-size: 22px;
}
.dashboard-hero p {
  margin: 0;
  color: var(--dsh-text-3);
  font-size: 12px;
}
.dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 0.55fr);
  gap: 8px;
}
.drone-viewer {
  position: relative;
  height: 25vh;
  min-height: 240px;
  max-height: 320px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--dsh-console-bg);
}
.instruments {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.instrument {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
}
.instrument--left {
  left: 6px;
  width: 182px;
  height: 182px;
}
.instrument--right {
  right: 6px;
  width: 226px;
  height: 226px;
}
.dashboard-summary {
  display: grid;
  gap: 8px;
}
.dashboard-row {
  margin-top: 8px;
}
.stat-card {
  margin-bottom: 0;
}
.dashboard :deep(.el-card__body) {
  padding: 12px;
}
.stat-label {
  font-weight: bold;
  margin-bottom: 6px;
  color: var(--dsh-accent-ink);
}
.attitude-note {
  margin-left: 6px;
  font-weight: 400;
  font-size: 11px;
  color: var(--dsh-text-3);
}
.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 13px;
}
.stat-val {
  font-weight: 600;
}
.dashboard-summary .stat-val.dsh-num {
  font-size: var(--dsh-font-lg);
  line-height: 1.25;
}
@media (max-width: 900px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
  .dashboard-summary {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 600px) {
  .dashboard-summary {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 430px) {
  .instrument--left {
    left: 2px;
    width: 116px;
    height: 116px;
  }
  .instrument--right {
    right: 2px;
    width: 150px;
    height: 150px;
  }
}
</style>
