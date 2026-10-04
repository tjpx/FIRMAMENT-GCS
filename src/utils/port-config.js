/**
 * port-config.js —— 端口页（S2）的表结构与取值校验，纯逻辑
 *
 * 为什么单独拿出来：改的是飞控 `/sys/sysconfig.toml` 的设备表，写坏一行飞控就没通信口了。
 * 判据必须能被自测钉住，不能埋在 .vue 里靠肉眼。本模块不 import Vue、不碰串口。
 *
 * 三条硬规矩（对应开发方案 §1.2 第 3 条与附 D）：
 *   1. 字段与取值以 **固件解析器真实比较过的字符串** 为准
 *      （G:\fmt\FMT-Firmware\src\module\config\console_config.c / mavproxy_config.c /
 *      actuator_config.c / pilot_cmd_config.c / sensor\sensor_gps.c 里的 MATCH(key,"...") 与
 *      toml_string_in(...)），候选值集中在 ../protocol/fmt-enums.js；样例文件
 *      （sample/sysconfig.sieon-s1.toml）只用来看写法。固件里没有的选项不给用户选——
 *      地面站不替飞控发明能力；
 *   2. 校验只在有依据的地方设限（整数、端口 0~65535、固件注释/样例注释写明的 0 值白名单），
 *      其余只要求"是个数"；解析器接受任意整数、只有注释给了候选的项（如 dshot speed）
 *      标 allowUnknown，不替飞控硬卡范围；
 *   3. 本模块只回答"这个值能不能写、写成什么类型"，真正落笔一律走 fcconfig 的定点接口，
 *      这样每一次改动都会进 `changes()` 清单，右下角保存条才拦得住没有清单的回传（S1 闸门）。
 */

import { parseTomlValue } from './config-doc.js'
import {
  CONSOLE_DEVICE_TYPE_OPTIONS,
  MAVPROXY_DEVICE_TYPE_OPTIONS,
  RTCM_DEVICE_TYPE_OPTIONS,
  GNSS_DEVICE_TYPE_OPTIONS,
  GNSS_PROTOCOL_OPTIONS,
  ACTUATOR_PROTOCOL_OPTIONS,
  ACTUATOR_FROM_OPTIONS,
  DSHOT_SPEED_OPTIONS,
} from '../protocol/fmt-enums.js'

/** 编辑器种类 */
export const KIND = {
  ENUM: 'enum',
  NUMBER: 'number',
  TEXT: 'text',
  BOOL: 'bool',
  ARRAY: 'array',
}

/**
 * 各节 device type 的合法值分别来自各自解析器里真实比较过的字符串，**不是同一份表**
 * （行号出处见 ../protocol/fmt-enums.js 顶部的清单）：
 *   console   serial | mavlink —— 写 usb/eth 会让整行解析失败（console_config.c:194/208/221）
 *   mavproxy  serial | usb | eth（mavproxy_config.c:94/113/123）
 *   rtcm      只有 serial，其余 FMT_ERROR（mavproxy_config.c:173/186）
 *   gnss      只有 serial，而且 type 必填（gnss_config.c:69/91）
 * 候选表带中文标签，界面用 optionLabel() 显示，保存时仍写回原始字符串。
 */
const CONSOLE_TYPES = CONSOLE_DEVICE_TYPE_OPTIONS
const MAVPROXY_TYPES = MAVPROXY_DEVICE_TYPE_OPTIONS
const RTCM_TYPES = RTCM_DEVICE_TYPE_OPTIONS
const GNSS_TYPES = GNSS_DEVICE_TYPE_OPTIONS
const GNSS_PROTOCOLS = GNSS_PROTOCOL_OPTIONS
const ACTUATOR_PROTOCOLS = ACTUATOR_PROTOCOL_OPTIONS
const ACTUATOR_FROMS = ACTUATOR_FROM_OPTIONS
const DSHOT_SPEEDS = DSHOT_SPEED_OPTIONS

