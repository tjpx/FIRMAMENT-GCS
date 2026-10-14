<!--
  src/components/cells.vue

  【已弃用 · 计划 D-8】
  本页整体弃用：路由与侧栏入口已摘除，电池页按 §三 S7 从零重写（连同单体电压、
  日志分析一起设计）。现有实现与采样代码不予继承——文件暂不删除，只为保留
  "SYS_STATUS 换算 percent/current 的真实做法（拿不到显示 --）"这段已验证逻辑，
  需要时从 git 历史取，不要在它上面继续加功能。
  ================================================================
  电池 / 低压保护页。

  数据来源：mav.data.battery —— 由 SYS_STATUS（飞控 1 Hz 推送）换算而来
    voltage：V（协议里是 mV，0 表示飞控没有电压上报）
    current：A（协议 10mA 单位）
    percent：SYS_STATUS.battery_remaining，INT8，-1 表示飞控不知道
  注意：本飞控不周期发送 BATTERY_STATUS，所以没有单体电压、没有剩余 mAh。
  页面里凡是协议给不出的量，一律显示 --，不用上一个值或随机数顶替。

  未接通：电池参数（分压系数、LVP 阈值）写入要走文件写通道（开发计划 S1 全局保存），
  所以本页不提供"已写入 EEPROM / 校准成功"这类结论。
-->

