// src/utils/mavlink-protocol.js
// ================================================================
// 提供：常量 / CRC / 帧解析器 / 帧编码器 / SERIAL_CONTROL 编解码 / FTP 编解码
// ================================================================

/* ----------------------------- 常量 ----------------------------- */

/* --------------------------- 协议表接入 --------------------------- */
// 消息号 / crc_extra / 字段表 / 枚举一律来自生成表，禁止手抄：
// crc_extra 写错一个字节，该消息会被**静默丢弃**，现象是「某项数据一直是 0」而不报错。
// 生成链：vendor/mavlink/（飞控自带 mavlink C 库副本） → npm run gen:mavlink → src/protocol/mavlink-table.generated.js
import { CRC_EXTRA, ENUMS, MESSAGE_NAMES } from '../protocol/mavlink-table.generated.js'

/** 消息名 -> msgid（全量，覆盖协议表里的所有消息） */
export const MAVLINK_MSG_ID = Object.freeze(
  Object.fromEntries(Object.entries(MESSAGE_NAMES).map(([id, name]) => [name, Number(id)])),
)

/** 常用枚举（避免在业务代码里写魔法数字） */
export const MAV_MODE_FLAG = ENUMS.MAV_MODE_FLAG
export const MAV_STATE = ENUMS.MAV_STATE
export const MAV_SEVERITY = ENUMS.MAV_SEVERITY
export const MAV_RESULT = ENUMS.MAV_RESULT

/** 协议表声明的 crc_extra：msgid -> value（只读） */
export const MAVLINK_CRC_EXTRA = Object.freeze({ ...CRC_EXTRA })

/** 运行时学习到的 crc_extra：msgid -> { value, declared } */
const crcOverrides = new Map()

/** crc_extra 差异台账（供「协议」面板展示，记录协议表与固件不一致之处） */
export const crcAuditLog = []

/** 当前生效的 crc_extra；undefined 表示协议表没有该消息（解析器保持不校验的旧行为） */
export function effectiveCrcExtra(msgid) {
  const hit = crcOverrides.get(msgid)
  if (hit) return hit.value
  const declared = CRC_EXTRA[msgid]
  return declared === undefined ? undefined : declared
}

/** 登记学习到的 crc_extra（TX/RX 两端同时生效） */
export function learnCrcExtra(msgid, value, declared) {
  crcOverrides.set(msgid, { value, declared })
  crcAuditLog.push({
    msgid,
    name: MESSAGE_NAMES[msgid] || `MSG_${msgid}`,
    declared,
    value,
    at: Date.now(),
  })
}

/** 清空学习结果（重连或切换固件后调用，回到协议表基准） */
export function resetLearnedCrcExtra() {
  crcOverrides.clear()
  crcAuditLog.length = 0
}

/**
 * 反解 crc_extra：CRC16/X-25 的最后一步对 extra 是双射，因此候选唯一。
 * 导出给自测脚本验证「已知帧能反解出正确 extra」。
 */
export function searchCrcExtra(received, bodyCrc) {
  for (let x = 0; x < 256; x++) if (crcAccumulate(x, bodyCrc) === received) return x
  return undefined
}

/**
 * 生成「取 crc_extra」的函数。默认走生效表（协议表 + 运行期学习值）。
 * 测试可传入固定表；传 undefined 之外 falsy 表也按固定表处理，便于构造错误场景。
 */
export function makeCrcExtraOf(table) {
  if (typeof table === 'function') return table
  if (table) return (msgid) => table[msgid]
  return (msgid) => effectiveCrcExtra(msgid)
}

/** SERIAL_CONTROL 的设备号与标志位（取错值飞控会 NAK，不会静默丢帧，故保留本地常量） */
export const SERIAL_CONTROL_DEV = {
  TELEM1: 0, TELEM2: 1, GPS1: 2, GPS2: 3,
  SHELL: 10,
}

export const SERIAL_CONTROL_FLAG = {
  REPLY: 1, EXCLUSIVE: 2, MULTI: 4,
}

/* ----------------------------- CRC ----------------------------- */

