// src/utils/calibration-faces.js
// ================================================================
// 六面姿态校准的静态元数据与缺面统计（纯函数，无 DOM，供自测直接 import）
// ----------------------------------------------------------------
// 事实来源＝本机固件：
//   - 姿态名与判定阈值：mavproxy_cmd.c:129-180 acc_position_detect()
//     目标轴 |a| > 8.8、其余两轴 |a| < 2.0，且同一姿态连续保持 1 s（1000/CALIB_TIME_INTERVAL 次）才认。
//     acc[0]<0 → front / >0 → back；acc[1]<0 → right / >0 → left；acc[2]>0 → up / <0 → down。
//   - 旋转方向：加速度计 mavproxy_cmd.c:553-578，罗盘 mavproxy_cmd.c:553-578 同一套门槛
//     （|gyro 分量| ≥ GYR_ROTAT_THRESHOLD 0.5 rad/s 才累积采样）。可见固件对同一面只认一个轴向：
//       朝上/朝下 → 绕 Z、朝左/朝右 → 绕 Y、朝前/朝后 → 绕 X
//   - 罗盘同样走 acc_position_detect()（mavproxy_cmd.c:498）识别当前面，六面 done 才求解椭球
//     （:628-633 全 done → status 3 → :655 CAL_DONE），所以罗盘校准是「六个姿态，每个姿态绕该面法线旋转」，
//     与加速度计的「六个姿态，每个姿态保持静止」用的是同一张六面图。
//
// 界面用这里的 axis 文案告诉用户「这一面要绕哪根轴转」，不靠猜。

/** 六面姿态：key 与固件 [cal] 播报里的姿态名一致；axis 是固件要求旋转的机体轴 */
export const CALIBRATION_FACES = Object.freeze([
  { key: 'up', label: '朝上', glyph: '↑', axis: 'Z', axisText: '绕 Z 轴（竖直）旋转' },
  { key: 'down', label: '朝下', glyph: '↓', axis: 'Z', axisText: '绕 Z 轴（竖直）旋转' },
  { key: 'left', label: '朝左', glyph: '←', axis: 'Y', axisText: '绕 Y 轴（机头方向）旋转' },
  { key: 'right', label: '朝右', glyph: '→', axis: 'Y', axisText: '绕 Y 轴（机头方向）旋转' },
  { key: 'front', label: '朝前', glyph: '↗', axis: 'X', axisText: '绕 X 轴（左右方向）旋转' },
  { key: 'back', label: '朝后', glyph: '↙', axis: 'X', axisText: '绕 X 轴（左右方向）旋转' },
])

export const CALIBRATION_FACE_KEYS = Object.freeze(CALIBRATION_FACES.map((f) => f.key))

const FACE_BY_KEY = Object.fromEntries(CALIBRATION_FACES.map((f) => [f.key, f]))

export function faceMeta(key) {
  return FACE_BY_KEY[key] || null
}

export function faceLabel(key) {
  return FACE_BY_KEY[key]?.label || String(key || '')
}

/** 已完成的面（state === 'done'），按固件姿态顺序 */
export function doneFaces(states) {
  const s = states || {}
  return CALIBRATION_FACES.filter((f) => s[f.key]?.state === 'done')
}

/**
 * 缺哪些面：只把「已有任意一面完成」当作本轮校准真的开始了；
 * 一面都没完成时返回空数组（免得还没开始就报「缺 6 面」），由界面自己说「等待飞控识别姿态」。
 */
export function missingFaceKeys(states) {
  const s = states || {}
  const anyProgress = CALIBRATION_FACE_KEYS.some((k) => s[k]?.state === 'done' || s[k]?.state === 'active')
  if (!anyProgress) return []
  return CALIBRATION_FACE_KEYS.filter((k) => s[k]?.state !== 'done')
}

/** 缺面的人话文案；没开始时给出等待提示 */
export function missingFaceText(states) {
  const missing = missingFaceKeys(states)
  const done = doneFaces(states)
  if (!done.length && !missing.length) return '尚未完成任何面：等待飞控识别第一个姿态'
  if (!missing.length) return `六面已完成（${done.length}/6）`
  return `已完成 ${done.length}/6，还缺 ${missing.map(faceLabel).join('、')}`
}
