<!--
  src/components/pid.vue
  ================================================================
  PID 调参页（S3）：编辑 /sys/param.xml 的 CONTROL 组

  与 S2 端口页同一套规矩，只是数据源换成了 param.xml：
    · 字段来自飞控原文：这一页显示的每一项都是 mapGroupToCards() 从下载下来的
      param.xml 里摊出来的，地面站不往里加飞控没有的东西（自测第 21 组核对）；
      飞控哪一项不存在（例如没有 VEL_X_P、没有 YAW_P），界面上就没有那个格子。
    · 连上飞控就自动读到：App.vue 首次心跳即拉取，本页不需要人去点"读取"。
    · 落笔即记账：每次改写走 fc.setParam()，一定在 changes() 里留一条 from→to，
      右下角「全局保存」的回传闸门要的就是这份清单。
    · 格式跟原文对齐：整数项写不了小数（写下去会把整数变成浮点写法），
      浮点项由 config-doc 按固件的 %f 六位小数回填，不会出现 0.05 这种"看着变了"的抖动。
  本页只改内存里的文档，要写回飞控请点右下角「全局保存」。
  ================================================================
-->
<template>
  <div class="pid-page">
    <TaskHeader eyebrow="PID / TUNING" title="PID 调参" description="编辑飞控 /sys/param.xml 的 CONTROL 组；修改只留在内存，统一保存后才写回飞控。" />
    <div class="page-head">
      <div class="head-left">
        <h2 class="pp-title">PID 调参</h2>
        <p class="pp-hint">
          编辑飞控 <code>/sys/param.xml</code> 的 <b>CONTROL</b> 组（共 {{ totalCount }} 项，全部来自下载原文）。
          改动先留在内存，要点右下角「全局保存」才会写回飞控。
        </p>
      </div>
      <div class="head-right">
        <el-tag :type="dirtyCount ? 'warning' : 'success'" size="small" effect="dark">
          {{ dirtyCount ? `${dirtyCount} 处待保存` : '与飞控一致' }}
        </el-tag>
        <el-tag v-if="fc.loaded" size="small" type="info" effect="plain">
          param.xml {{ paramSize }} 字节 · CRC32 {{ paramCrc }}
        </el-tag>
        <el-button size="small" :disabled="!!busy" @click="reload">重新读取</el-button>
      </div>
    </div>
    <div class="tuning-toolbar">
      <el-input v-model="query" clearable size="small" placeholder="搜索参数名或说明" style="max-width:280px" />
      <span class="pp-hint">显示 {{ filteredCards.reduce((n, c) => n + c.items.length, 0) }} / {{ totalCount }} 项；范围校验失败不会写入配置事务</span>
    </div>

    <!-- 还没读到文件：只说明现状，不给假数字 -->
    <el-card v-if="!fc.loaded" shadow="never" class="pp-card">
      <EmptyStateAction title="配置尚未就绪" :reason="emptyText" action-label="从飞控读取配置" :action-disabled="!online || !!busy" @action="reload" />
      <el-alert
          v-if="fc.lastPullError"
          type="error"
          :closable="false"
          show-icon
          :title="`读取失败：${fc.lastPullError}`"
          description="通常是飞控固件没带 MAVLink FTP 命令（实测这台在 CALC_FILE_CRC32 上就缺），可改用「文件」页整文件下载后核对。" />
    </el-card>

    <template v-else>
      <el-alert
          v-if="!cards.length"
          type="warning"
          :closable="false"
          show-icon
          title="这份 param.xml 里没有 CONTROL 组"
          description="固件的整定参数不在这个组，本页不凭空造控件；请到「参数」页按整本文件查看。" />

      <template v-else>
        <el-alert
            type="info"
            :closable="false"
            show-icon
            class="pp-alert"
            title="改完要重启飞控才生效"
            description="param.xml 是开机时加载的文件；右下角保存只写文件，不会走 PARAM_SET 逐条下发（同名参数在飞控的两份清单里有重复，用 PARAM_SET 反可能写错地方，这条通路按计划 M2 再做）。" />

        <div class="loop-card-grid"><el-card v-for="card in filteredCards" :id="`pid-card-${card.card}`" :key="card.card" shadow="never" class="pp-card loop-card" :class="`loop-card--${card.card}`">
          <template #header>
            <div class="pp-card-head">
              <span class="pp-card-title">{{ card.title }}</span>
              <el-tag v-if="cardChanged(card)" type="warning" size="small" effect="dark">本卡 {{ cardChanged(card) }} 处待保存</el-tag>
              <span class="pp-card-count">{{ card.items.length }} 项</span>
            </div>
          </template>
          <p class="pp-note">{{ card.note }}</p><div v-if="cardChanged(card)" class="pid-save-hint">已记录修改，请使用右下角“保存”写入飞控</div>
           <el-alert v-if="card.card === 'other'" type="info" :closable="false" show-icon title="此卡为未识别字段，已按控制参数归类；请结合固件文档确认含义" />

          <div class="pid-item-grid"><div v-for="row in card.items" :key="row.name" class="pid-item" :data-search-key="`param:CONTROL:${row.name}`"><div class="pid-item-head"><code class="pp-key">{{ row.name }}</code><span>{{ row.label }}</span></div><span v-if="row.name === 'AIRFRAME'" class="airframe-readonly">{{ airframeLabel(row.value) }}</span><template v-else-if="row.kind === 'float' || row.kind === 'int'"><div class="pid-value-row"><small class="pp-raw">原值 {{ originalValue(row) }}</small><el-input-number :model-value="numberValue(row)" :min="sliderMin(row)" :max="sliderMax(row)" :step="row.kind === 'float' ? 0.01 : 1" controls-position="right" size="small" @update:model-value="(v) => setDraft(row, String(v))" @change="(v) => setAndCommit(row, v)" /></div><div class="pid-slider-row"><el-slider :model-value="numberValue(row)" :min="sliderMin(row)" :max="sliderMax(row)" :step="row.kind === 'float' ? 0.01 : 1" :show-tooltip="false" @update:model-value="(v) => setDraft(row, String(v))" @change="(v) => setAndCommit(row, v)" /></div></template><el-input v-else size="small" :model-value="draftOf(row)" :placeholder="`当前 ${row.raw}`" @update:model-value="(v) => setDraft(row, v)" @change="commit(row)" /><small v-if="row.hint" class="pp-note">{{ row.hint }}</small></div></div>
