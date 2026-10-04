<template>
  <div class="port">
    <TaskHeader title="端口配置" description="配置通信端口与设备。修改后，请通过右下角保存到飞控。">
      <template v-if="loaded">
        <el-tag size="small" :type="dirtyCount ? 'warning' : 'info'" effect="plain">{{ dirtyCount ? `${dirtyCount} 处待保存` : '配置已读取' }}</el-tag>
        <el-button size="small" plain :disabled="!!busy" @click="reload">重新读取</el-button>
      </template>
      <el-tag v-else size="small" type="info" effect="plain">{{ unloadedText }}</el-tag>
    </TaskHeader>

    <div v-if="!loaded" class="pp-blocked">
      <EmptyStateAction title="配置尚未就绪" :reason="unloadedText" action-label="从飞控读取配置" :action-disabled="!connected || !!busy" @action="reload" />
    </div>

    <template v-else>
      <p class="pp-tip">系统 ID 请在 <router-link to="/parameter">参数页</router-link> 中设置。</p>

      <el-card v-for="sec in PORT_SECTIONS" :key="sec.key" shadow="never" class="pp-card">
        <template #header>
          <div class="pp-card-head">
            <span class="pp-card-title">{{ sec.title }}</span>
            <el-tag size="small" type="info">{{ rowsOf(sec).length }} 行</el-tag>
            <span v-if="dirtyOfSection(sec)" class="pp-dirty">{{ dirtyOfSection(sec) }} 处待保存</span>
            <span class="pp-spacer" />
            <el-button size="small" :disabled="uploading" @click="addRow(sec)">新增一行</el-button>
          </div>
        </template>

        <p class="pp-note">{{ sec.note }}</p>

        <div v-if="rowsOf(sec).length" class="port-row-grid">
          <el-card v-for="row in rowsOf(sec)" :key="row.index" shadow="never" class="port-row-card">
            <div class="port-row-title"><strong>端口 {{ row.index + 1 }}</strong><el-button size="small" text type="danger" :disabled="uploading" @click="removeRow(sec, row)">删除</el-button></div>
            <div v-for="def in sec.fields" :key="def.key" class="port-field">
              <label>{{ def.label }}<span v-if="def.unit">（{{ def.unit }}）</span></label>
              <div v-if="!fieldVisible(def, row)" class="pp-na">不适用</div>
              <el-select v-else-if="def.kind === 'enum' || def.kind === 'bool' || def.values" size="small" :model-value="def.kind === 'bool' ? boolModel(row, def) : cellValue(row, def)" @update:model-value="(v) => commit(sec, row, def, v)"><el-option v-if="def.kind === 'bool'" label="未配置" value="" /><el-option v-if="def.kind === 'bool'" label="是" value="true" /><el-option v-if="def.kind === 'bool'" label="否" value="false" /><el-option v-for="o in cellOptions(def, row)" :key="String(o.value)" :label="portOptionLabel(o)" :value="String(o.value)" /></el-select>
              <el-input v-else size="small" :model-value="cellText(row, def)" @update:model-value="(v) => setDraft(sec, row, def, v)" @change="(v) => commit(sec, row, def, v)" />
              <div v-if="cellError(sec, row, def)" class="pp-err">{{ cellError(sec, row, def) }}</div>
              <div v-else-if="cellWarning(sec, row, def)" class="pp-warn">{{ cellWarning(sec, row, def) }}</div>
              <div v-else-if="def.note" class="pp-hint">{{ def.note }}</div>
            </div>
          </el-card>
        </div>
        <el-table v-if="false" :data="rowsOf(sec)" size="small" border>
          <el-table-column label="行" width="72" fixed="left">
            <template #default="{ row }">第 {{ row.index + 1 }} 行</template>
          </el-table-column>

          <el-table-column v-for="def in sec.fields" :key="def.key" min-width="170">
            <template #header>
              <span>{{ def.label }}</span>
              <span v-if="def.unit" class="pp-unit">（{{ def.unit }}）</span>
              <el-tooltip v-if="def.note" :content="def.note" placement="top">
                <el-icon class="pp-help"><QuestionFilled /></el-icon>
              </el-tooltip>
            </template>
            <template #default="{ row }">
              <div v-if="!fieldVisible(def, row)" class="pp-na">不适用</div>
              <template v-else>
                <!-- 枚举：候选 = 固件解析器比较过的值 ∪ 这一行原本写的值 -->
                <el-select v-if="def.kind === 'enum'" size="small" :model-value="cellValue(row, def)"
                  :placeholder="cellPlaceholder(row, def)" @update:model-value="(v) => commit(sec, row, def, v)">
                  <el-option v-for="o in cellOptions(def, row)" :key="String(o.value)" :label="portOptionLabel(o)" :value="String(o.value)" />
                </el-select>

                <el-select v-else-if="def.kind === 'bool'" size="small" :model-value="boolModel(row, def)"
                  placeholder="未配置" @update:model-value="(v) => commit(sec, row, def, v)">
                  <el-option label="未配置" value="" />
                  <el-option label="是" value="true" />
                  <el-option label="否" value="false" />
                </el-select>

                <el-select v-else-if="def.values" size="small" :model-value="cellValue(row, def)"
                  :placeholder="cellPlaceholder(row, def)" @update:model-value="(v) => commit(sec, row, def, v)">
                  <el-option v-for="o in def.values" :key="o" :label="String(o)" :value="String(o)" />
                </el-select>

                <el-input v-else size="small" :model-value="cellText(row, def)"
                  :placeholder="cellPlaceholder(row, def)" clearable
                  @update:model-value="(v) => setDraft(sec, row, def, v)"
                  @change="(v) => commit(sec, row, def, v)"
                  @keyup.enter="(e) => commit(sec, row, def, e.target.value)" />
                <div v-if="cellError(sec, row, def)" class="pp-err">{{ cellError(sec, row, def) }}</div>
                <div v-else-if="def.kind === 'array'" class="pp-hint">{{ def.placeholder }}</div>
              </template>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="76" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="danger" :disabled="uploading" @click="removeRow(sec, row)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <EmptyStateAction v-if="!rowsOf(sec).length" title="没有设备行" :reason="`飞控的 ${sec.path} 里没有设备行`" action-label="新增一行" :action-disabled="!!busy" @action="addRow(sec)" />
      </el-card>
    </template>
  </div>