<template>
  <div class="battery-config-container">
    <!-- 顶部安全警告 -->
    <el-alert
      title="安全警告：请确保在连接电池前完成所有设置，错误的低电压保护值可能导致电池过放损坏或飞行事故。"
      type="error"
      :closable="false"
      show-icon
      class="mb-4"
    />

    <PrototypeNotice
      title="实时监控接的是 SYS_STATUS 真遥测；下方的保护值与校准系数目前只能本地编辑，写不回飞控"
      :items="noticeItems"
    />

    <el-row :gutter="20">
      <!-- 左侧：实时监控与校准 -->
      <el-col :xs="24" :lg="14">
        <el-card class="box-card" shadow="hover">
          <template #header>
            <div class="card-header">
              <span>电池状态实时监控</span>
              <el-tag :type="batteryStatus.type">{{ batteryStatus.text }}</el-tag>
            </div>
          </template>

          <!-- 电压曲线图 -->
          <div class="chart-wrapper">
            <canvas ref="voltageChartRef" height="200" />
            <div v-if="!hasBattery" class="chart-placeholder">未收到电池电压（SYS_STATUS.voltage_battery 为 0）</div>
          </div>

          <el-descriptions :column="3" border class="mt-4">
            <el-descriptions-item label="当前总电压">
              <span class="highlight-text">{{ textVol }} V</span>
            </el-descriptions-item>
            <el-descriptions-item label="单片平均"> {{ textCell }} V </el-descriptions-item>
            <el-descriptions-item label="剩余电量">
              {{ textPercent }}
            </el-descriptions-item>
            <el-descriptions-item label="当前电流"> {{ textAmp }} A </el-descriptions-item>
            <el-descriptions-item label="采样来源">
              {{ hasBattery ? 'SYS_STATUS（1 Hz）' : '--' }}
            </el-descriptions-item>
            <el-descriptions-item label="剩余容量 (mAh)">
              <span class="text-muted">--（本飞控不上报）</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-divider content-position="left">电池校准向导（流程提示）</el-divider>
          <div class="calibration-steps">
            <el-steps :active="calibStep" finish-status="success" align-center simple>
              <el-step title="零点确认" description="断开电池" />
              <el-step title="记录参考电压" description="接已知电压" />
              <el-step title="流程结束" description="未写入飞控" />
            </el-steps>

            <div class="step-action-area">
              <div v-if="calibStep === 0" class="step-content">
                <p>请断开所有电池连接，确认地面站读数降到 0V。</p>
                <p class="sub-label">当前读数：{{ textVol }} V</p>
                <el-button type="primary" @click="nextCalibStep">已断开，下一步</el-button>
              </div>
              <div v-if="calibStep === 1" class="step-content">
                <p>请连接一块已知电压的满电电池（例如 4S 16.8V），填入实测参考值。</p>
                <el-input-number v-model="manualRefVoltage" :precision="2" :step="0.1" class="mr-2" />
                <span class="unit">V (万用表实测)</span>
                <el-button type="success" class="ml-2" @click="finishCalibration">记录参考值</el-button>
              </div>
              <div v-if="calibStep === 2" class="step-content">
                <!-- 没有写入通道，就不能说"校准成功" -->
                <el-result icon="info" title="已记录到本页（未写入飞控）" :sub-title="calibSummary">
                  <template #extra>
                    <el-button @click="resetCalibration">重新校准</el-button>
                  </template>
                </el-result>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 右侧：保护参数设置 -->
      <el-col :xs="24" :lg="10">
        <el-card class="box-card" shadow="hover">
          <template #header>
            <div class="card-header">
              <span>低电压保护 (LVP)</span>
              <el-switch v-model="lvpEnabled" active-text="启用" />
            </div>
          </template>
          <el-form :model="lvpForm" label-width="120px" :disabled="!lvpEnabled">
            <el-form-item label="报警电压 (Warn)">
              <el-input-number v-model="lvpForm.warnVolt" :precision="2" :step="0.1" :min="0" />
              <span class="sub-label">每片电芯低于此值时蜂鸣器报警</span>
            </el-form-item>
            <el-form-item label="强制降落 (Land)">
              <el-input-number v-model="lvpForm.landVolt" :precision="2" :step="0.1" :min="0" />
              <span class="sub-label">触发后限制油门至 30%</span>
            </el-form-item>
            <el-form-item label="紧急切断 (Cut)">
              <el-input-number v-model="lvpForm.cutVolt" :precision="2" :step="0.1" :min="0" />
              <span class="sub-label text-danger">触发后立即关闭所有电机</span>
            </el-form-item>
            <el-form-item label="电芯数量 (Cells)">
              <el-radio-group v-model="lvpForm.cells">
                <el-radio-button :label="2">2S</el-radio-button>
                <el-radio-button :label="3">3S</el-radio-button>
                <el-radio-button :label="4">4S</el-radio-button>
                <el-radio-button :label="6">6S</el-radio-button>
              </el-radio-group>
              <span class="sub-label">用于换算总压阈值与单片均值，只影响本页判定</span>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card class="box-card mt-4" shadow="hover">
          <template #header>
            <div class="card-header">
              <span>失控保护 (Failsafe)</span>
              <el-tag type="info">RX Loss</el-tag>
            </div>
          </template>
          <el-form :model="fsForm" label-width="100px">
            <el-form-item label="触发延迟">
              <el-slider v-model="fsForm.delay" :max="5000" :step="100" show-input />
              <span class="sub-label">毫秒 (ms)</span>
            </el-form-item>
            <el-form-item label="保护动作">
              <el-select v-model="fsForm.action" class="w-full">
                <el-option label="自动降落 (Drop)" value="drop" />
                <el-option label="悬停等待 (Hover)" value="hover" />
                <el-option label="返航 (RTH)" value="rth" />
                <el-option label="断电 (Disarm)" value="disarm" />
              </el-select>
            </el-form-item>
            <el-form-item label="降落油门">
              <el-slider v-model="fsForm.throttle" :max="100" show-input />
              <span class="sub-label">百分比 (%)</span>
            </el-form-item>
          </el-form>
          <div class="card-footer">
            <el-button type="primary" class="w-full" @click="saveAllSettings">保存所有设置</el-button>
            <span class="sub-label">
              实际生效值请写进 /sys/sysconfig.toml 的电池与失控保护段，并用「参数配置」页上传（上传后地面站会回读 CRC32
              校验）。
            </span>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, inject } from 'vue'
import { ElMessage } from 'element-plus'
import Chart from 'chart.js/auto'
import PrototypeNotice from './PrototypeNotice.vue'

