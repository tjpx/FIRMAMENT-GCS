/**
 * FMT 已确认枚举表。value 是写回飞控的原始值，label 只用于界面显示。
 *
 * 出处（本机固件源码，逐项核对过，不是猜的）：
 *   G:\fmt\FMT-Firmware\src\model\fms\{mc,fw,vtol,car,boat,template}_fms\lib\FMS_types.h
 *     - PilotMode：None=0, Manual=1, Acro=2, Stabilize=3, Altitude=4, Position=5, Mission=6, Offboard=7
 *     - FMS_Cmd：None=0, PreArm=1000, Arm..Continue=1001..1007, SetHome=2000
 *   G:\fmt\FMT-Firmware\src\module\sysio\gcs_cmd.c
 *     - gcs_set_mode() 的 switch 只接 Manual..Offboard（1~7），其余走 default 打印
 *       "set Unknown mode %d" 并返回 FMT_EINVAL —— 所以 mode=0 写进配置不会生效
 *     - gcs_set_cmd() 只接 1000~1007 与 2000，其余 "recv Unknown command %d" FMT_ENOTHANDLE
 *       —— 所以 cmd=0（None）同样不是一条有效配置
 *   G:\fmt\FMT-Firmware\src\module\sysio\pilot_cmd.c:188
 *     - 摇杆档位没落进任何 range 时 pilot_cmd->mode = 0xFF（固件自己的「未知模式」哨兵）
 *
 * acceptedOnFc=false 表示「协议里有这个成员，但把它写进 pilot-cmd 配置飞控会拒绝」。
 * 界面仍然要原样显示这个值（不做自动替换），只是给一句有依据的提醒。
 */
export const FMT_MODE_OPTIONS = [
  { value: 0, name: 'None', label: '无动作', description: '飞控不执行任何动作', acceptedOnFc: false },
  { value: 1, name: 'Manual', label: '手动', description: '摇杆输入直接发送给执行器' },
  { value: 2, name: 'Acro', label: '特技', description: '摇杆输入转换为角速度控制' },
  { value: 3, name: 'Stabilize', label: '自稳', description: '保持横滚和俯仰姿态，高度由人工控制' },
  { value: 4, name: 'Altitude', label: '定高', description: '保持高度，油门控制垂直速度' },
  { value: 5, name: 'Position', label: '定点', description: '保持位置和高度' },
  { value: 6, name: 'Mission', label: '任务', description: '执行 /sys/mission.txt 中的任务' },
  { value: 7, name: 'Offboard', label: '外部控制', description: '接受 auto_cmd 主题的外部控制命令' },
]

export const PILOT_COMMAND_TYPE_OPTIONS = [
  { value: 1, name: 'event', label: '事件' },
  { value: 2, name: 'status', label: '状态' },
]

export const FMT_COMMAND_OPTIONS = [
  { value: 0, name: 'None', label: '无动作', description: '飞控不执行任何动作', acceptedOnFc: false },
  { value: 1000, name: 'PreArm', label: '预解锁检查', description: '进入待机状态前执行预解锁检查' },
  { value: 1001, name: 'Arm', label: '解锁', description: '进入解锁状态，跳过待机状态' },
  { value: 1002, name: 'Disarm', label: '上锁', description: '上锁飞行器' },
  { value: 1003, name: 'Takeoff', label: '起飞', description: '起飞至预定义高度' },
  { value: 1004, name: 'Land', label: '降落', description: '在当前位置降落' },
  { value: 1005, name: 'Return', label: '返航', description: '返回 Home 点后降落' },
  { value: 1006, name: 'Pause', label: '暂停任务', description: '暂停当前任务' },
  { value: 1007, name: 'Continue', label: '继续任务', description: '继续执行任务' },
  { value: 2000, name: 'SetHome', label: '设置 Home 点', description: '以 [x y z yaw] 四个参数设定 Home 点（gcs_cmd.c 会打印这四个值）' },
]

/**
 * 多旋翼/ADRC 控制律的布局号取值。
 * 依据 mc_controller（与 adrc_controller 同）lib/Controller_types.h:46 的编译期变体检查：
 * 只允许 1~8 中的一个，其余值编译不过。
 * 名称没有权威来源：FMT-Firmware/docs 与 model 目录都查不到「布局 1 = 四轴 X 型」这类表，
 * 所以这里只给编号，不给中文名——地面站不替飞控发明叫法。
 */