</template>

<script setup>
/**
 * 端口页（S2）。
 *
 * 三条设计约束，跟 S1 的保存闸门配套：
 *   1. 表结构、取值范围、校验文案全在 `src/utils/port-config.js`（纯模块，自测第 20 组钉住），
 *      这一页只负责渲染与"改一笔就走 store 的定点接口"；
 *   2. 每次改动都调 fc.setTomlTableField / appendTomlTable / removeTomlTable，
 *      于是 config-doc 一定留下 changes() 记录——S1 闸门要求"长度变了必须有改动清单"，
 *      靠的就是这里不落笔就直接写文档；
 *   3. 校验不过就**不写**：内存里的文档保持原样，错误就地显示在格子上。绝不出现"改了没生效"。
 */
import { computed, inject, reactive, watch } from 'vue'
import EmptyStateAction from './empty-state-action.vue'
import TaskHeader from './task-header.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { QuestionFilled } from '@element-plus/icons-vue'
import {
  KIND,
  PORT_SECTIONS,
  emptyRowValues,
  enumOptions,
  portOptionLabel,
  normalizeRows,
  validateField,
} from '../utils/port-config.js'

const fc = inject('fcconfig')
const mav = inject('mavlink')

const connected = computed(() => mav?.connected?.value === true)
const busy = computed(() => fc.busy || '')
const uploading = computed(() => fc.busy === 'uploading')
const loaded = computed(() => fc.files.sysconfig.loaded === true)
const sizeText = computed(() => `${fc.files.sysconfig.size || 0} 字节`)
const crcText = computed(() => fc.files.sysconfig.crc32Hex || '—')
const dirtyCount = computed(() => (fc.files.sysconfig.changes || []).length)
const unloadedText = computed(() => {
  if (!connected.value) return '飞控未连接，还没读到 /sys/sysconfig.toml'
  if (busy.value === 'pulling') return '正在从飞控读取配置…'
  return fc.files.sysconfig.error || '飞控上没有读到 /sys/sysconfig.toml'
})

/**
 * 所有行都过一遍 normalizeRows。
 * 依赖要显式列全：文档本体是 shallowRef（Map 的深层变化追不到），定点改动靠 revision，
 * 而重新下载既不涨 revision 也不换 Map——所以必须把「下载时刻」和「那份 CRC32」也当依赖，
 * 否则重新读取后这一页还在显示上一份的行。
 */
const model = computed(() => {
  void fc.revision
  void fc.lastPullAt
  void fc.files.sysconfig.crc32Hex
  const out = Object.create(null)
  for (const sec of PORT_SECTIONS) {
    // 给每行标上所属节：草稿键与就地错误都按「节 + 行号 + 字段」定位（normalizeRows 每次新建对象，加字段安全）
    out[sec.key] = normalizeRows(sec, fc.tomlTables(sec.path)).map((r) => Object.assign(r, { sectionKey: sec.key }))
  }
  return out
})

