<!--
  src/views/ConfigEditor.vue
  ================================================================
  飞控配置文件编辑器
  - 通过 MAVLink FTP 下载 /sys/sysconfig.toml 和 /sys/param.xml
  - 分别解析为可编辑表格，支持单元格修改、搜索过滤、重置
  - 一键把修改后的两个文件上传回飞控
  ================================================================
-->
<template>
  <div ref="editorRef" class="config-editor">
    <!-- 顶部操作区 -->
    <el-card shadow="never" class="toolbar-card">
      <el-row :gutter="12" align="middle" class="toolbar-row">
        <el-col :span="12">
          <el-space wrap>
            <el-button type="primary" :loading="loading" :disabled="!mav.canOperate.value" @click="refreshFromStore">
              <el-icon><Download /></el-icon>&nbsp;刷新全局配置快照
            </el-button>
            <el-button type="success" :disabled="true" title="配置写回统一由右下角全局保存条执行">
              <el-icon><Upload /></el-icon>&nbsp;由全局保存条写回
            </el-button>
            <el-button :disabled="!loaded" @click="resetAll">
              <el-icon><RefreshLeft /></el-icon>&nbsp;放弃修改
            </el-button>
            <el-button :disabled="!loaded" @click="exportLocal">
              <el-icon><DocumentCopy /></el-icon>&nbsp;导出到本地
            </el-button>
          </el-space>
        </el-col>
        <el-col :span="12" style="text-align: right"
          ><el-select
            v-if="activeTab === 'toml'"
            v-model="selectedTomlGroup"
            placeholder="选择 sysconfig 大类"
            clearable
            filterable
            style="width: 180px; margin-right: 8px"
            ><el-option v-for="g in tomlGroupNames" :key="g" :label="g" :value="g" /></el-select
          ><el-select
            v-else
            v-model="selectedXmlGroup"
            placeholder="选择 param.xml 大类"
            clearable
            filterable
            style="width: 180px; margin-right: 8px"
            ><el-option v-for="g in allGroups" :key="g" :label="g" :value="g"
          /></el-select>
          <el-input
            v-model="filter"
            placeholder="子序列搜索键名 / 参数名 / 分组 / 值..."
            aria-label="子序列搜索配置字段"
            clearable
            style="max-width: 320px"
            :prefix-icon="Search"
          />
        </el-col>
      </el-row>
      <ConnectionStateNotice :state="connectionState" :cleared="connectionState === 'disconnected'" />
      <TaskProgress
        v-if="loading && connectionState === 'online'"
        title="正在读取配置文件"
        description="请等待配置读取完成。"
        :percentage="null"
      />
      <div v-if="lastMsg" class="status-line">
        <el-tag :type="lastMsgType" size="small" effect="light">{{ lastMsg }}</el-tag>
      </div>
    </el-card>

    <!-- 两个 Tab：sysconfig.toml / param.xml -->
    <el-tabs v-model="activeTab" class="config-tabs" v-loading="loading">
      <!-- ============ TOML ============ -->
      <el-tab-pane label="/sys/sysconfig.toml" name="toml">
        <template #label>
          <span>
            <el-icon><Document /></el-icon>&nbsp;sysconfig.toml
            <el-tag v-if="tomlDirty" size="small" type="danger" effect="dark" style="margin-left: 6px">已修改</el-tag>
          </span>
        </template>

        <EmptyStateAction
          v-if="!tomlLoaded || connectionState !== 'online'"
          title="sysconfig.toml 尚不可用"
          :reason="fileEmptyReason('sysconfig')"
          :evidence="fileEvidence('sysconfig', TOML_PATH)"
        />

        <div v-if="connectionState === 'online'" class="param-card-grid">
          <el-card v-for="group in tomlGroups" :key="group.name" shadow="never" class="param-group-card">
            <template #header
              ><div class="param-group-head">
                <strong>{{ group.name }}</strong
                ><el-tag size="small" effect="plain">{{ group.rows.length }} 项</el-tag>
              </div></template
            >
            <div class="param-items-grid">
              <div
                v-for="row in group.rows"
                :key="row.keyPath"
                class="param-item"
                :data-search-key="tomlSearchKey(row.keyPath)"
                :class="{ 'search-focused': focusedSearchKey === tomlSearchKey(row.keyPath) }"
                tabindex="-1"
              >
                <div class="param-item-label">
                  <span>{{ row.keyPath }}</span
                  ><small>{{ row.type }}</small>
                </div>
                <el-switch
                  v-if="row.type === 'boolean'"
                  v-model="row.value"
                  :active-value="true"
                  :inactive-value="false"
                  @change="commitTomlRow(row)"
                />
                <el-input-number
                  v-else-if="row.type === 'number'"
                  v-model="row.value"
                  :controls="true"
                  size="small"
                  @change="commitTomlRow(row)"
                />
                <el-input v-else v-model="row.value" size="small" @blur="commitTomlRow(row)" />
              </div>
            </div>
          </el-card>
        </div>
        <el-table
          v-if="false"
          :data="filteredTomlRows"
          stripe
          border
          size="small"
          height="calc(100vh - 280px)"
          :row-class-name="tomlRowClass"
          @cell-dblclick="() => {}"
        >
          <el-table-column prop="keyPath" label="配置项" min-width="240" fixed="left">
            <template #default="{ row }">
              <span class="keypath">{{ row.keyPath }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="type" label="类型" width="100">
            <template #default="{ row }">
              <el-select v-model="row.type" size="small" style="width: 100%" @change="onTomlTypeChange(row)">
                <el-option label="字符串" value="string" />
                <el-option label="数字" value="number" />
                <el-option label="布尔" value="boolean" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="值" min-width="360">
            <template #default="{ row }">
              <el-switch
                v-if="row.type === 'boolean'"
                v-model="row.value"
                :active-value="true"
                :inactive-value="false"
                @change="commitTomlRow(row)"
              />
              <el-input-number
                v-else-if="row.type === 'number'"
                v-model="row.value"
                :controls="false"
                size="small"
                style="width: 100%"
                @change="commitTomlRow(row)"
              />
              <el-input v-else v-model="row.value" size="small" placeholder="请输入值" @blur="commitTomlRow(row)" />
            </template>
          </el-table-column>
          <el-table-column prop="original" label="原始值" width="180">
            <template #default="{ row }">
              <span class="original">{{ formatOriginal(row.original) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="warning" @click="resetTomlRow(row)">还原</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ XML ============ -->
      <el-tab-pane label="/sys/param.xml" name="xml">
        <template #label>
          <span>
            <el-icon><Tickets /></el-icon>&nbsp;param.xml
            <el-tag v-if="xmlDirty" size="small" type="danger" effect="dark" style="margin-left: 6px">已修改</el-tag>
          </span>
        </template>

        <EmptyStateAction
          v-if="!xmlLoaded || connectionState !== 'online'"
          title="param.xml 尚不可用"
          :reason="fileEmptyReason('param')"
          :evidence="fileEvidence('param', XML_PATH)"
        />

        <div v-if="xmlLoaded" class="param-dict-bar">
          <span class="param-dict-label">枚举字典依据</span>
          <el-select v-model="dictVehicle" size="small" class="param-dict-select">
            <el-option v-for="name in VEHICLE_NAMES" :key="name" :label="vehicleOptionLabel(name)" :value="name" />
          </el-select>
          <span class="param-dict-note">{{ dictNote }}</span>
        </div>
        <div v-if="connectionState === 'online'" class="param-card-grid">
          <el-card v-for="group in xmlGroups" :key="group.name" shadow="never" class="param-group-card" data-tab="xml">
            <template #header
              ><div class="param-group-head">
                <strong>{{ group.name || '未分组' }}</strong
                ><el-tag size="small" effect="plain">{{ group.rows.length }} 项</el-tag>
              </div></template
            >
            <div class="param-items-grid">
              <div
                v-for="row in group.rows"
                :key="paramSearchKey(row.group, row.name)"
                class="param-item"
                :data-search-key="paramSearchKey(row.group, row.name)"
                :class="{ 'search-focused': focusedSearchKey === paramSearchKey(row.group, row.name) }"
                tabindex="-1"
              >
                <div class="param-item-label">
                  <span>{{ row.name }}</span
                  ><small>{{ row.type }}</small>
                </div>
                <!-- 单选枚举：候选来自固件源码；飞控里现存的怪值原样列在第一位，绝不自动改写 -->
                <el-select
                  v-if="xmlMeta(row)?.kind === 'enum'"
                  v-model="row.value"
                  size="small"
                  @change="commitXmlRow(row)"
                  ><el-option
                    v-for="option in xmlMeta(row).options"
                    :key="String(option.value)"
                    :label="paramOptionLabel(option)"
                    :value="option.value"
                /></el-select>
                <!-- 位掩码：多选。勾选的位按位或，原值里没被列出的位保留不动 -->
                <el-select
                  v-else-if="xmlMeta(row)?.kind === 'bits'"
                  :model-value="bitsOf(row)"
                  multiple
                  size="small"
                  collapse-tags
                  collapse-tags-tooltip
                  @update:model-value="(list) => commitBitsRow(row, list)"
                  ><el-option
                    v-for="option in xmlMeta(row).options"
                    :key="option.bit"
                    :label="bitOptionLabel(option)"
                    :value="option.bit"
                /></el-select>
                <el-switch
                  v-else-if="row.type === 'BOOL' || row.type === 'BOOLEAN'"
                  v-model="row.value"
                  :active-value="true"
                  :inactive-value="false"
                  @change="commitXmlRow(row)"
                />
                <el-input-number
                  v-else-if="isNumericType(row.type)"
                  v-model="row.value"
                  :controls="true"
                  size="small"
                  :step="stepFor(row.type)"
                  :min="xmlMeta(row)?.min"
                  :max="xmlMeta(row)?.max"
                  @change="commitXmlRow(row)"
                />
                <el-input v-else v-model="row.value" size="small" @blur="commitXmlRow(row)" />
                <div v-if="xmlMeta(row)?.hint" class="param-item-hint">{{ xmlMeta(row).hint }}</div>
              </div>
            </div>
          </el-card>
        </div>
        <el-table
          v-if="false"
          :data="filteredXmlRows"
          stripe
          border
          size="small"
          height="calc(100vh - 280px)"
          :row-class-name="xmlRowClass"
        >
          <el-table-column prop="group" label="分组" width="140">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.group || '—' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="参数名" min-width="220" fixed="left">
            <template #default="{ row }">
              <span class="paramname">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="type" label="类型" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="typeTagType(row.type)">{{ row.type }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="值" min-width="320">
            <template #default="{ row }">
              <el-switch
                v-if="row.type === 'BOOL' || row.type === 'BOOLEAN'"
                v-model="row.value"
                :active-value="true"
                :inactive-value="false"
                @change="commitXmlRow(row)"
              />
              <el-input-number
                v-else-if="isNumericType(row.type)"
                v-model="row.value"
                :controls="false"
                size="small"
                :step="stepFor(row.type)"
                style="width: 100%"
                @change="commitXmlRow(row)"
              />
              <el-input v-else v-model="row.value" size="small" @blur="commitXmlRow(row)" />
            </template>
          </el-table-column>
          <el-table-column prop="default" label="默认值" width="140">
            <template #default="{ row }">
              <span class="original">{{ row.default ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="warning" @click="resetXmlRow(row)">还原</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 上传结果对话框 -->
    <el-dialog v-model="resultDialog" title="操作结果" width="480px">
      <el-alert
        :title="resultOk ? '上传成功' : '上传过程中出现问题'"
        :type="resultOk ? 'success' : 'error'"
        :closable="false"
        show-icon
        :description="resultMsg"
      />
      <template #footer>
        <el-button type="primary" @click="resultDialog = false">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, inject, watch, watchEffect, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { rankFuzzy } from '../utils/fuzzy.js'
import { paramSearchKey, tomlSearchKey } from '../utils/search-index.js'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Upload, RefreshLeft, DocumentCopy, Document, Tickets, Search } from '@element-plus/icons-vue'
import EmptyStateAction from './empty-state-action.vue'
import TaskProgress from './task-progress.vue'
import ConnectionStateNotice from './connection-state-notice.vue'
import { paramMeta, paramOptionLabel, bitsToList, listToBits } from '../protocol/fmt-param-meta.js'
import { VEHICLE_PRESETS, DEFAULT_VEHICLE, resolveDictionary } from '../protocol/fmt-dictionary.js'

const mav = inject('mavlink')
/* M1：本页只编辑 fcconfig 的定点文档；写回统一由右下角保存条执行。 */
const fc = inject('fcconfig', null)
const route = useRoute()
const editorRef = ref(null)
const focusedSearchKey = ref('')
let pendingFocus = ''
let focusRequest = 0
function queryText(value) {
  return typeof value === 'string' ? value : ''
}

/* ---------------- 路径常量 ---------------- */
const TOML_PATH = '/sys/sysconfig.toml'
const XML_PATH = '/sys/param.xml'

/* ---------------- UI 状态 ---------------- */
const activeTab = ref('toml')
const filter = ref('')
const selectedTomlGroup = ref('')
const selectedXmlGroup = ref('')
const loading = computed(
  () => fc?.busy === 'pulling' || fc?.files?.sysconfig?.loading === true || fc?.files?.param?.loading === true
)
const connectionState = computed(() => {
  if (!mav.connected.value) return 'disconnected'
  if (mav.deviceState?.phase === 'stale') return 'stale'
  return mav.canOperate.value ? 'online' : 'waiting'
})
function fileEmptyReason(key) {
  if (connectionState.value === 'disconnected') return '链路已断开，配置数值已清空，当前值为 --。请在顶部连接飞控。'
  if (connectionState.value !== 'online') return '等待有效心跳；旧配置不作为当前值展示，当前值为 --。'
  if (fc?.files?.[key]?.loading || loading.value)
    return '全局 store 正在读取配置文件；总量未上报，不显示虚构的参数计数或百分比。'
  return (
    fc?.files?.[key]?.error ||
    fc?.lastPullError ||
    '尚未从全局 store 下载成功，当前值为 --；连接后由 store 自动读取。刷新快照不会重新拉取文件。'
  )
}
function fileEvidence(key, path) {
  return `${path} · fcconfig.files.${key} · ${fc?.files?.[key]?.loaded ? '文件已下载' : '文件未下载成功'}`
}
const lastMsg = ref('')
const lastMsgType = ref('info')
const resultDialog = ref(false)
const resultOk = ref(true)
const resultMsg = ref('')

/* ---------------- TOML 状态 ---------------- */
const tomlLoaded = ref(false)
const tomlDirty = ref(false)
const tomlRows = ref([]) // [{keyPath, key, value, type, original}]

/* ---------------- XML 状态 ---------------- */
const xmlLoaded = ref(false)
const xmlDirty = ref(false)
const xmlParsed = ref(null)

const dirty = computed(() => tomlDirty.value || xmlDirty.value)
const loaded = computed(() => tomlLoaded.value || xmlLoaded.value)

/* ---------------- 过滤 ---------------- */
const allGroups = computed(() =>
  [...new Set((xmlParsed.value?.params || []).map((r) => r.group || '未分组'))].sort(
    (a, b) => ['FMS', 'INS', 'CONTROL'].indexOf(a) - ['FMS', 'INS', 'CONTROL'].indexOf(b)
  )
)
const tomlGroupNames = computed(() =>
  [...new Set(tomlRows.value.map((r) => String(r.keyPath || '').split('.')[0] || '系统配置'))].sort()
)
const filteredTomlRows = computed(() =>
  rankFuzzy(
    tomlRows.value.filter(
      (r) =>
        !selectedTomlGroup.value || (String(r.keyPath || '').split('.')[0] || '系统配置') === selectedTomlGroup.value
    ),
    filter.value,
    (r) => [r.keyPath, r.section, String(r.value)]
  )
)
const tomlGroups = computed(() => {
  if (!selectedTomlGroup.value) return tomlRows.value.length ? [{ name: '全部参数', rows: filteredTomlRows.value }] : []
  const groups = new Map()
  for (const row of filteredTomlRows.value) {
    const name = String(row.keyPath || '').split('.')[0] || '系统配置'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(row)
  }
  return [...groups].map(([name, rows]) => ({ name, rows }))
})
function tomlMin(row) {
  const n = Number(row.min)
  return Number.isFinite(n) ? n : -100
}
function tomlMax(row) {
  const n = Number(row.max)
  return Number.isFinite(n) ? n : 100
}
const filteredXmlRows = computed(() =>
  rankFuzzy(xmlParsed.value?.params || [], filter.value, (r) => [r.name, r.group || '', String(r.value)])
)
const xmlGroups = computed(() => {
  if (!selectedXmlGroup.value) return [{ name: '全部参数', rows: filteredXmlRows.value }]
  const groups = new Map()
  for (const row of filteredXmlRows.value) {
    if (!selectedXmlGroup.value || (row.group || '未分组') !== selectedXmlGroup.value) continue
    const name = row.group || '未分组'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(row)
  }
  return [...groups].map(([name, rows]) => ({ name, rows }))
})
function numericMin(row) {
  const n = Number(row.min)
  return Number.isFinite(n) ? n : -100
}
function numericMax(row) {
  const n = Number(row.max)
  return Number.isFinite(n) ? n : 100
}

/* 路由定位只清筛选、不重读文档或提交值；普通 revision 不抢走正在编辑的焦点。 */
watch(
  () => [route.query.focus, route.query.file, route.query.group],
  () => {
    pendingFocus = queryText(route.query.focus)
    focusedSearchKey.value = ''
    focusRequest++
    if (!pendingFocus) return
    filter.value = ''
    selectedTomlGroup.value = ''
    selectedXmlGroup.value = ''
    activeTab.value = pendingFocus.startsWith('param:') || route.query.file === 'param' ? 'xml' : 'toml'
    focusRouteField()
  },
  { immediate: true }
)
async function focusRouteField() {
  if (!pendingFocus || connectionState.value !== 'online') return
  const request = focusRequest,
    key = pendingFocus
  const exists =
    activeTab.value === 'xml'
      ? (xmlParsed.value?.params || []).some((row) => paramSearchKey(row.group, row.name) === key)
      : tomlRows.value.some((row) => tomlSearchKey(row.keyPath) === key)
  if (!exists) return
  await nextTick()
  if (request !== focusRequest) return
  // 不把参数名拼成 CSS 选择器，包含标点的实际字段仍能精确定位。
  const field = [...(editorRef.value?.querySelectorAll('[data-search-key]') || [])].find(
    (node) => node.dataset.searchKey === key
  )
  if (!field) return
  focusedSearchKey.value = key
  pendingFocus = ''
  field.scrollIntoView?.({ block: 'center', behavior: 'auto' })
  const control = field.querySelector(
    'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role="switch"], [role="combobox"]'
  )
  ;(control || field).focus({ preventScroll: true })
}
watch(() => [tomlRows.value, xmlParsed.value, connectionState.value], focusRouteField, { flush: 'post' })

/* ---------------- 消息提示 ---------------- */
function setMsg(text, type = 'info') {
  lastMsg.value = text
  lastMsgType.value = type
}

/* =========================================================
 *  从飞控读取两个文件
 * ========================================================= */
function rowsFromStore() {
  const toml = fc?.doc('sysconfig')
  const param = fc?.doc('param')
  tomlRows.value = []
  if (toml) {
    for (const section of toml.sections()) {
      const tables = toml.tablesOf(section)
      if (tables.length)
        tables.forEach((table, arrayIndex) =>
          table.keys.forEach((key) => {
            const value = table.fields[key]
            tomlRows.value.push({
              keyPath: `${section}[${arrayIndex}].${key}`,
              section,
              arrayIndex,
              key,
              value,
              original: value,
              type: typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : 'number',
            })
          })
        )
      else
        toml.keys(section).forEach((key) => {
          const item = toml.get(section, key)
          tomlRows.value.push({
            keyPath: section ? `${section}.${key}` : key,
            section,
            key,
            value: item?.value,
            original: item?.value,
            type: item?.type === 'bool' ? 'boolean' : item?.type === 'string' ? 'string' : 'number',
          })
        })
    }
  }
  xmlParsed.value = param
    ? {
        params: param.list().map((row) => ({
          ...row,
          rawValue: row.raw,
          type: row.type === 'float' ? 'FLOAT' : row.type === 'int' ? 'INT32' : 'STRING',
        })),
      }
    : null
  tomlLoaded.value = !!toml
  xmlLoaded.value = !!param
}
function refreshFromStore() {
  rowsFromStore()
  setMsg(fc?.loaded ? '已刷新为全局配置快照' : '配置尚未从飞控完整读取', fc?.loaded ? 'success' : 'warning')
}
watch(() => [fc?.revision, fc?.files?.sysconfig?.loaded, fc?.files?.param?.loaded], rowsFromStore, { immediate: true })
function commitTomlRow(row) {
  if (!fc?.loaded) return
  try {
    row.arrayIndex != null
      ? fc.setTomlTableField(row.section, row.arrayIndex, row.key, row.value)
      : fc.setToml(row.section, row.key, row.value)
    tomlDirty.value = true
  } catch (e) {
    setMsg('配置未写入内存：' + (e?.message || e), 'error')
  }
}
function commitXmlRow(row) {
  if (!fc?.loaded) return
  try {
    fc.setParam(row.group || '', row.name, row.value)
    xmlDirty.value = true
  } catch (e) {
    setMsg('参数未写入内存：' + (e?.message || e), 'error')
  }
}
function showSaveBarHint() {
  setMsg('修改已进入全局配置事务，请使用右下角保存条写回。', 'warning')
}

/* =========================================================
 *  param.xml 的枚举字典（改造方案第 4/5 项）
 *  字典按「机型预设」切换：布局号（AIRFRAME）只有编译期确定下来的那一套才合法，
 *  多旋翼是 1~8，VTOL 与艇载是 1~2，固定翼/车/模板没有公开集合，退回数字输入。
 *  HEARTBEAT 不能用来选字典：固件把 type/autopilot 写死成 QUADROTOR/PX4，
 *  所以这里由用户显式声明，界面把风险说清楚，不做任何猜测。
 * ========================================================= */
const VEHICLE_NAMES = Object.keys(VEHICLE_PRESETS)
const dictVehicle = ref(DEFAULT_VEHICLE)
const dictCtx = computed(() => ({ vehicle: dictVehicle.value }))
const dictResolved = computed(() => resolveDictionary(dictCtx.value))
const dictNote = computed(() => {
  const preset = dictResolved.value?.preset
  const r = dictResolved.value
  if (!preset) return '当前机型没有公开的布局编号集合，AIRFRAME 退回数字输入'
  if (r?.warning) return `${r.warning}`
  const list = preset.airframes
  return list
    ? `当前机型可用布局：${list.map((n) => n.value ?? n).join(' / ')}`
    : '当前机型没有公开的布局编号集合，AIRFRAME 退回数字输入'
})
function vehicleOptionLabel(name) {
  const preset = VEHICLE_PRESETS[name]
  if (!preset) return name
  const list = preset.airframes
  return list ? `${name}（布局 ${list.map((n) => n.value ?? n).join('~')}）` : `${name}（布局未公开）`
}

/** 这一行的枚举/位掩码元数据；ctx 用当前机型预设，切换预设后下拉候选会跟着变 */
function xmlMeta(row) {
  return paramMeta(row.group, row.name, row.value, dictCtx.value)
}

/** 位掩码 → 勾选中的位。原值里没被列出的位由 bitsToList 放进 extra，不参与勾选但保留 */
function bitsOf(row) {
  const meta = xmlMeta(row)
  if (!meta || meta.kind !== 'bits') return []
  return bitsToList(Number(row.value) || 0, meta.options).list
}

/** 勾选的位按位或回去，extra（未知的残留位）原样保留，绝不因为"界面看不到"就清掉 */
function commitBitsRow(row, list) {
  const meta = xmlMeta(row)
  if (!meta || meta.kind !== 'bits') return
  const { extra } = bitsToList(Number(row.value) || 0, meta.options)
  row.value = listToBits(Array.isArray(list) ? list : [], meta.options, extra)
  commitXmlRow(row)
}

function bitOptionLabel(option) {
  const name =
    option.name && option.name !== String(option.bit)
      ? `（${option.name}，第 ${option.bit} 位）`
      : `（第 ${option.bit} 位）`
  return `${option.label}${name}`
}
/* =========================================================`r`n *  修改处理
 * ========================================================= */
function markTomlDirty() {
  tomlDirty.value = true
}
function markXmlDirty() {
  xmlDirty.value = true
}

function onTomlTypeChange(row) {
  // 切换类型时尝试转换值
  if (row.type === 'boolean') {
    row.value = row.value === true || row.value === 'true' || row.value === '1' || row.value === 1
  } else if (row.type === 'number') {
    const n = Number(row.value)
    row.value = Number.isFinite(n) ? n : 0
  } else {
    row.value = row.value == null ? '' : String(row.value)
  }
  markTomlDirty()
}

function tomlRowClass({ row }) {
  return isTomlRowDirty(row) ? 'row-dirty' : ''
}
function xmlRowClass({ row }) {
  return isXmlRowDirty(row) ? 'row-dirty' : ''
}
function isTomlRowDirty(row) {
  return String(row.value) !== String(row.original) || row.type !== originalType(row.original)
}
function isXmlRowDirty(row) {
  return String(row.value) !== String(xmlOriginalValue(row))
}
function xmlOriginalValue(row) {
  // 读取原始属性值用于对比
  return row.rawValue
}
function originalType(v) {
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  return 'string'
}
function formatOriginal(v) {
  if (v === true) return 'true'
  if (v === false) return 'false'
  return String(v)
}

function resetTomlRow(row) {
  row.value = row.original
  row.type = originalType(row.original)
  // 如果所有行都干净则清 dirty
  tomlDirty.value = tomlRows.value.some(isTomlRowDirty)
}
function resetXmlRow(row) {
  row.value = autoRestore(row.rawValue, row.type)
  xmlDirty.value = xmlParsed.value.params.some(isXmlRowDirty)
}
function autoRestore(raw, type) {
  if (type === 'BOOL' || type === 'BOOLEAN') return raw === 'true' || raw === '1'
  if (isNumericType(type)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  return raw == null ? '' : String(raw)
}

function resetAll() {
  if (fc) {
    fc.discardAll()
    tomlDirty.value = false
    xmlDirty.value = false
    const toml = fc.doc('sysconfig')
    const param = fc.doc('param')
    if (toml) {
      tomlRows.value = []
      for (const section of toml.sections()) {
        const tables = toml.tablesOf(section)
        if (tables.length)
          tables.forEach((table, arrayIndex) =>
            table.keys.forEach((key) => {
              const value = table.fields[key]
              tomlRows.value.push({
                keyPath: `${section}[${arrayIndex}].${key}`,
                section,
                arrayIndex,
                key,
                value,
                original: value,
                type: typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : 'number',
              })
            })
          )
        else
          toml.keys(section).forEach((key) => {
            const item = toml.get(section, key)
            tomlRows.value.push({
              keyPath: section ? `${section}.${key}` : key,
              section,
              key,
              value: item?.value,
              original: item?.value,
              type: item?.type === 'bool' ? 'boolean' : item?.type === 'string' ? 'string' : 'number',
            })
          })
      }
    }
    if (param)
      xmlParsed.value = {
        params: param.list().map((row) => ({
          ...row,
          rawValue: row.raw,
          type: row.type === 'float' ? 'FLOAT' : row.type === 'int' ? 'INT32' : 'STRING',
        })),
      }
    setMsg('已放弃本地修改，恢复为连接时读取的文件', 'info')
    ElMessage.success('已放弃修改')
    return
  }
  rowsFromStore()
  ElMessage.success('已恢复为下载时的状态')
  setMsg('已恢复为下载时的状态', 'info')
}

/* =========================================================
 *  导出本地
 * ========================================================= */
function exportLocal() {
  try {
    const tomlText = buildTomlText()
    const xmlText = buildXmlText()
    downloadText(tomlText, 'sysconfig.toml')
    setTimeout(() => downloadText(xmlText, 'param.xml'), 200)
    ElMessage.success('已导出到本地下载目录')
  } catch (e) {
    ElMessage.error('导出失败：' + e.message)
  }
}
function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* =========================================================
 *  类型辅助
 * ========================================================= */
function isNumericType(t) {
  return ['INT32', 'INT16', 'INT8', 'UINT32', 'UINT16', 'UINT8', 'FLOAT', 'DOUBLE'].includes((t || '').toUpperCase())
}
function stepFor(t) {
  const u = (t || '').toUpperCase()
  if (u === 'FLOAT' || u === 'DOUBLE') return 0.01
  return 1
}
function typeTagType(t) {
  const u = (t || '').toUpperCase()
  if (u.startsWith('INT') || u.startsWith('UINT')) return 'warning'
  if (u === 'FLOAT' || u === 'DOUBLE') return 'success'
  if (u === 'BOOL' || u === 'BOOLEAN') return 'info'
  return ''
}
</script>

<style scoped>
.param-group-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  flex-wrap: wrap;
}
.param-group-caption {
  color: var(--dsh-text-2);
  font-size: 12px;
}
.param-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px;
  padding: 8px 0;
  max-height: calc(100vh - 280px);
  overflow: auto;
}
.param-group-card {
  min-width: 0;
}
.param-group-head,
.param-item-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.param-items-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 14px;
}
.param-item {
  min-width: 0;
  padding: 7px 0;
  border-bottom: 1px solid var(--dsh-border);
  display: grid;
  grid-template-columns: minmax(100px, 1fr) minmax(110px, 1fr);
  gap: 8px;
  align-items: center;
}
.param-item-label {
  min-width: 0;
}
@media (max-width: 760px) {
  .param-items-grid {
    grid-template-columns: 1fr;
  }
}
.param-item.search-focused {
  background: var(--dsh-accent-soft);
  outline: 2px solid var(--dsh-accent);
  outline-offset: 2px;
  scroll-margin-block: var(--dsh-gap-lg);
}
.param-item:focus-visible {
  outline: 2px solid var(--dsh-accent);
  outline-offset: 2px;
}
.param-item:last-child {
  border-bottom: 0;
}
.param-item-hint {
  grid-column: 1 / -1;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsh-text-3);
}
.param-dict-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--dsh-text-3);
}
.param-dict-label {
  font-weight: 600;
}
.param-dict-select {
  width: 190px;
}
.param-dict-note {
  color: var(--dsh-text-3);
}
.param-item-label span {
  font-family: var(--dsh-font-mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.param-item-label small {
  color: var(--dsh-text-3);
  white-space: nowrap;
}
.config-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
}
.toolbar-card {
  border-radius: 6px;
}
.status-line {
  margin-top: 8px;
}
.config-tabs :deep(.el-tabs__content) {
  overflow: hidden;
}
.empty-tip {
  padding: 40px 0;
}
.keypath {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 12px;
  color: var(--dsh-text-1);
}
.paramname {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 12px;
  font-weight: 600;
}
.original {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  color: var(--dsh-text-3);
  font-size: 12px;
}
/* 被修改的行高亮 */
:deep(.row-dirty) {
  background-color: rgba(245, 108, 108, 0.08) !important;
}
:deep(.row-dirty td) {
  background-color: rgba(245, 108, 108, 0.08) !important;
}
</style>