/** 点分十进制 IPv4。飞控支不支持 IPv6 无从证实，所以不给空泛的"任意地址"。 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isIpv4(s) {
  const m = IPV4_RE.exec(s)
  if (!m) return false
  return m.slice(1).every((seg) => Number(seg) <= 255)
}

/** 通道映射：`[[输入...],[输出...]]`，两个数组、元素都是整数。 */
function checkChanMap(value) {
  if (!Array.isArray(value)) return '要写成 [[输入通道...],[输出通道...]]，例如 [[1,2,3,4],[1,2,3,4]]'
  if (value.length !== 2) return `chan-map 必须是两个数组（输入一行、输出一行），这里写了 ${value.length} 个`
  for (const [i, list] of value.entries()) {
    if (!Array.isArray(list)) return `第 ${i + 1} 个不是数组，chan-map 要写成 [[输入...],[输出...]]`
    if (!list.length) return `第 ${i + 1} 个数组是空的，至少要有一个通道号`
    if (!list.every((n) => Number.isInteger(n) && n > 0)) {
      return `第 ${i + 1} 个数组里出现了不是正整数的通道号：${list.join(',')}`
    }
  }
  const [ins, outs] = value
  if (ins.length !== outs.length) {
    return `输入 ${ins.length} 个、输出 ${outs.length} 个，个数要对上才能一一对应（现在是 ${ins.join(',')} ↔ ${outs.join(',')}）`
  }
  return ''
}

/**
 * 页面上的一张设备表。
 * @typedef {object} PortField
 * @property {string} key       TOML 里的键名（原样，含连字符）
 * @property {string} label     界面中文标签
 * @property {string} kind      KIND 之一
 * @property {string[]} [options] 枚举取值（只列有依据的）
 * @property {number[]} [values]  数字的合法取值（有依据时才给）
 * @property {boolean} [int]      要求整数
 * @property {number} [min] @property {number} [max]
 * @property {boolean} [ip]       要求点分十进制 IPv4
 * @property {string} [unit] @property {string} [note] 界面提示（中文，写清依据）
 * @property {(row: object) => boolean} [showIf] 该行的这个字段是否适用
 */

/**
 * 设备表清单。路径就是 TOML 里的表名，`[[a.b]]` 用 `a.b` 寻址（config-doc 的 tablesOf 契约）。
 * @type {Array<{key: string, path: string, title: string, note: string, addable: boolean,
 *               defaults: object, fields: PortField[]}>}
 */
