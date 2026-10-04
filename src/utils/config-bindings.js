/**
 * src/utils/config-bindings.js
 * ================================================================
 * 页面 ↔ 飞控配置文件 的字段映射层（S3）
 *
 * 存在的理由：各页面（PID、接收机、传感器、电机）要显示和改写的是
 * /sys/param.xml 与 /sys/sysconfig.toml 里**真实存在**的那些名字，
 * 而不是地面站自己想象出来的表单。这一层把"哪个参数归哪张卡、中文叫什么、
 * 是什么形态、能改成什么"集中成纯数据 + 纯函数，好处有两个：
 *   1) 界面不会替飞控发明字段（自测第 21 组拿真文档逐字比对）；
 *   2) 飞控以后加了参数，也会被"其余"卡接住显示出来，而不是悄悄消失在界面上。
 *
 * 唯一事实源：sample/param.sample.xml、sample/sysconfig.sieon-s1.toml
 * （两份都是从飞控完整下载回来的原文）。
 *
 * 格式对齐：param.xml 里浮点一律是 %f 六位小数（0.045000），整数是裸写法（0），
 * 所以写回时**不许**由界面决定数值形态；一律交给 config-doc 的 formatNumber，
 * 让它按下载到的原文形态回填（见 paramDoc.set 的 isFloat 缺省逻辑）。
 * ================================================================
 */

/** 数值形态：由下载到的原文决定，不由界面决定 */
export const KIND = { INT: 'int', FLOAT: 'float', STRING: 'string' }

/** 从名字派生中文用词的构词表：标签跟着名字走，就不会出现界面与原文两头对不上 */
const WORDS = {
  ROLL: '横滚',
  PITCH: '俯仰',
  YAW: '偏航',
  VEL: '速度',
  RATE: '角速度',
  XY: '水平 XY',
  Z: '垂直 Z',
  P: 'P',
  I: 'I',
  D: 'D',
  FF: '前馈 FF',
  MIN: '下限',
  MAX: '上限',
}

/** 整词占用的名字（不参与拆词，直接给整句标签） */
const WHOLE = {
  AIRFRAME: '整机布局号',
  HOVER_THRO: '悬停油门',
  ROLL_PITCH_CMD_LIM: '横滚/俯仰指令限幅',
  P_Q_CMD_LIM: 'P/Q 指令限幅',
  R_CMD_LIM: 'R 指令限幅',
  RC_CHAN_CNT: '接收机通道数',
}

/** 需要写清依据的地方。凡是固件没在配置文件里说明的东西，这里只说"没说"，不编。 */
const HINTS = {
  VEL_XY_P: 'X、Y 两个水平轴共用这一组参数：param.xml 里没有 VEL_X_P / VEL_Y_P，所以界面上也不分开填',
  VEL_XY_I: 'X、Y 两轴共用；上下限见本卡的 VEL_XY_I_MIN / VEL_XY_I_MAX',
  VEL_XY_D: 'X、Y 两轴共用；上下限见本卡的 VEL_XY_D_MIN / VEL_XY_D_MAX',
  VEL_Z_P: '垂直（高度）速度环',
  AIRFRAME: '整数布局号。固件没随配置文件给出这张枚举表，改之前先查飞控文档，本页不替你猜含义',
  HOVER_THRO: '样例原文 0.500000。量纲（0~1 还是 0~1000）配置文件里没写，本页只按数字原样写回',
  RC_CHAN_CNT: '样例原文是 0，文件与注释都没说明 0 的含义（自动探测还是未设置），本页不替你解释；改完走右下角全局保存',
  P_Q_CMD_LIM: '样例原文 1.570796 ≈ π/2、R_CMD_LIM 3.141593 ≈ π，看着是弧度；固件没在文件里标单位，故只按数字显示',
  R_CMD_LIM: '同上：样例原文正好是 π，页面不替固件断言单位',
}

