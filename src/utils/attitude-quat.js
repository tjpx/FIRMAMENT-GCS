// src/utils/attitude-quat.js
// ================================================================
// ATTITUDE_QUATERNION(31) → 欧拉角（纯函数，无 DOM，供自测直接 import）
// ----------------------------------------------------------------
// 为什么需要单独一份：FMT 的数传固件推的是 msgid 31 而不是 msgid 30，转换公式一旦写错
// 不会报错，只会让姿态整片反了/滚转和偏航互换。这里把公式固定下来并对着固件源码核验。
//
// 事实来源＝本机固件：
//   - 字段顺序：mavlink_msg_attitude_quaternion.h:8-11
//     q1 = w、q2 = x、q3 = y、q4 = z（"1 in null-rotation" 的那个分量在 q1）；
//     固件按 ins_out.quat[0..3] 原样填（task_comm.c:308-311），quat 结构体是 {w,x,y,z}
//     （module/math/quaternion.h:32-37）。
//   - 转换公式：module/math/quaternion.c:148-167 quaternion_toEuler() —— 标准 3-2-1(ZYX)：
//       roll  = atan2(2(wx + yz), 1 - 2(x² + y²))
//       pitch = asin(clamp(2(wy - zx), -1, 1))
//       yaw   = atan2(2(wz + xy), 1 - 2(y² + z²))
//     本文件逐项与之一致，单位只差一个 rad→deg（界面统一用度）。
//   - repr_offset_q：mavlink_msg_attitude_quaternion.h:15 规定它是用来把姿态「再旋转一次供显示」的
//     偏移四元数（w,x,y,z，无偏移时为 [1,0,0,0]），固件当前发全 0（板级旋转由 SENS_BOARD_ROT 在
//     估计器内部处理，固件里没有任何地方写 repr_offset_q）。这里按协议把它乘在左边
//     （R_display = R_offset · R_attitude），非零时才是「用户看到的那套姿态」；全 0 视为无效偏移。

/** MAVLink 的 q1..q4 → 内部按 w,x,y,z 存放 */
export function quatFromMavlink(raw) {
  return [num(raw?.q1), num(raw?.q2), num(raw?.q3), num(raw?.q4)]
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 归一化；模长过小（或含 NaN）时返回 null，调用方不得把它当成合法姿态 */
export function quatNormalize(q) {
  if (!Array.isArray(q) || q.length < 4) return null
  const v = q.slice(0, 4).map(num)
  const n = Math.hypot(v[0], v[1], v[2], v[3])
  if (!Number.isFinite(n) || n < 1e-6) return null
  return v.map((x) => x / n)
}

/** 四元数乘法 R = left · right（先施加 right，再施加 left） */
export function quatMultiply(left, right) {
  const [lw, lx, ly, lz] = left
  const [rw, rx, ry, rz] = right
  return [
    lw * rw - lx * rx - ly * ry - lz * rz,
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
  ]
}

/**
 * 欧拉角（弧度，3-2-1/ZYX，与固件 quaternion_toEuler 同定义）。
 * @param {number[]} q [w,x,y,z]，内部会归一化
 * @returns {{roll:number,pitch:number,yaw:number}|null} 非法输入返回 null
 */
export function quatToEulerRad(q) {
  const n = quatNormalize(q)
  if (!n) return null
  const [w, x, y, z] = n
  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  }
}

/**
 * 协议语义的完整入口：把 q1..q4 与 repr_offset_q 一起换算成**显示用**欧拉角（度）。
 * @param {object} raw 解码后的 ATTITUDE_QUATERNION raw 字段
 * @returns {{roll:number,pitch:number,yaw:number,quat:number[],offsetApplied:boolean}|null}
 */
export function attitudeFromQuaternion(raw) {
  const q = quatNormalize(quatFromMavlink(raw))
  if (!q) return null
  const offsetRaw = Array.isArray(raw?.repr_offset_q) ? raw.repr_offset_q.map(num) : [0, 0, 0, 0]
  // 协议规定无偏移是 [1,0,0,0]，不支持时发全 0（mavlink_msg_attitude_quaternion.h:15）。
  // 固件当前发全 0 ⇒ 视为没有偏移；[1,0,0,0] 乘上去也是恒等变换，同样按"无偏移"处理。
  const offsetNorm = Math.hypot(...offsetRaw)
  const identityOffset = offsetRaw[0] === 1 && offsetRaw.slice(1).every((v) => v === 0)
  const hasOffset = !identityOffset && offsetRaw.some((v) => v !== 0) && Math.abs(offsetNorm - 1) <= 0.1
  const composed = hasOffset ? quatNormalize(quatMultiply(offsetRaw, q)) : q
  const e = quatToEulerRad(composed || q)
  if (!e) return null
  return {
    roll: e.roll * 180 / Math.PI,
    pitch: e.pitch * 180 / Math.PI,
    yaw: e.yaw * 180 / Math.PI,
    quat: q,
    offsetApplied: !!hasOffset,
  }
}