export const PORT_SECTIONS = [
  {
    key: 'console-devices',
    path: 'console.devices',
    title: '控制台设备 [console.devices]',
    note: '飞控的调试/控制台走哪个口。设备名必须和板级 BSP 注册的名字一致（serial0 这种写法），'
      + '写错飞控不会报错、只会安静地没数据，所以改完务必重新读一遍确认。'
      + '这一节最多 5 行（console_config.c:26 CONSOLE_MAX_DEVICE_NUM），type 写 serial/mavlink 之外的值整行被丢（:221）。',
    addable: true,
    defaults: { type: 'serial', name: '', baudrate: 57600 },
    fields: [
      { key: 'type', label: '类型', kind: KIND.ENUM, options: CONSOLE_TYPES, allowUnknown: true, note: '固件 console 只有 serial 与 mavlink 两个分支（console_config.c:194/208），写别的整行解析失败' },
      { key: 'name', label: '设备名', kind: KIND.TEXT, required: true, placeholder: 'serial0，以 BSP 注册名为准', note: '必填，缺了或设备找不到整行报错（console_config.c:230）' },
      { key: 'baudrate', label: '波特率', kind: KIND.NUMBER, int: true, min: 1, max: 2000000, showIf: (r) => r.type === 'serial', note: '只有 serial 才解析这一项（console_config.c:244），默认 57600（:196）' },
      { key: 'auto-switch', label: '自动探测', kind: KIND.BOOL, note: 'serial 与 mavlink 都有这一项（console_config.c:252/277）；开启后靠设备状态回调切换活动口' },
    ],
  },
  {
    key: 'mavproxy-devices',
    path: 'mavproxy.devices',
    title: 'MAVLink 转发通道 [mavproxy.devices]',
    note: '地面站实际用的通信链路通常就是这里的一行。一行是一个转发实例，chan 是转发通道号，'
      + '同一个 chan 下最多 5 行（mavproxy_config.c:27 MAVPROXY_MAX_DEVICE_NUM），chan 本身最多 5 个（mavproxy_dev.h:26 MAXPROXY_MAX_CHAN）。',
    addable: true,
    defaults: { chan: 0, type: 'serial', name: '', baudrate: 57600 },
    fields: [
      { key: 'chan', label: '实例号 chan', kind: KIND.NUMBER, int: true, min: 0, max: 4, note: '0~4：chan >= MAXPROXY_MAX_CHAN 会被判 invalid channel（mavproxy_config.c:71）' },
      { key: 'type', label: '类型', kind: KIND.ENUM, options: MAVPROXY_TYPES, allowUnknown: true, note: 'serial / usb / eth 三个分支（mavproxy_config.c:94/113/123），其余报 unknown device type（:126）' },
      { key: 'name', label: '设备名', kind: KIND.TEXT, required: true, placeholder: '以 BSP 注册名为准' },
      { key: 'baudrate', label: '波特率', kind: KIND.NUMBER, int: true, min: 1, max: 2000000, showIf: (r) => r.type === 'serial' },
      { key: 'auto-switch', label: '自动探测', kind: KIND.BOOL },
    ],
  },
  {
    key: 'mavproxy-rtcm',
    path: 'mavproxy.rtcm_devices',
    title: 'RTCM 差分段 [mavproxy.rtcm_devices]',
    note: '给 GNSS 灌差分数据的串口。这一节 type 只认 serial，写别的整行报错（mavproxy_config.c:173/186）；'
      + '最多 5 行（:166 用同一个 MAVPROXY_MAX_DEVICE_NUM 判）。波特率本节的默认值是 0，'
      + '固件注释写明 "0 means don\'t change baudrate"（:175），样例里没写这一项，本页也不替它凭空加一行。',
    addable: true,
    defaults: { type: 'serial', name: '' },
    fields: [
      { key: 'type', label: '类型', kind: KIND.ENUM, options: RTCM_TYPES, allowUnknown: true, note: '固件只比较了 serial 这一个字符串（mavproxy_config.c:173）' },
      { key: 'name', label: '设备名', kind: KIND.TEXT, required: true, placeholder: '以 BSP 注册名为准' },
      { key: 'baudrate', label: '波特率', kind: KIND.NUMBER, int: true, min: 0, max: 2000000, showIf: (r) => r.type === 'serial', note: '只有 serial 才解析这一项（mavproxy_config.c:209）；0 = 不改波特率（:175 注释 don\'t change baudrate），跟 GNSS 那节的 0 = 自动探测不是一回事' },
    ],
  },
  {
    key: 'ethernet-devices',
    path: 'ethernet.devices',
    title: '以太网转发 [ethernet.devices]',
    note: '样例里 local_port = 0（本地端口交给飞控自选）。地址写错同样不会报错、只会连不上。',
    addable: true,
    defaults: { name: 'eth_dev0', local_addr: '0.0.0.0', local_port: 0, remote_addr: '', remote_port: 14550 },
    fields: [
      { key: 'name', label: '设备名', kind: KIND.TEXT, required: true, placeholder: 'eth_dev0' },
      { key: 'local_addr', label: '本地地址', kind: KIND.TEXT, ip: true },
      { key: 'local_port', label: '本地端口', kind: KIND.NUMBER, int: true, min: 0, max: 65535, note: '0 = 由飞控自选' },
      { key: 'remote_addr', label: '远端地址', kind: KIND.TEXT, ip: true },
      { key: 'remote_port', label: '远端端口', kind: KIND.NUMBER, int: true, min: 1, max: 65535 },
    ],
  },
  {
    key: 'gnss-devices',
    path: 'gnss.devices',
    title: 'GNSS 接收机 [gnss.devices]',
    note: 'protocol 只有 ublox / nmea 两种（sensor_gps.c:108/110），其余报 "unknown gnss protocol" 并且整个 GNSS 不初始化（:113）。'
      + 'type 必填且只认 serial，缺了或写错整行报错（gnss_config.c:68-94）。baudrate = 0 是"自动探测"'
      + '（gnss_config.c:71 注释 auto detect），所以这里允许 0。飞控目前只支持 1 台接收机（gnss_config.c:26 GNSS_MAX_DEVICE_NUM = 1），'
      + '多写的行会被解析器丢弃。',
    addable: true,
    defaults: { id: 0, protocol: 'ublox', type: 'serial', name: '', baudrate: 0 },
    fields: [
      { key: 'id', label: '接收机序号', kind: KIND.NUMBER, int: true, min: 0, note: '必填（gnss_config.c:48）；样例用的是 0。固件只登记 1 台接收机（gnss_config.c:26），给多个 id 目前不会生效' },
      { key: 'protocol', label: '协议', kind: KIND.ENUM, options: GNSS_PROTOCOLS, note: 'ublox → gps_ubx_init()，nmea → gps_nmea_init()（sensor_gps.c:108/110）；固件编译时还要打开 GNSS_UBX / GNSS_NMEA 宏' },
      { key: 'type', label: '设备类型', kind: KIND.ENUM, options: GNSS_TYPES, note: '只有 serial 分支（gnss_config.c:69），且必填（缺了 :91-93 整行报错）' },
      { key: 'name', label: '设备名', kind: KIND.TEXT, required: true, placeholder: '以 BSP 注册名为准', note: '必填（gnss_config.c:96）' },
      { key: 'auto-config', label: '自动配置', kind: KIND.BOOL, note: '可选项（gnss_config.c:59）；开着我方会往接收机写配置指令，只连第三方接收机时慎开' },
      { key: 'baudrate', label: '波特率', kind: KIND.NUMBER, int: true, min: 0, max: 2000000, note: '只在 type = serial 时解析（gnss_config.c:80）；0 = 自动探测（:71）' },
    ],
  },
  {
    key: 'actuator-devices',
    path: 'actuator.devices',
    title: '执行器输出 [actuator.devices]',
    note: '这一节最多 5 行（actuator_config.c:27 ACTUATOR_MAX_DEVICE_NUM）。协议只有 pwm 与 dshot 两个分支'
      + '（:87 读取、:142 其余报 unknown device protocol）：pwm 用 freq（:160）与 init-val（:168），dshot 用 speed（:230）与 telem-req（:238）。'
      + '这一节改错会直接动到输出，改完先在台架确认再上桨。',
    addable: true,
    defaults: { protocol: 'pwm', name: 'main_out', freq: 400 },
    fields: [
      { key: 'protocol', label: '输出协议', kind: KIND.ENUM, options: ACTUATOR_PROTOCOLS, allowUnknown: true, note: 'pwm → freq/init-val，dshot → speed/telem-req（actuator_config.c:160/168/230/238）' },
      { key: 'name', label: '输出组', kind: KIND.ENUM, options: ['main_out', 'aux_out'], allowUnknown: true, note: '这一项要与 [actuator.devices] 里注册的设备名对上（actuator_config.c:81）；候选来自样例，不是固件常量' },
      { key: 'freq', label: 'PWM 频率', kind: KIND.NUMBER, int: true, unit: 'Hz', showIf: (r) => r.protocol === 'pwm', note: '固件按任意整数读取（actuator_config.c:160），没有上下限校验；样例是 main_out 400、aux_out 50' },
      { key: 'speed', label: 'DShot 速率', kind: KIND.NUMBER, values: DSHOT_SPEEDS, allowUnknown: true, unit: 'Mbps', showIf: (r) => r.protocol === 'dshot', note: '150/300/600 只来自配置注释（sysconfig.toml:68 "dshot speed: 150, 300, 600"）；解析器收任意整数（actuator_config.c:230）' },
      { key: 'telem-req', label: '要遥测回传', kind: KIND.BOOL, showIf: (r) => r.protocol === 'dshot', note: 'dshot 分支才解析这一项（actuator_config.c:238）' },
    ],
  },
  {
    key: 'actuator-mappings',
    path: 'actuator.mappings',
    title: '通道映射 [actuator.mappings]',
    note: '这一节最多 10 行（actuator_config.c:28 ACTUATOR_MAX_MAPPING_NUM）。chan-map 必须是两个数组、'
      + '而且两个数组长度相等（actuator_config.c:309/326，不满足直接 FMT_ERROR）。'
      + '这一项决定"哪个控制量打到哪个物理输出"，写反会炸机——先在台架、不上桨用小幅度验证。',
    addable: true,
    defaults: { from: 'control_out', to: 'main_out', 'chan-map': '[[1,2,3,4],[1,2,3,4]]' },
    fields: [
      { key: 'from', label: '来源', kind: KIND.ENUM, options: ACTUATOR_FROMS, allowUnknown: true, note: '固件比较过 control_out / rc_channels / mav_actuator_control 三个字符串（actuator_cmd.c:198/200/202），其余归为 UNKNOWN' },
      { key: 'to', label: '去向', kind: KIND.ENUM, options: ['main_out', 'aux_out'], allowUnknown: true, note: '必填（actuator_config.c:298），取值是 [actuator.devices] 里注册的设备名' },
      { key: 'chan-map', label: '通道映射', kind: KIND.ARRAY, placeholder: '[[1,2,3,4],[1,2,3,4]]' },
    ],
  },
]