/** 限幅对：下限必须不大于上限，这是逻辑约束，不依赖固件文档 */
const LIMIT_PAIRS = {
  RATE_I_MIN: 'RATE_I_MAX',
  RATE_I_MAX: 'RATE_I_MIN',
  RATE_D_MIN: 'RATE_D_MAX',
  RATE_D_MAX: 'RATE_D_MIN',
  VEL_XY_I_MIN: 'VEL_XY_I_MAX',
  VEL_XY_I_MAX: 'VEL_XY_I_MIN',
  VEL_XY_D_MIN: 'VEL_XY_D_MAX',
  VEL_XY_D_MAX: 'VEL_XY_D_MIN',
  VEL_Z_I_MIN: 'VEL_Z_I_MAX',
  VEL_Z_I_MAX: 'VEL_Z_I_MIN',
  VEL_Z_D_MIN: 'VEL_Z_D_MAX',
  VEL_Z_D_MAX: 'VEL_Z_D_MIN',
}

/**
 * CONTROL 组（PID 页）的分卡规则。
 * 每条规则命中一组名字；都没命中就落到 'other'——保证飞控有的每一项都有去处。
 * 卡内顺序一律用 param.xml 里的出现顺序，界面上的排列与原文一致，不自己重排。
 */
const CONTROL_RULES = [
  {
    card: 'rate',
    title: '角速度环 ROLL / PITCH / YAW（RATE_P I D FF）',
    note: '三轴的角速度环。param.xml 里每轴都有 P/I/D/FF 四项，就按四项显示；这一组直接决定手感，改完先小幅度试飞。',
    test: (n) => /^(ROLL|PITCH|YAW)_RATE_(P|I|D|FF)$/.test(n),
  },
  {
    card: 'angle',
    title: '角度环（RATE 的外环 P）',
    note: '角度环只有横滚与俯仰的 P：飞控没有 YAW_P，也没有角度 I/D，所以这里不会有那些格子。',
    test: (n) => /^(ROLL|PITCH)_P$/.test(n),
  },
  {
    card: 'velocity',
    title: '位置/速度环 P I D（水平 XY 一组、垂直 Z 一组）',
    note: '水平方向 X/Y 共用一组参数，垂直方向单独一组。原文里没有 VEL_X_P、VEL_Y_P 这种分轴写法。',
    test: (n) => /^VEL_(XY|Z)_(P|I|D)$/.test(n),
  },
  {
    card: 'vel-limits',
    title: '速度环积分/微分限幅（VEL_…_MIN MAX）',
    note: '下限必须不大于上限，页面会拦住写反的情况；数值形态按原文（浮点）回填。',
    test: (n) => /^VEL_(XY|Z)_(I|D)_(MIN|MAX)$/.test(n),
  },
  {
    card: 'rate-limits',
    title: '角速度环积分/微分限幅（RATE_…_MIN MAX）',
    note: '同上，作用于角速度环的 I/D 项。',
    test: (n) => /^RATE_(I|D)_(MIN|MAX)$/.test(n),
  },
  {
    card: 'acro',
    title: 'Acro 控制环',
    note: 'Acro 手动模式相关控制项。具体作用以固件字段名和说明为准。',
    test: (n) => /^(ACRO|MANUAL|RATE_CMD|ROLL_PITCH_CMD_LIM|P_Q_CMD_LIM|R_CMD_LIM)/.test(n),
  },
  {
    card: 'stabilize',
    title: 'Stabilize 控制环',
    note: '自稳模式相关控制项。只展示配置文件中真实存在的字段。',
    test: (n) => /^(STAB|STABILIZE|ANGLE|ATTITUDE)/.test(n),
  },
  {
    card: 'position',
    title: 'Position 控制环',
    note: '位置/速度控制相关项。',
    test: (n) => /^(POS|POSITION|VEL|ALT|HEIGHT)/.test(n),
  },
  {
    card: 'acro-misc',
    title: 'Acro 控制环 · 指令限幅',
    note: 'Acro / 手动控制的指令限幅与输出相关参数。',
    test: (n) => /^(ROLL_PITCH_CMD_LIM|P_Q_CMD_LIM|R_CMD_LIM)$/.test(n),
  },
  {
    card: 'misc',
    title: '整机与基础配置',
    note: 'AIRFRAME 是整数布局号；三个 CMD_LIM 与 HOVER_THRO 是输出/指令的限幅与配平。',
    test: (n) => /^(AIRFRAME|HOVER_THRO)$/.test(n),
  },
]

