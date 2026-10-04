<template>
  <main class="presets-page">
    <TaskHeader title="预设 Beta" description="按机型与任务浏览预设。当前条目待收录，仅供查看。">
      <el-tag type="info" effect="plain">只读 · 无参数数值</el-tag>
    </TaskHeader>
    <el-alert class="framework-notice" type="warning" :closable="false" show-icon title="预设配置待收录，未实机验证。当前仅供查看，不能应用到飞控。" />
    <section class="preset-filters" aria-label="筛选预设">
      <label>机型<el-select v-model="aircraft" aria-label="机型筛选"><el-option label="全部机型" value="" /><el-option v-for="value in aircraftOptions" :key="value" :label="value" :value="value" /></el-select></label>
      <label>任务<el-select v-model="task" aria-label="任务筛选"><el-option label="全部任务" value="" /><el-option v-for="value in taskOptions" :key="value" :label="value" :value="value" /></el-select></label>
      <label class="search-filter">搜索<el-input v-model="search" clearable aria-label="搜索预设" placeholder="搜索名称、机型或任务" /></label>
      <button type="button" class="plain-button" @click="resetFilters">重置筛选</button>
    </section>
    <div class="catalog-summary" aria-live="polite"><span>{{ filtered.length }} 个待收录预设</span><span>{{ loadedSummary }}</span></div>
    <section v-if="filtered.length" class="preset-grid" aria-label="待收录预设列表">
      <article v-for="item in filtered" :key="item.id" class="preset-card">
        <div class="card-heading"><span class="card-category">{{ item.aircraft }} / {{ item.task }}</span><el-tag size="small" type="info" effect="plain">待收录</el-tag></div>
        <h2>{{ item.title }}</h2><p class="card-description">{{ item.summary }}</p>
        <dl class="card-metadata"><div><dt>作者</dt><dd>{{ item.author }}</dd></div><div><dt>来源</dt><dd>{{ item.source }}</dd></div><div><dt>固件</dt><dd>{{ item.firmware }}</dd></div><div><dt>验证</dt><dd>{{ item.validation }}</dd></div></dl>
        <div class="card-footer"><span>无参数数值</span><button type="button" class="detail-button" :aria-label="`查看${item.title}详情`" @click="openDetails(item)">查看详情</button></div>
      </article>
    </section>
    <el-empty v-else description="没有匹配的待收录预设，请调整筛选条件。" :image-size="72" />
    <el-dialog v-model="dialogVisible" :title="selected ? `${selected.title} · 待收录预设` : '详情'" width="min(760px, calc(100vw - 24px))">
      <div v-if="selected" class="preset-details">
        <el-alert type="warning" :closable="false" show-icon title="只读预设 · 未实机验证 · 配置待收录" />
        <dl class="detail-metadata"><div><dt>作者</dt><dd>{{ selected.author }}</dd></div><div><dt>来源</dt><dd>{{ selected.source }}</dd></div><div><dt>固件</dt><dd>{{ selected.firmware }}</dd></div><div><dt>验证</dt><dd>{{ selected.validation }}</dd></div></dl>
        <section><h3>适用前提</h3><ul><li v-for="line in selected.prerequisites" :key="line">{{ line }}</li></ul></section>
        <section><h3>安全说明</h3><ul><li v-for="line in selected.safety" :key="line">{{ line }}</li></ul></section>
        <section><h3>任务检查清单</h3><p class="detail-note">待执行事项，不代表已检查或已通过。</p><ul><li v-for="line in selected.checklist" :key="line">{{ line }}</li></ul></section>
        <section><h3>参数差异对照（只读）</h3><p class="detail-note">{{ loadedSummary }}。</p>
          <el-table v-if="comparison.length" :data="comparison" size="small" border>
            <el-table-column prop="group" label="分组" min-width="100" /><el-table-column prop="name" label="参数名" min-width="120" />
            <el-table-column label="已读取值" min-width="110"><template #default="{ row }">{{ row.hasCurrent ? row.currentValue : '缺失' }}</template></el-table-column>
            <el-table-column prop="presetValue" label="待审查数值" min-width="110" />
            <el-table-column label="对照" min-width="90"><template #default="{ row }">{{ comparisonLabel(row.status) }}</template></el-table-column>
          </el-table>
          <p v-else class="no-values" role="status">暂无预设数值，无法参数差异对照</p>
        </section>
      </div>
      <template #footer><el-button @click="dialogVisible = false">关闭</el-button></template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, inject, ref } from 'vue'