/** 按 TOML 路径找节定义 */
export function sectionByPath(path) {
  return PORT_SECTIONS.find((s) => s.path === path) || null
}

/** 某节某个字段的定义 */
export function fieldDef(path, key) {
  const sec = sectionByPath(path)
  return sec ? sec.fields.find((f) => f.key === key) || null : null
}

/**
 * 把 config-doc 的 tablesOf 结果规整成界面好用的行。
 * tablesOf 契约（自测钉住）：`[{ index, path, array, keys, fields, raws }]`。
 * @param {object} sec 节定义
 * @param {Array<object>} rawRows fc.tomlTables(sec.path) 的返回值
 * @returns {Array<{index: number, fields: object, keys: string[], has(key: string): boolean}>}
 */
export function normalizeRows(sec, rawRows) {
  return (rawRows || []).map((r) => {
    const fields = r.fields || {}
    return {
      index: r.index,
      fields,
      keys: r.keys || Object.keys(fields),
      has: (key) => Object.prototype.hasOwnProperty.call(fields, key),
    }
  })
}

/** 新增一行时的初始值（浅拷贝，防止改脏默认表） */
export function emptyRowValues(sec) {
  return Object.assign(Object.create(null), sec.defaults || {})
}

/**
 * 校验一个输入值。
 * @param {PortField} def 字段定义
 * @param {unknown} raw 界面原始输入（字符串/数字/布尔）
 * @returns {{ok: boolean, value?: unknown, message?: string}} 不通过时 message 是给用户看的中文
 */