/** 兜底卡的键名：飞控加了新参数时会出现在这里，提醒人去归类而不是让字段消失 */
export const OTHER = 'other'

function otherCard(group) {
  return {
    card: OTHER,
    title: `其余 ${group} 参数（地面站还没归类）`,
    note: '这一卡里的项飞控确实有、只是页面还没给它们选好位置。照样能改，改完走右下角全局保存。',
  }
}

/** RC 组后缀的中文说法（RCn_MIN/MAX/REV/TRIM） */
const RC_SUFFIX = { MIN: '最小行程', MAX: '最大行程', REV: '方向（±1）', TRIM: '中位 Trim' }

/**
 * 按名字生成中文标签：整词表优先，其次 RC 组专用式，最后用构词表逐词拼接。
 * 因为标签是从名字本身派生的，界面上的称法不可能和 param.xml 里的名字对不上。
 * @param {string} name
 */
export function labelOf(name) {
  if (WHOLE[name]) return WHOLE[name]
  const rc = /^RC(\d+)_(MIN|MAX|REV|TRIM)$/.exec(name)
  if (rc) return `通道 ${rc[1]} · ${RC_SUFFIX[rc[2]]}`
  return name.split('_').map((w) => WORDS[w] || (/^\d+$/.test(w) ? `通道 ${w}` : w)).join(' ')
}

/** 某个组已写好的归类规则。新页面（接收机 RC 组、传感器 INS 组）在这里加规则，不要往界面里写。 */
const CONTROL_SEMANTIC_RULES = [
  { card: 'rate-limits', test: (n) => /(?:RATE|ANGULAR|GYRO).*(?:MIN|MAX|LIM)|(?:MIN|MAX|LIM).*(?:RATE|ANGULAR|GYRO)/i.test(n) },
  { card: 'vel-limits', test: (n) => /(?:VEL|VELOC|SPEED|POS|ALT|HEIGHT).*(?:MIN|MAX|LIM)|(?:MIN|MAX|LIM).*(?:VEL|VELOC|SPEED|POS|ALT|HEIGHT)/i.test(n) },
  { card: 'rate', test: (n) => /(?:RATE|ANGULAR|GYRO|ROLL|PITCH|YAW).*(?:P|I|D|FF)|(?:P|I|D|FF).*(?:RATE|ANGULAR|GYRO)/i.test(n) },
  { card: 'angle', test: (n) => /(?:ANGLE|ATTITUDE|STAB|STABILIZE).*(?:P|I|D|FF)|(?:P|I|D|FF).*(?:ANGLE|ATTITUDE|STAB|STABILIZE)/i.test(n) },
  { card: 'position', test: (n) => /(?:POS|POSITION|VEL|VELOC|SPEED|ALT|HEIGHT)/i.test(n) },
]

function rulesFor(group) {
  if (group === 'CONTROL') return CONTROL_RULES
  if (group === 'RC') return RC_RULES
  return []
}

/** 某个名字落在哪张卡；没规则命中就落兜底卡 */
export function cardOf(group, name) {
  for (const rule of rulesFor(group)) if (rule.test(name)) return rule.card
  if (group === 'CONTROL') {
    for (const rule of CONTROL_SEMANTIC_RULES) if (rule.test(name)) return rule.card
  }
  return OTHER
}

/** 某个名字落在哪张卡（PID 页常用） */
export function cardOfControl(name) {
  return cardOf('CONTROL', name)
}

/** 页面要渲染的卡片清单（含兜底卡） */
export function cardsFor(group) {
  return [...rulesFor(group).map(({ test, ...rest }) => rest), otherCard(group)] // eslint-disable-line no-unused-vars
}

/** 兼容旧名字：PID 页的卡清单 */
export function controlCards() {
  return cardsFor('CONTROL')
}

