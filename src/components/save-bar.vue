<template>
  <div class="save-bar" :class="{ 'sb-open': open }">
    <div class="sb-drawer-label" v-if="!open && pendingTotal">配置事务 · {{ pendingTotal }} 项待保存</div>
    <!-- 明细：展开时才占地方，平时只留右下角这一条，不挡主内容 -->
    <div v-show="open" class="sb-panel">
      <div class="sb-head">
        <span class="sb-title">机载配置与运行参数</span>
        <el-tag size="small" :type="stateTag.type" effect="dark">{{ stateTag.text }}</el-tag>
        <span class="sb-spacer" />
        <el-button size="small" text :loading="pulling" :disabled="busyNow" @click="doPull"> 重新读取 </el-button>
      </div>

      <!-- 两个文件各自的账：远端大小、下载那一刻的 CRC32、本地待保存改动数 -->
      <div v-for="row in rows" :key="row.key" class="sb-file" :class="{ 'sb-dirty': row.dirty }">
        <div class="sb-line1">
          <span class="sb-name" :title="row.remote">{{ row.label }}</span>
          <el-tag v-if="row.dirty" size="small" type="warning" effect="plain">待保存 {{ row.changes }}</el-tag>
          <el-tag v-else-if="!row.loaded" size="small" type="danger" effect="plain">拿不到</el-tag>
          <el-tag v-else size="small" type="success" effect="plain">与飞控一致</el-tag>
        </div>
        <div class="sb-line2">
          <span>{{ row.key === 'param' ? '存储快照' : '飞控' }} {{ row.sizeText }}</span>
          <span>{{ row.key === 'param' ? '快照 CRC32' : 'CRC32' }} {{ row.crcText }}</span>
          <span>本地 {{ row.localText }}</span>
        </div>
        <!-- 拦截原因必须原样显示：这条闸门存在的意义就是"不许悄悄不让你保存" -->
        <div v-if="row.gate && !row.gate.allowed" class="sb-block">
          {{ row.gate.reason }}
        </div>
        <div v-else-if="row.gate && row.gate.warn" class="sb-warn">{{ row.gate.warn }}</div>
        <div v-if="row.error" class="sb-err">{{ row.error }}</div>
      </div>

      <!-- 参数命令及回读不提供百分比；仅显示 FTP 上报的真实上传进度。 -->
      <TaskProgress
        v-if="saving"
        :title="progressTitle"
        :description="progressText"
        :percentage="saveStage === 'uploading' ? percent : null"
        :total="saveStage === 'uploading' ? saveFileTotal : null"
        unit="个文件"
      />

      <!-- 结果只认回读校验过的证据：本地 CRC32 与飞控回读 CRC32 并列显示 -->
      <div v-for="r in results" :key="r.key" class="sb-result" :class="r.ok ? 'rs-ok' : 'rs-bad'">
        {{ r.line }}
      </div>
      <div v-if="professionalNote" class="sb-note">{{ professionalNote }}</div>
      <div v-if="noteLines.length" class="sb-note">
        <div v-for="(n, i) in noteLines" :key="i">{{ n }}</div>
      </div>

      <div class="sb-actions">
        <el-button
          size="small"
          type="primary"
          :loading="saving"
          :disabled="!canSave"
          :title="canSave ? '' : saveDisabledReason"
          @click="doSave"
        >
          <el-icon><Upload /></el-icon>&nbsp;保存到飞控{{ pendingTotal ? ` (${pendingTotal})` : '' }}
        </el-button>
        <el-button size="small" :disabled="!pendingTotal || saving" @click="doDiscard">
          <el-icon><RefreshLeft /></el-icon>&nbsp;放弃改动
        </el-button>
        <span class="sb-note">运行参数保存后无需重启；系统配置校验通过后自动重启并重连</span>
      </div>
    </div>

    <!-- 折叠态：右下角一个会报数的条。没数据也要说清是没读到，不能一片灰让人以为坏了 -->
    <div
      class="sb-pill"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      title="点开看两个机载配置文件的读取与待保存情况"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
      @keydown.space.prevent="open = !open"
    >
      <el-badge v-if="pendingTotal" :value="pendingTotal" :max="99" class="sb-badge">
        <span class="sb-pill-text">全局保存</span>
      </el-badge>
      <span v-else class="sb-pill-text">全局保存</span>
      <span class="sb-pill-brief">{{ briefText }}</span>
      <span class="sb-pill-state" :class="'st-' + stateTag.type">{{ stateTag.text }}</span>
      <el-icon class="sb-caret"><ArrowDown v-if="open" /><ArrowUp v-else /></el-icon>
    </div>
  </div>
