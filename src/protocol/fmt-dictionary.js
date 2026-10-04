/**
 * fmt-dictionary.js —— 「同一份枚举，按机型/板卡分键」的字典层（改造方案第 5 项）
 *
 * 为什么要有这一层：sysconfig.toml 与 param.xml 里的整数含义随编译期选项变化，
 * 地面站不该把「多旋翼的取值集合」当成全世界。这里的分键依据全部来自本机固件源码：
 *
 *   1) 模式号与指令号：**所有机型共用同一张表**。六个 FMS 变体
 *      （mc/fw/vtol/car/boat/template 的 lib/FMS_types.h）里 PilotMode 都到 Offboard=7、
 *      FMS_Cmd 都含 SetHome=2000，逐字一致，所以这里直接复用同一份数组，不做机型差异。
 *   2) 布局号 AIRFRAME：取值集合按控制律不同（各 Controller_types.h 的编译期变体检查）：
 *      mc/adrc 允许 1~8；vtol/boat 只允许 1~2；fw/car/template 未见该检查 → 不下拉，只留整数输入。
 *   3) 机型名取自构建选项 --vehicle 的字符串（target/<vendor>/config/model.py 里的分支）：
 *      Multicopter / Fixwing（固件原文拼写，少一个 d）/ VTOL / Boat / Car / Template。
 *   4) 板卡名取自各 target/<vendor>/config/sysconfig.toml 第 4 行的 target 字符串，
 *      地面站能直接读到（它就是被编辑的那个文件），这是目前唯一可靠的识别途径。
 *
 * ⚠ HEARTBEAT 不能用来分键：task_comm.c 里 type/autopilot 是硬编码的
 *   heartbeat.type = MAV_TYPE_QUADROTOR(2)、heartbeat.autopilot = MAV_AUTOPILOT_PX4(3)，
 *   即使编译成 Fixwing 也照样发 QUADROTOR，而且与真正的 PX4 无法区分。
 *   所以这里把 HEARTBEAT 只当作「对不上就提示」的辅助证据，不参与选表。
 */
import {
  FMT_MODE_OPTIONS,
  FMT_COMMAND_OPTIONS,
  AIRFRAME_LAYOUT_OPTIONS,
  AIRFRAME_VTOL_BOAT_OPTIONS,
} from './fmt-enums.js'

/** 本文件抄表的来源与时间，出问题时能追溯到是哪个版本的规定 */
export const DICTIONARY_SOURCE = {
  firmware: 'G:\\fmt\\fmt-mcu\\FMT-Firmware（本机源码，非发布包）',
  enums: [
    'src/model/fms/{mc,fw,vtol,car,boat,template}_fms/lib/FMS_types.h',
    'src/module/sysio/gcs_cmd.c（gcs_set_mode / gcs_set_cmd 实际接受的分支）',
    'src/task/comm/task_comm.c get_custom_mode()、src/task/comm/mavgcs.c SET_MODE 分支',
    'src/module/mavproxy/px4_custom_mode.h',
  ],
  airframe: [
    'src/model/control/{mc,adrc}_controller/lib/Controller_types.h（1~8）',
    'src/model/control/{vtol,boat}_controller/lib/Controller_types.h（1~2）',
  ],
  boards: 'target/*/config/sysconfig.toml:4（target 字符串）+ target/*/config/model.py（--vehicle 分支）',
}

/** 机型（--vehicle 取值）到取值集合。airframes 为 null 表示固件没给出集合，界面不猜 */
export const VEHICLE_PRESETS = {
  Multicopter: {
    label: '多旋翼',
    modes: FMT_MODE_OPTIONS,
    commands: FMT_COMMAND_OPTIONS,
    airframes: AIRFRAME_LAYOUT_OPTIONS,
    airframeHint: '多旋翼控制律只允许 1~8（mc_controller/lib/Controller_types.h 的编译期检查）；具体是哪种桨架布局固件里没有名称表，界面只显示编号。布局在编译期选定，运行期改这个参数一般不会重新映射电机输出。',
  },
  Fixwing: {
    label: '固定翼（固件拼写 Fixwing）',
    modes: FMT_MODE_OPTIONS,
    commands: FMT_COMMAND_OPTIONS,
    airframes: null,
    airframeHint: '固定翼控制律源码里没看到编译期 AIRFRAME 取值集合，界面保持整数输入，不替飞控编一份表。',
  },
  VTOL: {
    label: '垂直起降',
    modes: FMT_MODE_OPTIONS,
    commands: FMT_COMMAND_OPTIONS,
    airframes: AIRFRAME_VTOL_BOAT_OPTIONS,
    airframeHint: 'VTOL 控制律只允许 1~2（vtol_controller/lib/Controller_types.h）。',
  },
  Boat: {
    label: '艇载',
    modes: FMT_MODE_OPTIONS,
    commands: FMT_COMMAND_OPTIONS,
    airframes: AIRFRAME_VTOL_BOAT_OPTIONS,
    airframeHint: '艇载控制律只允许 1~2（boat_controller/lib/Controller_types.h）。',
  },
  Car: {
    label: '车载',
    modes: FMT_MODE_OPTIONS,
    commands: FMT_COMMAND_OPTIONS,
    airframes: null,
    airframeHint: '车载控制律源码里未见编译期 AIRFRAME 取值集合，保持整数输入。',
  },
  Template: {
    label: '模板',
    modes: FMT_MODE_OPTIONS,
    commands: FMT_COMMAND_OPTIONS,
    airframes: null,
    airframeHint: '模板机型没有控制律取值表，保持整数输入。',
  },
}