/**
 * 把 param 文档里的一个组摊成"卡 → 行"的结构，直接给界面渲染。
 * 顺序一律用 param.xml 里的出现顺序：界面上的排列与原文一致，不自己重排。
 * @param {{list:()=>{group:string,name:string,value:unknown,raw:string,type:string}[]}|null} doc paramDoc
 * @param {string} group 例如 'CONTROL'
 */
export function mapGroupToCards(doc, group = 'CONTROL') {
  const entries = doc ? doc.list().filter((e) => e.group === group) : []
  const byCard = Object.create(null)
  const cards = cardsFor(group)
  for (const card of cards) byCard[card.card] = []
  for (const e of entries) byCard[cardOf(group, e.name)].push(toItem(e))
  return cards.filter((card) => byCard[card.card].length).map((card) => ({ ...card, items: byCard[card.card] }))
}

/** 一条参数 → 界面用的一行 */
export function toItem(entry) {
  return {
    name: entry.name,
    label: labelOf(entry.name),
    kind: entry.type === 'float' ? KIND.FLOAT : entry.type === 'int' ? KIND.INT : KIND.STRING,
    raw: entry.raw,
    value: entry.value,
    hint: HINTS[entry.name] || '',
    pair: pairOf(entry.name),
    range: rangeOf(entry.name),
  }
}

/**
 * 校验一次改写。返回 ok=false 时界面**不要**落笔。
 * @param {{name:string,label:string,kind:string,value:unknown,pair:string}} item
 * @param {string|number} input 用户在格子里输入的内容
 * @param {(name:string)=>number|undefined} sibling 取同组另一项的当前值（限幅对用）
 */
export function validateParamInput(item, input, sibling) {
  const text = String(input ?? '').trim()
  if (!text) return { ok: false, message: `${item.name} 原本是 ${item.raw}；清空不算改动，也不会删掉这一项` }
  if (item.kind === KIND.STRING) return { ok: true, value: text }
  const n = Number(text)
  if (!Number.isFinite(n)) return { ok: false, message: `${item.name} 要填数字，「${text}」不是` }
  if (Math.abs(n) > 1e9) return { ok: false, message: `${item.name} 填的 ${text} 超出常理（|值|>1e9），先确认是不是多写了零` }
  if (item.kind === KIND.INT && !Number.isInteger(n)) {
    return {
      ok: false,
      message: `${item.name} 在 param.xml 里是整数写法（${item.raw}）。写小数会把这一项变成浮点写法，与飞控原文格式不一致，请填整数`,
    }
  }
  if (item.pair && typeof sibling === 'function') {
    const other = sibling(item.pair)
    if (typeof other === 'number' && Number.isFinite(other)) {
      const isMin = /_MIN$/.test(item.name)
      if (isMin && n > other) return { ok: false, message: `${item.name} 不能大于 ${item.pair}（当前 ${other}）：下限写在上限之上` }
      if (!isMin && n < other) return { ok: false, message: `${item.name} 不能小于 ${item.pair}（当前 ${other}）：上限写在下限之下` }
    }
  }
  if (/^RC\d+_REV$/.test(item.name) && n !== 1 && n !== -1) {
    return {
      ok: false,
      message: `${item.name} 在 param.xml 里只有 1.000000 与 -1.000000 两种写法（本条原文 ${item.raw}），${text} 地面站不认——方向项写成别的数含义不明，先核对固件`,
    }
  }
  if (item.range && typeof sibling === 'function') {
    const lo = sibling(item.range.min)
    const hi = sibling(item.range.max)
    if (typeof lo === 'number' && typeof hi === 'number' && (n < lo || n > hi)) {
      return {
        ok: false,
        message: `${item.name} 要落在同通道 ${item.range.min}（${lo}）与 ${item.range.max}（${hi}）之间：中位写到行程外面，这一路在行程端点上就是满舵`,
      }
    }
  }
  return { ok: true, value: n }
}

/**
 * 字段对齐检查：界面绑定的名字集合 与 文档里真实存在的名字集合 互相核对。
 * invented = 界面上有、飞控文件里没有（绝不许出现，等于替飞控发明参数）；
 * missing  = 飞控文件里有、界面上没去处（兜底卡存在时应恒为空）。
 * @param {string[]} docNames param.xml 里该组的真实名字
 * @param {string[]} boundNames 页面绑定的名字
 */
