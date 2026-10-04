<template>
  <main class="environment-page">
    <section class="environment-panel" aria-labelledby="environment-title">
      <div class="section-heading"><div><h1 id="environment-title">飞前环境 · 人工检查</h1></div><span class="manual-badge">人工确认</span></div>
      <p class="panel-copy">空域、许可、人员和现场条件需逐项人工确认；天气可按需查询公开接口，仅作参考，不替代设备检查或当地规定。</p>
      <p class="manual-warning">未自动检测，不代表获准飞行</p>
      <div class="environment-list">
        <label v-for="item in environmentItems" :key="item.key" class="environment-item">
          <input v-model="manualChecks" type="checkbox" :value="item.key" />
          <span><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span>
          <span class="manual-state">{{ manualChecks.includes(item.key) ? '已人工确认' : '未人工确认' }}</span>
        </label>
      </div>
      <div class="checklist-footer"><span aria-live="polite">已人工勾选 {{ manualChecks.length }} / {{ environmentItems.length }} 项；不形成飞行许可结论。</span><el-button plain size="small" @click="resetEnvironment">重置人工记录</el-button></div>
      <p class="subtle">记录仅保留在当前页面，离开或断开连接后清空。地点、天气或人员变化时，请手动重置并重新检查。</p>
      <section class="weather-reference" aria-label="天气参考">
        <div class="weather-head"><div><h2>天气参考（可选）</h2><p class="subtle">点击后请求浏览器定位授权，并将坐标发送至 <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> 第三方公开天气接口；不存储定位记录，不自动勾选任何项。</p></div><el-button plain :loading="weatherBusy" :disabled="!canQueryWeather" @click="queryWeather">{{ weather.status === 'ok' ? '重新查询' : '查询当前地点天气' }}</el-button></div>
        <p v-if="!canQueryWeather" class="weather-note">当前浏览器无法查询天气，请使用支持定位的浏览器并通过 HTTPS 或本机地址访问；也可按现场情况人工确认。</p>
        <p v-else-if="weather.status === 'locating'" class="weather-note" aria-live="polite">正在请求浏览器定位授权…</p>
        <p v-else-if="weather.status === 'loading'" class="weather-note" aria-live="polite">定位已授权，正在查询天气…</p>
        <p v-else-if="weather.status === 'error'" class="weather-note" aria-live="polite">天气参考不可用：{{ weather.error }}。仍请按现场目视确认。</p>
        <template v-else-if="weather.status === 'ok'">
          <dl class="weather-facts">
            <div><dt>气温</dt><dd>{{ formatWeatherNumber(weather.data.temperatureC) }} ℃</dd></div>
            <div><dt>天气</dt><dd>{{ weather.data.weatherText }}</dd></div>
            <div><dt>风速</dt><dd>{{ formatWeatherNumber(weather.data.windSpeedMs) }} m/s</dd></div>
            <div><dt>阵风</dt><dd>{{ weather.data.windGustMs === null ? '暂无数据' : formatWeatherNumber(weather.data.windGustMs) + ' m/s' }}</dd></div>
            <div><dt>湿度</dt><dd>{{ weather.data.humidityPercent === null ? '暂无数据' : formatWeatherNumber(weather.data.humidityPercent) + ' %' }}</dd></div>
            <div><dt>天气时间</dt><dd>{{ formatWeatherTime(weather.data.observedAt) }}</dd></div>
          </dl>
          <p class="weather-note">以上为第三方模型天气参考，不是现场传感器测量；不构成飞行许可。现场情况变化后重新查询。</p>
        </template>
      </section>
    </section>
  </main>
