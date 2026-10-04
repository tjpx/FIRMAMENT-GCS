// src/utils/stall-watch.js
// ================================================================
// 主线程停顿记录仪（诊断"点了没反应/整页死住"）
// ----------------------------------------------------------------
// 为什么要有它：连上飞控之后偶发切页卡死，光看代码猜不出是谁占住了主线程。
// 浏览器自己知道答案——只要有人把它记下来。记录必须能活过卡死本身：
//   · 写进 sessionStorage，Vite 强制整页 reload 或用户手动刷新之后还在；
//   · 每条都带上"当时在哪个页面、正要切去哪、链路在不在线、收了多少包"，
//     于是下一次复现能直接看到卡顿发生在哪个页面、什么状态下，而不是凭印象。
// 两条互补的探测：
//   1) PerformanceObserver('longtask')：≥50ms 的任务会上报，attribution 有时能给出脚本来源；
//      但它不保证覆盖所有情况，所以不能只靠它。
//   2) 心跳间隔法：setInterval 两次触发之间的实测差值。任何把主线程占死的代码都会让它迟到，
//      迟到多少就是被占住多久。
// 本模块只观测，不改变任何行为，也不做任何"自动优化"。
// ================================================================
import { computed, ref } from 'vue'

const MAX_RECORDS = 40
const BEAT_MS = 250 // 心跳标称间隔
const STALL_MS = 400 // 实测间隔超过这个值就认定发生了一次卡顿
const LONGTASK_MS = 50 // longtask 记录阈值

const instances = new Map() // 按 key 复用，dev 热重载时不重复注册观察者

/** 把记录数组压成紧凑文本，方便复制给开发者 */
export function formatStalls(records) {
  if (!records.length) return '（没有记录到超过阈值的停顿）'
  return records
      .map((r) => {
        const t = new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false })
        const ctx = []
        if (r.route) ctx.push(`在 ${r.route}`)
        if (r.pendingRoute) ctx.push(`正要切到 ${r.pendingRoute}`)
        if (r.connected !== undefined) ctx.push(r.connected ? '已连接' : '未连接')
        if (r.rxTotal !== undefined) ctx.push(`RX ${r.rxTotal} 条`)
        if (r.frames !== undefined) ctx.push(`解出 ${r.frames} 帧`)
        if (r.crcErrors) ctx.push(`校验错 ${r.crcErrors}`)
        if (r.txPending !== undefined) ctx.push(`待发送 ${r.txPending}`)
        if (r.phase) ctx.push(`阶段 ${r.phase}`)
        if (r.attribution?.length) ctx.push(`归因 ${r.attribution.join(',')}`)
        return `${t} [${r.kind}] ${Math.round(r.durMs)}ms — ${ctx.join(' · ')}`
      })
      .join('\n')
}

/**
 * 启动停顿记录（幂等）。
 * @param {object} [options]
 * @param {string} [options.key] 多实例区分（热重载复用）
 * @param {(() => string)|import('vue').Ref<string>} [options.route] 当前路由
 * @param {() => object} [options.state] 当时的链路快照：{connected, rxTotal, frames, crcErrors, txPending, phase, pendingRoute}
 * @param {(r: object) => void} [options.onStall] 每条新记录的回调（界面提示用）
 * @returns {{records: import('vue').Ref<object[]>, stallCount: import('vue').ComputedRef<number>, maxMs: import('vue').ComputedRef<number>, text: () => string, clear: () => void, mark: (p: string) => void, stop: () => void} | null}
 *          Node（没有 window）下返回 null，方便脚本环境直接 import 而不炸
 */
export function startStallWatch(options = {}) {
  const key = options.key || 'default'
  if (instances.get(key)) return instances.get(key)
  if (typeof window === 'undefined') return null

  const records = ref([])
  let lastBeat = performance.now()
  let phase = ''
  let intervalId = 0
  let observer = null

  const snapshot = () => {
    try {
      return typeof options.state === 'function' ? options.state() || {} : {}
    } catch {
      return {} // 快照取值出错不能把观察者本身搞挂
    }
  }

  const currentRoute = () => {
    try {
      const r = options.route
      if (!r) return ''
      return typeof r === 'function' ? r() : (r.value ?? '')
    } catch {
      return ''
    }
  }

  const persist = () => {
    try {
      window.sessionStorage.setItem('fmt-stall-log', JSON.stringify(records.value))
    } catch {} // 隐私模式或配额满，记不下来也不能影响主流程
  }

  const push = (rec) => {
    records.value = [rec, ...records.value].slice(0, MAX_RECORDS)
    persist()
    try { options.onStall?.(rec) } catch {}
  }

  const record = (kind, durMs, attribution) => {
    const s = snapshot()
    push({
      at: Date.now(),
      kind,
      durMs,
      route: currentRoute(),
      pendingRoute: s.pendingRoute || '',
      connected: s.connected,
      rxTotal: s.rxTotal,
      frames: s.frames,
      crcErrors: s.crcErrors,
      txPending: s.txPending,
      phase: s.phase || phase,
      attribution: attribution || [],
    })
  }

  // 先把上一次（刷新前）的记录捞回来：卡死后用户刷新，证据不能跟着一起没了
  try {
    const raw = window.sessionStorage.getItem('fmt-stall-log')
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) records.value = arr.slice(0, MAX_RECORDS)
    }
  } catch {}

  // 1) longtask
  try {
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < LONGTASK_MS) continue
          const names = (e.attribution || []).map((a) => a?.name).filter(Boolean)
          record('longtask', e.duration, [...new Set(names)])
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    }
  } catch {
    observer = null // 不支持就只剩心跳法，但绝不假装测到了
  }

  // 2) 心跳间隔
  intervalId = window.setInterval(() => {
    const now = performance.now()
    const gap = now - lastBeat
    lastBeat = now
    if (gap >= STALL_MS) record('beat-gap', gap - BEAT_MS)
  }, BEAT_MS)

  const api = {
    records,
    stallCount: computed(() => records.value.length),
    maxMs: computed(() => records.value.reduce((m, r) => Math.max(m, r.durMs || 0), 0)),
    text: () => formatStalls(records.value),
    clear: () => {
      records.value = []
      persist()
    },
    mark: (p) => { phase = String(p || '') }, // 手动标注阶段，例如 'ftp:param.xml'
    stop: () => {
      try { observer?.disconnect() } catch {}
      if (intervalId) window.clearInterval(intervalId)
      instances.delete(key)
    },
  }

  instances.set(key, api)
  return api
}