import TaskHeader from './task-header.vue'
import { PRESET_CATALOG, filterPresets, comparePresetParameters } from '../utils/preset-catalog.js'

const fc = inject('fcconfig', null)
const aircraft = ref(''), task = ref(''), search = ref('')
const selected = ref(null), dialogVisible = ref(false)
const aircraftOptions = [...new Set(PRESET_CATALOG.map((item) => item.aircraft))]
const taskOptions = [...new Set(PRESET_CATALOG.map((item) => item.task))]
const filtered = computed(() => filterPresets(PRESET_CATALOG, { aircraft: aircraft.value, task: task.value, search: search.value }))
// 只观察注入的已加载文档；没有文档不推测参数数量，也不触发通信。
const parameterDoc = computed(() => { void fc?.revision; return fc?.files?.param?.loaded ? fc.doc('param') : null })
const currentParameters = computed(() => { void fc?.revision; return parameterDoc.value?.list?.() ?? [] })
const loadedSummary = computed(() => parameterDoc.value ? `已读取 ${currentParameters.value.length} 项参数；实时值可能已变化` : '尚未读取飞控参数')
const comparison = computed(() => comparePresetParameters(selected.value?.parameters ?? [], currentParameters.value))
function resetFilters() { aircraft.value = ''; task.value = ''; search.value = '' }
function openDetails(item) { selected.value = item; dialogVisible.value = true }
function comparisonLabel(status) { return ({ missing: '当前缺失', same: '相同', different: '不同' })[status] }
</script>

<style scoped>
.presets-page{min-height:100%;padding:clamp(16px,3vw,32px);background:var(--dsh-canvas);color:var(--dsh-text-1)}
.framework-notice{margin-bottom:16px}.preset-filters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;padding:12px;border:1px solid var(--dsh-border);border-radius:var(--dsh-radius);background:var(--dsh-surface)}
.preset-filters label{display:grid;gap:5px;width:155px;color:var(--dsh-text-2);font-size:12px}.preset-filters .search-filter{flex:1;min-width:190px}.catalog-summary{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:12px 0;color:var(--dsh-text-3);font-size:12px}
.preset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.preset-card{display:flex;flex-direction:column;min-width:0;padding:15px;border:1px solid var(--dsh-border);border-top:3px solid var(--dsh-accent);border-radius:var(--dsh-radius);background:var(--dsh-surface)}
.card-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.card-category{color:var(--dsh-text-3);font-size:12px}.preset-card h2{margin:12px 0 6px;font-size:18px}.card-description{margin:0 0 14px;line-height:1.6;color:var(--dsh-text-2);font-size:13px;flex:1}
.card-metadata,.detail-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;font-size:12px}.card-metadata div,.detail-metadata div{display:flex;gap:8px;flex-wrap:wrap}dt{color:var(--dsh-text-3)}dd{margin:0;color:var(--dsh-text-2)}.card-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-border);font-size:12px;color:var(--dsh-text-3)}
.plain-button,.detail-button{cursor:pointer;border:1px solid var(--dsh-border);border-radius:var(--dsh-radius-sm);padding:7px 10px;background:var(--dsh-surface-2);color:var(--dsh-text-1);font:inherit;font-size:12px}.detail-button{border-color:var(--dsh-accent-deep)}button:hover{background:var(--dsh-surface-3)}button:focus-visible{outline:2px solid var(--dsh-accent-deep);outline-offset:3px}
.preset-details{line-height:1.6}.detail-metadata{margin:16px 0}.preset-details h3{font-size:14px;margin:18px 0 6px}.preset-details ul{margin:0;padding-left:21px;color:var(--dsh-text-2)}.detail-note{margin:0 0 8px;color:var(--dsh-text-3);font-size:12px}.no-values{padding:14px;background:var(--dsh-surface-2);border:1px dashed var(--dsh-border);border-radius:var(--dsh-radius);color:var(--dsh-text-2)}
@media(max-width:1050px){.preset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){.preset-grid{grid-template-columns:1fr}.preset-filters label{width:calc(50% - 6px)}.preset-filters .search-filter{flex-basis:100%}.catalog-summary{flex-direction:column}.detail-metadata{grid-template-columns:1fr}}
</style>
