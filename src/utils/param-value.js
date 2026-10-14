/**
 * PARAM_VALUE 的取值解码。
 *
 * 飞控 `make_mavlink_param_msg()`（mavlink_param.c:407-466）往 4 字节 value 字段里
 * 塞东西的方式分两种：
 *   - FLOAT/DOUBLE：写 `(float)param->val.f`，即正常浮点数值；
 *   - INT32/UINT32/INT16/UINT16/INT8/UINT8：`memcpy` 整数的**原始小端字节**。
 * 而地面站解码器始终把该字段按 `f` 解出来，所以整型参数拿到的是位模式重新解释出的
 * 怪值（int 1 → 1.401298464324817e-45）。这里按 param_type 把字节读回整数。
 *
 * 但还有一层不确定：`/sys/param.xml` 的表把值统一存成 float 再 memcpy，
 * 于是"声明 INT32、实际发的是 float 125.0"（CAL_GYRO0_ID）和
 * "声明 UINT8、实际发的是原始字节 01 cc 4c 3f"（AIRFRAME → u8=1）两种情况并存。
 * 两种编码在链路上**无法逐参数判定**，所以本模块只做一件事：
 * 把两种读法都算出来，标出是否一致，并把结论交给调用方——
 * 整型/布尔参数的权威值以 param.xml 文件为准，MAVLink 通道只对 REAL32 可靠。
 */

/** wire 上的 param_type 取值（MAVLINK_TYPE_* 与 MAV_PARAM_TYPE_* 在 1-6、9 上重合） */
export const PARAM_TYPE = {
  NONE: 0,
  UINT8: 1,
  INT8: 2,
  UINT16: 3,
  INT16: 4,
  UINT32: 5,
  INT32: 6,
  UINT64: 7,
  INT64: 8,
  REAL32: 9,
  REAL64: 10,
}

export const PARAM_TYPE_TEXT = {
  0: '未知',
  1: 'uint8',
  2: 'int8',
  3: 'uint16',
  4: 'int16',
  5: 'uint32',
  6: 'int32',
  7: 'uint64',
  8: 'int64',
  9: 'float',
  10: 'double',
}

/** 位重解释只需要一个复用的 4 字节缓冲，避免每个参数都新建 typed array */
const f32 = new Float32Array(1)
const u8 = new Uint8Array(f32.buffer)
const i8 = new Int8Array(f32.buffer)
const u16 = new Uint16Array(f32.buffer)
const i16 = new Int16Array(f32.buffer)
const u32 = new Uint32Array(f32.buffer)
const i32 = new Int32Array(f32.buffer)

function isDenormalFloat(v) {
  // 小整数的位模式落在 float32 的非规格化区间：|x| < 2^-126 ≈ 1.18e-38
  return Number.isFinite(v) && v !== 0 && Math.abs(v) < 1e-30
}

/** 把 wire 上的 float 按整数类型读回来（返回 null 表示无法读） */
export function reinterpretInt(rawFloat, type) {
  if (!Number.isFinite(rawFloat)) return null
  f32[0] = rawFloat

  switch (type) {
    case PARAM_TYPE.UINT8:
      return u8[0]
    case PARAM_TYPE.INT8:
      return i8[0]
    case PARAM_TYPE.UINT16:
      return u16[0]
    case PARAM_TYPE.INT16:
      return i16[0]
    case PARAM_TYPE.UINT32:
      return u32[0]
    case PARAM_TYPE.INT32:
      return i32[0]
    default:
      return null
  }
}

/**
 * @returns {{
 *   kind: 'float'|'int'|'unknown',
 *   value: number|null,     // 推荐的显示/使用值（float 类型就是它本身）
 *   float: number|null,     // 按 float32 解出来的读法
 *   typed: number|null,     // 按 param_type 整数读法
 *   agrees: boolean|null,   // 两种读法是否给出同一个数
 *   encoding: string|null,  // 'float-numeric' | 'raw-packed' | 'undetermined' | 'wide-int-unsupported'
 *   reliable: boolean,      // 该参数在链路上的取值是否可信
 *   note: string
 * }}
 */
