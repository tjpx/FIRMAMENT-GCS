<template>
  <div class="evidence">
    <span class="evidence-label">{{ label }}</span
    ><strong>{{ value || '—' }}</strong
    ><small v-if="detail">{{ detail }}</small>
  </div>
</template>
<script setup>
defineProps({ label: String, value: String, detail: String })
</script>
<style scoped>
.evidence {
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 12px;
}
.evidence-label {
  color: var(--dsh-text-3);
}
.evidence strong {
  font-family: var(--dsh-font-mono);
  font-weight: 600;
}
.evidence small {
  color: var(--dsh-text-3);
}
</style>
