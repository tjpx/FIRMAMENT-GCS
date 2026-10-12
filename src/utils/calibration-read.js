// src/utils/calibration-read.js
// ================================================================
// 传感器校准证据（纯函数，无 DOM，可被 Node 自测直接 import）
// ----------------------------------------------------------------
// 为什么需要它：准备飞行页原先的「传感器健康」只比 SYS_STATUS 的 health/enabled 位图，
// 而固件把 health 写成 enabled|present|PREARM_CHECK（task_comm.c:253-254），这个检查永远通过，
// 和「校准过没有」没有任何关系。固件里那批 SENSOR_*_UNCALI / NEED_CALI / OK 播报
// （mavlink_status.h:91-105）定义了却从未发送，所以 STATUSTEXT 也补不上这个信息。
//
// 唯一权威的校准证据在 CALIB 参数组（calibration_param.c:23-87）。四类校准各有专属字段，
// 全部由 MAV_CMD_PREFLIGHT_CALIBRATION 走完之后写入（mavproxy_cmd.c 的 PARAM_SET_FLOAT 调用）：
//   陀螺仪  :293-295  GYRO0_XOFF/YOFF/ZOFF       = 本次静置零偏均值
//   加速度计 :431-440  ACC0_XOFF/YOFF/ZOFF + ACC0_XX/YY/ZZ/XY/XZ/YZSCALE = 椭球拟合的 bias 与 ROT_M
//   罗盘     :663-672  MAG0_XOFF/YOFF/ZOFF + MAG0_XX/YY/ZZ/XY/XZ/YZSCALE = ellipsoid_fit_solve 的 bias 与 RotM
//   水平     :776-777  LEVEL_XOFF/YOFF           = 机体水平时的 roll/pitch 偏移（LEVEL_ZOFF 固件从不写）
// 校准完成后 sensor_update_calibration() 立即生效，param save 负责持久化。
//
// 判据取「是否等于固件出厂默认值」：
//   这些字段是紧跟真实测量结果的连续量，某类校准真的跑完过一次，它自己那组字段至少要有一个偏离默认值。
//   默认 GYRO0_*OFF=0.0、ACC0/MAG0 对角=1.0 非对角=0.0、LEVEL_XOFF/YOFF=0.0（calibration_param.c:25-81）。
//
// 边界（界面必须照说，不许含糊）：
//   - 某组全等于默认值 ⇒ 没有「本板跑过这类校准」的证据（可能从未校准，也可能被 param restore / 重刷固件抹掉）；
//   - 有字段偏离默认值 ⇒ 只证明这些参数曾被写入，不证明当次校准的几何正确、更不证明水平/罗盘可用；
//   - 固件把浮点参数按 6 位小数落盘（cmd_param.c:99-103），零偏小于 5e-7 会被写成 0.000000，
//     这种极端情况会被判成「无证据」——宁可少判通过，也不把 0 偏置当成测过的结果。

/** 属性 → CALIB 参数名 → 出厂默认值（calibration_param.c 的 PARAM_FLOAT 第二参）与容差 */
export const CALIBRATION_FIELDS = Object.freeze([
  { sensor: 'gyro', name: 'GYRO0_XOFF', def: 0, tol: 5e-7 },
  { sensor: 'gyro', name: 'GYRO0_YOFF', def: 0, tol: 5e-7 },
  { sensor: 'gyro', name: 'GYRO0_ZOFF', def: 0, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_XOFF', def: 0, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_YOFF', def: 0, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_ZOFF', def: 0, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_XXSCALE', def: 1, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_YYSCALE', def: 1, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_ZZSCALE', def: 1, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_XYSCALE', def: 0, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_XZSCALE', def: 0, tol: 5e-7 },
  { sensor: 'accel', name: 'ACC0_YZSCALE', def: 0, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_XOFF', def: 0, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_YOFF', def: 0, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_ZOFF', def: 0, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_XXSCALE', def: 1, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_YYSCALE', def: 1, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_ZZSCALE', def: 1, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_XYSCALE', def: 0, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_XZSCALE', def: 0, tol: 5e-7 },
  { sensor: 'mag', name: 'MAG0_YZSCALE', def: 0, tol: 5e-7 },
  // 水平校准只写 X/Y 两个偏移；LEVEL_ZOFF 在 calibration_param.c:81 定义但固件从不写，故不列入判据。
  { sensor: 'level', name: 'LEVEL_XOFF', def: 0, tol: 5e-7 },
  { sensor: 'level', name: 'LEVEL_YOFF', def: 0, tol: 5e-7 },
])

/** 判据覆盖的四类校准，顺序即界面展示顺序 */
export const CALIBRATION_SENSORS = Object.freeze(['gyro', 'accel', 'mag', 'level'])

export const CALIBRATION_SENSOR_LABEL = Object.freeze({
  gyro: '陀螺仪',
  accel: '加速度计',
  mag: '罗盘',
  level: '水平',
})

/** 通过条件：四类校准各自都有偏离默认值的字段 */
export const CALIBRATION_REQUIRED = Object.freeze(CALIBRATION_SENSORS.slice())

