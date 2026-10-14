<template>
  <main class="safety-page">
    <TaskHeader
      eyebrow="电池与电源"
      title="电池"
      description="查看电池读数并调整设备已有的校准参数；修改后需保存到飞控。"
      ><el-tag type="info" effect="plain">遥测 / 条件配置</el-tag></TaskHeader
    >
    <div class="safety-grid">
      <section class="safety-card">
        <header>
          <h2>SYS_STATUS 电池遥测</h2>
          <el-tag :type="battery.fresh ? 'success' : 'warning'" size="small">{{ battery.label }}</el-tag>
        </header>
        <div class="metrics">
          <article>
            <span>电压</span><strong>{{ number(battery.voltage, 'V') }}</strong>
          </article>
          <article>
            <span>电流</span><strong>{{ number(battery.current, 'A') }}</strong>
          </article>
          <article>
            <span>剩余电量</span><strong>{{ number(battery.remaining, '%', 0) }}</strong>
          </article>
        </div>
        <EvidenceLine label="来源" value="SYS_STATUS" :detail="battery.label" />
        <div class="telemetry-status" role="status" aria-live="polite">
          <strong>{{
            battery.fresh ? '已收到新鲜电池遥测' : battery.held ? '暂无更新 / 上一帧' : '等待有效电池遥测'
          }}</strong>
          <p>暂无更新时保留本会话上一帧有效读数，并非实时数据；首次未收到有效帧显示“—”，断开或切换设备后清空。</p>
        </div>
        <p class="note">无效读数显示“—”；遥测读数不代表电源传感器已完成校准。</p>
      </section>
      <section class="safety-card">
        <header>
          <h2>校准证据与能力边界</h2>
          <el-tag type="warning" size="small">未验证</el-tag>
        </header>
        <EvidenceLine label="传感器校准" value="未知 / 未验证" detail="当前遥测与参数存在不证明传感器已完成校准" />
        <p class="note">电芯数、容量及校准系数需按实际电池与电源模块确认；本页不根据电压推算这些设置。</p>
        <p class="note">按对应板型官方说明，用独立仪表核对读数；确认字段来源和单位后，再在完整参数页审阅。</p>
        <a href="https://docs.sieon.net/product/calibrate_battery.md" target="_blank" rel="noopener noreferrer"
          >官方电池校准说明（补充参考，示例不是本设备默认值）↗</a
        >
      </section>
      <section class="safety-card discovery">
        <header>
          <h2>已存在的 POWER 校准 / 电池配置</h2>
          <el-tag type="info" size="small">仅修改内存</el-tag>
        </header>
        <p class="note">
          仅当下载文档已有精确字段时显示。来源为上游 POWER
          定义，需核对当前固件兼容性；不预填示例或默认值，不以配置存在宣称已校准。
        </p>
        <a
          href="https://raw.githubusercontent.com/Firmament-Autopilot/FMT-Firmware/master/src/module/pmu/power_manage.c"
          target="_blank"
          rel="noopener noreferrer"
          >POWER 字段上游来源 ↗</a
        >
        <div
          v-for="field in editable"
          :key="field.focus"
          :data-search-key="field.focus"
          tabindex="-1"
          class="field-row"
        >
          <div>
            <EvidenceLine :label="field.label" :value="field.name" :detail="field.unit" /><code
              >当前文档：{{ safetyValue(field.value) }}</code
            ><el-input
              v-model="drafts[field.focus]"
              :disabled="!editAllowed"
              :placeholder="'输入新值，不预填'"
              :aria-label="field.label"
            />
          </div>
          <el-button
            :disabled="!editAllowed || !validateSafetyInput(field, drafts[field.focus]).ok"
            @click="stage(field)"
            >修改内存</el-button
          >
        </div>
        <EmptyStateAction
          v-if="!editable.length"
          title="未发现来源确认的 POWER 字段"
          description="不创建缺失项，也不生成校准值；可查看完整参数与板型文档。"
        />
        <p class="note">{{ editMessage || '运行参数通过 param save 保存，无需重启；系统配置按全局流程另行处理。' }}</p>
      </section>
      <section class="safety-card discovery">
        <header>
          <h2>已加载文档 · 相关字段</h2>
          <el-tag type="info" size="small">{{ fields.length }} 项 · 只读</el-tag>
        </header>
        <p class="note">
          仅按实际字段名 / 分组匹配
          battery、power、电压、电流等词。原名原值不代表已知单位、范围或动作语义；显示内存文档值，未必已保存到飞控。
        </p>
        <div v-for="field in fields" :key="field.focus" class="field-row">
          <div>
            <EvidenceLine :label="field.file" :value="field.name" :detail="field.group" /><code>{{
              safetyValue(field.value)
            }}</code>
          </div>
          <router-link :to="field.route">参数页定位 →</router-link>
        </div>
        <EmptyStateAction
          v-if="!fields.length"
          title="没有发现相关字段"
          description="当前已加载的配置中没有相关字段；可查看完整参数或设备说明。"
          action-label="打开参数页"
          @action="$router.push('/parameter')"
        />
      </section>
      <section class="safety-card discovery">
        <header><h2>下一步与资料</h2></header>
        <nav class="links">
          <router-link to="/parameter">完整参数</router-link><router-link to="/port">端口配置</router-link
          ><router-link to="/rc">接收机</router-link><router-link to="/preflight">飞行前检查</router-link>
        </nav>
        <div class="sources">
          <a href="https://docs.sieon.net/fmt/#/content_ch/" target="_blank" rel="noopener noreferrer"
            >FMT 官方文档入口 ↗</a
          ><a href="https://docs.sieon.net/product/" target="_blank" rel="noopener noreferrer">产品资料入口 ↗</a>
        </div>
        <p class="note">请按当前设备型号与固件版本核对资料。</p>
      </section>
    </div>
  </main>