export function crcAccumulate(byte, crc) {
  let tmp = (byte ^ (crc & 0xff)) & 0xff
  tmp = (tmp ^ (tmp << 4)) & 0xff
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
}

export function crc16Mavlink(data, start = 0, end = data.length, initial = 0xffff) {
  let crc = initial
  for (let i = start; i < end; i++) crc = crcAccumulate(data[i], crc)
  return crc
}

/* -------------------------- MAVLink 帧 -------------------------- */

/**
 * 统一的 MAVLink 2 解析器（支持 v1 跳过 + v2 CRC 校验 + payload truncation + signature）
 * 使用状态机方式（来自原 ftp 实现，更稳健），CRC 校验走统一 MAVLINK_CRC_EXTRA 表
 */
const S_WAIT = 0, S_LEN = 1,
      S_V2_INCOMPAT = 2, S_V2_COMPAT = 3, S_V2_SEQ = 4, S_V2_SYSID = 5, S_V2_COMPID = 6, S_V2_MSGID = 7,
      S_V1_SEQ = 8, S_V1_SYSID = 9, S_V1_COMPID = 10, S_V1_MSGID = 11,
      S_PAYLOAD = 12, S_CRC = 13, S_SIGNATURE = 14

export class Mavlink2Parser {
  constructor(options = {}) {
    this.validateCrc = options.validateCrc ?? true
    // 取 crc_extra 的函数：默认使用生效表（含运行期学习值），测试可注入固定表
    this.crcExtraOf = makeCrcExtraOf(options.crcExtra)
    this.onMessage = options.onMessage || (() => {})
    this.reset()
  }

  reset() {
    this.state = S_WAIT
    this.version = 0
    this.len = 0
    this.incompat = 0
    this.sysid = 0
    this.compid = 0
    this.msgid = 0
    this.msgidShift = 0
    this.payload = []
    this.crcBytes = []
    this.crc = 0xffff
    this.signatureLeft = 0
  }

  push(chunk) {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    for (let i = 0; i < incoming.length; i++) this.process(incoming[i])
  }

  feed(bytes) { this.push(bytes) }  // 兼容 ftp 命名

  process(b) {
    if (this.state === S_WAIT) {
      if (b === 0xfd) { this.beginFrame(2); return }
      if (b === 0xfe) { this.beginFrame(1); return }
      return
    }
    if (this.state === S_SIGNATURE) {
      this.signatureLeft--
      if (this.signatureLeft <= 0) this.reset()
      return
    }
    switch (this.state) {
      case S_LEN:
        this.len = b; this.acc(b); this.state = this.version === 2 ? S_V2_INCOMPAT : S_V1_SEQ; break
      case S_V2_INCOMPAT: this.incompat = b; this.acc(b); this.state = S_V2_COMPAT; break
      case S_V2_COMPAT:   this.acc(b); this.state = S_V2_SEQ; break
      case S_V2_SEQ:      this.acc(b); this.state = S_V2_SYSID; break
      case S_V2_SYSID:    this.sysid = b; this.acc(b); this.state = S_V2_COMPID; break
      case S_V2_COMPID:   this.compid = b; this.acc(b); this.state = S_V2_MSGID; break
      case S_V2_MSGID:
        this.msgid |= b << this.msgidShift; this.msgidShift += 8; this.acc(b)
        if (this.msgidShift >= 24) this.state = this.len > 0 ? S_PAYLOAD : S_CRC
        break
      case S_V1_SEQ:    this.acc(b); this.state = S_V1_SYSID; break
      case S_V1_SYSID:  this.sysid = b; this.acc(b); this.state = S_V1_COMPID; break
      case S_V1_COMPID: this.compid = b; this.acc(b); this.state = S_V1_MSGID; break
      case S_V1_MSGID:  this.msgid = b; this.acc(b); this.state = this.len > 0 ? S_PAYLOAD : S_CRC; break
      case S_PAYLOAD:
        this.payload.push(b); this.acc(b)
        if (this.payload.length === this.len) this.state = S_CRC
        break
      case S_CRC:
        this.crcBytes.push(b)
        if (this.crcBytes.length === 2) this.finishCrc()
        break
      default: this.reset()
    }
  }

