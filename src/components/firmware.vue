<template>
  <main class="firmware-page">
    <TaskHeader title="固件烧写" description="先选择机架与飞控型号，再选择固件。烧写前请拆桨、备份配置并保持稳定供电。" />
    <section class="firmware-card">
      <div class="selectors"><label>机架类型<el-select v-model="airframe" :disabled="busy || !!device" @change="resetSelection"><el-option v-for="item in FIRMWARE_AIRFRAMES" :key="item.value" :label="item.label" :value="item.value" /></el-select></label><label>飞控型号<el-select v-model="board" :disabled="busy || !!device" @change="resetSelection"><el-option v-for="item in FIRMWARE_BOARDS" :key="item.value" :label="item.label" :value="item.value" /></el-select></label></div>
      <el-tabs v-model="source" :before-leave="() => !busy">
        <el-tab-pane label="本地固件" name="local"><p class="note">当前支持 Sieon S1 的 .bin 文件。机架选择不会修改固件内容，请使用适合所选机架的文件。</p><input type="file" accept=".bin" :disabled="busy || !!device" aria-label="选择本地固件" @change="selectFile" /><p v-if="inspection">{{ inspection.name }} · {{ (inspection.size / 1024).toFixed(1) }} KB</p></el-tab-pane>
        <el-tab-pane label="在线固件" name="online"><p class="note">{{ firmwareDistributionState().reason }}</p></el-tab-pane>
      </el-tabs>
      <el-alert v-if="error" type="error" :closable="false" :title="error" />
      <template v-if="source === 'local'">
        <p class="note">连接引导器会断开 MAVLink。点击后选择引导器串口；必要时按设备说明重新插拔 USB 进入引导器，并关闭 QGC 等占用串口的软件。</p>
        <div class="actions"><el-button :disabled="!canIdentify" :loading="busy && !device" @click="connectBootloader">连接并检查引导器</el-button><el-button v-if="device && !destructive" :disabled="busy" @click="closeAfterOperation">退出引导器连接</el-button></div>
        <p v-if="device" class="note">已确认 Sieon S1 引导器，固件空间 {{ (device.flashSize / 1024).toFixed(0) }} KB。</p>
        <TypedConfirm v-if="device" v-model="typed" expected="刷写" description="输入“刷写”确认擦除并写入固件。写入中断可能需要重新烧写。" :disabled="busy || destructive" />
        <el-button v-if="device" type="danger" :disabled="!canFlash" @click="flash">开始烧写</el-button>
      </template>
      <TaskProgress v-if="busy" :title="status" :percentage="progress" />
      <p role="status" class="note">{{ status }}</p>
      <el-alert v-if="destructive && error" type="warning" :closable="false" title="固件写入未完成，请勿飞行" description="保持设备供电，重新进入引导器后再次烧写。关闭页面不能恢复之前的固件。" />
      <el-button v-if="destructive && error && !busy" @click="resetFailedSession">重新准备烧写</el-button>
    </section>
  </main>