</template>

<script setup>
// src/components/save-bar.vue
// ================================================================
// 右下角全局保存条（开发计划 §三 S1）
// ----------------------------------------------------------------
// 为什么是"全局"而不是每页一个保存按钮：
//   遥控 / 端口 / PID / 传感器这些页改的是**同一份内存文档**（stores/fcconfig.js）。
//   每页各存各的，最后保存的人会把别人的改动静默盖掉；只有一个出口才能把
//   "这次到底要写回什么"说清楚，所以下面所有页面都只改文档，写盘只认这里。
//
// 保存分两条路径：运行参数先 param set 写 RAM、param save 持久化，再 FTP 下载验证；
// sysconfig.toml 保留完整文件上传、CRC32 回读、重启重连与重新读取。
// 混合事务必须先验证参数成功；任何保存失败都不能启动重启。
// ================================================================
import { computed, inject, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowUp, RefreshLeft, Upload } from '@element-plus/icons-vue'
import TaskProgress from './task-progress.vue'

const mav = inject('mavlink')
const fc = inject('fcconfig')
const emit = defineEmits(['saved', 'save-failed'])
function showPanel() {
  open.value = true
}
defineExpose({ save: doSave, showPanel })

/* 首次出现默认展开：用户抱怨"只有一个灰色的全局保存"就是因为折叠态什么都没露出来。
   收起的选择记住（只记这一个偏好，不拿它当功能开关）。 */
const OPEN_KEY = 'dsh.save-bar.open'
const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(OPEN_KEY) : null
const open = ref(saved === null ? true : saved === 'true')
watch(open, (v) => {
  try {
    localStorage.setItem(OPEN_KEY, String(v))
  } catch {
    /* 隐私模式下写不进去，不影响功能 */
  }
})
const saving = ref(false)
const percent = ref(null)
const progressText = ref('')
const results = ref([])
const saveStage = ref('preparing')
const saveFileTotal = ref(null)
const noteLines = ref([])
const progressTitle = computed(
  () =>
    ({
      'parameter-writing': '写入运行参数',
      'parameter-persisting': '持久化运行参数',
      'parameter-verifying': '回读验证运行参数',
      uploading: '上传系统配置文件',
      verifying: '回读校验系统配置',
      reconnecting: '重启与重连',
      reloading: '重新读取机载配置',
    })[saveStage.value] || '准备保存'
)
const professionalNote = computed(() => {
  if (!changeTotal.value) return ''
  return fc.files.sysconfig?.dirty
    ? '运行参数先写入并持久化验证；系统配置整文件回读校验通过后自动重启并重连。'
    : '运行参数写入 RAM 后持久化，并下载快照验证；无需重启飞控。'
})

const KEYS = [
  { key: 'param', label: '运行参数' },
  { key: 'sysconfig', label: 'sysconfig.toml' },
]

const pulling = computed(() => fc.busy === 'pulling')
const busyNow = computed(() => !!fc.busy)

/** 每个文件一行的账。gate 是 store 的 previewSave 给的，界面不自己猜规则。 */
const rows = computed(() =>
  KEYS.map((k) => {
    const st = fc.files[k.key] || {}
    const gate = preview.value.byKey[k.key] || null
    return {
      key: k.key,
      label: k.key === 'param' ? k.label : st.label || k.label,
      remote: st.remote || '',
      loaded: !!st.loaded,
      dirty: !!st.dirty,
      error: st.error || '',
      changes: (st.changes || []).length,
      sizeText: st.size ? `${st.size} 字节` : '—',
      crcText: st.crc32Hex || '—',
      localText:
        k.key === 'param'
          ? `${(st.changes || []).length} 项待保存`
          : gate
            ? `${gate.bytes} 字节`
            : st.dirty
              ? '计算中…'
              : '与飞控相同',
      gate,
    }
  })
)

/**
 * 预检：每次状态变化都重算一遍（纯函数，只是数一下字节）。
 * 界面用它回答"现在能不能保存、不能保存是因为哪个文件"。
 */
const preview = computed(() => fc.previewSave())

const pendingTotal = computed(() => rows.value.reduce((n, r) => n + r.changes, 0))
const changeTotal = computed(() => fc.changeList.length)

