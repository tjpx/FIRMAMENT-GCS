<template>
  <span class="ui-state" :class="`ui-state--${state}`" :title="detail || label">{{ label }}</span>
</template>
<script setup>
defineProps({
  state: { type: String, default: 'unknown' },
  label: { type: String, default: '未验证' },
  detail: { type: String, default: '' },
})
</script>
<style scoped>
.ui-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}
.ui-state::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsh-placeholder);
}
.ui-state--live::before,
.ui-state--success::before {
  background: var(--dsh-success);
}
.ui-state--working::before {
  background: var(--dsh-accent);
}
.ui-state--warning::before,
.ui-state--stale::before {
  background: var(--dsh-warning);
}
.ui-state--danger::before,
.ui-state--blocked::before {
  background: var(--dsh-danger-vivid);
}
.ui-state--live,
.ui-state--success {
  color: var(--dsh-success);
}
.ui-state--danger,
.ui-state--blocked {
  color: var(--dsh-danger-vivid);
}
.ui-state--stale {
  color: var(--dsh-text-3);
}
</style>