function rowsOf(sec) {
  return model.value[sec.key] || []
}

/** 这一节里待保存的改动条数（按 config-doc 的 where 前缀归属，只读，不改文档）。 */
function dirtyOfSection(sec) {
  const all = fc.files.sysconfig.changes || []
  const prefix = sec.path.split('.').pop()
  return all.filter((c) => String(c.where || '').includes(prefix)).length
}

/* ---------- 输入草稿与就地错误 ---------- */
const drafts = reactive(Object.create(null))
const errors = reactive(Object.create(null))
const warnings = reactive(Object.create(null))
watch(() => `${fc.restoreRevision}|${fc.lastPullAt}|${fc.files.sysconfig.crc32Hex}`, () => {
  for (const state of [drafts, errors, warnings]) for (const key of Object.keys(state)) delete state[key]
})
const draftKey = (sec, row, def) => `${sec ? sec.key : row.sectionKey}|${row.index}|${def.key}`

function rawOf(row, def) {
  const k = draftKey(null, row, def)
  if (Object.prototype.hasOwnProperty.call(drafts, k)) return drafts[k]
  return row.has(def.key) ? row.fields[def.key] : undefined
}

/** 显示成文本（数组用 TOML 写法，贴回去还能被 parseTomlValue 解析回来） */
function cellText(row, def) {
  const v = rawOf(row, def)
  if (v === undefined) return ''
  if (Array.isArray(v)) return JSON.stringify(v)
  return String(v)
}

function cellValue(row, def) {
  const v = rawOf(row, def)
  if (v === undefined || v === '') return undefined
  return def.kind === KIND.NUMBER || def.values ? String(v) : v
}

function boolModel(row, def) {
  const v = rawOf(row, def)
  if (v === undefined || v === '') return ''
  return v === true || String(v) === 'true' ? 'true' : 'false'
}

function cellOptions(def, row) {
  return enumOptions(def, row.has(def.key) ? row.fields[def.key] : undefined)
}

function cellPlaceholder(row, def) {
  if (row.has(def.key)) return ''
  if (def.kind === KIND.ARRAY) return def.placeholder || '[]'
  return '未配置（写了才生效）'
}

function fieldVisible(def, row) {
  return !def.showIf || def.showIf(row.fields)
}

function cellError(sec, row, def) {
  return errors[draftKey(sec, row, def)] || ''
}

/**
 * 放行但有风险的提示（allowUnknown 的枚举/数字）：值照写，界面上说明飞控多半会忽略它。
 * 绝不因为"不在候选里"就自动改写用户的值。
 */
function cellWarning(sec, row, def) {
  return warnings[draftKey(sec, row, def)] || ''
}

function setDraft(sec, row, def, v) {
  drafts[draftKey(sec, row, def)] = v
  const k = draftKey(sec, row, def)
  if (errors[k]) delete errors[k]
}

/**
 * 落笔：先校验，校验不过只标红、不动文档。
 * 空输入的语义是"这一项不改"——config-doc 没有删键的接口，删键会连行内注释一起丢，
 * 所以已有键绝不清空（D-2：只改值、不重排、不删行）。
 */
function commit(sec, row, def, raw) {
  const k = draftKey(sec, row, def)
  const check = validateField(def, raw)
  if (!check.ok) {
    errors[k] = check.message
    delete warnings[k]
    return
  }
  if (check.value === '' || check.value === undefined) {
    delete drafts[k]
    delete warnings[k]
    if (row.has(def.key)) errors[k] = `${def.label} 原本是 ${JSON.stringify(row.fields[def.key])}；本页不删已有键，清空等于不改`
    return
  }
  try {
    fc.setTomlTableField(sec.path, row.index, def.key, check.value)
    delete drafts[k]
    delete errors[k]
    if (check.warning) warnings[k] = check.warning
    else delete warnings[k]
  } catch (e) {
    errors[k] = `这一项写不进去：${e?.message || e}`
  }
}

/** 行号会因增删而错位，所以增删之后把这一节的所有草稿、错误与提示全部丢掉，绝不把草稿落到别的行上。 */
function clearEdits(sec) {
  const p = `${sec.key}|`
  for (const k of Object.keys(drafts)) if (k.startsWith(p)) delete drafts[k]
  for (const k of Object.keys(errors)) if (k.startsWith(p)) delete errors[k]
  for (const k of Object.keys(warnings)) if (k.startsWith(p)) delete warnings[k]
}