  beginFrame(version) {
    this.version = version
    this.state = S_LEN
    this.crc = 0xffff
    this.payload = []
    this.msgid = 0
    this.msgidShift = 0
    this.incompat = 0
    this.crcBytes = []
  }

  acc(b) { if (this.validateCrc) this.crc = crcAccumulate(b, this.crc) }

  /**
   * 帧收尾，含 **crc_extra 自愈**。
   *
   * 需要自愈的原因：协议表落后于固件时，该消息每一帧都校验失败并被静默丢弃，
   * 用户只看到「某项数据一直是 0」，地面站却没有任何异常提示（历史上真出过这种事故）。
   *
   * 规则：
   *  - 校验失败时反解出「能让本帧 CRC 成立」的 extra（候选唯一）；
   *  - **连续两帧**反解结果一致才接受，避免把噪声帧学成协议；
   *  - 接受前该帧仍然丢弃（不放宽校验），接受后写入生效表并打出中文告警，指明该重跑生成命令。
   */
  finishCrc() {
    const received = this.crcBytes[0] | (this.crcBytes[1] << 8)
    const bodyCrc = this.crc
    const msgid = this.msgid

    const stats = (this.stats ??= { frames: 0, crcErrors: 0, learned: 0, byMsgid: {} })
    stats.frames++
    const one = (stats.byMsgid[msgid] ??= {
      rx: 0, bad: 0, name: MESSAGE_NAMES[msgid] || `MSG_${msgid}`,
    })
    one.rx++

    const declared = this.crcExtraOf(msgid)
    // 协议表里没有该消息时保持原有行为：不校验，但仍然尝试补齐 extra（学习后启用校验）
    const tableMissing = declared === undefined
    const ok = tableMissing ? true : crcAccumulate(declared, bodyCrc) === received

    let accept = ok
    if (ok) {
      // 表里缺失时不能清候选，否则永远凑不齐"连续两帧一致"
      if (!tableMissing) this.pendingCrc = null
    } else {
      stats.crcErrors++
      one.bad++
      accept = this.tryLearnCrcExtra(received, bodyCrc)
    }
    if (tableMissing) accept = this.tryLearnCrcExtra(received, bodyCrc) || accept

    if (accept) {
      this.onMessage({
        version: this.version,
        seq: 0,
        sysid: this.sysid,
        compid: this.compid,
        msgid: this.msgid,
        payload: Uint8Array.from(this.payload),
      })
    }

    if (this.version === 2 && (this.incompat & 0x01)) {
      this.signatureLeft = 13
      this.state = S_SIGNATURE
    } else {
      this.reset()
    }
  }

  /**
   * crc_extra 自愈的判定与登记：由收到的帧反解 extra，并要求连续两帧反解结果一致
   * 才登记（单帧可能是噪声）。两种触发路径：表里缺失该消息、表里值与飞控不一致。
   * @returns {boolean} 本帧是否可信
   */
  tryLearnCrcExtra(received, bodyCrc) {
    const cand = searchCrcExtra(received, bodyCrc)
    if (cand === undefined) { this.pendingCrc = null; return false }

    const pending = this.pendingCrc
    if (!(pending && pending.msgid === this.msgid && pending.value === cand)) {
      this.pendingCrc = { msgid: this.msgid, value: cand }
      return false // 第一帧：先丢弃，等下一帧印证
    }

    this.pendingCrc = null
    // 报告"当前生效值"与"实际值"的差异（生效值可能是协议表值，也可能是上一次的学习结果）
    const declared = this.crcExtraOf(this.msgid)
    const name = MESSAGE_NAMES[this.msgid] || `MSG_${this.msgid}`
    if (declared === undefined) {
      console.warn(`[mavlink] 协议表缺少 ${name}（msgid=${this.msgid}）的 crc_extra，已连续两帧反解为 ${cand}，按该值登记并启用校验`)
    } else {
      console.error(
        `[mavlink] crc_extra 不一致：${name} 协议表=${declared}，飞控实际=${cand}。` +
        `已按飞控值接收（否则该消息会被静默丢弃）。请核对 vendor/mavlink 是否落后于飞控固件，并重跑 npm run gen:mavlink`,
      )
    }
    learnCrcExtra(this.msgid, cand, declared)
    this.stats.learned++
    return true // 连续两帧一致 ⇒ 可信，收下比继续丢弃有价值
  }
}

