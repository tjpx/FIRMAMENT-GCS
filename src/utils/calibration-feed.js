/**
 * 校准播报解析（纯函数，无 DOM，可被 Node 自测直接 import）。
 *
 * 来源=本机固件 src/module/mavproxy/mavlink_status.h:36-44 的宏原文，
 * 以及 mavlink_status.c:28-84 实际下发的字符串。固件把校准进度用
 * STATUSTEXT 播报，前缀固定为 `[cal]`，QGroundControl 的校准向导
 * 也是靠这些文案推进的——不是靠 COMMAND_ACK。
 *
 * 这里只认固件原文出现过的前缀，认不出就返回 null（判 unknown），
 * 绝不猜一条不存在的进度文案出来骗界面。
 */

export const CALIB_PREFIX = '[cal]'

/** 固件姿态名 → 中文引导文案（只列 mavlink_status.c 里真实出现的六个） */
export const CALIB_ORIENTATIONS = {
  up: '朝上',
  down: '朝下',
  left: '朝左',
  right: '朝右',
  front: '朝前',
  back: '朝后',
}

/** 固件 sensor 名 → 中文（mavlink_status.c:28-34 的四个 started 文案） */
export const CALIB_SENSORS = {
  gyro: '陀螺仪',
  accel: '加速度计',
  mag: '磁力计',
  level: '水平',
}

export function isCalibStatus(text) {
  return String(text || '')
    .trim()
    .startsWith(CALIB_PREFIX)
}

/**
 * 把一行 STATUSTEXT 解析成结构化事件。
 * @returns {null|{kind:string, raw:string, sensor?:string, progress?:number, orientation?:string}}
 *          非 `[cal]` 前缀返回 null（不是校准播报，调用方不该记账）。
 */
export function parseCalibStatus(text) {
  // MAVLink STATUSTEXT 的 text 是定长 char[50]；固件未使用的尾部字节可能是 NUL。
  // 先去掉 NUL 再 trim，否则肉眼看到的 "[cal] down ..." 也会匹配失败。
  const line = String(text || '')
    .replace(/\0+$/g, '')
    .trim()
  if (!isCalibStatus(line)) return null
  const body = line.slice(CALIB_PREFIX.length).trim()
  const raw = line
  let m

  // "[cal] calibration started: 2 gyro"（"2" 是固件宏里的固定字面量，不参与判断）
  if ((m = body.match(/^calibration started:\s*\d+\s+(\w+)$/i))) {
    return { kind: 'started', sensor: m[1].toLowerCase(), raw }
  }
  // "[cal] calibration done: level"；固件内部还会发不带名字的 "[cal] calibration done:"
  if ((m = body.match(/^calibration done:\s*(\w+)?$/i))) {
    return { kind: 'done', sensor: (m[1] || '').toLowerCase(), raw }
  }
  if ((m = body.match(/^calibration failed:\s*(\w+)?$/i))) {
    return { kind: 'failed', sensor: (m[1] || '').toLowerCase(), raw }
  }
  if (/^calibration cancelled$/i.test(body)) return { kind: 'cancelled', raw }
  // "[cal] progress <42>"
  if ((m = body.match(/^progress\s*<(\d+)>$/i))) {
    return { kind: 'progress', progress: Number(m[1]), raw }
  }
  // "[cal] up orientation detected"
  if ((m = body.match(/^(\w+)\s+orientation detected$/i))) {
    return { kind: 'orientation', orientation: m[1].toLowerCase(), raw }
  }
  // "[cal] up side done, rotate to a different side"
  if ((m = body.match(/^(\w+)\s+side done, rotate to a different side$/i))) {
    return { kind: 'sideDone', orientation: m[1].toLowerCase(), raw }
  }
  return { kind: 'unknown', raw }
}

/**
 * 事件 → 界面上给人看的一句话。认不出的 kind 一律回原文，不编造进度。
 * @param {{kind:string, raw:string, sensor?:string, progress?:number, orientation?:string}} evt
 */
export function describeCalibEvent(evt) {
  if (!evt) return ''
  const sensor = evt.sensor && CALIB_SENSORS[evt.sensor] ? CALIB_SENSORS[evt.sensor] : evt.sensor
  const orient =
    evt.orientation && CALIB_ORIENTATIONS[evt.orientation] ? CALIB_ORIENTATIONS[evt.orientation] : evt.orientation
  switch (evt.kind) {
    case 'started':
      return `飞控已开始校准${sensor ? `（${sensor}）` : ''}`
    case 'progress':
      return `飞控进度 ${evt.progress}%`
    case 'orientation':
      return `已识别姿态：${orient}，请保持不动`
    case 'sideDone':
      return `${orient} 面已完成，请旋转到另一个面`
    case 'done':
      return `飞控回报校准完成${sensor ? `（${sensor}）` : ''}`
    case 'failed':
      return `飞控回报校准失败${sensor ? `（${sensor}）` : ''}`
    case 'cancelled':
      return '飞控回报校准已取消'
    default:
      return evt.raw
  }
}

/** 该事件是否代表校准已经不该继续等待（完成/失败/取消） */
export function isCalibTerminal(evt) {
  return !!evt && (evt.kind === 'done' || evt.kind === 'failed' || evt.kind === 'cancelled')
}
