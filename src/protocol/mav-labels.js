// src/protocol/mav-labels.js
// ================================================================
// MAVLink 数值的中文文案：飞行模式、系统状态、定位质量、命令结果、传感器健康
// ----------------------------------------------------------------
// 枚举数值全部取自生成表（vendor/mavlink 生成），本文件只维护"数值 -> 中文"的映射，
// 不出现任何协议数值；新增枚举成员时中文缺失会退回英文短名，属于可接受的降级。
//
// 关于飞行模式：FMT 飞控与 PX4 一致，custom_mode 采用「主模式 << 16 | 子模式 << 24」编码，
// 判定依据是固件 src/task/comm/mavgcs.c 的 SET_MODE 分支与 px4_custom_mode.h。
// ================================================================
import { ENUMS } from './mavlink-table.generated.js'

const E = ENUMS

/** 去掉成员前缀：{ MAV_STATE_ACTIVE: 4 } -> { ACTIVE: 4 } */
function shortMap(enumName) {
  const src = E[enumName] || {}
  const prefix = `${enumName}_`
  const out = {}
  for (const k in src) {
    if (k.endsWith('_ENUM_END')) continue
    out[k.startsWith(prefix) ? k.slice(prefix.length) : k] = src[k]
  }
  return out
}

/** 数值 -> 短名（同值多个成员时取第一个，与 C 侧一致） */
function valueMap(enumName) {
  const sm = shortMap(enumName)
  const out = {}
  for (const k in sm) if (out[sm[k]] === undefined) out[sm[k]] = k
  return out
}

// 模式判定需要「数值 -> 短名」，所以用 valueMap；短名 -> 中文 的表在下方单独维护
const MAIN = valueMap('PX4_CUSTOM_MAIN_MODE')
const SUB_AUTO = valueMap('PX4_CUSTOM_SUB_MODE_AUTO')
const SUB_POSCTL = valueMap('PX4_CUSTOM_SUB_MODE_POSCTL')
const STATE = valueMap('MAV_STATE')
const SEVERITY = valueMap('MAV_SEVERITY')
const GPS_FIX = valueMap('GPS_FIX_TYPE')
const LANDED = valueMap('MAV_LANDED_STATE')
const VTOL = valueMap('MAV_VTOL_STATE')
const RESULT = valueMap('MAV_RESULT')
const CMD = valueMap('MAV_CMD')
const SENSOR_BIT = shortMap('MAV_SYS_STATUS_SENSOR')
const FMT_CMD = valueMap('MavCmd_ID')
const EXT_FLAG = valueMap('FMT_EXT_STATE_FLAG_TYPE')

/* ------------------------------ 飞行模式 ------------------------------ */

const MAIN_CN = {
  MANUAL: '手动',
  ALTCTL: '定高',
  POSCTL: '定点',
  AUTO: '自动',
  ACRO: '特技',
  OFFBOARD: '离线',
  STABILIZED: '自稳',
  RATTITUDE: '姿态切换',
  SIMPLE: '简单',
}

const SUB_AUTO_CN = {
  READY: '就绪',
  TAKEOFF: '起飞',
  LOITER: '悬停',
  MISSION: '任务',
  RTL: '返航',
  LAND: '降落',
  PRECLAND: '精准降落',
}

const SUB_POSCTL_CN = {
  SUPER_SIMPLE: '超级环绕',
  BACK: '后退',
}

/** 解锁位：VEHICLE_MODE_FLAG_SAFETY_ARMED（固件同款判定 base_mode & 128） */
export function isArmed(baseMode) {
  return !!(baseMode & (E.MAV_MODE_FLAG_SAFETY_ARMED ?? 128))
}

/** base_mode 里所有置位的标志，中文短语数组（用于诊断面板） */
export function describeBaseMode(baseMode) {
  const sm = shortMap('MAV_MODE_FLAG')
  const out = []
  for (const k in sm) {
    const bit = sm[k]
    if (bit && baseMode & bit) out.push(BASE_MODE_CN[k] || k)
  }
  return out
}

const BASE_MODE_CN = {
  CUSTOM_MODE_ENABLED: '自定义模式',
  TEST_ENABLED: '测试',
  AUTO_ENABLED: '自动',
  GUIDED_ENABLED: '引导',
  STABILIZE_ENABLED: '增稳',
  HIL_ENABLED: 'HIL',
  MANUAL_INPUT_ENABLED: '手动输入',
  SAFETY_ARMED: '已解锁',
}

/**
 * 解析 custom_mode（PX4/FMT 编码）。
 * @returns {{label:string, code:string, main:number, sub:number, custom:boolean, raw:number}}
 *   label 为中文（如「自动·返航」），code 为稳定标识（如 AUTO.RTL），供页面 class/判断使用
 */