export function checkFieldAlignment(docNames, boundNames) {
  const a = new Set(docNames)
  const b = new Set(boundNames)
  return {
    invented: [...b].filter((n) => !a.has(n)),
    missing: [...a].filter((n) => !b.has(n)),
    duplicate: boundNames.filter((n, i) => boundNames.indexOf(n) !== i),
  }
}

/**
 * sysconfig 侧：接收机页要动的字段（[pilot-cmd] 与 [pilot-cmd.device]）。
 * 键名与取值形态全部照 sample/sysconfig.sieon-s1.toml 的原文来，注释里的枚举是固件作者写的依据。
 */
export const PILOT_SECTION = 'pilot-cmd'
export const PILOT_DEVICE = 'pilot-cmd.device'

export const PILOT_DEVICE_FIELDS = [
  {
    key: 'type', label: '输入源类型', kind: 'enum', valueType: 'string', options: RC_DEVICE_TYPE_OPTIONS, values: RC_DEVICE_TYPE_OPTIONS.map((item) => item.value),
    hint: '固件只支持 "rc"：pilot_cmd_config.c:427 判 type=="rc"，否则 LOG_E("only rc device is supported in pilot-cmd table")（:457-461）',
  },
  { key: 'name', label: '设备名', kind: 'text', hint: '样例里是 "rc"（hal/rc 注册的设备名，fmtio.c:451 hal_rc_register(&rc_dev, "rc", ...)）；写回时字符串带引号，与原文一致' },
  {
    key: 'protocol', label: '接收机协议', kind: 'enum', valueType: 'string', options: RECEIVER_PROTOCOL_OPTIONS, values: RECEIVER_PROTOCOL_OPTIONS.map((item) => item.value), allowUnknown: true,
    hint: '依据 pilot_cmd_config.c:467-475：只有 auto / sbus / ppm 三个字符串有分支，其余打印 "unknown rc protocol" 后忽略；界面显示中文，写回原始字符串',
  },
  {
    key: 'channel-num', label: '通道数', kind: 'enum', valueType: 'int', options: CHANNEL_COUNT_OPTIONS, values: CHANNEL_COUNT_OPTIONS.map((item) => item.value), min: 1, max: 16, allowUnknown: true,
    hint: '上限 16 的依据是 hal/rc/rc.c:50 的通道掩码是 uint16_t（(1 << channel_num) - 1），且 rc_param.c 只有 RC1~RC16；样例注释另说 ppm 实际只有 8 路',
  },
  { key: 'sample-time', label: '采样周期（秒）', kind: 'float', hint: '样例 0.05 = 20 Hz；注释说 -1 表示继承上级配置' },
  { key: 'range', label: '量程（µs）', kind: 'range', hint: '样例是 [1000,2000]，即接收机输出的 PWM 微秒范围' },
]

/** 摇杆四通道映射：注释给出顺序 [yaw, throttle, roll, pitch]，页面按这个顺序标，改错等于换杆 */
export const STICK_CHANNELS = [
  { index: 0, label: 'yaw（偏航）' },
  { index: 1, label: 'throttle（油门）' },
  { index: 2, label: 'roll（横滚）' },
  { index: 3, label: 'pitch（俯仰）' },
]

/**
 * stick-channel = [4,3,1,2] 的校验：四个正整数通道号。
 * 不做"不许重复"这种断言吗？——做：四个轴映射到同一通道显然是错的，飞控不会替你兜。
 * @param {string|number[]} input
 */
export function validateStickChannel(input) {
  let value = input
  if (typeof value === 'string') {
    const text = value.trim()
    try {
      value = JSON.parse(/^\[/.test(text) ? text : `[${text}]`)
    } catch {
      return { ok: false, message: '要写成 [4,3,1,2] 这样的四个通道号' }
    }
  }
  if (!Array.isArray(value) || value.length !== 4) return { ok: false, message: 'stick-channel 必须是 4 个通道号，顺序是 [yaw, throttle, roll, pitch]' }
  const nums = value.map((v) => Number(v))
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 18)) return { ok: false, message: '通道号要是 1~18 的整数（sbus 最多 16 路，ppm 8 路）' }
  if (new Set(nums).size !== 4) return { ok: false, message: '四个轴映射到了同一个通道：' + nums.join(',') + '，这样杆量会互相踩' }
  return { ok: true, value: nums }
}

