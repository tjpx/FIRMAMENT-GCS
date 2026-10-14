// src/protocol/mav-decoder.js
// ================================================================
// 通用消息解码：按生成表的字段偏移取值，并按协议 [单位] 标注换算
// ----------------------------------------------------------------
// 为什么换算也放在协议层：系数写错和偏移写错一样难查——高度显示成 1/1000 看起来仍是
// "正常数字"。偏移与单位都来自 vendor 生成表，页面只负责画，不参与协议换算。
// ================================================================
import { MESSAGES, MESSAGE_NAMES } from './mavlink-table.generated.js'

/** 类型码 -> 字节数 */
const SIZEOF = { u8: 1, c: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, f: 4, d: 8 }

/**
 * 协议单位标注 -> 乘以该系数得到常用展示单位（米/秒/安/伏/度…）。
 * 未列出的单位（m、rad、deg、%、mAh、hPa…）本身就常用，直接原值使用。
 * 提醒：少数字段协议里没标单位但实际是倍率值（如 GPS_RAW_INT.eph/epv 为 0.01 倍），
 * 这类特例只在 useMavlink 里按消息单独处理，不改单位表。
 */
export const UNIT_TO_SI = {
  degE7: 1e-7,
  degE6: 1e-6,
  degE5: 1e-5,
  cdeg: 1e-2,
  cdegC: 1e-2,
  cel: 1,
  mm: 1e-3,
  cm: 1e-2,
  mV: 1e-3,
  uV: 1e-6,
  cA: 1e-2,
  mA: 1e-3,
  dA: 1e-1,
  'd%': 1e-1, // 分百分比 -> %（SYS_STATUS.load 标注为 [d%]，即 0.1% 单位）
  'c%': 1e-2, // 厘百分比 -> %（SYS_STATUS.drop_rate_comm）
  hJ: 1e2, // 百焦耳 -> 焦耳（1 hJ = 100 J；这里曾是 1e-1，方向写反了）
  mG: 1e-3, // 毫高斯 -> 高斯
  kPa: 1e3, // -> 帕
  ms: 1e-3,
  us: 1e-6,
  nsec: 1e-9, // 时间 -> 秒
  'cm/s': 1e-2,
  'mm/s': 1e-3,
  'dm/s': 1e-1, // 速度 -> 米/秒
}

function readOne(dv, t, off) {
  switch (t) {
    case 'u8':
      return dv.getUint8(off)
    case 'i8':
      return dv.getInt8(off)
    case 'c':
      return dv.getUint8(off)
    case 'u16':
      return dv.getUint16(off, true)
    case 'i16':
      return dv.getInt16(off, true)
    case 'u32':
      return dv.getUint32(off, true)
    case 'i32':
      return dv.getInt32(off, true)
    // 64 位遥测值不会超过 2^53（time_usec 为微秒 uptime），按 Number 返回便于展示与比较
    case 'u64':
      return Number(dv.getBigUint64(off, true))
    case 'i64':
      return Number(dv.getBigInt64(off, true))
    case 'f':
      return dv.getFloat32(off, true)
    case 'd':
      return dv.getFloat64(off, true)
    default:
      return undefined
  }
}

/** char[n] 读成 C 字符串（到第一个 0 截断），其它类型读成数值数组 */
function readArray(dv, t, off, n) {
  if (t === 'c') {
    let s = ''
    for (let i = 0; i < n; i++) {
      const c = dv.getUint8(off + i)
      if (!c) break
      s += String.fromCharCode(c)
    }
    return s
  }
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = readOne(dv, t, off + i * SIZEOF[t])
  return out
}

function applyUnit(v, unit) {
  const k = UNIT_TO_SI[unit]
  if (k === undefined || typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => Math.round(x * k * 1e9) / 1e9)
  return Math.round(v * k * 1e9) / 1e9
}

/** 该消息是否在生成表里带字段定义（白名单外为 false，走专用解码） */
function hasFields(msgid) {
  return !!MESSAGES[msgid]
}