export function describeMode(baseMode, customMode) {
  const custom = !!(baseMode & (E.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED ?? 1))
  const main = (customMode >>> 16) & 0xff
  const sub = (customMode >>> 24) & 0xff
  const mainName = MAIN[main]
  let subName = ''
  if (mainName === 'AUTO') subName = SUB_AUTO[sub] || (sub ? `子模式${sub}` : '')
  else if (mainName === 'POSCTL') subName = SUB_POSCTL[sub] || ''

  if (!custom || !mainName) {
    return { label: `未知模式(${customMode})`, code: `UNKNOWN_${customMode}`, main, sub, custom, raw: customMode }
  }
  const code = subName && SUB_AUTO[sub] ? `AUTO.${SUB_AUTO[sub]}` : mainName
  const label = subName ? `${MAIN_CN[mainName]}·${SUB_AUTO_CN[subName] || SUB_POSCTL_CN[subName] || subName}` : MAIN_CN[mainName]
  return { label, code, main, sub, custom, raw: customMode }
}

/* ------------------------------ 状态与告警 ------------------------------ */

const STATE_CN = {
  UNINIT: '未初始化', BOOT: '启动中', CALIBRATING: '校准中', STANDBY: '待机',
  ACTIVE: '运行中', CRITICAL: '危险', EMERGENCY: '紧急', POWEROFF: '关机',
}

export function systemState(v) {
  const key = STATE[v] || `STATE_${v}`
  return { key, label: STATE_CN[key] || key }
}

/** 告警等级 -> 中文 + Element Plus tag 类型（颜色按"越靠前越严重"分级） */
export function severity(v) {
  const key = SEVERITY[v] || `SEVERITY_${v}`
  const label = SEVERITY_CN[key] || key
  let type = 'info'
  if (v <= 3) type = 'danger'
  else if (v <= 5) type = 'warning'
  return { key, label, type }
}

const SEVERITY_CN = {
  EMERGENCY: '紧急', ALERT: '警告', CRITICAL: '严重', ERROR: '错误',
  WARNING: '注意', NOTICE: '通知', INFO: '信息', DEBUG: '调试',
}

/* ------------------------------ 定位质量 ------------------------------ */

const FIX_CN = {
  NO_GPS: '无 GPS', NO_FIX: '未定位', '2D_FIX': '2D 定位', '3D_FIX': '3D 定位', DGPS: '差分定位',
  RTK_FLOAT: 'RTK 浮点解', RTK_FIXED: 'RTK 固定解', STATIC: 'RTK 静态', PPP: 'PPP',
}

export function gpsFix(v) {
  const key = GPS_FIX[v] || `FIX_${v}`
  // 3D 及以上才算可用于导航，与固件里对 fix_type 的门限一致
  return { key, label: FIX_CN[key] || key, usable: v >= (E.GPS_FIX_TYPE?.GPS_FIX_TYPE_3D_FIX ?? 3) }
}

const LANDED_CN = { UNDEFINED: '未知', ON_GROUND: '已着陆', IN_AIR: '空中', TAKEOFF: '起飞中', LANDING: '降落中' }

export function landedState(v) {
  const key = LANDED[v] || `LANDED_${v}`
  return { key, label: LANDED_CN[key] || key }
}

export function vtolState(v) {
  const key = VTOL[v] || `VTOL_${v}`
  return { key, label: key.toLowerCase() }
}

/* ------------------------------ 命令与结果 ------------------------------ */

const RESULT_CN = {
  ACCEPTED: '已接受', TEMPORARILY_REJECTED: '暂时拒绝', DENIED: '拒绝',
  UNSUPPORTED: '不支持', FAILED: '失败', IN_PROGRESS: '执行中', CANCELLED: '已取消',
}

/** 注意：这套 MAVLink 库里 1=TEMPORARILY_REJECTED、2=DENIED，与新版相反，只能取自枚举 */
export function commandResult(v) {
  const key = RESULT[v] || `RESULT_${v}`
  const label = RESULT_CN[key] || key
  let type = 'success'
  if (v === 5) type = 'info'
  else if (v !== 0) type = 'danger'
  return { key, label, type }
}

