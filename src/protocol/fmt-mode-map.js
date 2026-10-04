/**
 * fmt-mode-map.js —— FMT 内部模式号（sysconfig pilot-cmd 的 mode，0~7）
 * 与 MAVLink HEARTBEAT/SET_MODE 的 custom_mode 之间的双向换算。
 *
 * 全部照抄固件原文，不做任何推断：
 *   正向（飞控→地面站）：src/task/comm/task_comm.c  get_custom_mode()（未解锁分支按 fms_out.mode，
 *                       解锁后分支按 fms_out.state，两者都要实现，否则回读会误判）
 *   反向（地面站→飞控）：src/task/comm/mavgcs.c     MAVLINK_MSG_ID_SET_MODE 分支
 *   数值：            src/module/mavproxy/px4_custom_mode.h
 *
 * 为什么要单独一个文件：改造方案里「保存后回读验证」必须知道模式号↔custom_mode 的对应，
 * 这条对应以前是缺的（文档里写「需固件确认」），现在有出处了。
 */

/** PX4_CUSTOM_MAIN_MODE（px4_custom_mode.h） */
export const MAIN_MODE = {
  MANUAL: 1,
  ALTCTL: 2,
  POSCTL: 3,
  AUTO: 4,
  ACRO: 5,
  OFFBOARD: 6,
  STABILIZED: 7,
  RATTITUDE: 8,
  SIMPLE: 9,
}

/** PX4_CUSTOM_SUB_MODE_AUTO（px4_custom_mode.h） */
export const SUB_MODE_AUTO = {
  READY: 1,
  TAKEOFF: 2,
  LOITER: 3,
  MISSION: 4,
  RTL: 5,
  LAND: 6,
  RESERVED: 7,
  FOLLOW_TARGET: 8,
  PRECLAND: 9,
}

/** VEHICLE_MODE_FLAG_*（px4_custom_mode.h；SET_MODE 的 base_mode 用它） */
export const MODE_FLAG = {
  CUSTOM_MODE_ENABLED: 1,
  SAFETY_ARMED: 128,
}

/** PilotMode 号（FMS_types.h），这里只用常量做索引，值本身来自 fmt-enums */
export const PILOT_MODE = {
  None: 0,
  Manual: 1,
  Acro: 2,
  Stabilize: 3,
  Altitude: 4,
  Position: 5,
  Mission: 6,
  Offboard: 7,
}

/** VehicleState（mc_fms/lib/FMS_types.h:412 起，顺序编号）——解锁后 HEARTBEAT 按它给 custom_mode */
export const VEHICLE_STATE = {
  None: 0,
  Disarm: 1,
  Standby: 2,
  Offboard: 3,
  Mission: 4,
  InvalidAutoMode: 5,
  Hold: 6,
  Acro: 7,
  Stabilize: 8,
  Altitude: 9,
  Position: 10,
  InvalidAssistMode: 11,
  Manual: 12,
  InValidManualMode: 13,
  InvalidArmMode: 14,
  Land: 15,
  Return: 16,
  Takeoff: 17,
}

const autoMode = (main, sub = 0) => ((main << 16) + (sub << 24)) >>> 0

/**
 * 未解锁分支：PilotMode → custom_mode（task_comm.c L108~L133）。
 * None(0) 落到 default → 0，界面据此显示 custom_mode=0（样例里没有这条档位，属正常）。
 */
export const PILOT_MODE_TO_CUSTOM_MODE = {
  [PILOT_MODE.None]: 0,
  [PILOT_MODE.Manual]: autoMode(MAIN_MODE.MANUAL),
  [PILOT_MODE.Acro]: autoMode(MAIN_MODE.ACRO),
  [PILOT_MODE.Stabilize]: autoMode(MAIN_MODE.STABILIZED),
  [PILOT_MODE.Altitude]: autoMode(MAIN_MODE.ALTCTL),
  [PILOT_MODE.Position]: autoMode(MAIN_MODE.POSCTL),
  [PILOT_MODE.Mission]: autoMode(MAIN_MODE.AUTO, SUB_MODE_AUTO.MISSION),
  [PILOT_MODE.Offboard]: autoMode(MAIN_MODE.OFFBOARD),
}

/** 解锁后分支：VehicleState → custom_mode（task_comm.c L69~L106） */
export const VEHICLE_STATE_TO_CUSTOM_MODE = {
  [VEHICLE_STATE.Manual]: autoMode(MAIN_MODE.MANUAL),
  [VEHICLE_STATE.Altitude]: autoMode(MAIN_MODE.ALTCTL),
  [VEHICLE_STATE.Position]: autoMode(MAIN_MODE.POSCTL),
  [VEHICLE_STATE.Takeoff]: autoMode(MAIN_MODE.AUTO, SUB_MODE_AUTO.TAKEOFF),
  [VEHICLE_STATE.Hold]: autoMode(MAIN_MODE.AUTO, SUB_MODE_AUTO.LOITER),
  [VEHICLE_STATE.Mission]: autoMode(MAIN_MODE.AUTO, SUB_MODE_AUTO.MISSION),
  [VEHICLE_STATE.Return]: autoMode(MAIN_MODE.AUTO, SUB_MODE_AUTO.RTL),
  [VEHICLE_STATE.Land]: autoMode(MAIN_MODE.AUTO, SUB_MODE_AUTO.LAND),
  [VEHICLE_STATE.Acro]: autoMode(MAIN_MODE.ACRO),
  [VEHICLE_STATE.Offboard]: autoMode(MAIN_MODE.OFFBOARD),
  [VEHICLE_STATE.Stabilize]: autoMode(MAIN_MODE.STABILIZED),
}

