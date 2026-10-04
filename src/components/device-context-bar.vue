<template>
  <div class="device-context" :class="`device-context--${state}`">
    <span class="context-dot" aria-hidden="true"></span><strong>{{ status }}</strong><span>{{ identity }}</span><span class="context-sep">·</span><span>{{ heartbeat }}</span><span v-if="warning" class="context-warning">{{ warning }}</span><slot />
  </div>
</template>
<script setup>
defineProps({ state: { type: String, default: 'unknown' }, status: { type: String, default: '未连接' }, identity: { type: String, default: '设备未识别' }, heartbeat: { type: String, default: '心跳 —' }, warning: { type: String, default: '' } })
</script>
<style scoped>
.device-context{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin-bottom:12px;border:1px solid var(--dsh-border);border-radius:6px;background:var(--dsh-surface-2);font-size:12px;color:var(--dsh-text-2)}.device-context strong{color:var(--dsh-text-1)}.context-dot{width:8px;height:8px;border-radius:50%;background:var(--dsh-placeholder)}.device-context--live .context-dot{background:var(--dsh-success)}.device-context--stale .context-dot{background:var(--dsh-warning)}.device-context--danger .context-dot{background:var(--dsh-danger-vivid)}.context-sep{color:var(--dsh-text-3)}.context-warning{color:var(--dsh-warning);margin-left:auto}
</style>