export const AIRFRAME_LAYOUT_OPTIONS = Array.from({ length: 8 }, (_, i) => ({
  value: i + 1,
  name: `AIRFRAME=${i + 1}`,
  label: `布局 ${i + 1}`,
}))

/** VTOL 与艇载控制律只允许 1~2（各自 Controller_types.h:46 的同类检查） */
export const AIRFRAME_VTOL_BOAT_OPTIONS = [1, 2].map((v) => ({
  value: v,
  name: `AIRFRAME=${v}`,
  label: `布局 ${v}`,
}))

export const RC_DIRECTION_OPTIONS = [
  { value: 1, name: 'Normal', label: '正向' },
  { value: -1, name: 'Reversed', label: '反向' },
]

/**
 * RC 通道号。上限 16 有两条固件依据：
 *   src/module/param/rc_param.c:24-88 只定义了 RC1~RC16 的 MAX/MIN/REV/TRIM；
 *   src/hal/rc/rc.c:39-57 用 uint16_t 通道掩码 `(1 << channel_num) - 1` 并以此为循环上界，
 *   所以通道号写 17/18 在飞控里没有对应的参数、也没有对应的位。
 * 老配置里真读到 17/18 时靠 optionsWithCurrent 原样显示，不自动改写。
 */
export const RC_CHANNEL_OPTIONS = Array.from({ length: 16 }, (_, index) => ({
  value: index + 1,
  label: `CH${index + 1}`,
}))

/**
 * 遥控器设备能接收的通道数（同上：rc.c 的掩码是 16 位宽），
 * pilot_cmd_config.c:479 的 channel-num 是任意整数，这里给的是协议上有效的范围。
 */
export const CHANNEL_COUNT_OPTIONS = Array.from({ length: 16 }, (_, index) => ({
  value: index + 1,
  label: `${index + 1} 路`,
}))

/**
 * 遥控机输入协议（pilot_cmd_config.c:467-475）：
 * 只比较 "auto" / "sbus" / "ppm" 三个字符串，其余打印 "unknown rc protocol:%s" 后忽略。
 */
export const RECEIVER_PROTOCOL_OPTIONS = [
  { value: 'auto', label: '自动识别' },
  { value: 'sbus', label: 'SBUS' },
  { value: 'ppm', label: 'PPM' },
]

/**
 * 下面这组「设备类型 / 协议」集合全部来自 config 解析器里真实比较过的字符串。
 * 出处（G:\fmt\FMT-Firmware\src\module\config，行号按本机这份源码）：
 *   console_config.c   :30 DEVICE_TYPE_IS 宏；:194 serial、:208 mavlink 两个分支，
 *                        其余 :221-223 打印 "unknown device type" 并返回 FMT_ERROR
 *                        —— 也就是说 console.devices 只认 serial 与 mavlink，写 usb/eth 整行报错
 *   mavproxy_config.c  :93 读 type，:94 serial、:113 usb、:123 eth，其余 :126 报错
 *   mavproxy_config.c  :172-173 rtcm_devices 的 type 只有 serial，:186-188 其余 FMT_ERROR；
 *                        :209 只有 baudrate 一个附加键，:175 注释 "0 means don't change baudrate"
 *   gnss_config.c      :68 读 type（必填，:91-93 缺了就整行 FMT_ERROR），:69 只有 serial 分支，
 *                        :80 baudrate 仅在 serial 下解析，:71 注释 "auto detect"
 *   sensor_gps.c       :108/:110 只比较 "ublox" / "nmea"，:113 "unknown gnss protocol" + FMT_EINVAL
 *   actuator_config.c  :87 读 protocol，:142 其余 "unknown device protocol"；
 *                        pwm 分支 :160 freq、:168 init-val；dshot 分支 :230 speed、:238 telem-req
 *   actuator_cmd.c     :198/:200/:202 mappings 的 from 只有 control_out / rc_channels /
 *                        mav_actuator_control 三个字符串有对应分支，其余 ACTUATOR_FROM_UNKNOWN
 *   pilot_cmd_config.c :427 type 必须是 "rc"，:443-444 其余 "Unknown device type" + FMT_EINVAL；
 *                        :467-472 protocol 只比较 auto / sbus / ppm，:474 其余只警告后忽略；
 *                        :479-484 channel-num 收任意整数后强转 uint16_t（hal/rc/rc.c:50 的掩码也是 16 位）
 * 解析器对未列出的字符串多数是「忽略这一项」，所以界面保留原值 + allowUnknown，不自动改写。
 */

