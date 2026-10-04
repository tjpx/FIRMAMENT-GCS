<template>
  <main class="safety-page">
    <TaskHeader eyebrow="链路与保护" title="失控保护" description="查看飞控心跳、接收机消息与已有保护配置；链路状态不能确认返航、降落或停机动作。"><el-tag type="warning" effect="plain">保护动作未知</el-tag></TaskHeader>
    <div class="safety-grid">
      <section class="safety-card"><header><h2>地面站 ↔ 飞控 HEARTBEAT</h2><el-tag :type="heartbeat.fresh ? 'success' : 'warning'" size="small">{{ heartbeat.label }}</el-tag></header><EvidenceLine label="接收状态" :value="heartbeat.frame?.received || '—'" :detail="heartbeat.label" /><EvidenceLine label="当前链路状态" :value="live.heartbeat.healthy ? '心跳正常' : '未确认健康'" /><p class="note">暂无更新时接收状态保留上一帧，并非实时数据；断开或切换设备后清空。这是地面站接收到的飞控心跳。心跳超时不等于机载接收机失控，也不能证明返航、降落或停机已经发生。</p></section>
      <section class="safety-card"><header><h2>RC_CHANNELS 消息</h2><el-tag :type="rc.fresh ? 'success' : 'warning'" size="small">{{ rc.label }}</el-tag></header><EvidenceLine label="接收状态" :value="rc.frame?.received || '—'" :detail="rc.label" /><EvidenceLine label="机载 RC 失控判定" value="未知 / 未提供可靠判据" /><p class="note">暂无更新时接收状态保留上一帧，并非实时数据；断开或切换设备后清空。RC 消息新鲜度与地面站心跳独立。消息到达不证明接收机链路安全；不由 RSSI 或通道值推断机载失控状态。</p><router-link to="/rc">查看接收机原始输入 →</router-link></section>
      <section class="safety-card discovery"><header><h2>保护动作与触发条件</h2><el-tag type="warning" size="small">不可用 / 未知</el-tag></header><EmptyStateAction title="当前不能确认机载保护动作" description="当前设备未提供可确认的保护策略和动作回报。请核对对应固件说明；本页不提供主动失控测试。" evidence="保护动作未确认；不以 HEARTBEAT 丢失代替机载 RC 失控证据" /></section>
      <section class="safety-card discovery"><header><h2>已存在的 FMS 控制链路失联返航配置</h2><el-tag type="info" size="small">仅修改内存</el-tag></header><p class="note">上游多旋翼 FMS 定义：计时可由 GCS 或 pilot 更新重置，不是 RC 专用超时；返航还依赖 INS 等条件。字段存在和使能不证明当前保护已触发或能安全返航。仅在当前文档已有精确项时可编辑。</p><div class="sources"><a href="https://raw.githubusercontent.com/Firmament-Autopilot/FMT-Firmware/master/src/model/fms/mc_fms/fms_interface.c" target="_blank" rel="noopener noreferrer">FMS 字段类型来源 ↗</a><a href="https://raw.githubusercontent.com/Firmament-Autopilot/FMT-Firmware/master/src/model/fms/mc_fms/lib/FMS.c" target="_blank" rel="noopener noreferrer">FMS 计时与条件实现 ↗</a></div><div v-for="field in editable" :key="field.focus" :data-search-key="field.focus" tabindex="-1" class="field-row"><div><EvidenceLine :label="field.label" :value="field.name" :detail="field.unit" /><code>当前文档：{{ safetyValue(field.value) }}</code><el-input v-model="drafts[field.focus]" :disabled="!editAllowed" placeholder="输入新值，不预填" :aria-label="field.label" /></div><el-button :disabled="!editAllowed || !validateSafetyInput(field, drafts[field.focus]).ok" @click="stage(field)">修改内存</el-button></div><EmptyStateAction v-if="!editable.length" title="未发现来源确认的 FMS 字段" description="不创建缺失项，不生成假定的保护动作或超时。" /><p class="note">{{ editMessage || '运行参数通过 param save 保存，无需重启；系统配置按全局流程另行处理。' }}</p></section>
      <section class="safety-card discovery"><header><h2>已加载文档 · 相关字段与元数据</h2><el-tag type="info" size="small">{{ fields.length }} 项 · 只读</el-tag></header><p class="note">仅列出实际字段名 / 分组包含 failsafe、loss 等词的项；原名原值不表示已知单位或保护动作。SYSTEM/OBC_HEARTBEAT 仅作实际元数据，不能解释为失控超时或动作。显示内存文档值，未必已保存。</p>
        <div v-for="field in fields" :key="field.focus" class="field-row"><div><EvidenceLine :label="field.file" :value="field.name" :detail="field.metadata ? 'SYSTEM 元数据；非失控策略定义' : field.group" /><code>{{ safetyValue(field.value) }}</code></div><router-link :to="field.route">参数页定位 →</router-link></div>
        <EmptyStateAction v-if="!fields.length" title="没有发现相关字段" description="当前已加载的配置中没有相关字段；可查看完整参数或设备说明。" action-label="打开参数页" @action="$router.push('/parameter')" />
      </section>
      <section class="safety-card"><header><h2>拆桨地面验证 · 人工清单</h2><el-tag type="info" size="small">只读清单</el-tag></header><ol class="checklist"><li>移除所有螺旋桨，确保未解锁，固定机体并清空运动部件周围区域。</li><li>先核对设备、固件版本和对应官方说明，备份配置并记录预期策略。</li><li>按板型官方安全流程，在地面分别验证接收机链路与地面站链路；观察机载实际回报，不能只看本页消息颜色。</li><li>记录触发条件、实际动作和恢复过程；不明确或不符合预期时停止使用并排查。</li><li>恢复正常链路、重新核对配置，并完成飞行前检查。</li></ol><p class="note">本页不会发送断链、解锁、电机或失控测试命令；人工清单不是自动验证通过记录。</p></section>
      <section class="safety-card"><header><h2>下一步与官方资料</h2></header><nav class="links"><router-link to="/parameter">完整参数</router-link><router-link to="/port">端口配置</router-link><router-link to="/rc">接收机</router-link><router-link to="/preflight">飞行前检查</router-link></nav><div class="sources"><a href="https://docs.sieon.net/fmt/#/content_ch/" target="_blank" rel="noopener noreferrer">FMT 官方文档入口 ↗</a><a href="https://docs.sieon.net/product/" target="_blank" rel="noopener noreferrer">产品资料入口 ↗</a></div><p class="note">请按当前设备型号与固件版本核对保护策略。</p></section>
    </div>
  </main>