/** 新增一行：字段取该节的默认值；表本身不存在就如实报错，不假装加上。 */
function addRow(sec) {
  try {
    fc.appendTomlTable(sec.path, emptyRowValues(sec))
    clearEdits(sec)
    ElMessage.success(`已在 ${sec.path} 追加一行，记得点右下角保存`)
  } catch (e) {
    ElMessage.error(`${sec.path} 在飞控的文件里不存在，加不了行：${e?.message || e}`)
  }
}

/** 删除整行：这是会丢配置的动作，必须二次确认。 */
async function removeRow(sec, row) {
  const brief = sec.fields
    .slice(0, 3)
    .map((d) => `${d.label}=${row.has(d.key) ? row.fields[d.key] : '未配置'}`)
    .join(' ')
  try {
    await ElMessageBox.confirm(
      `确定删掉第 ${row.index + 1} 行（${brief}）？这一行代表飞控上的一个通信设备，删掉保存后该设备就没有配置了。`,
      `删除 ${sec.path} 的一行`,
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch {
    return
  }
  try {
    fc.removeTomlTable(sec.path, row.index)
    clearEdits(sec)
    ElMessage.success(`已删除 ${sec.path} 第 ${row.index + 1} 行（还没写回飞控）`)
  } catch (e) {
    ElMessage.error(`删除失败：${e?.message || e}`)
  }
}

/** 重新读取会丢掉没保存的改动，所以有脏数据时先问。 */
async function reload() {
  if (dirtyCount.value) {
    try {
      await ElMessageBox.confirm(
        `当前有 ${dirtyCount.value} 处没保存的改动，重新读取会用飞控上的内容覆盖它们。`, '放弃改动并重新读取？',
        { type: 'warning', confirmButtonText: '放弃并重新读取', cancelButtonText: '取消' })
    } catch {
      return
    }
  }
  const r = await fc.pullAll()
  if (r.ok) ElMessage.success('已重新读取飞控配置')
  else if (r.reason === 'busy') ElMessage.info('飞控正在传输，稍后再点一次')
  else if (r.reason === 'not-connected') ElMessage.warning(r.error || '飞控未连接')
  else ElMessage.error(fc.lastPullError || r.error || '读取失败，飞控上的文件没有被改动')
}
</script>

<style scoped>
.port{padding:18px 20px 60px;color:var(--dsh-text-1);background:var(--dsh-canvas);min-height:100%}
.pp-blocked{padding:24px 0}.pp-tip{margin:0 0 16px;color:var(--dsh-text-3);font-size:12px;line-height:1.6}.pp-tip a{color:var(--dsh-accent)}
.pp-card{margin-bottom:16px;border:1px solid var(--dsh-border);border-radius:var(--dsh-radius);background:var(--dsh-surface)}
.pp-card :deep(.el-card__header){padding:14px 16px;border-bottom:1px solid var(--dsh-border)}.pp-card :deep(.el-card__body){padding:16px}
.pp-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pp-card-title{font-weight:600;font-size:15px}.pp-dirty{font-size:12px;color:var(--dsh-warning)}.pp-spacer{flex:1}
.pp-note{margin:0 0 14px;font-size:12px;color:var(--dsh-text-3);line-height:1.7}
.port-row-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px}
.port-row-card{min-width:0;border:1px solid var(--dsh-border);border-radius:var(--dsh-radius);background:var(--dsh-canvas)}.port-row-card :deep(.el-card__body){padding:14px 16px}
.port-row-title{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid var(--dsh-border);font-size:13px}
.port-field{display:grid;grid-template-columns:minmax(100px,.8fr) minmax(0,1.2fr);gap:6px 14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--dsh-border)}.port-field:last-child{border-bottom:0}.port-field label{color:var(--dsh-text-2);font-size:12px;line-height:1.5}.port-field :deep(.el-select),.port-field :deep(.el-input){width:100%;min-width:0}
.pp-err,.pp-warn,.pp-hint{grid-column:2;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.pp-err{color:var(--dsh-danger)}.pp-warn{color:var(--dsh-warning)}.pp-hint,.pp-na,.pp-unit{color:var(--dsh-text-3)}.pp-na{font-size:12px}
@media(max-width:650px){.port{padding:14px 12px 60px}.pp-card :deep(.el-card__body){padding:12px}.port-row-grid{grid-template-columns:1fr}.port-field{gap:6px 10px}.pp-card-title{font-size:14px}}
</style>