export function decodeParamValue(rawFloat, type) {
  const t = Number.isFinite(type) ? type | 0 : null
  const f = Number.isFinite(rawFloat) ? rawFloat : null

  if (t === PARAM_TYPE.REAL32 || t === PARAM_TYPE.REAL64) {
    return {
      kind: 'float',
      value: f,
      float: f,
      typed: null,
      agrees: true,
      encoding: 'float-numeric',
      reliable: true,
      note: '',
    }
  }

  if (t === PARAM_TYPE.UINT64 || t === PARAM_TYPE.INT64) {
    return {
      kind: 'int',
      value: null,
      float: f,
      typed: null,
      agrees: null,
      encoding: 'wide-int-unsupported',
      reliable: false,
      note: '64 位整型塞不进 4 字节 value 字段，链路读不到真实值',
    }
  }

  if (t === null || t === PARAM_TYPE.NONE || reinterpretInt(0, t) === null) {
    return {
      kind: 'unknown',
      value: f,
      float: f,
      typed: null,
      agrees: null,
      encoding: null,
      reliable: false,
      note: `param_type=${t} 不在已知类型表里，只能按 float 呈现`,
    }
  }

  const typed = reinterpretInt(rawFloat, t)

  if (typed === null) {
    return {
      kind: 'int',
      value: f,
      float: f,
      typed: null,
      agrees: null,
      encoding: null,
      reliable: false,
      note: '整数读法失败',
    }
  }

  const agrees = Number.isFinite(f) && Math.fround(typed) === f

  // 非规格化 float 几乎不可能是真实浮点值，只可能是小整数的位模式
  const rawPacked = isDenormalFloat(f)

  if (agrees) {
    return {
      kind: 'int',
      value: typed,
      float: f,
      typed,
      agrees: true,
      encoding: 'float-numeric',
      reliable: true,
      note: '',
    }
  }

  if (rawPacked) {
    return {
      kind: 'int',
      value: typed,
      float: f,
      typed,
      agrees: false,
      encoding: 'raw-packed',
      reliable: true,
      note: `按 ${PARAM_TYPE_TEXT[t]} 读回整数 ${typed}（float 读法 ${f} 是同一串字节的位模式）`,
    }
  }

  return {
    kind: 'int',
    value: f,
    float: f,
    typed,
    agrees: false,
    encoding: 'undetermined',
    reliable: false,
    note: `两种读法分歧：float=${f}，${PARAM_TYPE_TEXT[t]}=${typed}；` + '该参数的权威值以 param.xml 文件为准',
  }
}

/**
 * 一批 PARAM_VALUE 帧的类型体检。
 * @param {Array<{name?:string,type?:number,value?:number,typed?:number,agrees?:boolean,hits?:number}>} list
 */
export function auditParamTypes(list, { frames = null } = {}) {
  const rows = Array.isArray(list) ? list : []
  const rx = Number.isFinite(frames) ? frames : null
  const byType = new Map()
  const diverging = []
  let floatTyped = 0
  let intTyped = 0
  let unreliable = 0
  let duplicated = 0

  for (const r of rows) {
    const d = decodeParamValue(r?.value, r?.type)
    const key = Number.isFinite(r?.type) ? r.type : -1
    const bucket = byType.get(key) || { type: key, text: PARAM_TYPE_TEXT[key] || '未知', count: 0 }
    bucket.count++
    byType.set(key, bucket)

    if (d.kind === 'float') floatTyped++
    else if (d.kind === 'int') intTyped++

    if (!d.reliable) unreliable++
    if ((r?.hits || 1) > 1) duplicated++

    if (d.agrees === false) {
      diverging.push({
        name: r?.name ?? null,
        type: key,
        typeText: PARAM_TYPE_TEXT[key] || '未知',
        float: d.float,
        typed: d.typed,
        encoding: d.encoding,
      })
    }
  }

  return {
    total: rows.length,
    /* 链路收到的 PARAM_VALUE 帧数与去重后的名字数之差：
       真机一次整表读取 494 帧只剩 410 个名字，说明静态表和 param.xml 表重名 84 个，
       而地面站只会留下后到的那一帧——回写参数前必须先看清这件事。 */
    frames: rx,
    duplicatedFrames: rx !== null ? rx - rows.length : null,
    floatTyped,
    intTyped,
    unreliable,
    duplicatedNames: duplicated,
    divergingCount: diverging.length,
    byType: [...byType.values()].sort((a, b) => b.count - a.count),
    diverging: diverging.slice(0, 40),
    divergingTruncated: diverging.length > 40,
  }
}