<el-table v-if="false" :data="card.items" border stripe size="small" :row-class-name="rowClass">
            <el-table-column label="参数名" width="200">
              <template #default="{ row }"><code class="pp-key">{{ row.name }}</code></template>
            </el-table-column>
            <el-table-column label="名称" min-width="150">
              <template #default="{ row }">{{ row.label }}</template>
            </el-table-column>
            <el-table-column label="飞控上的值" width="190">
              <template #default="{ row }">
                <el-input
                    size="small"
                    :model-value="draftOf(row)"
                    :placeholder="`当前 ${row.raw}`"
                    :class="{ 'pp-invalid': errorOf(row) }"
                    @update:model-value="(v) => setDraft(row, v)"
                    @change="commit(row)" />
              </template>
            </el-table-column>
            <el-table-column label="原文写法" width="130">
              <template #default="{ row }">
                <el-tooltip
                    content="飞控 param.xml 里这一项的字面写法。浮点是 %f 六位小数，整数是裸写法；写回时按这个形态回填"
                    placement="top">
                  <code class="pp-raw">{{ row.raw }}</code>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="260">
              <template #default="{ row }">
                <span v-if="row.hint" class="pp-note cell">{{ row.hint }}</span>
                <span v-else class="pp-muted">—</span>
              </template>
            </el-table-column>
          </el-table>

          <ul class="pp-errs">
            <li v-for="(msg, key) in cardErrors(card)" :key="key">{{ msg }}</li>
          </ul>
        </el-card></div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed, inject, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import TaskHeader from './task-header.vue'
import EmptyStateAction from './empty-state-action.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  mapGroupToCards,
  validateParamInput,
} from '../utils/config-bindings.js'

const fc = inject('fcconfig')
const mav = inject('mavlink')

const GROUP = 'CONTROL'
const online = computed(() => mav.connected?.value === true)
const busy = computed(() => fc.busy)
const paramSize = computed(() => fc.files.param.size)
const paramCrc = computed(() => fc.files.param.crc32Hex || '—')