</template>
<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import TaskHeader from './task-header.vue'
import EmptyStateAction from './empty-state-action.vue'
import EvidenceLine from './evidence-line.vue'
import {
  batteryEvidence,
  heldSafetyFrame,
  discoverSafetyFields,
  safetyValue,
  knownSafetyFields,
  validateSafetyInput,
} from '../utils/safety-page-state.js'
const mav = inject('mavlink'),
  fc = inject('fcconfig')
const now = ref(Date.now())
let timer
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 500)
})
onUnmounted(() => clearInterval(timer))
const batteryFrame = ref(null)
// 会话变化立即清空；遥测在本轮字段更新完成后采样，避免拼接两帧。
watch(
  () => [mav.connected.value, mav.deviceState.sessionId],
  () => {
    batteryFrame.value = null
  },
  { flush: 'sync' }
)
watch(
  () => [
    mav.connected.value,
    mav.deviceState.sessionId,
    mav.deviceState.connectedAt,
    mav.canOperate.value,
    mav.deviceState.valid.battery,
    mav.deviceState.freshness.battery,
    mav.data.battery?.source,
    mav.data.battery?.voltage,
    mav.data.battery?.current,
    mav.data.battery?.percent,
    now.value,
  ],
  () => {
    const evidence = batteryEvidence({
      connected: mav.connected.value,
      canOperate: mav.canOperate.value,
      valid: mav.deviceState.valid.battery,
      stamp: mav.deviceState.freshness.battery,
      battery: mav.data.battery,
      now: now.value,
    })
    const frame = { voltage: evidence.voltage, current: evidence.current, remaining: evidence.remaining }
    batteryFrame.value = heldSafetyFrame(batteryFrame.value, {
      connected: mav.connected.value,
      sessionId: mav.deviceState.sessionId,
      sessionStartedAt: mav.deviceState.connectedAt,
      stamp: mav.deviceState.freshness.battery,
      now: now.value,
      valid: evidence.fresh && Object.values(frame).some((value) => value !== null),
      frame,
    })
  },
  { immediate: true }
)
const battery = computed(() => ({
  ...batteryFrame.value,
  ...(batteryFrame.value?.frame || { voltage: null, current: null, remaining: null }),
}))
const fields = computed(() => {
  void fc.revision
  return discoverSafetyFields(fc, 'power')
})
const editable = computed(() => {
  void fc.revision
  return knownSafetyFields(fc, 'power')
})
const drafts = ref({}),
  editMessage = ref('')