export function validateField(def, raw) {
  if (!def) return { ok: false, message: '地面站里没有这一项的定义，不敢替飞控发明' }
  const text = typeof raw === 'string' ? raw.trim() : raw
  const empty = text === '' || text === null || text === undefined || (Array.isArray(text) && !text.length)

  if (empty) {
    if (def.required) return { ok: false, message: `${def.label} 不能为空（这一行没有它飞控认不出设备）` }
    return { ok: true, value: '' }
  }

  switch (def.kind) {
    case KIND.BOOL: {
      if (typeof text === 'boolean') return { ok: true, value: text }
      const s = String(text).toLowerCase()
      if (['true', '1', 'yes', 'on', '是'].includes(s)) return { ok: true, value: true }
      if (['false', '0', 'no', 'off', '否'].includes(s)) return { ok: true, value: false }
      return { ok: false, message: `${def.label} 只能是要么开要么关（写成 true/false），现在是「${text}」` }
    }
    case KIND.ENUM: {
      const s = String(text)
      const known = optionValues(def)
      if (!known.includes(s)) {
        // 解析器对认不出的字符串多数只是忽略或警告后保留原值（见 fmt-enums.js 的行号清单），
        // 所以 allowUnknown 的项放行，但界面要显示 warning，不能让用户以为写生效了。
        if (def.allowUnknown) {
          return {
            ok: true,
            value: s,
            warning: `${def.label}「${s}」不在固件分支里（候选：${known.join(' / ')}）；飞控多半会忽略这一行，界面保留原值不自动改`,
          }
        }
        return { ok: false, message: `${def.label} 只能从这些值里选：${known.join(' / ')}（依据是固件解析器里比较过的字符串），现在是「${s}」` }
      }
      return { ok: true, value: s }
    }
    case KIND.NUMBER: {
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, message: `${def.label} 要填数字，现在是「${text}」` }
      if (def.int && !Number.isInteger(n)) return { ok: false, message: `${def.label} 要填整数，现在是 ${n}` }
      if (def.values && !optionValues(def).includes(n)) {
        if (def.allowUnknown) {
          return { ok: true, value: n, warning: `${def.label} ${n} 不在候选（${optionValues(def).join(' / ')}）里；候选只是注释里给过的值，飞控按任意数处理` }
        }
        return { ok: false, message: `${def.label} 只能填 ${optionValues(def).join(' / ')}（依据见这一项的说明），现在是 ${n}` }
      }
      if (def.min !== undefined && n < def.min) return { ok: false, message: `${def.label} 不能小于 ${def.min}${def.unit ? ' ' + def.unit : ''}，现在是 ${n}` }
      if (def.max !== undefined && n > def.max) return { ok: false, message: `${def.label} 不能大于 ${def.max}${def.unit ? ' ' + def.unit : ''}，现在是 ${n}` }
      return { ok: true, value: n }
    }
    case KIND.ARRAY: {
      let value = text
      if (typeof text === 'string') {
        try {
          // TOML 数组的字面量写法，交给 config-doc 的解析器，省得页面自己拆逗号。
          // 注意 parseTomlValue 返回的是 { type, value } 包装，必须拆出来再判。
          const parsed = parseTomlValue(text)
          value = parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed
        } catch {
          return { ok: false, message: `${def.label} 解析不了「${text}」，按 TOML 数组写，例如 ${def.placeholder || '[1,2,3]'}` }
        }
      }
      const msg = def.key === 'chan-map' ? checkChanMap(value) : (Array.isArray(value) ? '' : `${def.label} 要写成数组`)
      if (msg) return { ok: false, message: `${def.label}：${msg}` }
      return { ok: true, value }
    }
    case KIND.TEXT:
    default: {
      const s = String(text)
      if (def.ip && !isIpv4(s)) return { ok: false, message: `${def.label} 要写成点分十进制 IPv4（例如 192.168.1.24），现在是「${s}」` }
      return { ok: true, value: s }
    }
  }
}