/**
 * 发送端 —— 统一编码 MAVLink 2 帧
 */
export class MavlinkLink {
  constructor(options = {}) {
    this.sysid = options.sysid ?? 255        // GCS 默认 255
    this.compid = options.compid ?? 190      // MAV_COMP_ID_MISSIONPLANNER
    this.seq = 0
    this.crcExtraOf = makeCrcExtraOf(options.crcExtra)
  }

  nextSeq() { this.seq = (this.seq + 1) & 0xff; return this.seq }

  encode(msgid, payload, options = {}) {
    const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload || [])
    const len = p.length
    const out = new Uint8Array(12 + len)

    out[0] = 0xfd                                // STX v2
    out[1] = len
    out[2] = options.incompatFlags ?? 0
    out[3] = options.compatFlags ?? 0
    out[4] = this.nextSeq()
    out[5] = this.sysid
    out[6] = this.compid
    out[7] = msgid & 0xff
    out[8] = (msgid >> 8) & 0xff
    out[9] = (msgid >> 16) & 0xff
    out.set(p, 10)

    let crc = crc16Mavlink(out, 1, 10 + len)
    // 与接收端共用生效表：学习过之后必须用同一个值发，否则飞控会静默丢弃本地站的上行帧
    const extra = this.crcExtraOf(msgid)
    if (extra !== undefined) crc = crcAccumulate(extra, crc)
    else console.warn(`[mavlink] 协议表缺少 msgid=${msgid} 的 crc_extra，上行帧未附加校验（飞控可能丢弃）`)
    out[10 + len] = crc & 0xff
    out[11 + len] = (crc >> 8) & 0xff
    return out
  }

  encodeHeartbeat(params = {}) {
    const payload = new Uint8Array(9)
    const dv = new DataView(payload.buffer)
    dv.setUint32(0, params.customMode ?? 0, true)  // custom_mode
    payload[4] = params.type ?? 6                 // MAV_TYPE_GCS
    payload[5] = params.autopilot ?? 8            // MAV_AUTOPILOT_INVALID
    payload[6] = params.baseMode ?? 0
    payload[7] = params.systemStatus ?? 4         // MAV_STATE_ACTIVE
    payload[8] = 3                                // mavlink_version
    return this.encode(MAVLINK_MSG_ID.HEARTBEAT, payload)
  }

  /**
   * SERIAL_CONTROL（用于 Shell/CLI）payload 共 79 bytes
   *   uint32 baud_rate | uint16 timeout | uint8 flags | uint8 device
   *   uint8 count      | uint8 data[70]
   */
  encodeSerialControl(data, options = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || [])
    const payload = new Uint8Array(79)
    const dv = new DataView(payload.buffer)
    dv.setUint32(0, (options.baudRate ?? 0) >>> 0, true)
    dv.setUint16(4, (options.timeout ?? 0) & 0xffff, true)
    payload[6] = (options.flags ?? SERIAL_CONTROL_FLAG.EXCLUSIVE) & 0xff
    payload[7] = (options.device ?? SERIAL_CONTROL_DEV.SHELL) & 0xff
    const count = Math.min(bytes.length, 70)
    payload[8] = count
    if (count > 0) payload.set(bytes.subarray(0, count), 9)
    return this.encode(MAVLINK_MSG_ID.SERIAL_CONTROL, payload)
  }

  /**
   * FILE_TRANSFER_PROTOCOL（msgid=110） payload 共 254 bytes
   *   uint8 target_network | uint8 target_system | uint8 target_component
   *   uint8 payload[251]   —— FTP 子协议
   */
  encodeFileTransfer(ftpPayload, targetSystem = 1, targetComponent = 1) {
    const p = new Uint8Array(254)
    p[0] = 0
    p[1] = targetSystem & 0xff
    p[2] = targetComponent & 0xff
    const fp = ftpPayload instanceof Uint8Array ? ftpPayload : new Uint8Array(ftpPayload)
    p.set(fp.subarray(0, 251), 3)
    return this.encode(MAVLINK_MSG_ID.FILE_TRANSFER_PROTOCOL, p)
  }
}