/** 折叠态也要报数：两个文件各自从飞控读到多少字节，一眼看出配置到底进没进内存。 */
const briefText = computed(() => {
  if (pulling.value) return '读取中…'
  const parts = rows.value.map((r) => {
    if (!r.loaded) return `${r.label} 未读到`
    return `${r.label.replace(/\.(toml|xml)$/, '')} ${r.sizeText}`
  })
  return parts.join(' · ')
})

const canSave = computed(() => !!preview.value.ready && !!mav.canWrite.value && !saving.value)
const saveDisabledReason = computed(() =>
  !mav.canWrite.value ? '飞控未确认安全在线或已解锁，禁止覆盖配置' : preview.value.error || '没有待保存的改动'
)

const stateTag = computed(() => {
  if (pulling.value) return { type: 'info', text: '正在读取' }
  if (saving.value) return { type: 'primary', text: '正在保存' }
  const blocked = (preview.value.blocked || []).length
  if (blocked) return { type: 'danger', text: `${blocked} 个文件不许回传` }
  if (pendingTotal.value) return { type: 'warning', text: `${pendingTotal.value} 处改动待保存` }
  if (!fc.loaded) return { type: 'info', text: '配置未就绪' }
  return { type: 'success', text: '已与飞控一致' }
})

async function doPull() {
  const r = await fc.pullAll()
  if (r.ok) ElMessage.success('两份配置文件已重新读取并核对完整')
  else ElMessage.error(r.error || '重新读取失败')
}

async function doSave() {
  if (saving.value || busyNow.value || !mav.canWrite.value) return
  const plan = preview.value
  if (!plan.ready) {
    ElMessage.error(plan.error || '现在不能保存')
    return
  }
  saving.value = true
  results.value = []
  noteLines.value = []
  percent.value = null
  saveFileTotal.value = plan.allowed.filter((item) => item.key === 'sysconfig').length || null
  saveStage.value = 'preparing'
  progressText.value = '准备保存运行参数与系统配置…'

  try {
    const r = await fc.saveAll({
      onStage: ({ key, stage }) => {
        saveStage.value = stage
        percent.value = null
        const descriptions = {
          'parameter-writing': '正在通过 RAM shell param set 写入运行参数；进度未上报',
          'parameter-persisting': '正在执行 param save 持久化运行参数；进度未上报',
          'parameter-verifying': '正在通过 FTP 下载参数快照并验证持久化值；进度未上报',
          uploading: '正在上传 sysconfig.toml…',
          verifying: '正在整文件回读 sysconfig.toml 并核对 CRC32；校验进度未上报',
        }
        progressText.value = descriptions[stage] || `正在保存 ${key === 'param' ? '运行参数' : '系统配置'}…`
      },
      onProgress: ({ key, progress }) => {
        // 参数命令不提供可量化进度；不把参数阶段算成已上传文件。
        if (key !== 'sysconfig' || saveStage.value !== 'uploading') return
        percent.value = Number.isFinite(progress) ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : null
        progressText.value = '正在上传 sysconfig.toml，随后整份回读校验'
      },
    })
    Object.entries(r.results || {}).forEach(([key, v]) => {
      const label = (KEYS.find((k) => k.key === key) || {}).label || key
      if (v.ok && v.method === 'param-save' && v.persisted === true) {
        results.value.push({ key, ok: true, line: `✅ ${label}：${v.count} 项已写入、持久化并回读验证，无需重启` })
      } else if (v.ok && key === 'sysconfig') {
        results.value.push({
          key,
          ok: true,
          line: `✅ ${label}：${v.size} 字节已写入，本地 CRC32 ${v.localCrc32}＝飞控回读 ${v.remoteCrc32 || '（未回读）'}`,
        })
      } else {
        results.value.push({ key, ok: false, line: `❌ ${label}：${v.error || '保存未验证成功'}` })
      }
    })
    ;(r.blocked || []).forEach((b) => {
      const label = b.key === 'param' ? '运行参数' : b.label
      results.value.push({ key: b.key || b.remote || b.label, ok: false, line: `⛔ ${label}：${b.reason}` })
    })
    noteLines.value = (r.notes || []).slice()
    if (r.ok && !fc.hasChanges) {
      if (r.needsReboot === true) {
        saveStage.value = 'reconnecting'
        progressText.value = '系统配置保存校验通过，正在重启并自动重连…'
        const stageLabels = {
          'sending-reboot': '正在发送重启命令…',
          'waiting-offline': '等待飞控重启…',
          reconnecting: '正在重新打开已授权串口…',
          'waiting-heartbeat': '等待重启后的新心跳…',
          online: '新心跳已确认',
          cancelled: '自动重连已取消',
          failed: '自动重连失败',
        }
        const result = await mav.rebootAndReconnect({
          onStage: (stage) => {
            progressText.value = stageLabels[stage] || String(stage)
          },
        })
        if (!result?.ok) throw new Error('重启重连未确认成功')
        saveStage.value = 'reloading'
        progressText.value = '新心跳已确认，正在重新读取机载配置…'
        const refreshed = await fc.reloadAfterReconnect()
        if (!refreshed.ok) throw new Error(`飞控已重连，但配置重读失败：${refreshed.error || fc.lastPullError}`)
        ElMessage.success('配置已保存，飞控已重连并重新读取配置')
      } else {
        ElMessage.success('运行参数已保存并持久化验证，无需重启飞控')
      }
      emit('saved')
    } else {
      ElMessage.error(r.error || '部分配置未保存，未重启飞控')
      emit('save-failed')
    }
  } catch (e) {
    // saveAll 内部捕获保存失败，走到这里说明是意料之外的错：原样带出来，不粉饰
    const failure = `保存或重启重连失败：${e?.message || e}`
    noteLines.value = [failure]
    open.value = true
    ElMessage.error(failure)
    emit('save-failed')
  } finally {
    saving.value = false
  }
}

