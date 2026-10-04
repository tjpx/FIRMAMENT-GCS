<template>
  <section class="task-progress" role="status" aria-live="polite" :aria-busy="active">
    <div class="task-head"><strong>{{ title }}</strong><span class="dsh-num">{{ knownPercentage === null ? '--' : `${knownPercentage}%` }}</span></div>
    <p v-if="description">{{ description }}</p>
    <div v-if="knownPercentage !== null" class="progress-track" role="progressbar" :aria-label="title" :aria-valuenow="knownPercentage" :aria-valuemin="0" :aria-valuemax="100"><div :style="{ width: `${knownPercentage}%` }" /></div>
    <div class="task-detail">
      <span v-if="knownReceived !== null">已收到 <span class="dsh-num">{{ knownReceived }}</span> {{ unit }}</span>
      <span v-if="knownTotal !== null">总数 <span class="dsh-num">{{ knownTotal }}</span> {{ unit }}</span>
      <span v-else>总量未上报</span>
      <span v-if="knownPercentage === null">进度未知</span>
    </div>
    <small v-if="evidence">证据：{{ evidence }}</small>
  </section>
</template>
<script setup>
import { computed } from 'vue'
// 仅接受父页面提供的真实计数/百分比，不按时间或收到数推测进度。
const props = defineProps({
  title: { type: String, default: '正在读取' },
  description: { type: String, default: '' },
  active: { type: Boolean, default: true },
  percentage: { type: Number, default: null },
  received: { type: Number, default: null },
  total: { type: Number, default: null },
  unit: { type: String, default: '项' },
  evidence: { type: String, default: '' },
})
const validNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const knownPercentage = computed(() => validNumber(props.percentage) && props.percentage <= 100 ? props.percentage : null)
const knownReceived = computed(() => validNumber(props.received) ? props.received : null)
const knownTotal = computed(() => validNumber(props.total) ? props.total : null)
</script>
<style scoped>
.task-progress { padding:12px 14px; border:1px solid var(--dsh-border); border-radius:var(--dsh-radius); background:var(--dsh-surface-2); color:var(--dsh-text-2); font-size:12px }
.task-head { display:flex; justify-content:space-between; gap:12px; color:var(--dsh-text-1) }
p { margin:6px 0; line-height:1.55 }
.task-detail { display:flex; gap:12px; flex-wrap:wrap; margin-top:7px }
.progress-track { margin-top:8px; height:4px; border-radius:var(--dsh-radius-full); background:var(--dsh-border); overflow:hidden }
.progress-track > div { height:100%; background:var(--dsh-accent) }
small { display:block; margin-top:6px; color:var(--dsh-text-3); overflow-wrap:anywhere; font-family:var(--dsh-font-mono) }
</style>