/* ---------------------- SERIAL_CONTROL 解码 ---------------------- */

/**
 * 解码 SERIAL_CONTROL payload（兼容 MAVLink 2 trailing-zero truncation）
 */
export function decodeSerialControl(payload) {
  const full = new Uint8Array(79)
  if (payload && payload.length) {
    full.set(payload.subarray(0, Math.min(payload.length, full.length)), 0)
  }
  const dv = new DataView(full.buffer)
  const baudRate = dv.getUint32(0, true)
  const timeout = dv.getUint16(4, true)
  const flags = full[6]
  const device = full[7]
  const count = Math.min(full[8] ?? 0, 70)
  return {
    baudRate, timeout, flags, device, count,
    data: full.slice(9, 9 + count),
  }
}

/* ------------------------ FTP 子协议编解码 ------------------------ */

export const FTP_OP = {
  NONE: 0, TERMINATE_SESSION: 1, RESET_SESSIONS: 2, LIST_DIRECTORY: 3,
  OPEN_FILE_RO: 4, READ_FILE: 5, CREATE_FILE: 6, WRITE_FILE: 7,
  REMOVE_FILE: 8, CREATE_DIRECTORY: 9, REMOVE_DIRECTORY: 10,
  OPEN_FILE_WO: 11, TRUNCATE_FILE: 12, RENAME: 13, CALC_FILE_CRC32: 14,
  BURST_READ_FILE: 15,
  ACK: 128, NAK: 129,
}

export const FTP_ERR = {
  0: 'None', 1: 'Fail', 2: 'FailErrno', 3: 'InvalidDataSize',
  4: 'InvalidSession', 5: 'NoSessionsAvailable', 6: 'EOF',
  7: 'UnknownCommand', 8: 'FileExists', 9: 'FileProtected', 10: 'FileNotFound',
}

export const POSIX_ERRNO_TEXT = {
  1: 'EPERM 操作不被允许', 2: 'ENOENT 文件或路径不存在', 5: 'EIO 输入输出错误 / SD 卡异常',
  9: 'EBADF 文件句柄无效', 13: 'EACCES 权限不足', 16: 'EBUSY 资源忙 / 文件被占用',
  17: 'EEXIST 文件已存在', 20: 'ENOTDIR 不是目录', 21: 'EISDIR 目标是目录',
  22: 'EINVAL 参数无效', 24: 'EMFILE 打开文件过多', 28: 'ENOSPC 存储空间不足',
  30: 'EROFS 只读文件系统', 36: 'ENAMETOOLONG 文件名过长',
  38: 'ENOSYS 功能未实现', 39: 'ENOTEMPTY 目录非空',
}

function buildFtpPayload({ seq, session = 0, opcode, size = 0, reqOpcode = 0,
                           burstComplete = 0, offset = 0, data = null }) {
  const p = new Uint8Array(251)
  const dv = new DataView(p.buffer)
  dv.setUint16(0, seq & 0xffff, true)
  p[2] = session & 0xff
  p[3] = opcode & 0xff
  p[4] = size & 0xff
  p[5] = reqOpcode & 0xff
  p[6] = burstComplete ? 1 : 0
  p[7] = 0
  dv.setUint32(8, offset >>> 0, true)
  if (data) {
    const n = Math.min(data.length, 239)
    p.set(data.subarray(0, n), 12)
  }
  return p
}

function parseFtpPayload(p) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength)
  const seq = dv.getUint16(0, true)
  const session = p[2]
  const opcode = p[3]
  const size = p[4]
  const reqOpcode = p[5]
  const burstComplete = p[6]
  const offset = dv.getUint32(8, true)
  const dataSize = Math.min(size, Math.max(0, p.length - 12))
  return { seq, session, opcode, size, reqOpcode, burstComplete, offset,
           data: p.subarray(12, 12 + dataSize) }
}

export const __ftpInternal = { buildFtpPayload, parseFtpPayload }