/**
 * 候选项归一：既接受 fmt-enums 那种 `{value,label}`，也接受老写法的裸字符串/数字。
 * @param {PortField|null|undefined} def
 */
function optionValues(def) {
  const list = (def && (def.options || def.values)) || []
  return list.map((item) => (item && typeof item === 'object' ? item.value : item))
}

/**
 * 一个候选项在界面上怎么显示。带上原始值，避免"只看中文不知道飞控里写了什么"。
 * @param {unknown} item 候选项（对象或裸值）
 */
export function portOptionLabel(item) {
  if (item && typeof item === 'object') {
    const raw = String(item.value)
    if (!item.label || item.label === raw) return raw
    return item.description ? `${item.label}（${raw}）` : `${item.label}（${raw}）`
  }
  return String(item)
}

/**
 * 一行的枚举候选：定义里的取值 + 这一行原本写的值（飞控上出现过的怪值也要能选回去，
 * 免得下拉框把已有值吞掉）。返回 `{value,label}` 形式，界面直接渲染。
 * @param {PortField} def
 * @param {unknown} current
 */
export function enumOptions(def, current) {
  const list = (def && (def.options || def.values)) || []
  const objectMode = list.some((item) => item && typeof item === 'object')
  const normalized = objectMode
    ? list.map((item) => (item && typeof item === 'object' ? item : { value: item, label: String(item) }))
    : [...list]
  const hasCurrent = normalized.some((item) => String(item && typeof item === 'object' ? item.value : item) === String(current))
  if (current === undefined || current === null || hasCurrent) return normalized
  return objectMode
    ? [{ value: current, label: `当前值（${current}）`, unknown: true }, ...normalized]
    : [current, ...normalized]
}
