<template>
  <aside v-if="state !== 'online'" class="connection-notice" role="status" aria-live="polite">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 2 21h20L12 3zM12 9v5M12 17h.01" />
    </svg>
    <div>
      <strong>{{ heading }}</strong>
      <p>{{ description || defaultReason }}</p>
      <p v-if="state === 'disconnected' && cleared">断开后数值已清空，当前值为 --；重新连接后等待真实数据。</p>
      <small v-if="evidence">证据：{{ evidence }}</small>
    </div>
  </aside>
</template>
<script setup>
import { computed } from 'vue'
// 纯提示组件：父页面提供真实链路状态；不持有或恢复旧遥测。
const props = defineProps({
  state: { type: String, default: 'online' },
  description: { type: String, default: '' },
  cleared: { type: Boolean, default: false },
  evidence: { type: String, default: '' },
})
const heading = computed(
  () =>
    ({ disconnected: '链路已断开', stale: '心跳已过期', waiting: '等待飞控心跳', warning: '状态提醒' })[props.state] ||
    '状态未知'
)
const defaultReason = computed(
  () =>
    ({
      disconnected: '未连接飞控，不能读取或写回配置。',
      stale: '当前链路未收到有效心跳；页面残留读数不作为实时值或安全证据，请检查连接。',
      waiting: '串口已连接，尚未收到有效心跳，当前值为 --。',
      warning: '请确认真实数据与链路状态后继续操作。',
    })[props.state] || '链路状态未上报，当前值为 --。'
)
</script>
<style scoped>
.connection-notice {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid var(--dsh-border);
  border-left: 3px solid var(--dsh-warning);
  border-radius: var(--dsh-radius);
  background: var(--dsh-surface-2);
  color: var(--dsh-text-2);
  font-size: 12px;
}
svg {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--dsh-warning);
}
strong {
  color: var(--dsh-warning);
}
p {
  margin: 4px 0 0;
  line-height: 1.55;
}
small {
  display: block;
  margin-top: 5px;
  color: var(--dsh-text-3);
  overflow-wrap: anywhere;
  font-family: var(--dsh-font-mono);
}
</style>
