<template>
  <section class="monitor">
    <TaskHeader
      eyebrow="M5 / TELEMETRY INSPECTOR"
      title="监控与消息检查"
      description="只显示来自当前 MAVLink 会话的实时数据；未连接时不补造状态。"
    >
      <el-tag :type="online ? 'success' : 'info'">{{ online ? 'ONLINE' : 'OFFLINE' }}</el-tag
      ><el-button size="small" :disabled="!hasData" @click="exportJson">导出诊断 JSON</el-button>
    </TaskHeader>

    <el-alert
      v-if="!online"
      type="info"
      :closable="false"
      show-icon
      title="等待真实链路"
      description="请先连接飞控。消息速率、状态告警和链路统计将在收到数据后出现。"
    />
    <div class="stats-grid">
      <el-card v-for="item in linkCards" :key="item.label" class="metric-card">
        <div class="metric-label">{{ item.label }}</div>
        <strong
          v-flash-on-change="counterFlash(item.numeric ? item.value : null)"
          :class="{ 'dsh-num': item.numeric }"
          >{{ item.value }}</strong
        ><small>{{ item.detail }}</small>
      </el-card>
    </div>

    <el-row :gutter="10" class="main-row">
      <el-col :span="15"
        ><el-card class="panel">
          <template #header
            ><div class="panel-title">
              <span>消息普查</span><span class="muted">{{ snapshotAge }}</span>
            </div></template
          >
          <div class="filters">
            <el-input v-model="query" size="small" clearable placeholder="按消息名或 msgid 筛选" /><el-select
              v-model="rateFilter"
              size="small"
              ><el-option label="全部速率" value="all" /><el-option label="仅有流量" value="active" /><el-option
                label="无流量"
                value="idle"
            /></el-select>
          </div>
          <ResponsiveDataTable
            ><template #table
              ><el-table
                :data="filteredCensus"
                size="small"
                max-height="410"
                empty-text="尚未收到可统计的 MAVLink 消息"
              >
                <el-table-column prop="name" label="消息" min-width="180"
                  ><template #default="{ row }"
                    ><span class="mono">{{ row.name }}</span
                    ><span class="sub dsh-num">#{{ row.msgid }}</span></template
                  ></el-table-column
                >
                <el-table-column prop="rate" label="速率" width="105"
                  ><template #default="{ row }"
                    ><span class="dsh-num">{{ row.rate === null ? '—' : row.rate.toFixed(2) + ' Hz' }}</span></template
                  ></el-table-column
                >
                <el-table-column prop="delta" label="窗口条数" width="105"
                  ><template #default="{ row }"
                    ><span class="dsh-num">{{ row.delta }}</span></template
                  ></el-table-column
                ><el-table-column prop="rx" label="累计" width="90"
                  ><template #default="{ row }"
                    ><span class="dsh-num" v-flash-on-change="counterFlash(row.rx)">{{ row.rx }}</span></template
                  ></el-table-column
                >
                <el-table-column label="状态" width="85"
                  ><template #default="{ row }"
                    ><el-tag size="small" :type="row.rate > 0 ? 'success' : 'info'">{{
                      row.rate > 0 ? '接收中' : '静默'
                    }}</el-tag></template
                  ></el-table-column
                >
              </el-table></template
            ><template #cards
              ><div v-for="row in filteredCensus" :key="`card-${row.msgid}`" class="message-card">
                <EvidenceLine label="消息" :value="`${row.name} #${row.msgid}`" />
                <div class="evidence">
                  <span class="muted">速率</span
                  ><strong class="dsh-num">{{ row.rate === null ? '—' : `${row.rate.toFixed(2)} Hz` }}</strong
                  ><small
                    >窗口 <span class="dsh-num">{{ row.delta }}</span> · 累计
                    <span class="dsh-num" v-flash-on-change="counterFlash(row.rx)">{{ row.rx }}</span></small
                  >
                </div>
              </div>
              <EmptyStateAction
                v-if="!filteredCensus.length"
                title="尚未收到 MAVLink 消息"
                description="消息普查等待当前会话的真实数据。"
                evidence="msgCensus 为空" /></template
          ></ResponsiveDataTable> </el-card
      ></el-col>
      <el-col :span="9"
        ><el-card class="panel timeline-panel">
          <template #header
            ><div class="panel-title">
              <span>状态告警时间线</span><span class="muted">{{ statusLogs.length }} / 50</span>
            </div></template
          >
          <el-timeline v-if="statusLogs.length"
            ><el-timeline-item
              v-for="(entry, i) in reversedLogs"
              :key="entry.time + '-' + i"
              :timestamp="formatTime(entry.time)"
              :type="severityType(entry.severity)"
              >{{ entry.text || '（空消息）'
              }}<span class="sub"
                >SYS {{ entry.sysid ?? '—' }} · {{ severityLabel(entry.severity) }}</span
              ></el-timeline-item
            ></el-timeline
          >
          <EmptyStateAction
            v-else
            title="尚无状态告警"
            reason="当前会话尚未收到 STATUSTEXT；空列表不代表飞控已通过安全检查。"
          /> </el-card
      ></el-col>
    </el-row>

    <el-card class="panel details"
      ><template #header
        ><div class="panel-title">
          <span>会话诊断</span><span class="muted">快照每 {{ SNAPSHOT_MS / 1000 }} 秒更新</span>
        </div></template
      >
      <div class="kv">
        <span>传输</span><b>{{ device.transport || '—' }}</b
        ><span>阶段</span><b>{{ device.phase || 'idle' }}</b
        ><span>SYS / COMP</span><b class="dsh-num">{{ mav.vehicle.sysid }} / {{ mav.vehicle.compid }}</b
        ><span>最后心跳</span><b class="dsh-num">{{ heartbeatAge }}</b
        ><span>会话</span><b>{{ device.sessionId || '—' }}</b
        ><span>错误</span><b class="error-text">{{ mav.error || device.error?.message || '无已报告错误' }}</b>
      </div>
    </el-card>
  </section>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import TaskHeader from './task-header.vue'
