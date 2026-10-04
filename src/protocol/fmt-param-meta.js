/**
 * fmt-param-meta.js —— 参数页（param.xml）整数/枚举型参数的中文元数据（改造方案第 2、4 项）
 *
 * 这一份表里的每一条都能在固件源码里指出行号，地面站不替飞控编参数含义：
 *   SYSTEM 组   src/module/param/sys_param.c:22-38（含参数上方的官方注释，MLOG_MODE 的 0~3 就是那里写死的）
 *   RC 组       src/module/param/rc_param.c:24-90（RC1~RC16 的 MAX/MIN/REV/TRIM 全是 FLOAT，
 *               RC_CHAN_CNT 是 INT32，注释原文 "only used by ground station"）
 *   CONTROL 组  src/model/control/<vehicle>_controller/control_interface.c:34 PARAM_UINT8(AIRFRAME, AIRFRAME, true)
 *               —— 第三个参数 true 表示只读；值来自编译期宏 AIRFRAME（target/<vendor>/SConstruct:50
 *               `env.Append(CPPDEFINES=[('AIRFRAME', GetOption('airframe'))])`，默认 1）
 *   INS 组      src/model/ins/px4_ecl/ins_interface.c:117-178 的参数定义，
 *               位定义与整数定义见同文件 40-93 行、以及 ecl/EKF/common.h:166-199
 *
 * 三条规矩：
 *   1. 只登记源码里真出现的取值；查不到含义的参数返回 null，界面退回数字输入（不猜）。
 *   2. 位掩码参数用 kind:'bits'（多选，写回仍是这些位的按位或），不是单选下拉——
 *      把 bitmask 做成单选下拉会把已有组合吃掉。
 *   3. 飞控上读到的值不在已知集合里时，原值照样列出、照样能选回去，绝不自动改写。
 */
import { RC_DIRECTION_OPTIONS, AIRFRAME_LAYOUT_OPTIONS, optionsWithCurrent, optionLabel } from './fmt-enums.js'
import { resolveDictionary } from './fmt-dictionary.js'

/** 整数选项（写回原样整数），label 一律中文，name 保留固件里的宏名便于核对 */
function intOpt(value, name, label, description) {
  return { value, name, label, description }
}

/** 0/1 开关型整数参数（固件按真值使用，故 非 0 视为开启） */
const SWITCH_ZERO_ONE = [intOpt(0, '0', '关闭', '0 = 关'), intOpt(1, '1', '开启', '非 0 在固件里都按真值处理')]

function bits(...list) {
  return list.map(([bit, name, label, description]) => ({ bit, name, label, description }))
}

/* ---------------- INS / EKF2：位掩码与枚举（ins_interface.c:40-93） ---------------- */

const EKF2_DECL_TYPE_BITS = bits(
  [1, 'MASK_USE_GEO_DECL', '用地磁库的 declination', 'GPS 定位可用后取地磁偏角；不勾选则始终用 ekf2_mag_decl 的固定值'],
  [2, 'MASK_SAVE_GEO_DECL', '把取到的偏角写回 ekf2_mag_decl', '勾选后会把地磁库返回的值设置到 ekf2_mag_decl 参数'],
  [4, 'MASK_FUSE_DECL', '把偏角作为观测量融合', '勾选后始终把 declination 当观测量融合，抑制航向漂移'],
)

const EKF2_GPS_CHECK_BITS = bits(
  [1, 'MASK_GPS_NSATS', '卫星数检查', '可见卫星数下限检查'],
  [2, 'MASK_GPS_PDOP', 'PDOP 检查', '位置精度因子上限检查'],
  [4, 'MASK_GPS_HACC', '水平精度检查', '水平估计精度上限检查'],
  [8, 'MASK_GPS_VACC', '垂直精度检查', '垂直估计精度上限检查'],
  [16, 'MASK_GPS_SACC', '速度精度检查', '速度估计精度上限检查'],
  [32, 'MASK_GPS_HDRIFT', '水平漂移检查', '水平速度漂移检查'],
  [64, 'MASK_GPS_VDRIFT', '垂直漂移检查', '垂直速度漂移检查'],
  [128, 'MASK_GPS_HSPD', '水平速度检查', '水平速度合理性检查'],
  [256, 'MASK_GPS_VSPD', '垂直速度检查', '垂直速度合理性检查'],
)

