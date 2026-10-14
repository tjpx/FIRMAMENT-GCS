<template>
  <section class="danger-zone">
    <div>
      <p class="danger-kicker">DANGER ZONE</p>
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
    </div>
    <div class="danger-actions">
      <slot /><small v-if="disabledReason">{{ disabledReason }}</small>
    </div>
  </section>
</template>
<script setup>
defineProps({
  title: { type: String, default: '危险操作' },
  description: { type: String, default: '' },
  disabledReason: { type: String, default: '' },
})
</script>
<style scoped>
.danger-zone {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--dsh-danger-vivid) 60%, var(--dsh-border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--dsh-danger-vivid) 7%, var(--dsh-surface));
  margin-top: 14px;
}
.danger-kicker {
  margin: 0 0 3px;
  color: var(--dsh-danger-vivid);
  font: 11px var(--dsh-font-mono);
  letter-spacing: 0.12em;
}
.danger-zone h3 {
  margin: 0;
  color: var(--dsh-text-1);
  font-size: 15px;
}
.danger-zone p:not(.danger-kicker) {
  margin: 5px 0 0;
  color: var(--dsh-text-2);
  font-size: 12px;
  line-height: 1.5;
}
.danger-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.danger-actions small {
  color: var(--dsh-text-3);
  max-width: 210px;
}
@media (max-width: 650px) {
  .danger-zone {
    align-items: flex-start;
    flex-direction: column;
  }
  .danger-actions {
    width: 100%;
  }
}
</style>
