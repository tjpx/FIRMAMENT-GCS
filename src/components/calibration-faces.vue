<template>
  <div class="face-plate">
    <div class="airframe-diagram" :aria-label="`六面姿态校准指示图（${title}）`">
      <div
          v-for="face in faces"
          :key="face.key"
          class="face-cell"
          :class="[`face-cell--${stateOf(face.key)}`, { 'face-cell--current': current === face.key }]"
      >
        <div class="face-signal" :class="signalClass(face.key)" />
        <div class="face-glyph">{{ face.glyph }}</div>
        <div class="face-name">{{ face.label }}</div>
        <div class="face-status">{{ statusText(stateOf(face.key)) }}</div>
        <div v-if="showAxis" class="face-axis">{{ face.axis }}</div>
      </div>
    </div>
    <div class="calib-signal-line">
      <span class="signal-box" :class="current ? signalClass(current) : 'signal-box--idle'" />
      <span>{{ guide }}</span>
    </div>
    <div class="face-missing" :class="{ 'face-missing--ok': missing.length === 0 && doneCount > 0 }">{{ missingText }}</div>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { CALIBRATION_FACES, doneFaces, faceLabel, faceMeta, missingFaceKeys } from '../utils/calibration-faces.js'

const props = defineProps({
  /** 每面的状态：{ up: { state: 'idle' | 'active' | 'done' } } */
  states: { type: Object, default: () => ({}) },
  /** 当前飞控已识别的面 */
  current: { type: String, default: '' },
  /** accel = 保持静止；mag = 绕该面法线旋转 */
  mode: { type: String, default: 'accel' },
  busy: { type: Boolean, default: false },
  title: { type: String, default: '六面姿态' },
})

const faces = CALIBRATION_FACES
const showAxis = computed(() => props.mode === 'mag')
const stateOf = (key) => props.states?.[key]?.state || 'idle'
const signalClass = (key) => stateOf(key) === 'done' ? 'face-signal--green' : stateOf(key) === 'active' ? 'face-signal--red' : 'face-signal--idle'
const statusText = (state) => state === 'done' ? '已完成' : state === 'active' ? (props.mode === 'mag' ? '旋转中' : '保持不动') : '待校准'
const doneCount = computed(() => doneFaces(props.states).length)
const missing = computed(() => missingFaceKeys(props.states))
const missingText = computed(() => {
  if (!doneCount.value && !missing.value.length) return '尚未完成任何面：等待飞控识别第一个姿态'
  if (!missing.value.length) return `六面已完成（${doneCount.value}/6）`
  return `已完成 ${doneCount.value}/6，还缺 ${missing.value.map(faceLabel).join('、')}`
})
/* 引导文案只描述固件确实做过的事：mag 需要绕该面法线转，accel 需要保持静止 */
const guide = computed(() => {
  const meta = faceMeta(props.current)
  if (!meta) return props.busy ? '等待飞控识别姿态' : '开始后等待飞控识别姿态'
  return props.mode === 'mag'
    ? `已识别${faceLabel(props.current)}，把该面朝${meta.axis}轴方向摆好，${meta.axisText}`
    : `已识别${faceLabel(props.current)}，保持该姿态静止到飞控报 side done`
})
</script>
<style scoped>
.face-plate { display: grid; gap: 8px }
.airframe-diagram { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px }
.face-cell { position: relative; min-height: 76px; padding: 8px 6px; text-align: center; border: 1px solid var(--dsh-border); border-radius: 6px; background: var(--dsh-surface); transition: border-color .15s, background .15s }
.face-cell--current { border-color: var(--dsh-warning-fill); box-shadow: 0 0 0 1px var(--dsh-warning-fill) inset }
.face-cell--active { background: color-mix(in srgb, var(--dsh-danger) 12%, var(--dsh-surface)); border-color: var(--dsh-danger) }
.face-cell--done { background: color-mix(in srgb, var(--dsh-success) 12%, var(--dsh-surface)); border-color: var(--dsh-success) }
.face-signal { width: 10px; height: 10px; margin: 0 auto 3px; border-radius: 50%; background: var(--dsh-text-3) }
.face-signal--red { background: var(--dsh-danger); box-shadow: 0 0 8px color-mix(in srgb, var(--dsh-danger) 70%, transparent) }
.face-signal--green { background: var(--dsh-success); box-shadow: 0 0 8px color-mix(in srgb, var(--dsh-success) 70%, transparent) }
.face-glyph { font-size: 22px; line-height: 24px; color: var(--dsh-text-1) }
.face-name { font-size: 12px; color: var(--dsh-text-1) }
.face-status { margin-top: 2px; font-size: 11px; color: var(--dsh-text-2) }
.face-axis { margin-top: 2px; font: 11px var(--dsh-font-mono, monospace); color: var(--dsh-accent-ink, var(--dsh-accent)) }
.calib-signal-line { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsh-text-2) }
.signal-box { width: 12px; height: 12px; border-radius: 3px; background: var(--dsh-text-3); flex: none }
.signal-box--green { background: var(--dsh-success) }
.signal-box--red { background: var(--dsh-danger) }
.signal-box--idle { background: var(--dsh-text-3) }
.face-missing { font-size: 12px; color: var(--dsh-warning) }
.face-missing--ok { color: var(--dsh-success) }
</style>
