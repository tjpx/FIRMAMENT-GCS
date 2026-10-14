/** 遥测与只读字段证据；仅对当前文档已存在且有源码依据的精确字段提供校验，不造默认值或保护动作。 */
import { paramSearchKey, tomlSearchKey } from './search-index.js'

export const SAFETY_FRESH_MS = 3000
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
export function freshnessState(stamp, now, reported = true, online = true) {
  const ageMs = finite(stamp) && stamp > 0 && finite(now) && now >= stamp ? now - stamp : null
  const state = !online
    ? 'offline'
    : !reported || ageMs === null
      ? 'unknown'
      : ageMs <= SAFETY_FRESH_MS
        ? 'fresh'
        : 'stale'
  return { state, ageMs, fresh: state === 'fresh' }
}
/**
 * 仅供展示：只接纳新鲜有效帧，断开或切换设备会话即清空；不得用于控制许可判断。
 *
 * 存在理由是"读数突然变空"比"读数停在最后一帧"更让人误判——但停在最后一帧又极易被当成实时值。
 * 所以这里把两者拆开：`fresh` 表示这一帧就是当前值，`held` 表示这是**上一帧**且已经过期，
 * 界面对 held 必须显示「暂无更新 / 上一帧」，不能只显示数字。
 *
 * 四条必须保持的性质（`scripts/safety-pages.test.mjs` 逐条钉住）：
 *
 * 1. **不跨会话保留**：`sessionId` 与 `sessionStartedAt` 对不上就丢弃，否则换一台设备后会把旧机
 *    的电压当新机的。
 * 2. **不保留控制许可**：本函数只看展示用的帧数据，`canOperate` / 链路健康这类"能不能下手"的条件
 *    一律不进返回值——证据可以滞后展示，许可不行。
 * 3. **只接纳单向前进的帧**：`stamp < prior.stamp` 的帧被拒绝，避免乱序帧把旧值盖在新值上。
 * 4. **复制而非引用**：返回的是帧的浅拷贝，后续真实遥测再更新不会把"上一帧"一起改写。
 *
 * @param {object|null} previous 上一次的返回值（首帧传 null）
 * @param {{connected?:boolean, sessionId?:unknown, sessionStartedAt?:number, stamp?:number|null,
 *   now?:number, valid?:boolean, frame?:object|null}} input 当前链路与帧状态
 * @returns {{sessionId:unknown, frame:object|null, stamp:number|null, state:string,
 *   fresh:boolean, held:boolean, label:string}}
 */