const EKF2_AID_MASK_BITS = bits(
  [1, 'MASK_USE_GPS', '使用 GPS', '用 GPS 数据'],
  [2, 'MASK_USE_OF', '使用光流', '用光流数据'],
  [4, 'MASK_INHIBIT_ACC_BIAS', '禁止估计加计零偏', '抑制 delta velocity bias 估计'],
  [8, 'MASK_USE_EVPOS', '使用视觉位置', '用外部视觉位置数据'],
  [16, 'MASK_USE_EVYAW', '使用视觉航向', '用外部视觉四元数提供航向'],
  [32, 'MASK_USE_DRAG', '使用阻力模型估风', '用多旋翼阻力模型估计风'],
  [64, 'MASK_ROTATE_EV', '旋转视觉观测量', '视觉观测不在 NED 系时需旋转'],
  [128, 'MASK_USE_GPSYAW', '使用 GPS 航向', '有 GPS yaw 数据时使用'],
  [256, 'MASK_USE_EVVEL', '使用视觉速度', '用外部视觉速度数据'],
)

const EKF2_TERR_MASK_BITS = bits(
  [1, 'TERRAIN_FUSE_RANGEFINDER', '用地形测距', '地形估计使用测距仪'],
  [2, 'TERRAIN_FUSE_OPTICALFLOW', '用地形光流', '地形估计使用光流'],
)

/* ---------------- 参数名 → 元数据 ---------------- */