import ResponsiveDataTable from './responsive-data-table.vue'
import EmptyStateAction from './empty-state-action.vue'
import EvidenceLine from './evidence-line.vue'

const mav = inject('mavlink')
function counterFlash(value) {
  return {
    value,
    enabled: mav.canOperate.value && value !== null,
    stamp: mav.deviceState.lastRxAt,
    session: mav.deviceState.sessionId,
  }
}
const SNAPSHOT_MS = 2000
const query = ref('')
const rateFilter = ref('all')
const census = ref([])
const previous = ref(new Map())
const snapshotAt = ref(0)
let timer
const online = computed(() => mav?.connected?.value === true)
const device = computed(() => mav?.deviceState || {})
const statusLogs = computed(() => mav?.data?.statusLogs || [])
const reversedLogs = computed(() => [...statusLogs.value].reverse())
const hasData = computed(() => census.value.length > 0 || statusLogs.value.length > 0 || Number(mav?.stats?.rxMsgs) > 0)
const linkCards = computed(() => {
  const s = mav?.stats || {}
  return [
    { label: '接收消息', numeric: true, value: formatNumber(s.rxMsgs), detail: `${formatNumber(s.rxBytes)} bytes` },
    { label: '解析帧', numeric: true, value: formatNumber(s.frames), detail: `CRC 错误 ${formatNumber(s.crcErrors)}` },
    {
      label: '心跳',
      value: device.value.heartbeat?.healthy ? '健康' : device.value.heartbeat?.lastAt ? '超时' : '未收到',
      detail: heartbeatAge.value,
    },
    { label: '发现消息', numeric: true, value: census.value.length || '—', detail: snapshotAge.value },
  ]
})
const filteredCensus = computed(() =>
  census.value.filter((row) => {
    const q = query.value.trim().toLowerCase()
    return (
      (!q || row.name.toLowerCase().includes(q) || String(row.msgid).includes(q)) &&
      (rateFilter.value === 'all' || (rateFilter.value === 'active' ? row.rate > 0 : row.rate === 0))
    )
  })
)
const snapshotAge = computed(() => (snapshotAt.value ? `更新于 ${formatTime(snapshotAt.value)}` : '等待首个快照'))
const heartbeatAge = computed(() => {
  const age = device.value.heartbeat?.ageMs
  return age == null ? '—' : age < 1000 ? `${age} ms` : `${(age / 1000).toFixed(1)} s`
})
function formatNumber(v) {
  return Number.isFinite(Number(v)) ? Number(v).toLocaleString() : '—'
}
function formatTime(v) {
  return v ? new Date(v).toLocaleTimeString() : '—'
}
function severityType(v) {
  const n = Number(v)
  return n <= 2 ? 'danger' : n <= 4 ? 'warning' : 'primary'
}
function severityLabel(v) {
  return (
    { 0: 'EMERGENCY', 1: 'ALERT', 2: 'CRITICAL', 3: 'ERROR', 4: 'WARNING', 5: 'NOTICE', 6: 'INFO', 7: 'DEBUG' }[v] ||
    '未知等级'
  )
}
function takeSnapshot() {
  if (!mav?.msgCensus) return
  const now = Date.now()
  const old = previous.value
  const windowSec = SNAPSHOT_MS / 1000
  const rows = mav.msgCensus().map((item) => {
    const prior = old.get(item.msgid)
    const delta = prior == null ? 0 : Math.max(0, item.rx - prior)
    return { ...item, delta, rate: prior == null ? null : delta / windowSec }
  })
  previous.value = new Map(rows.map((r) => [r.msgid, r.rx]))
  census.value = rows.sort((a, b) => (b.rate || 0) - (a.rate || 0) || b.rx - a.rx)
  snapshotAt.value = now
}
function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    connected: online.value,
    vehicle: mav.vehicle,
    deviceState: device.value,
    linkStats: mav.stats,
    messages: census.value,
    statusLogs: statusLogs.value,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `m5-monitor-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}
onMounted(() => {
  takeSnapshot()
  timer = setInterval(takeSnapshot, SNAPSHOT_MS)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.monitor {
  padding: var(--dsh-gap-lg);
  background: var(--dsh-canvas);
  min-height: 100%;
  color: var(--dsh-text-1);
}
.monitor-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--dsh-gap);
}
h1 {
  margin: 2px 0;
  font-size: var(--dsh-font-2xl);
}
p,
.muted,
.sub,
small {
  color: var(--dsh-text-3);
  font-size: var(--dsh-font-sm);
}
.eyebrow {
  font: var(--dsh-font-xs) var(--dsh-font-mono);
  letter-spacing: 0.14em;
  color: var(--dsh-accent-ink);
}
.head-actions {
  display: flex;
  gap: var(--dsh-gap);
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--dsh-gap);
  margin: var(--dsh-gap) 0;
}
.metric-card strong {
  display: block;
  font-size: var(--dsh-font-lg);
  font-weight: 600;
  line-height: 1.25;
  margin: 5px 0;
}
.metric-label {
  color: var(--dsh-text-2);
  font-size: var(--dsh-font-sm);
}
.metric-card small {
  display: block;
}
.main-row {
  margin-top: var(--dsh-gap);
}
.panel {
  height: 100%;
}
.panel-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}
.filters {
  display: flex;
  gap: var(--dsh-gap);
  margin-bottom: var(--dsh-gap);
}
.filters .el-input {
  max-width: 280px;
}
.mono {
  font-family: var(--dsh-font-mono);
}
.evidence {
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex-wrap: wrap;
  font-size: var(--dsh-font-sm);
}
.evidence strong {
  font-weight: 600;
}
.sub {
  display: block;
  margin-top: 2px;
}
.timeline-panel :deep(.el-card__body) {
  max-height: 475px;
  overflow: auto;
}
.details {
  margin-top: var(--dsh-gap);
}
.kv {
  display: grid;
  grid-template-columns: repeat(6, max-content 1fr);
  gap: 8px 18px;
  align-items: center;
}
.error-text {
  color: var(--dsh-danger);
}
@media (max-width: 850px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .kv {
    grid-template-columns: max-content 1fr;
  }
  .main-row .el-col {
    margin-bottom: var(--dsh-gap);
  }
  .monitor-head {
    align-items: flex-start;
    gap: var(--dsh-gap);
    flex-direction: column;
  }
}
@media (max-width: 560px) {
  .stats-grid {
    grid-template-columns: 1fr 1fr;
  }
  .head-actions {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