export function heldSafetyFrame(
  previous,
  {
    connected = false,
    sessionId = null,
    sessionStartedAt = 0,
    stamp = null,
    now = Date.now(),
    valid = false,
    frame = null,
  } = {}
) {
  const freshness = freshnessState(stamp, now, valid === true, connected === true)
  const prior = connected === true && previous?.sessionId === sessionId ? previous : null
  const accepted =
    freshness.fresh &&
    finite(sessionStartedAt) &&
    stamp >= sessionStartedAt &&
    frame !== null &&
    typeof frame === 'object' &&
    (!prior?.frame || stamp >= prior.stamp)
  // 复制展示字段，避免后续原始遥测变动把上一帧一并改写；调用方只传展示值。
  const retained = accepted ? { ...frame } : prior?.frame ? { ...prior.frame } : null
  const fresh = accepted
  const held = retained !== null && !fresh
  return {
    sessionId,
    frame: retained,
    stamp: accepted ? stamp : retained ? prior.stamp : null,
    state: freshness.state,
    fresh,
    held,
    label: fresh ? freshnessLabel('fresh') : held ? '暂无更新 / 上一帧' : connected ? '暂无数据' : '未连接 / 暂无数据',
  }
}
export function batteryEvidence({
  connected = false,
  canOperate = false,
  valid = false,
  stamp = null,
  battery = null,
  now = Date.now(),
} = {}) {
  const freshness = freshnessState(stamp, now, valid === true, connected === true && canOperate === true)
  const usable = freshness.fresh && battery?.source === 'SYS_STATUS'
  return {
    ...freshness,
    source: 'SYS_STATUS',
    voltage:
      usable && finite(battery.voltage) && battery.voltage >= 0 && battery.voltage !== 65.535 ? battery.voltage : null,
    current: usable && finite(battery.current) && battery.current >= 0 ? battery.current : null,
    remaining:
      usable && finite(battery.percent) && battery.percent >= 0 && battery.percent <= 100 ? battery.percent : null,
    calibrated: null,
  }
}
export function failsafeEvidence({
  connected = false,
  heartbeatAt = null,
  heartbeatHealthy = false,
  rcAt = null,
  rcValid = false,
  now = Date.now(),
} = {}) {
  return {
    heartbeat: {
      ...freshnessState(heartbeatAt, now, true, connected === true),
      healthy: connected === true && heartbeatHealthy === true,
    },
    rc: freshnessState(rcAt, now, rcValid === true, connected === true),
    protectiveAction: null,
    onboardRcFailsafe: null,
  }
}
const words = {
  power: /battery|power|voltage|current|电池|电源|电压|电流/i,
  failsafe: /failsafe|fail.?safe|loss|lost|失控|丢失|失联/i,
}
/** Only names/group paths are matched; values never establish a field's meaning. */
export function discoverSafetyFields(fc, topic) {
  const rows = [],
    matcher = words[topic]
  if (!matcher || typeof fc?.doc !== 'function') return rows
  const append = (file, group, name, value, focus, metadata = false) => {
    if (!metadata && !matcher.test(`${group}/${name}`)) return
    rows.push({
      file,
      group,
      name,
      value,
      focus,
      metadata,
      readonly: true,
      route: { path: '/parameter', query: { file, group, focus } },
    })
  }
  const param = fc.files?.param?.loaded === true ? fc.doc('param') : null
  for (const row of param?.list() || []) {
    const group = row.group || ''
    const metadata = topic === 'failsafe' && group === 'SYSTEM' && row.name === 'OBC_HEARTBEAT'
    append('param', group, row.name, row.value, paramSearchKey(group, row.name), metadata)
  }
  const toml = fc.files?.sysconfig?.loaded === true ? fc.doc('sysconfig') : null
  for (const section of toml?.sections() || []) {
    const tables = toml.tablesOf(section)
    if (tables.length)
      tables.forEach((table, index) =>
        table.keys.forEach((key) => {
          const name = `${section}[${index}].${key}`
          append('sysconfig', section, name, table.fields[key], tomlSearchKey(name))
        })
      )
    else
      for (const key of toml.keys(section)) {
        const name = `${section}.${key}`
        append('sysconfig', section, name, toml.get(section, key)?.value, tomlSearchKey(name))
      }
  }
  return rows
}
export const SAFETY_BINDINGS = Object.freeze([
  { topic: 'power', group: 'POWER', name: 'BAT_V_DIV', label: '电压分压比', kind: 'positive', unit: '比例' },
  { topic: 'power', group: 'POWER', name: 'BAT_A_PER_V', label: '电流比例', kind: 'positive', unit: 'A/V' },
  {
    topic: 'power',
    group: 'POWER',
    name: 'BAT_N_CELLS',
    label: '电芯数量',
    kind: 'uint8',
    unit: 'UINT8；0 原值保留，不推断串数或自动检测',
  },
  {
    topic: 'power',
    group: 'POWER',
    name: 'CAPACITY_OF_BAT',
    label: '额定容量',
    kind: 'positive',
    unit: 'mAh（人工配置，非遥测）',
  },
  {
    topic: 'failsafe',
    group: 'FMS',
    name: 'MC_LOST_RETURN_TIME',
    label: '控制链路失联返航计时',
    kind: 'uint16',
    unit: 's',
  },
  {
    topic: 'failsafe',
    group: 'FMS',
    name: 'MC_LOST_RETURN_EN',
    label: '控制链路失联返航使能',
    kind: 'bool',
    unit: '0 关闭 / 1 开启',
  },
])
export function knownSafetyFields(fc, topic) {
  if (fc?.files?.param?.loaded !== true || typeof fc.doc !== 'function') return []
  const present = fc.doc('param')?.list() || []
  return SAFETY_BINDINGS.filter((binding) => binding.topic === topic).flatMap((binding) => {
    const row = present.find((item) => item.group === binding.group && item.name === binding.name)
    return row ? [{ ...binding, value: row.value, focus: paramSearchKey(row.group, row.name) }] : []
  })
}
/** Strict literal validation, not Number(null/empty) coercion; no UINT wraparound. */
export function validateSafetyInput(binding, input) {
  if (
    !SAFETY_BINDINGS.some(
      (item) => item.group === binding?.group && item.name === binding?.name && item.kind === binding?.kind
    )
  )
    return { ok: false, reason: '未知绑定' }
  if (typeof input !== 'string' && typeof input !== 'number') return { ok: false, reason: '请输入明确数值' }
  const literal = String(input).trim()
  const positive = binding.kind === 'positive'
  if (!(positive ? /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i : /^\d+$/).test(literal))
    return { ok: false, reason: positive ? '需正有限数值' : '需无符号整数原值' }
  const value = Number(literal)
  const max = positive ? 3.402823466e38 : binding.kind === 'uint16' ? 65535 : binding.kind === 'bool' ? 1 : 255
  if (
    !Number.isFinite(value) ||
    value > max ||
    (positive
      ? value <= 0 || Math.fround(value) <= 0 || Number(value.toFixed(6)) <= 0
      : !Number.isInteger(value) || value < 0)
  )
    return { ok: false, reason: `值超出${positive ? '正 FLOAT' : binding.kind.toUpperCase()}范围` }
  return { ok: true, value }
}

export function safetyValue(value) {
  if (value === null || value === undefined) return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
export function freshnessLabel(state) {
  return (
    { fresh: '新鲜（≤ 3 秒）', stale: '已过期（> 3 秒）', unknown: '未知 / 尚未上报', offline: '未连接 / 链路不可用' }[
      state
    ] || '未知'
  )
}