const emptyText = computed(() => {
  if (busy.value === 'pulling') return '正在从飞控读取 sysconfig.toml 与 param.xml…'
  if (!online.value) return '未连接飞控：连接后会自动读取，不需要手动点'
  return '还没读到 /sys/param.xml'
})

/**
 * 卡片内容由下载下来的文档决定。
 * 除了 revision（本页改过东西），还依赖 lastPullAt 与 crc32Hex：
 * 重新拉取会换掉整个文档对象却不改 revision，只依赖 revision 会留着上一台飞控的行。
 */
const cards = computed(() => {
  void fc.revision
  void fc.lastPullAt
  void fc.files.param.crc32Hex
  return mapGroupToCards(fc.doc('param'), GROUP)
})

const totalCount = computed(() => cards.value.reduce((n, c) => n + c.items.length, 0))
const query = ref('')
const route = useRoute()
watch(() => route.query.focus, key => { if (String(key || '').startsWith('param:CONTROL:')) query.value = '' }, { immediate: true })
const filteredCards = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return cards.value
  return cards.value.map((card) => ({ ...card, items: card.items.filter((item) => `${item.name} ${item.label} ${item.hint || ''}`.toLowerCase().includes(q)) })).filter((card) => card.items.length)
})

/** 本组在 param.xml 改动清单里记了几笔 */
const dirtyCount = computed(() => {
  void fc.revision
  return (fc.files.param.changes || []).filter((c) => String(c.where).startsWith(`${GROUP}.`)).length
})

function cardChanged(card) {
  return card.items.filter((item) => isChanged(item.name)).length
}

function cardErrors(card) {
  const out = Object.create(null)
  for (const key of Object.keys(errors)) {
    if (card.items.some((i) => i.name === key)) out[key] = errors[key]
  }
  return out
}

function isChanged(name) {
  return (fc.files.param.changes || []).some((c) => c.where === `${GROUP}.${name}`)
}

function rowClass({ row }) {
  return errorOf(row) || isChanged(row.name) ? 'pp-row-changed' : ''
}

/* ---------- 草稿与校验：校验不过就不落笔 ---------- */

const drafts = reactive(Object.create(null))
const errors = reactive(Object.create(null))

/**
 * 文档一换（重新拉取、或保存后回读）就丢掉本地草稿与报错。
 * 只认 lastPullAt 与 crc32Hex：本页自己落笔也会推 revision，若按 revision 清，
 * 用户在同一张卡里还没确认的第二格会被上一格的提交误清掉。
 */
watch(
    () => `${fc.lastPullAt}|${fc.files.param.crc32Hex}|${fc.restoreRevision}`,
    () => {
      Object.keys(drafts).forEach((k) => delete drafts[k])
      Object.keys(errors).forEach((k) => delete errors[k])
    },
)

function draftOf(row) {
  return row.name in drafts ? drafts[row.name] : ''
}

function airframeLabel(value) { return `机体类型编号：${value}（只读；具体枚举以固件机体类型文档为准）` }
function numberValue(row) { const v = Number(row.name in drafts ? drafts[row.name] : row.value); return Number.isFinite(v) ? v : 0 }
function originalValue(row) {
  const change = (fc.files.param.changes || []).find((c) => c.where === `${GROUP}.${row.name}`)
  return change ? change.from : row.raw
}
function sliderMin(row) { return row.kind === 'float' ? -10 : -100 }
function sliderMax(row) { return row.kind === 'float' ? 10 : 100 }
function setAndCommit(row, value) { if (value == null) return; setDraft(row, String(value)); commit(row) }

function setDraft(row, value) {
  drafts[row.name] = value
  if (errorOf(row)) delete errors[row.name]
}

function errorOf(row) {
  return errors[row.name] || ''
}

/** 取同组另一项的当前值，给限幅对（MIN/MAX）互相核对 */
function siblingValue(name) {
  const v = fc.paramValue(GROUP, name)
  return typeof v === 'number' ? v : undefined
}