export const DEFAULT_VEHICLE = 'Multicopter'

/**
 * 已知板卡：vehicles 是 target/<厂商>/<板>/config/model.py 里真出现的分支。
 * verified=false 表示这一份只核对到部分分支，界面据此说明「按部分核对结果显示」，
 * 而不是假装完整。
 */
export const KNOWN_BOARDS = [
  { target: 'SIEON S1', dir: 'target/sieon/s1', vehicles: ['Multicopter', 'Fixwing', 'VTOL', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'CUAV X7+', dir: 'target/cuav/x7_plus', vehicles: ['Multicopter', 'Fixwing', 'VTOL', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'CUAV V5+', dir: 'target/cuav/v5_plus', vehicles: ['Multicopter', 'Fixwing', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'CUAV V5-Nano', dir: 'target/cuav/v5_nano', vehicles: ['Multicopter', 'Fixwing', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'CUAV 7-Nano', dir: 'target/cuav/7_nano', vehicles: ['Multicopter', 'Fixwing', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'Pixhawk FMUv2', dir: 'target/pixhawk/fmu-v2', vehicles: ['Multicopter', 'Fixwing', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'Pixhawk4 FMUv5', dir: 'target/pixhawk/fmu-v5', vehicles: ['Multicopter', 'Fixwing', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'Pixhawk 6C', dir: 'target/pixhawk/fmu-v6c', vehicles: ['Multicopter', 'Fixwing', 'VTOL'], verified: false },
  { target: 'Amov-ICF5', dir: 'target/amov/icf5', vehicles: ['Multicopter', 'Fixwing', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'YunDrone X1', dir: 'target/yundrone/x1', vehicles: ['Multicopter', 'Fixwing', 'VTOL', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'Edge-E83', dir: 'target/infineon/edge-e83/{m33,m55}', vehicles: ['Multicopter', 'Fixwing', 'VTOL', 'Boat', 'Car', 'Template'], verified: true },
  { target: 'CUAV V5+ (minimum)', dir: 'target/minimum/cuav/v5_plus', vehicles: ['Multicopter', 'Fixwing', 'Template'], verified: true },
]

/** 规一化 target 字符串：大小写、空格、括号差异都不该让查表落空 */
function normalizeTarget(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * 选表。优先级：显式 vehicle > sysconfig 的 target 推出的机型 > 默认多旋翼。
 * @param {{target?:string, vehicle?:string, heartbeat?:{type?:number, autopilot?:number}}} [ctx]
 * @returns {{preset:object, presetKey:string, board:object|null, source:string, warning:string}}
 */
export function resolveDictionary(ctx = {}) {
  let presetKey = DEFAULT_VEHICLE
  let source = `默认机型 ${DEFAULT_VEHICLE}（sysconfig 里没读到 target，也没指定 --vehicle）`
  let warning = ''

  const vehicle = typeof ctx.vehicle === 'string' ? ctx.vehicle.trim() : ''
  const board = KNOWN_BOARDS.find((b) => normalizeTarget(b.target) === normalizeTarget(ctx.target))

  if (vehicle && VEHICLE_PRESETS[vehicle]) {
    presetKey = vehicle
    source = `构建选项 --vehicle = ${vehicle}`
  } else if (vehicle) {
    warning = `机型字符串「${vehicle}」不在固件 --vehicle 的分支里（Multicopter/Fixwing/VTOL/Boat/Car/Template），按 ${DEFAULT_VEHICLE} 的取值集合显示，原值保留不替换。`
  } else if (board) {
    presetKey = board.vehicles.includes(DEFAULT_VEHICLE) ? DEFAULT_VEHICLE : board.vehicles[0]
    source = `sysconfig target = "${board.target}" → 该板支持 ${board.vehicles.join(' / ')}，未指定编译机型，默认按 ${presetKey}`
    if (!board.verified) warning = `板卡「${board.target}」的 model.py 只核对到 ${board.vehicles.join('/')} 分支，其余分支未确认。`
  } else if (ctx.target) {
    warning = `sysconfig target = "${ctx.target}" 不在已知板卡清单里，按 ${DEFAULT_VEHICLE} 的取值集合显示，原值保留不替换。`
    source = '未知板卡 → 默认多旋翼'
  }

  if (!warning) {
    const hb = ctx.heartbeat || {}
    // task_comm.c 硬编码 type=2(QUADROTOR)、autopilot=3(PX4)：对不上就说明连的不是这套固件
    if (hb.autopilot !== undefined && hb.autopilot !== 3) {
      warning = `HEARTBEAT autopilot=${hb.autopilot}，FMT 固件固定发 3（MAV_AUTOPILOT_PX4），这台设备可能不是 FMT，枚举表按 ${presetKey} 显示仅供参考。`
    }
  }

  return { preset: VEHICLE_PRESETS[presetKey], presetKey, board: board || null, source, warning }
}