/* ================================================================
 * S4 接收机页要用的两件事：
 *   A) param.xml 的 RC 组（每路 MIN/MAX/REV/TRIM + RC_CHAN_CNT）
 *   B) sysconfig.toml 的 [pilot-cmd] 段（设备表、模式表、指令表）
 * 规则一律写在这里，页面只负责渲染——这样自测能拿飞控原文逐字核对界面字段。
 * ================================================================ */

/** 限幅配对：CONTROL 组查固定表，RC 组按同通道号配对（RC1_MIN ↔ RC1_MAX） */
export function pairOf(name) {
  if (LIMIT_PAIRS[name]) return LIMIT_PAIRS[name]
  const rc = /^RC(\d+)_(MIN|MAX)$/.exec(name)
  return rc ? `RC${rc[1]}_${rc[2] === 'MIN' ? 'MAX' : 'MIN'}` : ''
}

/** 中位 Trim 的参照：必须跟同通道的 MIN / MAX 比 */
export function rangeOf(name) {
  const rc = /^RC(\d+)_TRIM$/.exec(name)
  return rc ? { min: `RC${rc[1]}_MIN`, max: `RC${rc[1]}_MAX` } : null
}

/** RC 组的分卡规则（没命中的仍由兜底卡接住） */
const RC_RULES = [
  {
    card: 'rc-chan-cnt',
    title: '通道数（RC_CHAN_CNT）',
    note: '样例原文是 0，文件与注释都没解释 0 代表什么，页面只显示、不替你猜别的值代表几路。',
    test: (n) => n === 'RC_CHAN_CNT',
  },
  {
    card: 'rc-channels',
    title: '通道行程（每路 MIN / MAX / REV / TRIM）',
    note: '单位是 PWM 微秒，与本页「遥控器校准」看到的 RC_CHANNELS 同一量纲。行程写反、中位写出区间外，这一路在端点上就是满舵——所以一律拦住不落笔。',
    test: (n) => /^RC\d+_(MIN|MAX|REV|TRIM)$/.test(n),
  },
]

/** 通道行程表的列：列名与 labelOf 同源，不会出现「表头一个叫法、参数名另一个叫法」 */
export const RC_COLUMNS = ['MIN', 'MAX', 'REV', 'TRIM'].map((k) => ({ key: k, name: RC_SUFFIX[k] }))

/**
 * 把 RC 组的行摊成「一路一行、四个字段一列」的矩阵。
 * 只有 param.xml 里真有的通道才会成为一行：飞控给了 4 路就显示 4 路，不补到 18 路。
 * @param {ReturnType<typeof toItem>[]} items 来自 mapGroupToCards(doc,'RC') 的 rc-channels 卡
 */
export function channelMatrix(items) {
  const byChan = new Map()
  const others = []
  for (const it of items || []) {
    const m = /^RC(\d+)_(MIN|MAX|REV|TRIM)$/.exec(it.name)
    if (!m) {
      others.push(it)
      continue
    }
    const chan = Number(m[1])
    if (!byChan.has(chan)) byChan.set(chan, { chan, label: `通道 ${chan}`, fields: Object.create(null) })
    byChan.get(chan).fields[m[2]] = it
  }
  const channels = [...byChan.values()].sort((a, b) => a.chan - b.chan)
  for (const row of channels) {
    row.missing = RC_COLUMNS.filter((c) => !row.fields[c.key]).map((c) => `${c.name}（飞控这一路没这项）`)
  }
  return { channels, others }
}

/** sysconfig 里两张 pilot-cmd 数组表的键名 */
export const PILOT_MODE = 'pilot-cmd.mode'
export const PILOT_COMMAND = 'pilot-cmd.command'