</template>
<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { fetchWeatherReference } from '../utils/weather-reference.js'
const mav = inject('mavlink')
const secureContext = typeof window !== 'undefined' && window.isSecureContext === true
const environmentItems = [
  { key: 'airspace', label: '空域与许可', detail: '核实当地限制、所需许可及允许操作的地点。' },
  { key: 'people', label: '地点与人员', detail: '与人员、车辆和建筑保持适当距离，明确现场警戒范围。' },
  { key: 'weather', label: '天气与能见度', detail: '现场确认风、雨及能见度符合设备限制；公开天气接口仅供参考。' },
  { key: 'interference', label: '电磁干扰与障碍', detail: '留意高压线、无线电干扰源、树木及其他障碍物。' },
  { key: 'landing', label: '起降场地', detail: '检查地面平整与净空，明确起降和应急降落区域。' },
  { key: 'props', label: '地面操作与桨叶', detail: '桌面调试拆桨；飞行前按设备说明检查桨叶与安装，避免人员靠近。' },
]
const manualChecks = ref([])
function resetEnvironment() { manualChecks.value = [] }
watch(() => mav?.deviceState.phase, (phase) => {
  if (phase === 'idle' || phase === 'disconnected') resetEnvironment()
})
const weather = ref({ status: 'idle', coords: null, data: null, error: '' })
const weatherBusy = computed(() => ['locating', 'loading'].includes(weather.value.status))
const canQueryWeather = computed(() => secureContext && typeof navigator !== 'undefined' && !!navigator.geolocation && typeof globalThis.fetch === 'function')
let weatherToken = 0
let controller = null
let disposed = false
function formatWeatherTime(value) {
  if (!value) return '暂无数据'
  const time = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`)
  return Number.isNaN(time.getTime()) ? '暂无数据' : time.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}
function formatWeatherNumber(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—' }
function queryWeather() {
  if (!canQueryWeather.value || weatherBusy.value || disposed) return
  const token = ++weatherToken
  weather.value = { status: 'locating', coords: null, data: null, error: '' }
  const fail = (error) => {
    if (disposed || token !== weatherToken) return
    weather.value = { status: 'error', coords: null, data: null, error: error.code === 1 ? '定位授权被拒绝' : error.code === 3 ? '定位超时' : '位置不可用' }
  }
  try {
    navigator.geolocation.getCurrentPosition(async (position) => {
      if (disposed || token !== weatherToken) return
      const coords = { latitude: position.coords.latitude, longitude: position.coords.longitude }
      weather.value = { status: 'loading', coords, data: null, error: '' }
      controller = new AbortController()
      const result = await fetchWeatherReference({ ...coords, fetchImpl: globalThis.fetch.bind(globalThis), signal: controller.signal })
      if (disposed || token !== weatherToken) return
      controller = null
      weather.value = result.ok ? { status: 'ok', coords, data: result.data, error: '' } : { status: 'error', coords, data: null, error: result.error }
    }, fail, { timeout: 15000, maximumAge: 0, enableHighAccuracy: false })
  } catch (error) { fail(error) }
}
onBeforeUnmount(() => { disposed = true; ++weatherToken; controller?.abort() })
</script>
<style scoped>
.environment-page{padding:clamp(18px,3vw,38px);color:var(--dsh-text-1);background:var(--dsh-canvas);min-height:100%}.environment-panel{max-width:1100px;margin:auto;padding:24px;border:1px solid var(--dsh-border);border-radius:10px;background:var(--dsh-surface)}.section-heading,.weather-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.section-kicker{color:var(--dsh-accent);font-size:11px;letter-spacing:.08em;margin:0 0 8px}h1{font-size:24px;margin:0}h2{font-size:18px;margin:0}.manual-badge{white-space:nowrap;border:1px solid var(--dsh-border);border-radius:5px;padding:5px 8px;font-size:12px;color:var(--dsh-text-2)}.panel-copy,.weather-note{font-size:14px;line-height:1.7;color:var(--dsh-text-2)}.manual-warning{padding:12px;border-left:3px solid var(--dsh-warning);background:var(--dsh-canvas);font-size:13px}.environment-list{display:grid}.environment-item{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--dsh-border);cursor:pointer}.environment-item input{margin:3px 0 0;flex-shrink:0;width:16px;height:16px;accent-color:var(--dsh-accent)}.environment-item>span:first-of-type{flex:1}.environment-item strong{font-size:14px}.environment-item small{display:block;font-size:12px;line-height:1.7;margin-top:5px;color:var(--dsh-text-3)}.manual-state{font-size:12px;color:var(--dsh-text-3);white-space:nowrap}.checklist-footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:18px;font-size:13px;color:var(--dsh-text-2)}.subtle{color:var(--dsh-text-3);font-size:12px;line-height:1.7}.weather-reference{margin-top:24px;border-top:1px solid var(--dsh-border);padding-top:24px}.weather-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0 0}.weather-facts div{border:1px solid var(--dsh-border);border-radius:7px;padding:12px}.weather-facts dt{font-size:12px;color:var(--dsh-text-3)}.weather-facts dd{margin:6px 0 0;font-size:14px;overflow-wrap:anywhere}a{color:var(--dsh-accent)}a:focus-visible,input:focus-visible{outline:2px solid var(--dsh-accent);outline-offset:3px}@media(max-width:600px){.environment-panel{padding:16px}.weather-head,.section-heading{flex-wrap:wrap}.weather-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.manual-state{font-size:10px}}
</style>
