<template>
  <header class="task-header">
    <div><h1>{{ title }} <PageHelp v-if="help" :text="help" /></h1><p v-if="description" class="task-description">{{ description }}</p></div>
    <div class="task-actions"><slot name="status"><FreshnessBadge v-if="freshness" :state="freshness.state" :label="freshness.label" :detail="freshness.detail" /></slot><slot /></div>
  </header>
</template>
<script setup>
import FreshnessBadge from './freshness-badge.vue'
import PageHelp from './page-help.vue'
defineProps({ title: { type: String, required: true }, eyebrow: String, description: String, help: String, freshness: { type: Object, default: null } })
</script>
<style scoped>
.task-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--dsh-border)}h1{margin:0;font-size:clamp(22px,3vw,32px);color:var(--dsh-text-1);display:flex;align-items:center;gap:7px}.task-eyebrow{margin:0 0 5px;color:var(--dsh-accent);font:11px var(--dsh-font-mono);letter-spacing:.12em}.task-description{margin:7px 0 0;color:var(--dsh-text-2);line-height:1.5}.task-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}@media(max-width:650px){.task-header{flex-direction:column}.task-actions{width:100%}}
</style>

