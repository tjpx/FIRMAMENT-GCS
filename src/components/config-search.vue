<template>
  <el-dialog v-model="visible" title="全局配置搜索" width="min(680px, 94vw)" :close-on-click-modal="true" @opened="focusInput" @closed="finishNavigate" @keydown="handleKeydown">
    <el-input ref="inputRef" v-model="query" placeholder="参数名 / 中文标签 / 分组 / 当前内存值（子序列匹配）" clearable
      role="combobox" aria-label="搜索已加载配置" aria-autocomplete="list" aria-expanded="true" :aria-controls="listId"
      :aria-activedescendant="results.length ? optionId(activeIndex) : undefined" />
    <p class="search-note">仅搜索已下载配置的当前内存值（含已提交的待保存修改），不是实时遥测或预置参数库。</p>
    <p class="search-count" role="status" aria-live="polite">{{ entries.length ? `匹配 ${results.length} / ${entries.length} 项` : '尚未加载配置；连接并读取后即可搜索。' }}</p>
    <ul :id="listId" ref="listRef" class="search-results" role="listbox" aria-label="配置搜索结果">
      <li v-for="(entry, index) in results" :id="optionId(index)" :key="entry.key" role="option" :aria-selected="index === activeIndex"
          class="search-result" :class="{ 'is-active': index === activeIndex }" @mouseenter="activeIndex = index" @click="navigate(entry)">
        <div class="result-heading"><strong>{{ entry.name }}</strong><span>{{ pageLabel(entry.path) }}</span></div>
        <div class="result-detail"><span>{{ entry.label }} · {{ entry.group || '未分组' }}</span><code>{{ searchValue(entry.value) }}</code></div>
      </li>
    </ul>
    <p v-if="entries.length && !results.length" class="search-note">无匹配项。搜索不会创建或修改参数。</p>
    <template #footer><span class="search-note">↑ ↓ 选择 · Enter 定位 · Esc 关闭</span><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<script setup>
import { computed, inject, nextTick, ref, useId, watch } from 'vue'
import { buildConfigSearchIndex, searchConfigIndex, searchValue } from '../utils/search-index.js'
const emit = defineEmits(['navigate'])
const fc = inject('fcconfig', null)
const visible = ref(false), query = ref(''), activeIndex = ref(0)
const inputRef = ref(null), listRef = ref(null)
const listId = `config-search-${useId()}`
const optionId = (index) => `${listId}-${index}`
const entries = computed(() => {
  void fc?.revision
  void fc?.lastPullAt
  void fc?.files?.param?.crc32Hex
  void fc?.files?.sysconfig?.crc32Hex
  return buildConfigSearchIndex(fc)
})
const results = computed(() => searchConfigIndex(entries.value, query.value))
watch(results, () => { activeIndex.value = 0 })
watch(activeIndex, async () => {
  await nextTick()
  listRef.value?.children[activeIndex.value]?.scrollIntoView?.({ block: 'nearest' })
})
function focusInput() { inputRef.value?.focus() }
let pendingNavigation = null
function open(initialQuery = '') {
  pendingNavigation = null
  query.value = typeof initialQuery === 'string' ? initialQuery : ''
  activeIndex.value = 0
  visible.value = true
  nextTick(focusInput)
}
function navigate(entry) {
  if (!entry) return
  pendingNavigation = { path: entry.path, query: { ...entry.query } }
  visible.value = false
}
function finishNavigate() {
  const target = pendingNavigation
  pendingNavigation = null
  if (target) emit('navigate', target)
}
function handleKeydown(event) {
  if (event.isComposing) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); visible.value = false }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (results.value.length) activeIndex.value = (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + results.value.length) % results.value.length
  } else if (event.key === 'Enter') { event.preventDefault(); navigate(results.value[activeIndex.value]) }
}
function pageLabel(path) { return ({ '/power': '电池', '/failsafe': '失控保护', '/pid': 'PID 整定', '/rc': '遥控器 / 接收机', '/parameter': '参数配置' })[path] || path }
defineExpose({ open })
</script>

<style scoped>
.search-note,.search-count { color:var(--dsh-text-3); font-size:var(--dsh-font-sm); margin:var(--dsh-gap) 0 }
.search-results { list-style:none; padding:0; margin:0; max-height:50vh; overflow:auto; border:1px solid var(--dsh-border); border-radius:var(--dsh-radius-sm) }
.search-result { cursor:pointer; padding:var(--dsh-gap); border-bottom:1px solid var(--dsh-border); color:var(--dsh-text-1) }
.search-result:last-child { border-bottom:0 }
.search-result:hover { background:var(--dsh-hover) }
.search-result.is-active { background:var(--dsh-accent-soft); box-shadow:inset 2px 0 var(--dsh-accent) }
.result-heading,.result-detail { display:flex; justify-content:space-between; gap:var(--dsh-gap); overflow-wrap:anywhere }
.result-heading strong,.result-detail code { font-family:var(--dsh-font-mono); font-variant-numeric:tabular-nums }
.result-heading span,.result-detail { color:var(--dsh-text-2); font-size:var(--dsh-font-sm) }
.result-detail { margin-top:var(--dsh-gap-sm) }
.result-detail code { max-width:45%; overflow-wrap:anywhere }
</style>