function doDiscard() {
  try {
    fc.discardAll()
  } catch (error) {
    ElMessage.error(error?.message || '无法还原改动')
    return
  }
  results.value = []
  noteLines.value = []
  ElMessage.info('已放弃本地改动，回到下载时的原文')
}
</script>

<style scoped>
.sb-drawer-label {
  position: absolute;
  right: 0;
  bottom: 100%;
  margin-bottom: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--dsh-warning-soft);
  color: var(--dsh-warning);
  font-size: 11px;
  white-space: nowrap;
}
.save-bar {
  z-index: 2000;
  width: auto;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  min-width: 0;
}
.sb-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  box-sizing: border-box;
  width: min(560px, calc(100vw - 24px));
  max-height: min(62vh, 560px);
  overflow-y: auto;
  background: var(--dsh-surface);
  border: 1px solid var(--dsh-border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 18%);
  padding: 8px 10px;
}
.sb-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.sb-title {
  font-weight: 600;
  font-size: 13px;
}
.sb-spacer {
  flex: 1;
}
.sb-file {
  border-top: 1px dashed var(--dsh-divider);
  padding: 5px 0;
  font-size: 12px;
}
.sb-file.sb-dirty {
  background: color-mix(in srgb, var(--dsh-warning) 12%, var(--dsh-surface));
}
.sb-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sb-name {
  font-weight: 600;
}
.sb-line2 {
  display: flex;
  gap: 10px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
  flex-wrap: wrap;
}
.sb-block,
.sb-err {
  color: var(--el-color-danger);
  margin-top: 3px;
  line-height: 1.5;
}
.sb-warn {
  color: var(--el-color-warning);
  margin-top: 3px;
  line-height: 1.5;
}
.sb-progress-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.sb-result {
  font-size: 12px;
  line-height: 1.5;
  margin-top: 4px;
  word-break: break-all;
}
.rs-ok {
  color: var(--el-color-success);
}
.rs-bad {
  color: var(--el-color-danger);
}
.sb-note {
  font-size: 12px;
  color: var(--el-color-warning);
  margin-top: 5px;
  line-height: 1.6;
}
.sb-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.sb-pill {
  width: clamp(280px, 32vw, 460px);
  max-width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  padding: 5px 10px;
  border-radius: 16px;
  cursor: pointer;
  font-size: 12px;
  background: var(--dsh-surface);
  border: 1px solid var(--dsh-border);
  box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
  align-self: flex-end;
  width: fit-content;
}
.sb-pill-text {
  font-weight: 600;
}
.sb-pill:hover {
  border-color: var(--dsh-accent-hi);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--dsh-accent) 34%, transparent);
}
.sb-pill:focus-visible {
  outline: 2px solid var(--dsh-accent);
  outline-offset: 2px;
}
.sb-pill-brief {
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-pill-state {
  color: var(--el-text-color-secondary);
}
.st-danger {
  color: var(--el-color-danger);
}
.st-warning {
  color: var(--el-color-warning);
}
.st-success {
  color: var(--el-color-success);
}
.sb-badge :deep(.el-badge__content) {
  top: 6px;
}
.sb-caret {
  font-size: 12px;
}
</style>
