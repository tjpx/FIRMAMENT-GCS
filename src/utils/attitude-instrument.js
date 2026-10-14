// src/utils/attitude-instrument.js
// ================================================================
// 姿态仪表盘（地平线 / 俯仰梯尺 / 滚转刻度 / 磁罗盘带）的几何计算
// 纯函数，无 DOM、无 Vue：数值和 SVG 坐标由这里算好，组件只负责画，自测能直接跑。
// ----------------------------------------------------------------
// 约定（与航空仪表一致，也和 QGroundControl 的姿态盘一致）：
//   - 姿态角单位是度，向外为正：roll 右滚为正、pitch 抬头为正；
//   - SVG 里 y 向下为正，所以抬头（pitch>0）时地平线要**向下**移（天空变大）：
//       地平线 y = 圆心 y + pitch * pxPerDeg
//     于是俯仰梯尺上的 "10"（表示机头相对地平线抬高 10°）画在圆心下方 10*pxPerDeg 处。
//   - 俯仰梯尺的横线按飞机滚转反向旋转（-roll），使梯尺始终与地平线平行；
//     固定不动的外壳上画滚转刻度，由梯尺顶端的三角指针指示当前坡度。
//   - 罗盘带：当前航向固定在正中，刻度向两侧铺开；同一条刻度只出现一次，
//     取它离当前航向"最近"的那一份（360 环绕），避免 0/360 处出现重复刻度。

/** 地平线每度俯仰占多少像素（仪表坐标） */
export const PX_PER_DEG = 5

/** 罗盘带每度航向占多少像素 */
export const TAPE_PX_PER_DEG = 3

/** 滚转刻度：角度 → 该处是否画长刻度。**不带数字**（业主要求盘上不写刻度值） */
export const ROLL_SCALE_MARKS = Object.freeze(
  [0, 10, 20, 30, 45, 60].flatMap((deg) =>
    deg === 0
      ? [{ deg: 0, major: true }]
      : [
          { deg, major: deg === 30 || deg === 60 },
          { deg: -deg, major: deg === 30 || deg === 60 },
        ]
  )
)

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 把角度规整到 [0, 360) */
export function normalizeHeading(deg) {
  const n = Number(deg)
  if (!Number.isFinite(n)) return 0
  return ((n % 360) + 360) % 360
}

/**
 * 罗盘带的相对偏移（度）：把某个刻度摆到当前航向两侧。
 * 结果落在 [-180, 180)，所以 350° 航向时 0° 刻度是 +10（在右侧），而不是 -350。
 */
export function headingOffsetDeg(heading, tick) {
  return ((normalizeHeading(tick) - normalizeHeading(heading) + 540) % 360) - 180
}

/**
 * 当前可见的罗盘刻度；窗口是 ±halfWindowDeg，超过就不画。
 * @returns {Array<{deg:number, label:string, offsetDeg:number, x:number, major:boolean}>}
 */
export function headingTape(heading, { halfWindowDeg = 60, pxPerDeg = TAPE_PX_PER_DEG, stepDeg = 5 } = {}) {
  const out = []
  const h = normalizeHeading(heading)
  // 从当前航向向两侧按 step 取，保证窗口内一条不落（含跨越 0/360 的情况）
  const first = Math.ceil((h - halfWindowDeg) / stepDeg) * stepDeg
  for (let deg = first; deg <= h + halfWindowDeg; deg += stepDeg) {
    const tick = normalizeHeading(deg)
    const offsetDeg = headingOffsetDeg(h, tick)
    if (Math.abs(offsetDeg) > halfWindowDeg) continue
    out.push({
      deg: tick,
      label: headingLabel(tick),
      offsetDeg,
      x: offsetDeg * pxPerDeg,
      major: tick % 30 === 0,
    })
  }
  // 同一条刻度（例如 0 与 360）只留最近的那份
  const seen = new Map()
  for (const t of out) {
    const prev = seen.get(t.deg)
    if (!prev || Math.abs(t.offsetDeg) < Math.abs(prev.offsetDeg)) seen.set(t.deg, t)
  }
  return [...seen.values()].sort((a, b) => a.offsetDeg - b.offsetDeg)
}

/** 罗盘刻度文案：8 个方位给字母，其余给数字 */
export function headingLabel(deg) {
  const d = normalizeHeading(deg)
  const cardinal = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }
  if (cardinal[d]) return cardinal[d]
  return String(d)
}