const CMD_CN = {
  NAV_WAYPOINT: '航点', NAV_TAKEOFF: '起飞', NAV_LAND: '降落', NAV_RETURN_TO_LAUNCH: '返航',
  NAV_LOITER_UNLIM: '悬停', NAV_LOITER_TURNS: '环绕悬停', NAV_LOITER_TIME: '定时悬停',
  NAV_ROI: '兴趣点', NAV_SET_POSITION: '设置位置',
  COMPONENT_ARM_DISARM: '解锁/上锁', MAV_CMD_PREFLIGHT_CALIBRATION: '校准',
  PREFLIGHT_REBOOT_SHUTDOWN: '重启/关机', REQUEST_DATA_STREAM: '请求数据流',
  SET_HOME_POSITION: '设置_home_点', DO_SET_MODE: '切换模式',
  USER_1: '飞控自定义命令',
}

export function commandName(cmd) {
  return CMD[cmd] || `CMD_${cmd}`
}

export function commandLabel(cmd) {
  const key = CMD[cmd]
  if (!key) return `未知命令(${cmd})`
  const short = key.replace(/^MAV_CMD_/, '')
  return `${CMD_CN[short] || key}（${cmd}）`
}

/** 飞控内部命令号（mavproxy_cmd.h）：校准等走 MAV_CMD_USER_1 承载 */
export function fmtCommandLabel(id) {
  const key = FMT_CMD[id]
  if (!key) return `FMT_CMD_${id}`
  const cn = {
    CALIBRATION_GYR: '陀螺仪校准', CALIBRATION_ACC: '加速度计校准',
    CALIBRATION_MAG: '地磁校准', CALIBRATION_LEVEL: '水平校准',
    STREAM_SESSION: '数据流会话', ITEM_NUM: '命令总数',
  }[key.replace(/^MAVCMD_/, '')]
  return cn ? `${cn}（${id}）` : `${key}（${id}）`
}

/* ------------------------------ 传感器健康 ------------------------------ */

// 成员名取自本库版本的 MAV_SYS_STATUS_SENSOR 枚举（老命名：3D_GYRO / ABSOLUTE_PRESSURE …），
// 未覆盖的成员自动退回英文短名，因此新增枚举不会造成显示错误，只是少一层中文。
const SENSOR_CN = {
  '3D_GYRO': '陀螺仪1', '3D_ACCEL': '加速度计1', '3D_MAG': '地磁1',
  '3D_GYRO2': '陀螺仪2', '3D_ACCEL2': '加速度计2', '3D_MAG2': '地磁2',
  ABSOLUTE_PRESSURE: '气压计', DIFFERENTIAL_PRESSURE: '差压空速',
  GPS: 'GPS', OPTICAL_FLOW: '光流', VISION_POSITION: '视觉定位',
  LASER_POSITION: '激光测距', EXTERNAL_GROUND_TRUTH: '外部定位(动捕)',
  ANGULAR_RATE_CONTROL: '角速率控制', ATTITUDE_STABILIZATION: '姿态稳定',
  YAW_POSITION: '航向控制', Z_ALTITUDE_CONTROL: '高度控制',
  XY_POSITION_CONTROL: '水平位置控制', MOTOR_OUTPUTS: '电机输出',
  RC_RECEIVER: '遥控接收机', BATTERY: '电池', PROXIMITY: '近距感知',
  SATCOM: '卫星通信', PREARM_CHECK: '起飞前检查', OBSTACLE_AVOIDANCE: '避障',
  MAV_SYS_STATUS_GEOFENCE: '围栏', MAV_SYS_STATUS_AHRS: 'AHRS',
  MAV_SYS_STATUS_TERRAIN: '地形', MAV_SYS_STATUS_REVERSE_MOTOR: '电机反向',
  MAV_SYS_STATUS_LOGGING: '日志',
}

/** SYS_STATUS 的某个传感器字段（present/enabled/health）按位展开成中文条目 */
export function sensorBits(value) {
  const out = []
  for (const k in SENSOR_BIT) {
    const bit = SENSOR_BIT[k]
    if (bit && (value & bit)) out.push({ key: k, label: SENSOR_CN[k] || k, bit })
  }
  return out
}

export function sensorLabel(shortKey) {
  return SENSOR_CN[shortKey] || shortKey
}

/* ------------------------------ FMT 扩展状态 ------------------------------ */

/** FMT_EXTERNAL_STATE.flag 展开（外部视觉/动捕状态页使用） */
export function extStateFlags(flag) {
  const names = {
    ATT_VALID: '姿态', HEADING_VALID: '航向', VEL_VALID: '速度',
    LLA_VALID: '经纬度', POS_VALID: '位置', HGT_VALID: '高度', H_AGL_VALID: '对地高度',
  }
  const out = []
  for (const k in EXT_FLAG) {
    const bit = EXT_FLAG[k]
    if (bit && (flag & bit)) out.push(names[k.replace(/^FMT_EXT_STATE_FLAG_/, '')] || k)
  }
  return out
}