export function messageName(msgid) {
  return MESSAGE_NAMES[msgid] || `MSG_${msgid}`
}

/**
 * 按生成表解码一条消息。
 * @param {number} msgid
 * @param {Uint8Array} payload
 * @returns {{msgid:number,name:string,declaredLen:number,raw:Object,si:Object,missing:string[]}|null}
 *          raw=协议原始值，si=按单位标注换算后的值，missing=因 payload 比定义短而缺失的字段名
 *          （MAVLink v2 允许省略 payload 尾部的 0 字节，因此缺字段是正常现象，不是错误）
 */
export function decodeMessage(msgid, payload, options = {}) {
  const def = MESSAGES[msgid]
  if (!def || !payload) return null
  const wireLength = payload.byteLength
  // 仅已确认的 v2 帧允许尾零省略；不把未知版本/损坏的短 v1 载荷补成有效值。
  let bytes = payload
  if (options.version === 2 && wireLength > 0 && wireLength < def.len) {
    bytes = new Uint8Array(def.len)
    bytes.set(payload)
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const raw = {}
  const si = {}
  const missing = []
  for (const f of def.fields) {
    const [name, t, off, n, unit] = f
    const width = SIZEOF[t] * (n || 1)
    if (off + width > dv.byteLength) {
      missing.push(name)
      continue
    }
    const v = n ? readArray(dv, t, off, n) : readOne(dv, t, off)
    raw[name] = v
    si[name] = applyUnit(v, unit)
  }
  return { msgid, name: def.name, declaredLen: def.len, raw, si, missing }
}

function writeOne(dv, t, off, v) {
  switch (t) {
    case 'u8':
    case 'c':
      return dv.setUint8(off, v & 0xff)
    case 'i8':
      return dv.setInt8(off, v)
    case 'u16':
      return dv.setUint16(off, Math.round(v) & 0xffff, true)
    case 'i16':
      return dv.setInt16(off, Math.round(v), true)
    case 'u32':
      return dv.setUint32(off, Math.round(v) >>> 0, true)
    case 'i32':
      return dv.setInt32(off, Math.round(v), true)
    case 'u64':
      return dv.setBigUint64(off, BigInt(Math.round(v)), true)
    case 'i64':
      return dv.setBigInt64(off, BigInt(Math.round(v)), true)
    case 'f':
      return dv.setFloat32(off, v, true)
    case 'd':
      return dv.setFloat64(off, v, true)
    default:
      throw new Error(`未知类型 ${t}`)
  }
}

/**
 * 按生成表构造 payload（与 decodeMessage 同一张表，避免手写偏移再错一次）。
 * @param {number} msgid
 * @param {Object} values 字段名 -> 值；char[n] 传字符串
 * @param {{fromSi?:boolean}} options fromSi=true 时按单位表反算（传入米/度/秒等展示值）
 * @returns {Uint8Array} 长度为协议声明的完整长度（MAVLink v2 允许发送时截掉尾部 0）
 */
export function encodeFields(msgid, values, options = {}) {
  const def = MESSAGES[msgid]
  if (!def) throw new Error(`协议表缺少 msgid=${msgid}，无法编码（先确认消息名并重跑 npm run gen:mavlink）`)
  const fromSi = !!options.fromSi
  const p = new Uint8Array(def.len)
  const dv = new DataView(p.buffer)
  for (const [name, t, off, n, unit] of def.fields) {
    const v = values[name]
    if (v === undefined || v === null) continue
    if (t === 'c' && n) {
      const s = String(v)
      for (let i = 0; i < n && i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i) & 0xff)
      continue
    }
    const k = fromSi ? UNIT_TO_SI[unit] : undefined
    if (n) {
      const arr = Array.isArray(v) ? v : [v]
      for (let i = 0; i < n && i < arr.length; i++) {
        const x = typeof arr[i] === 'number' && k ? arr[i] / k : arr[i]
        writeOne(dv, t, off + i * SIZEOF[t], x)
      }
    } else {
      const x = typeof v === 'number' && k ? v / k : v
      writeOne(dv, t, off, x)
    }
  }
  return p
}