/** 方位角 → 该点是主方位（N/E/S/W）还是次方位（NE/SE/…）；都不是就返回 '' */
export function compassKind(deg) {
  const d = normalizeHeading(deg)
  if (d % 90 === 0) return 'cardinal'
  if (d % 45 === 0) return 'ordinal'
  return ''
}

/**
 * 圆形罗盘刻度盘：当前航向朝上（正北在盘内按航向旋转），
 * 每 5° 一条刻度、每 30° 一个数字、N/E/S/W 给字母并加粗。
 * 返回的 rot 是"盘面要旋转的角度"（= -heading），调用方直接拿它写 transform。
 * @returns {Array<{deg:number, rot:number, label:string, kind:'cardinal'|'ordinal'|'', major:boolean, minor:boolean}>}
 */
export function headingRose(heading, { stepDeg = 5, labelStepDeg = 30 } = {}) {
  const h = normalizeHeading(heading)
  const out = []
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const kind = compassKind(deg)
    const labeled = deg % labelStepDeg === 0
    out.push({
      deg,
      rot: deg - h,
      label: kind ? headingLabel(deg) : labeled ? String(deg) : '',
      kind,
      // 主刻度：带数字的每 30°、以及 8 个方位点（N/E/S/W 与 NE/SE/…，前者在组件里更粗）
      major: labeled || kind !== '',
      // 次方位（NE/SE/…）虽然没数字，也算主刻度
      minor: !labeled && kind === '',
    })
  }
  return out
}

/**
 * 俯仰梯尺：按当前俯仰列出可见的梯尺线。
 *
 * **不写数字**（业主明确要求：盘上不要刻度值，数字看右侧卡片）。
 * 每 5° 一条、每 10° 略长；另外一定画出"当前俯仰"那条并标 isPitch——
 * 它抵消掉外层的地平线平移（y = -pitch * pxPerDeg），所以永远压在表盘圆心，
 * 飞机抬多少度它就移动多少，是这张盘上唯一的读数指示。
 *
 * @returns {Array<{deg:number, y:number, width:number, label:string, positive:boolean, isPitch:boolean}>}
 */
export function pitchLadder(pitch, { pxPerDeg = PX_PER_DEG, limitDeg = 90, stepDeg = 5, visibleRangeDeg = 25 } = {}) {
  const raw = Number(pitch)
  const p = Number.isFinite(raw) ? raw : 0
  const out = []
  const from = Math.max(-limitDeg, Math.ceil((p - visibleRangeDeg) / stepDeg) * stepDeg)
  const to = Math.min(limitDeg, Math.floor((p + visibleRangeDeg) / stepDeg) * stepDeg)
  const pLine = Math.round(p * 10) / 10
  for (let deg = from; deg <= to; deg += stepDeg) {
    if (deg === 0) continue
    if (deg !== pLine) {
      out.push({
        deg,
        y: (deg - p) * pxPerDeg,
        width: deg % 10 === 0 ? 90 : 50,
        label: '',
        positive: deg > 0,
        isPitch: false,
      })
    }
  }
  const clamped = Math.max(-limitDeg, Math.min(limitDeg, pLine))
  if (Math.abs(clamped) > 0) {
    out.push({
      deg: clamped,
      y: -p * pxPerDeg,
      width: 90,
      label: '',
      positive: clamped > 0,
      isPitch: true,
    })
  }
  return out.sort((a, b) => a.deg - b.deg)
}

/** 地平线在仪表坐标里的垂直位置（圆心为原点） */
export function horizonOffsetY(pitch, pxPerDeg = PX_PER_DEG) {
  const p = Number.isFinite(Number(pitch)) ? Number(pitch) : 0
  return p * pxPerDeg
}

/** 仪表上给"人"看的姿态读数；无效值一律给占位符，不拿 0 冒充平飞 */
export function formatAttitude(roll, pitch, valid = true) {
  if (!valid) return { roll: '--', pitch: '--' }
  const r = Number.isFinite(Number(roll)) ? Number(roll) : 0
  const p = Number.isFinite(Number(pitch)) ? Number(pitch) : 0
  return { roll: r.toFixed(0), pitch: p.toFixed(0) }
}

/** 仪表上给"人"看的航向读数 */
export function formatHeading(heading, valid = true) {
  if (!valid) return { text: '--', label: '--' }
  const h = normalizeHeading(heading)
  return { text: String(Math.round(h)).padStart(3, '0'), label: headingLabel(Math.round(h) % 360) }
}