const PARAM_TABLE = {
  'SYSTEM/MAV_SYS_ID': {
    kind: 'number',
    min: 0,
    max: 255,
    hint: 'UINT8（sys_param.c:24 PARAM_UINT8）。同一条链路上的系统号，和别的飞控/伴机不能撞号。',
  },
  'SYSTEM/MAV_COMP_ID': {
    kind: 'number',
    min: 0,
    max: 255,
    hint: 'UINT8（sys_param.c:26 PARAM_UINT8）。组件号，默认 1。',
  },
  'SYSTEM/MLOG_MODE': {
    kind: 'enum',
    options: [
      intOpt(0, '0', '不记录', 'sys_param.c 注释：disabled'),
      intOpt(1, '1', '解锁后记录到失锁', '注释：when armed until disarm'),
      intOpt(2, '2', '从上电记到失锁，再解锁重新开记', '注释：from boot until disarm, next arm will restart logging'),
      intOpt(3, '3', '从上电记到关机', '注释：from boot until shutdown'),
    ],
    hint: '四个取值直接抄自 sys_param.c:27-31 的固件注释；使用处见 task_status.c:105/125、task_logger.c:139。',
  },
  'SYSTEM/LOOP_MISSION': {
    kind: 'enum',
    options: [
      intOpt(0, '0', '关闭', '任务做完就结束'),
      intOpt(1, '1', '开启', '任务完成后从第一条数据重新执行'),
    ],
    hint: 'UINT8，固件按真值使用（mission_data.c:411 loop_mission = PARAM_GET_UINT8(...)）；含义见 sys_param.c:33-34 注释「Endless mission mode」。非 0 都会被当成开启。',
  },
  'SYSTEM/OBC_HEARTBEAT': {
    kind: 'enum',
    options: SWITCH_ZERO_ONE.map((o) => intOpt(o.value, o.name, o.label, o.description)),
    hint: 'UINT8，是否向地面站发 OBC 心跳（mavobc.c:514 按真值判断；注释原文 Send obc heartbeat signal to gcs）。非 0 都会被当成开启。',
  },
  'RC/RC_CHAN_CNT': {
    kind: 'number',
    min: 0,
    max: 16,
    hint: 'INT32，固件注释原文 "only used by ground station"（rc_param.c:88-89）；分组名取自 PARAM_GROUP_DEFINE(RC, ...)（rc_param.c:91），所以参数全名是 RC/RC_CHAN_CNT。上限 16 是 RC1~RC16 的通道数（hal/rc/rc.c:50 的通道掩码是 uint16_t），改这里不会改变飞控行为。',
  },
  'CONTROL/AIRFRAME': {
    kind: 'enum',
    dictKey: 'airframes',
    hint: '布局号在编译期选定（target/*/SConstruct:50 --airframe），运行期改这个参数不会重新映射电机输出；'
      + '控制律的合法集合见各 Controller_types.h 的变体检查：多旋翼/ADRC 只允许 1~8，VTOL 与艇载只允许 1~2。'
      + '固件里没有布局编号对应的名称表，界面只显示编号，不编名字。',
  },
  'INS/ekf2_decl_type': { kind: 'bits', options: EKF2_DECL_TYPE_BITS, hint: '位定义见 ins_interface.c:173-176（同 ecl/EKF/common.h:173-175）。默认 7 = 三位全开。' },
  'INS/ekf2_gps_check': { kind: 'bits', options: EKF2_GPS_CHECK_BITS, hint: '起飞前 GPS 质量检查的位掩码，定义见 ins_interface.c:47-55。默认 20 = 速度精度|水平精度|卫星数。' },
  'INS/ekf2_aid_mask': { kind: 'bits', options: EKF2_AID_MASK_BITS, hint: '融合源选择掩码，定义见 ins_interface.c:58-66。默认 1 = 只用 GPS。' },
  'INS/ekf2_terr_mask': { kind: 'bits', options: EKF2_TERR_MASK_BITS, hint: '地形估计用的源，定义见 ins_interface.c:74-75。默认 3 = 测距+光流。' },
  'INS/ekf2_mag_type': {
    kind: 'enum',
    options: [
      intOpt(0, 'MAG_FUSE_TYPE_AUTO', '自动选择', '自动在航向融合与三轴融合之间选择'),
      intOpt(1, 'MAG_FUSE_TYPE_HEADING', '始终只用航向', '精度较低但受地磁扰动影响小；俯仰超出 -60~+60° 不建议'),
      intOpt(2, 'MAG_FUSE_TYPE_3D', '始终三轴融合', '精度较高但受局部地磁扰动影响大'),
      intOpt(3, 'MAG_FUSE_TYPE_UNUSED', '未实现', '固件注释原文 Not implemented'),
      intOpt(4, 'MAG_FUSE_TYPE_INDOOR', '室内模式', '同 0，但除非用了 GPS/视觉外部辅助，否则不用磁力计或航向融合'),
      intOpt(5, 'MAG_FUSE_TYPE_NONE', '完全不用磁力计', '任何情况下都不融合磁力计，航向靠 ekf2_aid_mask 里的其他源'),
    ],
    hint: '六个取值与说明抄自 ins_interface.c:39-44 / ecl/EKF/common.h:194-199。',
  },
  'INS/ekf2_hgt_mode': {
    kind: 'enum',
    options: [
      intOpt(0, 'VDIST_SENSOR_BARO', '气压计高度', 'Use baro height'),
      intOpt(1, 'VDIST_SENSOR_GPS', 'GPS 高度', 'Use GPS height'),
      intOpt(2, 'VDIST_SENSOR_RANGE', '测距仪高度', 'Use range finder height'),
      intOpt(3, 'VDIST_SENSOR_EV', '外部视觉高度', 'Use external vision'),
    ],
    hint: '四个取值抄自 ins_interface.c:68-72 / ecl/EKF/common.h:166-170（主高度源选择）。',
  },
  'INS/ekf2_ev_noise_md': {
    kind: 'enum',
    options: [
      intOpt(0, 'MATRIX_X_VARIANCE', '矩阵第 0 位（X 方差）', '取里程计协方差矩阵 index 0'),
      intOpt(6, 'MATRIX_Y_VARIANCE', '矩阵第 6 位（Y 方差）', '取里程计协方差矩阵 index 6'),
      intOpt(11, 'MATRIX_Z_VARIANCE', '矩阵第 11 位（Z 方差）', '取里程计协方差矩阵 index 11'),
      intOpt(15, 'MATRIX_ROLL_VARIANCE', '矩阵第 15 位（横滚方差）', '取里程计协方差矩阵 index 15'),
      intOpt(18, 'MATRIX_PITCH_VARIANCE', '矩阵第 18 位（俯仰方差）', '取里程计协方差矩阵 index 18'),
      intOpt(20, 'MATRIX_YAW_VARIANCE', '矩阵第 20 位（航向方差）', '取里程计协方差矩阵 index 20'),
    ],
    hint: '视觉观测噪声取自里程计协方差矩阵的哪一格，数值见 ins_interface.c:78-83（X/VX 同为 0、Y/VY 同为 6……所以只列 6 个不同数字）。',
  },
  'INS/ekf2_rng_aid': { kind: 'enum', options: SWITCH_ZERO_ONE, hint: 'INT32，是否允许主高度源不是测距仪时也用测距（ins_interface.c:154）。' },
  'INS/ekf2_fuse_beta': {
    kind: 'enum',
    options: [
      intOpt(0, '0', '关闭', '固件注释原文 0 disables'),
      intOpt(1, '1', '开启', '固件注释原文 1 enables'),
    ],
    hint: '合成侧滑角融合。ins_interface.c:168 注释「0 disables, 1 enables」；INS.c:87 实际只在固定翼且值 ==1 时打开。',
  },
  'INS/ekf2_synthetic_mag_z': { kind: 'enum', options: SWITCH_ZERO_ONE, hint: 'INT32，是否用三轴磁场推算合成的 Z 轴分量（ins_interface.c:175 注释）。' },
}