function commit(row) {
  if (!(row.name in drafts)) return
  const input = drafts[row.name]
  const item = { name: row.name, label: row.label, kind: row.kind, value: row.value, pair: row.pair }
  const v = validateParamInput(item, input, siblingValue)
  if (!v.ok) {
    errors[row.name] = v.message
    return
  }
  delete errors[row.name]
  if (Number(v.value) === Number(row.value)) {
    // 值本身没变就不写：省得改动清单里躺着一条 from == to 的噪音
    delete drafts[row.name]
    return
  }
  fc.setParam(GROUP, row.name, v.value)
  delete drafts[row.name]
  // 修改只记入统一 store，不对每一次滑动弹窗；卡片和底部保存栏会显示待保存状态。
}

function reload() {
  const go = async () => {
    const r = await fc.pullAll()
    if (r.ok) {
      Object.keys(drafts).forEach((k) => delete drafts[k])
      Object.keys(errors).forEach((k) => delete errors[k])
      ElMessage.success('已重新读取飞控配置')
    } else if (r.reason === 'busy') {
      ElMessage.info('正在读取或保存，稍后再试')
    } else if (r.reason === 'not-connected') {
      ElMessage.warning('还没连接飞控')
    } else {
      ElMessage.error(fc.lastPullError || r.error || '读取失败')
    }
  }
  if (!fc.hasChanges) {
    go()
    return
  }
  ElMessageBox.confirm(
      `当前有 ${fc.changeList.length} 处没保存的改动，重新读取会用飞控上的内容覆盖它们。`,
      '放弃改动并重新读取？',
      { type: 'warning', confirmButtonText: '放弃并重新读取', cancelButtonText: '取消' },
  ).then(go).catch(() => {})
}
</script>

<style scoped>
.tuning-toolbar{display:flex;align-items:center;gap:12px;margin:10px 0}.tuning-toolbar .pp-hint{margin:0}
.pid-save-hint { color:var(--dsh-warning); font-size:12px; margin:6px 0 }.airframe-readonly { display:block; padding:7px 10px; border:1px dashed var(--dsh-border-strong); color:var(--dsh-text-2); font:12px var(--dsh-font-mono) }
.loop-card-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; align-items:start }.loop-card { border-left:3px solid var(--dsh-accent); margin-bottom:12px }.loop-card--rate,.loop-card--rate-limits { border-left-color:var(--dsh-warning) }.loop-card--angle,.loop-card--stabilize { border-left-color:var(--dsh-success) }.loop-card--velocity,.loop-card--position,.loop-card--vel-limits { border-left-color:var(--dsh-accent) }.loop-card--acro,.loop-card--acro-misc { border-left-color:var(--dsh-danger-vivid) }.pid-item-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px } @media (max-width:760px){.loop-card-grid{grid-template-columns:1fr}}
.pid-item { padding:10px; border:1px solid var(--dsh-border); border-radius:6px; background:var(--dsh-surface-2) }.pid-value-row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0 }.pid-value-row .pp-raw { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }.pid-value-row .el-input-number { width:120px; flex:none }.pid-slider-row { width:100%; min-width:0; padding:2px 6px 0 0 }.pid-slider-row :deep(.el-slider) { width:100% }
.pid-item-head { display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; font-size:12px }
.pid-item-head span { color:var(--dsh-text-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.pid-page { padding: 16px; }

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.head-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.pp-title { margin: 0; font-size: 17px; font-weight: 600; }
.pp-hint { margin: 6px 0 0; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
.pp-card { margin-bottom: 14px; }
.pp-alert { margin-bottom: 12px; }

.pp-card-head { display: flex; align-items: center; gap: 10px; }
.pp-card-title { font-weight: 600; font-size: 14px; }
.pp-card-count { font-size: 12px; color: var(--el-text-color-secondary); }

.pp-note { margin: 0 0 10px; font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); }
.pp-note.cell { font-size: 12px; }
.pp-muted { color: var(--dsh-placeholder); }

.pp-key { font-size: 12px; color: var(--el-color-primary); }
.pp-raw { font-size: 12px; color: var(--el-text-color-secondary); }

.pp-invalid :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px var(--el-color-danger) inset; }

:deep(.pp-row-changed) { background: var(--el-color-warning-light-9); }

.pp-errs { margin: 8px 0 0; padding-left: 18px; }
.pp-errs li { font-size: 12px; color: var(--el-color-danger); line-height: 1.8; }

code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
