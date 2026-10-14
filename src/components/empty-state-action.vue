<template>
  <div class="empty-state" role="status" aria-live="polite">
    <svg
      class="empty-icon"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 4h10l5 5v19H8V4zM19 4v6h5M12 16h8M12 21h5" />
    </svg>
    <div class="empty-title">{{ title }}</div>
    <p>{{ reason || description || '数据尚未上报，当前值为 --。' }}</p>
    <el-button v-if="actionLabel" size="small" type="primary" :disabled="actionDisabled" @click="$emit('action')">{{
      actionLabel
    }}</el-button>
    <small v-if="evidence">证据：{{ evidence }}</small>
  </div>
</template>
<script setup>
defineEmits(['action'])
// description 保留兼容；新调用方可用 reason 明确说明缺口。
defineProps({
  title: { type: String, default: '尚无数据' },
  reason: { type: String, default: '' },
  description: { type: String, default: '' },
  actionLabel: { type: String, default: '' },
  actionDisabled: { type: Boolean, default: false },
  evidence: { type: String, default: '' },
})
</script>
<style scoped>
.empty-state {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 7px;
  padding: 28px 16px;
  text-align: center;
  color: var(--dsh-text-2);
}
.empty-icon {
  width: 32px;
  height: 32px;
  color: var(--dsh-text-3);
}
.empty-title {
  font-weight: 600;
  color: var(--dsh-text-1);
}
.empty-state p {
  margin: 0;
  max-width: 460px;
  font-size: 12px;
  line-height: 1.55;
}
.empty-state small {
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--dsh-text-3);
  font-family: var(--dsh-font-mono);
}
</style>