/** 依据说明：只转录样例文件里已有的注释，不补枚举 */
import {
  FMT_MODE_OPTIONS,
  FMT_COMMAND_OPTIONS,
  PILOT_COMMAND_TYPE_OPTIONS,
  RC_DIRECTION_OPTIONS,
  RC_CHANNEL_OPTIONS,
  CHANNEL_COUNT_OPTIONS,
  RECEIVER_PROTOCOL_OPTIONS,
  RC_DEVICE_TYPE_OPTIONS,
} from '../protocol/fmt-enums.js'

export { RC_DIRECTION_OPTIONS }

export const PILOT_MODE_NOTE =
    'FMT 飞行模式：0=无动作、1=手动、2=特技、3=自稳、4=定高、5=定点、6=任务、7=外部控制。'
    + '编号来自固件 src/model/fms/*_fms/lib/FMS_types.h 的 PilotMode，六种机型定义一致；'
    + '样例里三行依次注释为 mode = 5（Position mode）、4（Altitude mode）、3（Stabilize mode）。'
    + '写 0 会被 gcs_cmd.c 的 gcs_set_mode() 拒绝（打印 "set Unknown mode 0" 返回 FMT_EINVAL）。'
    + '模式分配属于高风险配置，改完请先在地面、不上桨验证。'
export const PILOT_COMMAND_NOTE =
    '指令表：0=无动作、1000=预解锁检查、1001=解锁、1002=上锁、1003=起飞、1004=降落、1005=返航、1006=暂停任务、1007=继续任务、2000=设置 Home 点。'
    + '编号来自固件 FMS_types.h 的 FMS_Cmd，gcs_cmd.c 的 gcs_set_cmd() 只处理 1000~1007 与 2000，其余返回 FMT_ENOTHANDLE；'
    + 'type = 1 表示 event、2 表示 status；cmd = 1002 的样例注释为 FMS_Cmd_Disarm；中文只用于显示，保存时写回原始整数。'

export const PILOT_MODES = FMT_MODE_OPTIONS
export const PILOT_MODE_FIELDS = [
  { key: 'mode', label: '飞行模式', kind: 'enum', valueType: 'int', options: PILOT_MODES, values: PILOT_MODES.map((m) => m.value), allowUnknown: true, hint: '编号来自固件 FMS_types.h 的 PilotMode（0~7）；中文只用于显示，保存时写回原始整数。写 0 飞控会拒绝' },
  { key: 'channel', label: '拨的通道', kind: 'enum', valueType: 'int', options: RC_CHANNEL_OPTIONS, values: RC_CHANNEL_OPTIONS.map((m) => m.value), min: 1, max: 16, allowUnknown: true, hint: '上限 16 的依据：hal/rc/rc.c:50 通道掩码是 uint16_t，rc_param.c 只定义到 RC16' },
  { key: 'range', label: '触发区间（µs）', kind: 'range' },
]

export const PILOT_COMMAND_FIELDS = [
  { key: 'type', label: '类型', kind: 'enum', valueType: 'int', options: PILOT_COMMAND_TYPE_OPTIONS, values: PILOT_COMMAND_TYPE_OPTIONS.map((m) => m.value), allowUnknown: true, hint: '1=事件，2=状态' },
  { key: 'cmd', label: '指令', kind: 'enum', valueType: 'int', options: FMT_COMMAND_OPTIONS, values: FMT_COMMAND_OPTIONS.map((item) => item.value), allowUnknown: true, hint: '编号来自固件 FMS_types.h 的 FMS_Cmd，gcs_cmd.c:1000~1007/2000 才处理；中文只用于显示，保存时写回原始整数。写 0 飞控会拒绝' },
  { key: 'channel', label: '拨的通道', kind: 'enum', valueType: 'int', options: RC_CHANNEL_OPTIONS, values: RC_CHANNEL_OPTIONS.map((m) => m.value), min: 1, max: 16, allowUnknown: true },
  { key: 'range', label: '触发区间（µs）', kind: 'range' },
]

/**
 * 区间校验：接受 [1000,2000] 或 1000,2000 两种写法，落成数字数组。
 * 依据：样例里所有 range 都是 500~2500 µs 之间的整数、且下限小于上限。
 */