</template>
<script setup>
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import TaskHeader from './task-header.vue'
import TaskProgress from './task-progress.vue'
import TypedConfirm from './typed-confirm.vue'
import { inspectFirmwareFile } from '../utils/firmware-package.js'
import { FIRMWARE_AIRFRAMES, FIRMWARE_BOARDS, firmwareDistributionState } from '../utils/firmware-catalog.js'
import { openBootloaderSerial } from '../utils/bootloader-serial.js'
import { identifyBootloader, flashS1Firmware, validateS1Image } from '../utils/px4-bootloader.js'
const mav = inject('mavlink'); const fc = inject('fcconfig')
const airframe = ref('multicopter'); const board = ref('sieon-s1'); const source = ref('local')
const inspection = ref(null); const busy = ref(false); const error = ref(''); const status = ref('请选择本地固件')
const typed = ref(''); const device = ref(null)
const progress = ref(null); const destructive = ref(false)
let io = null; let release = null; let disposed = false
const motorSafety = inject('motorTestSafety')
const canIdentify = computed(() => !motorSafety?.value?.active && !motorSafety?.value?.uncertain && !mav.firmwareExclusive.value && typeof navigator !== 'undefined' && !!navigator.serial && !busy.value && !device.value && inspection.value && compatible.value && backup.value && !fc.busy && !fc.hasChanges && !mav.connecting.value && !mav.reconnecting.value && !mav.vehicle.armed)
const canFlash = computed(() => !busy.value && !!device.value && !!io && !!release && !!inspection.value && !motorSafety?.value?.active && !motorSafety?.value?.uncertain && compatible.value && backup.value && source.value === 'local' && typed.value === '刷写' && !destructive.value)
function resetSelection() { compatible.value = false; typed.value = ''; inspection.value = null }
async function releaseDevice() {
  const channel = io
  if (channel) await channel.close()
  io = null; device.value = null
  if (release) { release(); release = null }
}
async function closeAfterOperation() {
  const wasBusy = busy.value; busy.value = true
  try { await releaseDevice() } catch (e) { error.value = `串口关闭失败，连接仍被锁定：${e.message || e}` }
  finally { busy.value = wasBusy }
}
async function selectFile(event) {
  if (busy.value) return
  const file = event.target.files?.[0]
  busy.value = true; error.value = ''; inspection.value = null; typed.value = ''; compatible.value = false
  try {
    await releaseDevice()
    const result = await inspectFirmwareFile(file)
    if (!result.ok) throw new Error(result.reason)
    if (result.extension !== '.bin') throw new Error('Sieon S1 当前仅支持 .bin 固件')
    validateS1Image(new Uint8Array(result.buffer))
    inspection.value = result; status.value = '固件文件已检查，可连接引导器'
  } catch (e) { error.value = e.message || String(e) }
  finally { busy.value = false }
}
async function connectBootloader() {
  if (!canIdentify.value) return
  // requestPort必须在用户点击调用栈内，随后再等待MAVLink清理。
  const portPromise = navigator.serial.requestPort()
  portPromise.catch(() => {})
  busy.value = true; error.value = ''; status.value = '正在释放 MAVLink 并连接引导器'
  try {
    release = await mav.acquireFirmwareExclusive()
    const port = await portPromise
    if (disposed) throw new Error('页面已关闭')
    io = await openBootloaderSerial(port)
    if (disposed) throw new Error('页面已关闭')
    const info = await identifyBootloader(io)
    if (disposed) throw new Error('页面已关闭')
    device.value = info
    status.value = '引导器检查通过，等待确认烧写'
  } catch (e) {
    error.value = e.message || String(e)
    if (e.ownershipUncertain) error.value += '；设备释放状态不确定，连接已锁定。请关闭页面并重新插拔设备后再试。'
    else await closeAfterOperation()
  }
  finally { busy.value = false; portPromise.catch(() => {}) }
}
async function flash() {
  if (!canFlash.value) return
  busy.value = true; error.value = ''; progress.value = null; destructive.value = false
  try {
    await flashS1Firmware(io, new Uint8Array(inspection.value.buffer), {
      confirmed: true,
      onStage: event => { if (event.stage === 'erasing') destructive.value = true; status.value = ({ erasing: '正在擦除固件', programming: '正在写入固件', verifying: '正在校验固件', rebooting: '校验通过，正在重启' })[event.stage] || '正在烧写' },
      onProgress: event => { progress.value = event.stage === 'programming' && event.total > 0 ? Math.floor(event.written / event.total * 100) : null },
    })
    status.value = '固件写入与校验完成。请等待设备启动，再手动连接 MAVLink 检查。'
    await releaseDevice(); destructive.value = false
  } catch (e) { error.value = e.message || String(e); status.value = '烧写未完成'; await closeAfterOperation() }
  finally { busy.value = false; progress.value = null }
}
function resetFailedSession() { destructive.value = false; typed.value = ''; error.value = ''; status.value = '请重新连接引导器' }
function preventUnload(event) { if (busy.value || device.value) { event.preventDefault(); event.returnValue = '' } }
window.addEventListener('beforeunload', preventUnload)
onBeforeUnmount(() => { disposed = true; window.removeEventListener('beforeunload', preventUnload); if (!busy.value) void closeAfterOperation() })
</script>
<style scoped>
.firmware-page{padding:20px;min-height:100%;color:var(--dsh-text-1);background:var(--dsh-canvas)}.firmware-card{padding:20px;border:1px solid var(--dsh-border);border-radius:var(--dsh-radius);background:var(--dsh-surface);max-width:1000px}.selectors{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px}.selectors label{display:flex;flex-direction:column;gap:8px;font-size:13px;min-width:220px}.note{font-size:13px;line-height:1.8;color:var(--dsh-text-2)}.checks,.actions{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}.checks{flex-direction:column;gap:8px}@media(max-width:650px){.firmware-page,.firmware-card{padding:14px}.selectors label{min-width:0;width:100%}}
</style>
