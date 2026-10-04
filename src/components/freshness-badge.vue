<template><span class="freshness" :class="`freshness--${state}`" :title="detail">● {{ label }}</span></template>
<script setup>
defineProps({ state: { type: String, default: 'unknown' }, label: { type: String, default: '未上报' }, detail: { type: String, default: '' } })
</script>
<style scoped>
.freshness{font-size:12px;white-space:nowrap}.freshness--live,.freshness--success{color:var(--dsh-success)}.freshness--working{color:var(--dsh-accent)}.freshness--warning{color:var(--dsh-warning)}.freshness--stale{color:var(--dsh-text-3)}.freshness--danger,.freshness--blocked{color:var(--dsh-danger-vivid)}
</style>