/* RC1~RC16 的 REV / MAX / MIN / TRIM（rc_param.c 全是 PARAM_FLOAT，REV 只能是 ±1） */
const RC_REV_RE = /^RC\d+_REV$/

/**
 * 取一个参数的界面元数据。
 * @param {string} group  参数组名（param.xml 的 group name，如 CONTROL / INS）
 * @param {string} name   参数名
 * @param {unknown} currentValue 飞控/样例里读到的原值
 * @param {{vehicle?:string, target?:string}} [ctx] 机型上下文，用于 AIRFRAME 这类按机型变集合的参数
 * @returns {null|{kind:'enum', options:array, valueType:string, hint:string}|
 *            {kind:'bits', options:array, valueType:string, hint:string}|
 *            {kind:'number', min?:number, max?:number, hint:string}}
 */
export function paramMeta(group, name, currentValue, ctx = {}) {
  if (group === 'RC' && RC_REV_RE.test(name)) {
    return {
      kind: 'enum',
      valueType: 'float',
      options: optionsWithCurrent(RC_DIRECTION_OPTIONS, Number(currentValue), '未知方向'),
      hint: '通道方向只允许 1（正向）或 -1（反向）',
    }
  }

  const entry = PARAM_TABLE[`${group}/${name}`]
  if (!entry) return null

  if (entry.kind === 'enum') {
    let options = entry.options
    let hint = entry.hint
    if (entry.dictKey === 'airframes') {
      const { preset, presetKey } = resolveDictionary(ctx)
      // 固件没给集合的机型（固定翼/车载/模板）不下拉：交回数字输入，不编表
      if (!preset.airframes) return null
      options = preset.airframes
      // 文案跟着机型走：多旋翼是 1~8，VTOL/艇载是 1~2
      hint = `${preset.airframeHint || entry.hint}（当前机型 ${presetKey}）`
    }
    return {
      kind: 'enum',
      valueType: 'int',
      options: optionsWithCurrent(options, Number(currentValue), '未知值'),
      hint,
    }
  }

  if (entry.kind === 'bits') {
    return { kind: 'bits', valueType: 'int', options: entry.options, hint: entry.hint }
  }

  return { kind: 'number', valueType: 'int', min: entry.min, max: entry.max, hint: entry.hint }
}

/** 下拉项文案：中文名 + 固件里的原文/宏名，安全类选项再带上「飞控会拒绝」 */
export function paramOptionLabel(option) {
  if (!option) return ''
  if (option.unknown) return `${option.label}`
  return optionLabel(option)
}

/** 位掩码值 → 勾选的位（未登记的位保留在 extra 里，避免下拉把已有值吞掉） */
export function bitsToList(value, options) {
  const n = Number(value)
  if (!Number.isInteger(n)) return { list: [], extra: [] }
  const known = options.map((o) => o.bit)
  const list = known.filter((b) => (n & b) === b)
  const extra = []
  let rest = n & ~known.reduce((a, b) => a | b, 0)
  if (rest < 0) rest = 0 // 负数（比如 INT32 全 1）不做拆解，只提示
  for (let i = 0; rest; i++) {
    const b = 1 << i
    if (rest & b) {
      extra.push(b)
      rest &= ~b
    }
    if (i > 30) break
  }
  return { list, extra }
}

/** 勾选的位（+ 原值里没登记的位）→ 写回的整数 */
export function listToBits(list, options, extra = []) {
  const known = options.map((o) => o.bit)
  let v = 0
  for (const b of [].concat(list || [])) if (known.includes(b)) v |= b
  for (const b of extra) v |= b
  return v
}
