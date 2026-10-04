<template>
  <div v-if="expected" class="typed-confirm">
    <p>{{ description }} 请手动输入 <strong>{{ expected }}</strong>。</p>
    <el-input :model-value="modelValue" :disabled="disabled" :placeholder="`输入 ${expected}`" autocomplete="off" @update:model-value="$emit('update:modelValue', $event)" @paste.prevent @drop.prevent />
  </div>
  <el-dialog :model-value="visible" :title="request.title || '危险操作二次确认'" width="min(480px, 92vw)" :close-on-click-modal="false" @update:model-value="value => { if (!value) settle(false) }">
    <p>{{ request.description }}</p><p>请手动输入 <strong>{{ request.expected }}</strong>。</p>
    <el-input v-model="typed" autocomplete="off" :placeholder="`输入 ${request.expected}`" @paste.prevent @drop.prevent />
    <template #footer><el-button @click="settle(false)">取消</el-button><el-button type="danger" :disabled="typed !== request.expected" @click="settle(true)">{{ request.confirmText || '确认继续' }}</el-button></template>
  </el-dialog>
</template>
<script setup>
import { ref, onUnmounted } from 'vue'
defineProps({ modelValue: { type: String, default: '' }, expected: { type: String, default: '' }, description: { type: String, default: '确认危险操作。' }, disabled: Boolean })
defineEmits(['update:modelValue'])
const visible = ref(false); const typed = ref(''); const request = ref({}); let resolve
function settle(value) { visible.value = false; typed.value = ''; const done = resolve; resolve = null; done?.(value) }
function confirm(options) { if (resolve) settle(false); request.value = { ...options }; typed.value = ''; visible.value = true; return new Promise((done) => { resolve = done }) }
defineExpose({ confirm })
onUnmounted(() => settle(false))
</script>
<style scoped>
.typed-confirm { padding:12px; border:1px solid var(--dsh-warning); border-radius:6px; background:var(--dsh-warning-soft); color:var(--dsh-text-1) }
.typed-confirm p { margin:0 0 8px; color:var(--dsh-text-2) }
strong { color:var(--dsh-warning) }
</style>