const mav = inject('mavlink')
const battery = mav.data.battery

const noticeItems = [
  '电压/电流/剩余电量取自 SYS_STATUS：飞控没上报时显示 --，不用随机数或旧值填充曲线。',
  '本飞控不周期发送 BATTERY_STATUS，因此没有单体电压与剩余 mAh，页面上这两项标注为不可得。',
  '电池校准系数与 LVP/Failsafe 阈值的写入依赖文件写通道（开发计划 S1）；接通前本页只做本地编辑，保存按钮不会假装写入飞控。',
]

// --- 状态定义 ---
const voltageChartRef = ref(null)
let chartInstance = null

/** 采样窗口：1 Hz 的 SYS_STATUS，留 60 点约一分钟 */
const MAX_POINTS = 60
const series = reactive({ labels: [], data: [] })

/* ---------- 读数格式化：拿不到就 -- ---------- */
// 结构体初值是 0，跟"飞控报了 0"长得一样；所以必须确认至少收到过一帧 SYS_STATUS
const sysStatusSeen = ref(false)
watch(
  () => mav.data.sysStatus,
  () => {
    sysStatusSeen.value = true
  },
  { deep: true }
)

const hasVoltage = computed(() => sysStatusSeen.value && battery.voltage > 0)
const hasPercent = computed(() => sysStatusSeen.value && Number.isFinite(battery.percent) && battery.percent >= 0)

const textVol = computed(() => (hasVoltage.value ? battery.voltage.toFixed(2) : '--'))
const textAmp = computed(() => (hasVoltage.value ? battery.current.toFixed(1) : '--'))
const textPercent = computed(() => (hasPercent.value ? `${battery.percent} %` : '--'))
const textCell = computed(() => {
  const n = lvpForm.cells > 0 ? lvpForm.cells : 0
  if (!hasVoltage.value || !n) return '--'
  return (battery.voltage / n).toFixed(3)
})

// 电池状态计算：没有电压读数就不能说"正常"
const batteryStatus = computed(() => {
  if (!hasVoltage.value) return { type: 'info', text: '无电池遥测' }
  const cell = battery.voltage / (lvpForm.cells || 1)
  if (cell < lvpForm.cutVolt) return { type: 'danger', text: '低于切断阈值' }
  if (cell < lvpForm.landVolt) return { type: 'warning', text: '低于降落阈值' }
  if (cell < lvpForm.warnVolt) return { type: 'warning', text: '低电压报警' }
  return { type: 'success', text: '正常' }
})

/* ---------- 电压曲线：只记真采样 ---------- */
watch(
  () => battery.voltage,
  (v) => {
    if (!(v > 0) || !chartInstance) return
    series.labels.push(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    series.data.push(Number(v.toFixed(3)))
    if (series.labels.length > MAX_POINTS) {
      series.labels.shift()
      series.data.shift()
    }
    if (chartInstance) {
      chartInstance.update('none')
    }
  }
)

onMounted(() => {
  // 这一段每一步都必须"可以失败"：canvas 取不到、Chart 构造抛异常，
  // 后果只能是没有曲线，不能让异常从生命周期钩子里冒出去——
  // 那会打断 Vue 的挂载/卸载流程，症状就是之后点哪个页面都切不过去。
  const el = voltageChartRef.value
  if (!el) {
    console.warn('[cells] 找不到电压曲线的 canvas 元素，跳过绘图')
    return
  }
  const ctx = el.getContext('2d')
  if (!ctx) {
    console.warn('[cells] canvas 2d 上下文获取失败，跳过绘图')
    return
  }
  try {
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [
          {
            label: '电池电压 (V)',
            data: series.data,
            /* 画布取色不吃 var()，从当前主题的 CSS 变量读一次（重建图表时重读） */
            borderColor:
              getComputedStyle(document.documentElement).getPropertyValue('--dsh-accent').trim() || '#66ccff',
            backgroundColor: 'rgba(64, 158, 255, 0.1)',
            tension: 0.4,
            fill: true,
            pointRadius: 0,
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          y: { grace: '10%', grid: { color: 'rgba(128,128,128,0.25)' } },
          x: { ticks: { maxTicksLimit: 6 } },
        },
        plugins: { legend: { display: false } },
      },
    })
  } catch (e) {
    // 建图失败时把实例留在 null，上面的 watch 回调会因此跳过刷新（已判空），
    // 曲线不出现，但页面其余部分和导航都必须还活着。
    chartInstance = null
    console.error('[cells] 电压曲线初始化失败：', e)
    ElMessage.error(`电压曲线初始化失败：${e?.message ?? e}`)
  }
})