/**
 * 组 SET_MODE 报文（mavgcs.c L176 要求 base_mode 带 CUSTOM_MODE_ENABLED，否则整条忽略）。
 * @param {number} pilotMode sysconfig pilot-cmd 里的 mode 号（0~7）
 * @returns {{base_mode:number, custom_mode:number}|null} 模式号不认识时返回 null，调用方不许瞎猜
 */
export function setModeRequest(pilotMode) {
  const custom = PILOT_MODE_TO_CUSTOM_MODE[Number(pilotMode)]
  if (custom === undefined) return null
  return { base_mode: MODE_FLAG.CUSTOM_MODE_ENABLED, custom_mode: custom }
}

/**
 * 反向解码：custom_mode → 飞控会做的那件事（mavgcs.c L177~L212 逐分支照抄）。
 * 注意 AUTO 的子模式在固件里是「指令」不是「模式」：RTL/Takeoff/Land/Loiter 走 gcs_set_cmd，
 * 只有 AUTO+MISSION 走 gcs_set_mode。回读核对时要把这个区别说清楚。
 * @returns {{kind:'mode'|'cmd'|'unknown', pilotMode?:number, cmd?:number, main:number, sub:number, reason:string}}
 */
export function decodeSetModeTarget(customMode) {
  const main = (customMode >>> 16) & 0xff
  const sub = (customMode >>> 24) & 0xff
  if (main === MAIN_MODE.AUTO) {
    if (sub === SUB_MODE_AUTO.MISSION) return { kind: 'mode', pilotMode: PILOT_MODE.Mission, main, sub, reason: 'AUTO+MISSION → set_mode(Mission)' }
    if (sub === SUB_MODE_AUTO.RTL) return { kind: 'cmd', cmd: 1005, main, sub, reason: 'AUTO+RTL → cmd Return(1005)' }
    if (sub === SUB_MODE_AUTO.TAKEOFF) return { kind: 'cmd', cmd: 1003, main, sub, reason: 'AUTO+Takeoff → cmd Takeoff(1003)' }
    if (sub === SUB_MODE_AUTO.LAND) return { kind: 'cmd', cmd: 1004, main, sub, reason: 'AUTO+Land → cmd Land(1004)' }
    if (sub === SUB_MODE_AUTO.LOITER) return { kind: 'cmd', cmd: 1006, main, sub, reason: 'AUTO+Loiter → cmd Pause(1006)' }
    return { kind: 'unknown', main, sub, reason: `AUTO 子模式 ${sub} 固件回 "Unsupported auto mode"` }
  }
  const map = {
    [MAIN_MODE.MANUAL]: PILOT_MODE.Manual,
    [MAIN_MODE.ALTCTL]: PILOT_MODE.Altitude,
    [MAIN_MODE.POSCTL]: PILOT_MODE.Position,
    [MAIN_MODE.ACRO]: PILOT_MODE.Acro,
    [MAIN_MODE.OFFBOARD]: PILOT_MODE.Offboard,
    [MAIN_MODE.STABILIZED]: PILOT_MODE.Stabilize,
  }
  if (map[main] !== undefined) return { kind: 'mode', pilotMode: map[main], main, sub, reason: `主模式 ${main} → set_mode` }
  return { kind: 'unknown', main, sub, reason: `主模式 ${main} 固件未接，SET_MODE 会被丢弃` }
}

/**
 * 回读核对：把「配置里写的模式号」与「飞控现在发的 custom_mode」对齐。
 * 解锁与否决定 custom_mode 的来源（模式 or 状态），这里如实分三种结论，不硬判。
 * @returns {{result:'match'|'differ'|'unknown-armed'|'unknown-mode', text:string, detail:string}}
 */
export function verifyModeReadback(pilotMode, customMode, armed) {
  const expect = PILOT_MODE_TO_CUSTOM_MODE[Number(pilotMode)]
  if (expect === undefined) {
    return { result: 'unknown-mode', text: '无法核对', detail: `模式号 ${pilotMode} 不在 PilotMode(0~7) 里，固件会拒绝` }
  }
  if (armed) {
    return {
      result: 'unknown-armed',
      text: '不能按模式号判定',
      detail: `已解锁时 HEARTBEAT 的 custom_mode 按飞行状态（VehicleState）给出，不等于档位里的模式号；当前 custom_mode=${customMode}`,
    }
  }
  if (Number(customMode) === expect) {
    return { result: 'match', text: '一致', detail: `custom_mode ${customMode} 与模式号 ${pilotMode} 的期望值相同` }
  }
  const decoded = decodeSetModeTarget(Number(customMode))
  return {
    result: 'differ',
    text: '不一致',
    detail: `期望 custom_mode=${expect}，实际 ${customMode}（飞控该值对应 ${decoded.reason}）`,
  }
}