</template>
<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import TaskHeader from './task-header.vue'
import EmptyStateAction from './empty-state-action.vue'
import EvidenceLine from './evidence-line.vue'
import { discoverSafetyFields, failsafeEvidence, heldSafetyFrame, safetyValue, knownSafetyFields, validateSafetyInput } from '../utils/safety-page-state.js'
const mav = inject('mavlink'), fc = inject('fcconfig')
const now = ref(Date.now()); let timer
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 500) })
onUnmounted(() => clearInterval(timer))
const live = computed(() => failsafeEvidence({ connected: mav.connected.value, heartbeatAt: mav.deviceState.heartbeat.lastAt, heartbeatHealthy: mav.deviceState.heartbeat.healthy, rcAt: mav.deviceState.freshness.rc, rcValid: mav.deviceState.valid.rc, now: now.value }))
const heartbeat = ref(null), rc = ref(null)
// 保留的只是接收记录；健康标记与写入条件仍由实时状态计算。
watch(() => [mav.connected.value, mav.deviceState.sessionId], () => { heartbeat.value = null; rc.value = null }, { flush: 'sync' })
watch(() => [mav.connected.value, mav.deviceState.sessionId, mav.deviceState.connectedAt, mav.deviceState.heartbeat.lastAt, mav.deviceState.freshness.rc, mav.deviceState.valid.rc, now.value], () => {
  const context = { connected: mav.connected.value, sessionId: mav.deviceState.sessionId, sessionStartedAt: mav.deviceState.connectedAt, now: now.value }
  heartbeat.value = heldSafetyFrame(heartbeat.value, { ...context, stamp: mav.deviceState.heartbeat.lastAt, valid: live.value.heartbeat.fresh, frame: { received: '已收到有效心跳' } })
  rc.value = heldSafetyFrame(rc.value, { ...context, stamp: mav.deviceState.freshness.rc, valid: live.value.rc.fresh, frame: { received: '已收到有效 RC 消息' } })
}, { immediate: true })
const fields = computed(() => { void fc.revision; return discoverSafetyFields(fc, 'failsafe') })
const editable = computed(() => { void fc.revision; return knownSafetyFields(fc, 'failsafe') })
const drafts = ref({}), editMessage = ref('')
watch(() => [fc.restoreRevision, mav.connected.value, mav.deviceState.sessionId], () => { drafts.value = {}; editMessage.value = '' })
const editAllowed = computed(() => mav.connected.value && mav.canWrite.value && !fc.busy)
function stage(field) {
  if (!editAllowed.value) return
  const existing = knownSafetyFields(fc, 'failsafe').find(item => item.focus === field.focus)
  const checked = validateSafetyInput(existing, drafts.value[field.focus])
  if (!existing || !checked.ok) { editMessage.value = checked.reason || '字段已失效'; return }
  try { fc.setParam(existing.group, existing.name, checked.value); delete drafts.value[field.focus]; editMessage.value = `${existing.name} 已修改内存，尚未保存到飞控；请使用统一保存栏。` } catch (error) { editMessage.value = error.message || String(error) }
}
</script>
<style scoped>
.safety-card header .el-tag{flex-shrink:0;min-width:132px;justify-content:center}.safety-card :deep(.evidence){min-height:24px}
.safety-page{padding:var(--dsh-gap-lg,20px);background:var(--dsh-canvas);min-height:100%;color:var(--dsh-text-1)}.safety-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.safety-card{padding:16px;border:1px solid var(--dsh-border);border-radius:var(--dsh-radius,8px);background:var(--dsh-surface);min-width:0}.safety-card header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px}.safety-card h2{font-size:14px;margin:0}.discovery{grid-column:1/-1}.note,.checklist{font-size:12px;line-height:1.7;color:var(--dsh-text-2)}.checklist{padding-left:20px;margin-bottom:0}.checklist li{margin:8px 0}a{color:var(--dsh-accent);font-size:12px;text-underline-offset:3px}.field-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--dsh-border)}.field-row>div{min-width:0;overflow-wrap:anywhere}.field-row a{flex-shrink:0}.field-row code{display:block;margin-top:5px;color:var(--dsh-text-2);overflow-wrap:anywhere}.links,.sources{display:flex;flex-wrap:wrap;gap:10px 18px}.links a{padding:10px 14px;border:1px solid var(--dsh-border);border-radius:6px;background:var(--dsh-surface-2);text-decoration:none}.sources{margin-top:14px}@media(max-width:760px){.safety-grid{grid-template-columns:1fr}.field-row{align-items:flex-start}}
</style>
