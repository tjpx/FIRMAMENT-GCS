// Mirrors mavproxy_cmd.c:129-213. Console echo values are m/s² and rad/s.
// A 20 ms console observation is evidence, not the firmware's internal sample counter.
export function parseImuEcho(text) {
  const rows = []
  const number = '([-+\\d.eE]+)'
  const re = new RegExp(`gyr:\\s*${number}\\s+${number}\\s+${number}\\s+acc:\\s*${number}\\s+${number}\\s+${number}`, 'g')
  for (const m of String(text).matchAll(re)) {
    const values = m.slice(1).map(Number)
    if (values.every(Number.isFinite)) rows.push({ gyro: values.slice(0, 3), accel: values.slice(3) })
  }
  return rows
}
export function firmwareFace(acc) {
  if (!Array.isArray(acc) || acc.length !== 3 || !acc.every(Number.isFinite)) return ''
  const a = acc.map(Math.abs)
  if (a[0] > 8.8 && a[1] < 2 && a[2] < 2) return acc[0] < 0 ? 'front' : 'back'
  if (a[0] < 2 && a[1] > 8.8 && a[2] < 2) return acc[1] < 0 ? 'right' : 'left'
  if (a[0] < 2 && a[1] < 2 && a[2] > 8.8) return acc[2] > 0 ? 'up' : 'down'
  return ''
}
export function summarizeImu(rows) {
  const faces = {}
  let jumps = 0
  rows.forEach((row, i) => {
    const face = firmwareFace(row.accel) || 'idle'
    faces[face] = (faces[face] || 0) + 1
    if (i && row.gyro.some((v, axis) => Math.abs(v - rows[i - 1].gyro[axis]) > 0.8)) jumps++
  })
  return { count: rows.length, faces, jumps }
}
export function sixFaceProgress(states, currentFace, progress) {
  const done = Object.values(states).filter((s) => s.state === 'done').length
  const partial = states[currentFace]?.state === 'active' && Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) / 100 : 0
  return Math.min(100, Math.round((done + partial) / 6 * 100))
}