/** console.devices 的 type：固件只有 serial 与 mavlink 两个分支（console_config.c:194/208） */
export const CONSOLE_DEVICE_TYPE_OPTIONS = [
  { value: 'serial', label: '串口' },
  { value: 'mavlink', label: 'MAVLink 端点' },
]

/** mavproxy.devices 的 type（mavproxy_config.c:94/113/123） */
export const MAVPROXY_DEVICE_TYPE_OPTIONS = [
  { value: 'serial', label: '串口' },
  { value: 'usb', label: 'USB' },
  { value: 'eth', label: '以太网' },
]

/** rtcm_devices 的 type：只有 serial 一个分支（mavproxy_config.c:172-189） */
export const RTCM_DEVICE_TYPE_OPTIONS = [
  { value: 'serial', label: '串口' },
]

/** gnss.devices 的 type：只有 serial 一个分支，而且这一项必填（gnss_config.c:68-94） */
export const GNSS_DEVICE_TYPE_OPTIONS = [
  { value: 'serial', label: '串口' },
]

/**
 * actuator.mappings 的 from（actuator_cmd.c:198-205）。
 * 样例里只用了 control_out，但固件确实还有另外两个来源，列全比只抄样例诚实。
 */
export const ACTUATOR_FROM_OPTIONS = [
  { value: 'control_out', label: '控制器输出', description: 'ACTUATOR_FROM_CONTROLLER：走控制律算出来的量' },
  { value: 'rc_channels', label: '遥控器通道直通', description: 'ACTUATOR_FROM_RC_CHANNEL：摇杆量直接打到输出' },
  { value: 'mav_actuator_control', label: 'MAVLink 执行器控制', description: 'ACTUATOR_FROM_MAVLINK：来自 ACTUATOR_CONTROL 消息' },
]

/**
 * gnss 的 protocol：sensor_gps.c:108/110 只比较 "ublox" 与 "nmea"，
 * 分别调 gps_ubx_init() / gps_nmea_init()，其余 :113 打印 "unknown gnss protocol" 并返回 FMT_EINVAL，
 * 整个 GNSS 都不初始化。
 */
export const GNSS_PROTOCOL_OPTIONS = [
  { value: 'ublox', label: 'ublox（UBX 协议）' },
  { value: 'nmea', label: 'nmea（NMEA 语句）' },
]

/** pilot-cmd 的 device type：固件只支持 "rc"（pilot_cmd_config.c:427，其余 :443-444 报 FMT_EINVAL） */
export const RC_DEVICE_TYPE_OPTIONS = [
  { value: 'rc', label: '遥控器（rc）' },
]

/** actuator.devices 的 protocol（actuator_config.c:87 读取，:142 其余报 unknown device protocol） */
export const ACTUATOR_PROTOCOL_OPTIONS = [
  { value: 'pwm', label: 'PWM', description: '配套参数 freq（刷新率）与 init-val' },
  { value: 'dshot', label: 'DShot', description: '配套参数 speed 与 telem-req' },
]

/**
 * DShot 速率候选。诚实说明：150/300/600 这组数字只出现在样例配置的注释里
 * （target/sieon/s1/config/sysconfig.toml:68 `speed = 600 # dshot speed: 150, 300, 600`），
 * 解析器 actuator_config.c:230 收的是任意整数，代码里没有 DSHOT_SPEED 常量。
 * 所以界面允许自由填写（allowUnknown），这三个只作为候选提示。
 */
export const DSHOT_SPEED_OPTIONS = [
  { value: 150, label: 'DSHOT150' },
  { value: 300, label: 'DSHOT300' },
  { value: 600, label: 'DSHOT600' },
]

export function optionLabel(option) {
  if (!option) return ''
  const raw = String(option.value)
  // 固件原文与数值本身相同时不再重复一遍（避免出现「关闭（0，0）」）
  const withName = option.name && option.name !== raw
  const base = withName ? `${option.label}（${option.name}，${option.value}）` : `${option.label}（${option.value}）`
  return option.acceptedOnFc === false ? `${base}｜写进配置飞控会拒绝` : base
}

export function optionsWithCurrent(options, currentValue, label = '未知值') {
  const list = Array.isArray(options) ? options.slice() : []
  if (currentValue === undefined || currentValue === null || list.some((item) => item.value === currentValue)) return list
  return [{ value: currentValue, label: `${label}（${currentValue}）`, unknown: true }, ...list]
}