watch(
  () => [fc.restoreRevision, mav.connected.value, mav.deviceState.sessionId],
  () => {
    drafts.value = {}
    editMessage.value = ''
  }
)
const editAllowed = computed(() => mav.connected.value && mav.canWrite.value && !fc.busy)
function stage(field) {
  if (!editAllowed.value) return
  const existing = knownSafetyFields(fc, 'power').find((item) => item.focus === field.focus)
  const checked = validateSafetyInput(existing, drafts.value[field.focus])
  if (!existing || !checked.ok) {
    editMessage.value = checked.reason || '字段已失效'
    return
  }
  try {
    fc.setParam(existing.group, existing.name, checked.value)
    delete drafts.value[field.focus]
    editMessage.value = `${existing.name} 已修改内存，尚未保存到飞控；请使用统一保存栏。`
  } catch (error) {
    editMessage.value = error.message || String(error)
  }
}
function number(value, unit, digits = 2) {
  return value === null ? '—' : `${value.toFixed(digits)} ${unit}`
}
</script>
<style scoped>
.telemetry-status {
  box-sizing: border-box;
  min-height: 88px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--dsh-border);
  border-radius: var(--dsh-radius);
  background: var(--dsh-surface-2);
}
.telemetry-status strong {
  display: block;
  font-size: 12px;
  line-height: 20px;
}
.telemetry-status p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsh-text-2);
}
.metrics strong {
  display: block;
  min-height: 28px;
  white-space: nowrap;
}
.safety-card header .el-tag {
  flex-shrink: 0;
  min-width: 132px;
  justify-content: center;
}
.safety-card :deep(.evidence) {
  min-height: 24px;
}
.safety-page {
  padding: var(--dsh-gap-lg, 20px);
  background: var(--dsh-canvas);
  min-height: 100%;
  color: var(--dsh-text-1);
}
.safety-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.safety-card {
  padding: 16px;
  border: 1px solid var(--dsh-border);
  border-radius: var(--dsh-radius, 8px);
  background: var(--dsh-surface);
  min-width: 0;
}
.safety-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 14px;
}
.safety-card h2 {
  font-size: 14px;
  margin: 0;
}
.discovery {
  grid-column: 1/-1;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}
.metrics article {
  padding: 12px 8px;
  background: var(--dsh-surface-2);
  border: 1px solid var(--dsh-border);
  border-radius: 6px;
}
.metrics span {
  display: block;
  color: var(--dsh-text-3);
  font-size: 12px;
  margin-bottom: 6px;
}
.metrics strong {
  font: 600 21px var(--dsh-font-mono);
  font-variant-numeric: tabular-nums;
}
.note {
  font-size: 12px;
  line-height: 1.7;
  color: var(--dsh-text-2);
}
a {
  color: var(--dsh-accent);
  font-size: 12px;
  text-underline-offset: 3px;
}
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--dsh-border);
}
.field-row > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.field-row a {
  flex-shrink: 0;
}
.field-row code {
  display: block;
  margin-top: 5px;
  color: var(--dsh-text-2);
  overflow-wrap: anywhere;
}
.links,
.sources {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
}
.links a {
  padding: 10px 14px;
  border: 1px solid var(--dsh-border);
  border-radius: 6px;
  background: var(--dsh-surface-2);
  text-decoration: none;
}
.sources {
  margin-top: 14px;
}
@media (max-width: 760px) {
  .safety-grid {
    grid-template-columns: 1fr;
  }
  .metrics strong {
    font-size: 17px;
  }
  .field-row {
    align-items: flex-start;
  }
}
</style>