export function validateRangeInput(input, label = '区间') {
  let value = input
  if (typeof value === 'string') {
    const text = value.trim()
    try {
      value = JSON.parse(/^\[/.test(text) ? text : `[${text}]`)
    } catch {
      return { ok: false, message: `${label} 要写成 [1000,2000] 这样，两个数用逗号分隔` }
    }
  }
  if (!Array.isArray(value) || value.length !== 2) return { ok: false, message: `${label} 必须是两个数：下限、上限` }
  const nums = value.map(Number)
  if (nums.some((n) => !Number.isInteger(n))) return { ok: false, message: `${label} 的两个数要是整数微秒（样例写法是 1000 / 2000）` }
  if (nums.some((n) => n < 500 || n > 2500)) return { ok: false, message: `${label} 里的 ${nums.join(', ')} 超出 500~2500 µs，先确认是不是多写了零` }
  if (nums[0] >= nums[1]) return { ok: false, message: `${label} 的下限必须小于上限（${nums.join(', ')} 触发不了）` }
  return { ok: true, value: nums }
}

/** 把原文值写成给人看的形态（数组要能看懂是数组） */
export function fmtRaw(v) {
  if (Array.isArray(v)) return `[${v.join(',')}]`
  if (typeof v === 'string') return `"${v}"`
  return String(v)
}

/**
 * [pilot-cmd] 各字段的校验。返回 ok=false 时界面不落笔。
 * 与端口页同一套纪律：飞控上已有的怪值允许原样选回去，但不许界面自己造值。
 * @param {{key:string,label:string,kind:string,values?:string[]|number[],min?:number,max?:number}} field
 * @param {string|number|number[]} input
 * @param {unknown} current 飞控原文里的值
 */
export function validatePilotField(field, input, current) {
  if (field.kind === 'range') return validateRangeInput(input, field.label)
  const text = String(input ?? '').trim()
  if (!text) {
    return { ok: false, message: `${field.label}（${field.key}）原本是 ${fmtRaw(current)}；清空不算改动，也不会删掉飞控上的这一项` }
  }
  if (field.kind === 'enum') {
    const value = field.valueType === 'int' ? Number(input) : text
    if (field.valueType === 'int' && (!Number.isFinite(value) || !Number.isInteger(value))) {
      return { ok: false, message: `${field.label} 要填整数（原文写法 ${fmtRaw(current)}）` }
    }
    const known = Array.isArray(field.values) && field.values.includes(value)
    const isCurrent = field.valueType === 'int' ? value === Number(current) : value === String(current ?? '')
    if (!known && !isCurrent && !field.allowUnknown) {
      return { ok: false, message: `${field.label} 只认已登记的选项，「${text}」没有依据` }
    }
    if (field.min !== undefined && value < field.min) return { ok: false, message: `${field.label} 不能小于 ${field.min}` }
    if (field.max !== undefined && value > field.max) return { ok: false, message: `${field.label} 不能大于 ${field.max}（样例注释：sbus 16 路、ppm 8 路）` }
    return { ok: true, value }
  }
  if (field.kind === 'int' || field.kind === 'float') {
    const n = Number(text)
    if (!Number.isFinite(n)) return { ok: false, message: `${field.label} 要填数字，「${text}」不是` }
    if (field.kind === 'int' && !Number.isInteger(n)) return { ok: false, message: `${field.label} 要填整数（原文写法 ${fmtRaw(current)}）` }
    if (field.values && !field.values.includes(n) && n !== Number(current)) {
      return { ok: false, message: `${field.label} 只认样例里出现过的 ${field.values.join(' / ')}（依据是那一行的注释），${text} 地面站没有依据` }
    }
    if (field.min !== undefined && n < field.min) return { ok: false, message: `${field.label} 不能小于 ${field.min}` }
    if (field.max !== undefined && n > field.max) return { ok: false, message: `${field.label} 不能大于 ${field.max}（样例注释：sbus 16 路、ppm 8 路）` }
    return { ok: true, value: n }
  }
  return { ok: true, value: text }
}