onUnmounted(() => {
  // 图表实例必须销毁，否则切页后 canvas 与监听会一直留着
  if (chartInstance) {
    chartInstance.destroy()
    chartInstance = null
  }
})

/* ---------- 校准向导（本地记录，不写飞控） ---------- */
const calibStep = ref(0)
const manualRefVoltage = ref(16.8)
const observedAtRef = ref(null)

const calibSummary = computed(() => {
  if (observedAtRef.value === null) return '尚未记录参考电压'
  return `参考电压 ${manualRefVoltage.value.toFixed(2)} V 时飞控上报 ${observedAtRef.value.toFixed(2)} V；分压系数需写入飞控参数才会生效（本页未写入）`
})

const nextCalibStep = () => {
  if (calibStep.value < 2) calibStep.value++
}

const finishCalibration = () => {
  // 只把"参考值 vs 实测值"记下来供人工比对，不宣称算出并保存了系数
  observedAtRef.value = hasVoltage.value ? battery.voltage : null
  calibStep.value = 2
  ElMessage.info('已记录本页参考值（未向飞控写入任何系数）')
}

const resetCalibration = () => {
  calibStep.value = 0
  observedAtRef.value = null
}

/* ---------- 保护值：写回走参数页 ---------- */
const lvpEnabled = ref(true)
const lvpForm = reactive({
  warnVolt: 3.5,
  landVolt: 3.3,
  cutVolt: 3.0,
  cells: 4,
})

const fsForm = reactive({
  delay: 1000,
  action: 'drop',
  throttle: 15,
})

const saveAllSettings = () => {
  // 没有 SET_PARAMETER / 配置文件写回路径时，不能提示"已写入飞控 EEPROM"
  ElMessage.warning('写入通道未接通：请把这些值填到「参数配置」页的 sysconfig.toml 里上传，飞控侧才会生效')
}
</script>

<style scoped>
.battery-config-container {
  padding: 20px;
  max-width: 1400px;
  margin: 0 auto;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: bold;
}

.chart-wrapper {
  position: relative;
  height: 200px;
  width: 100%;
  background: rgba(0, 0, 0, 0.02);
  border-radius: 4px;
  padding: 10px;
}

/* 没数据时给一句人话，而不是画一条 16.8V 的假直线 */
.chart-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--dsh-text-3);
  pointer-events: none;
}

.highlight-text {
  color: var(--dsh-accent-ink);
  font-weight: bold;
  font-size: 1.1em;
}

.sub-label {
  display: block;
  font-size: 12px;
  color: var(--dsh-text-3);
  margin-top: 4px;
  line-height: 1.5;
}

.text-danger {
  color: var(--dsh-danger-vivid);
}

.text-muted {
  color: var(--dsh-placeholder);
}

.step-action-area {
  margin-top: 20px;
  text-align: center;
  min-height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.unit {
  margin-left: 8px;
  color: var(--dsh-text-2);
}

.w-full {
  width: 100%;
}

.mt-4 {
  margin-top: 16px;
}

.mb-4 {
  margin-bottom: 16px;
}

.mr-2 {
  margin-right: 8px;
}

.ml-2 {
  margin-left: 8px;
}

.card-footer {
  margin-top: 12px;
}

/* 暗色模式适配 */
[data-theme='dark'] .chart-wrapper {
  background: rgba(255, 255, 255, 0.05);
}
</style>