/** 这一批值是否仍等于出厂默认（全是默认 ⇒ 没有校准写过的证据） */
export function isFactoryDefault(values, fields = CALIBRATION_FIELDS) {
  const v = values || {}
  let checked = 0
  for (const f of fields) {
    const got = v[f.name]
    if (typeof got !== 'number' || !Number.isFinite(got)) continue
    checked++
    if (Math.abs(got - f.def) > f.tol) return false
  }
  return checked > 0
}

/**
 * 读取结果（mav.param.read 的返回值列表）→ 可判定的证据快照。
 * 只认「按名字读回且数值有限」的字段；没读到的字段一律缺省，不替飞控猜。
 * @param {Array<{name:string,ok?:boolean,value?:number}>} readings
 */
export function evaluateCalibrationRead(readings, options = {}) {
  const fw = options.defaultsFrom
  const list = Array.isArray(readings) ? readings : []
  const byName = new Map()
  for (const r of list) {
    const name = typeof r?.name === 'string' ? r.name : ''
    if (!name) continue
    if (typeof r?.value === 'number' && Number.isFinite(r.value)) byName.set(name, { name, value: r.value, ok: r.ok !== false })
    else byName.set(name, { name, value: null, ok: false, reason: r?.reason || 'no-echo' })
  }

  const fields = []
  for (const f of CALIBRATION_FIELDS) {
    const got = byName.get(f.name)
    const value = got && typeof got.value === 'number' ? got.value : null
    fields.push({
      ...f,
      value,
      read: value !== null,
      isDefault: value === null ? null : Math.abs(value - f.def) <= f.tol,
    })
  }

  const sensors = {}
  for (const sensor of CALIBRATION_SENSORS) {
    const own = fields.filter((f) => f.sensor === sensor)
    const read = own.filter((f) => f.read)
    const changed = read.filter((f) => !f.isDefault)
    sensors[sensor] = {
      sensor,
      label: CALIBRATION_SENSOR_LABEL[sensor] || sensor,
      total: own.length,
      read: read.length,
      missing: own.length - read.length,
      changed: changed.map((f) => f.name),
      // 这组字段全部读到、且没有一个偏离默认 ⇒ 没有这类校准跑过的证据
      allDefault: read.length === own.length && own.length > 0 && changed.length === 0,
    }
  }

  const missingNames = fields.filter((f) => !f.read).map((f) => f.name)
  const complete = missingNames.length === 0
  // 通过条件：四类校准各自都有偏离默认的字段（缺字段一律不判通过，也不判「未校准」）
  const missingCalibrations = CALIBRATION_REQUIRED.filter((s) => !(sensors[s]?.changed.length > 0))
  const verified = complete && missingCalibrations.length === 0
  const allDefault = complete && CALIBRATION_REQUIRED.every((s) => sensors[s]?.allDefault)

  return {
    at: Date.now(),
    complete,
    verified,
    allDefault,
    missingCalibrations,
    missingCalibrationLabels: missingCalibrations.map((s) => CALIBRATION_SENSOR_LABEL[s] || s),
    sensors,
    fields,
    readCount: fields.filter((f) => f.read).length,
    missingNames,
    defaultsFrom: fw || '',
    raw: list,
  }
}

/** 校准证据的中文结论；界面与检查项共用，避免两处口径不一致 */
export function calibrationReadSummary(evidence) {
  if (!evidence) return '未读取 CALIB 参数组；本页不根据遥测或 SYS_STATUS 推断校准状态。'
  const { sensors } = evidence
  const parts = CALIBRATION_SENSORS.map((s) => {
    const g = sensors[s] || {}
    const label = CALIBRATION_SENSOR_LABEL[s] || s
    if (!g.total) return `${label} 无字段`
    const state = g.read !== g.total ? `只读到 ${g.read}/${g.total} 项（未验证）`
      : g.changed?.length ? `偏离默认（${g.changed.length} 项）`
        : '等于出厂默认'
    return `${label} ${state}`
  })
  if (!evidence.complete) {
    const miss = evidence.missingNames || []
    return `四类校准参数读取不完整：${parts.join('；')}。缺 ${miss.slice(0, 3).join('、')}${miss.length > 3 ? ' 等' : ''} 未回包，本次不判通过也不判未校准。`
  }
  if (evidence.verified) {
    const who = CALIBRATION_SENSORS.filter((s) => sensors[s]?.changed.length).map((s) => CALIBRATION_SENSOR_LABEL[s]).join('、')
    return `${parts.join('；')}。${who}都有偏离出厂默认的字段。`
  }
  const missing = (evidence.missingCalibrationLabels || []).join('、')
  return `${parts.join('；')}。${missing ? `${missing}没有偏离出厂默认的字段，即` : ''}查不到这几类校准跑过的证据。`
}

/** 逐字段回显行（用于证据卡，不写结论） */
export function calibrationFieldLines(evidence) {
  if (!evidence) return []
  return (evidence.fields || []).map((f) => ({
    name: f.name,
    sensor: f.sensor,
    sensorLabel: CALIBRATION_SENSOR_LABEL[f.sensor] || f.sensor,
    text: f.read ? String(f.value) : '未读到',
    defaultText: String(f.def),
    changed: f.read ? !f.isDefault : null,
  }))
}
