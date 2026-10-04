/**
 * 链路体检（开发计划 §三 S0a）的纯逻辑层。
 *
 * 这里只做一件事：把只读采到的原始数据整理成可导出的报告。不碰 DOM、不碰 MAVLink、
 * 不 import 任何运行时模块，因此能被 scripts/selftest.mjs 直接测。
 *
 * 两条硬规矩（自测第 16 组看着它们）：
 *  1. 采不到的数据一律 null，并在说明里写清为什么没有——**不许补 0**，
 *     0 在遥测表里会被读成"飞控在发，只是值为 0"，那是假事实。
 *  2. 只有真机回包/回显才算"有"，本页没有任何"成功"字样。
 */

/* param-value.js 同样是纯函数模块（不碰 MAVLink、不碰 DOM），所以这里可以继续被 selftest 直测 */
import { auditParamTypes } from './param-value.js'

export const REPORT_SCHEMA = 1
export const GCS_NAME = 'FIRMAMENT GCS'
export const PANEL_NAME = 'S0a 链路体检（只读）'

/** 体检摘要要回答的几个问题，对应这几条消息是否在发 */
export const CENSUS_WATCHLIST = [
  'HEARTBEAT',
  'SYS_STATUS',
  'ATTITUDE',
  'AUTOPILOT_VERSION',
  'GLOBAL_POSITION_INT',
  'GPS_RAW_INT',
  'RC_CHANNELS',
  'SERVO_OUTPUT_RAW',
  'BATTERY_STATUS',
  'PARAM_VALUE',
  'STATUSTEXT',
]

const round = (n, d) => {
  const k = 10 ** d
  return Math.round(n * k) / k
}
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 本地时间戳转 ISO（无效值给 null，不给 1970） */
export function nowIso(ms) {
  const v = numOrNull(ms) ?? Date.now()
  return v > 0 ? new Date(v).toISOString() : null
}

/**
 * 消息普查：用"窗口前后差值"算频率。
 * prev / cur 是 msgCensus() 的快照（[{ msgid, name, rx, bad }]）。
 * 首次出现（没有上次快照）时增量取当前值；计数器复位（当前值小于上次）时增量记 0——
 * 复位发生在窗口内哪一刻无从得知，宁少报也不虚报频率。
 */
export function censusRates(prev, cur, windowMs) {
  const prevMap = new Map((prev || []).map((r) => [r.msgid, r]))
  const win = numOrNull(windowMs)
  const rows = (cur || []).map((r) => {
    const before = prevMap.get(r.msgid)
    const rx = numOrNull(r.rx) ?? 0
    const bad = numOrNull(r.bad) ?? 0
    const dRx = before ? Math.max(rx - (numOrNull(before.rx) ?? 0), 0) : rx
    const dBad = before ? Math.max(bad - (numOrNull(before.bad) ?? 0), 0) : bad
    return {
      msgid: numOrNull(r.msgid),
      name: r.name || `MSG_${r.msgid}`,
      rxTotal: rx,
      rxInWindow: dRx,
      crcErrorsInWindow: dBad,
      rateHz: win && win > 0 ? round(dRx / (win / 1000), 2) : null,
    }
  })
  return rows.sort((a, b) => b.rxInWindow - a.rxInWindow)
}

/** 参数条目归一：字段名在解码层是 name，在事件里可能是 param_id；两者都认 */
export function normalizeParamList(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.list) ? raw.list : [])
  return list
    .map((e) => {
      const src = e || {}
      const n = src.name ?? src.param_id
      return {
        name: typeof n === 'string' ? n.replace(/\0+$/, '').trim() : null,
        type: numOrNull(src.type),
        value: numOrNull(src.value),
        index: numOrNull(src.index),
        count: numOrNull(src.count),
      }
    })
    .filter((e) => !!e.name)
}

/**
 * 参数名形态普查——这是 S0a 最想要的答案：
 * 固件里 PARAM_GROUP_DEFINE(组名) + param_t.name（裸名），地面站看到的到底是
 * `ROLL_RATE_P` 还是 `CONTROL_ROLL_RATE_P`？带不带前缀决定了 PID 页、参数字典、
 * 检查清单能不能按组取数。顺带量一下名字长度：MAVLink 1 的 param_id 只有 16 字节，
 * 组前缀一加就容易截断，那是静默错误。
 */
export function paramNameShape(params) {
  const names = (params || []).map((p) => p && p.name).filter(Boolean)
  const prefixes = new Map()
  let withUnderscore = 0
  let withoutUnderscore = 0
  for (const n of names) {
    const i = n.indexOf('_')
    if (i > 0) {
      withUnderscore++
      const p = n.slice(0, i)
      prefixes.set(p, (prefixes.get(p) || 0) + 1)
    } else {
      withoutUnderscore++
    }
  }
  return {
    total: names.length,
    withUnderscore,
    withoutUnderscore,
    prefixKinds: prefixes.size,
    topPrefixes: [...prefixes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([prefix, count]) => ({ prefix, count })),
    samples: names.slice(0, 8),
    maxLength: names.reduce((m, n) => Math.max(m, n.length), 0),
    // 逼近 16 字节上限的名字数：>0 就说明"带组前缀"这条路有截断风险
    nearParamIdLimit: names.filter((n) => n.length >= 15).length,
  }
}

/** 参数读取结论：把内核给的 reason 原样带上，不改写成"没有参数" */
/**
 * 参数表类型体检：整型参数的两种编码分歧，以及重名帧数。
 * 结论要回答的是「这条参数能不能只凭 MAVLink 链路定值」，
 * 而不是替飞控猜一个值。
 */
export function paramAudit(list, { frames = null } = {}) {
  return auditParamTypes(list, { frames })
}

export function paramReadSummary(result, params) {
  const list = params || []
  const reason = result && typeof result.reason === 'string' ? result.reason : null
  return {
    got: list.length,
    total: numOrNull(result && result.total),
    reason,
    ms: numOrNull(result && result.ms),
    note: reason === 'no-response'
      ? '一帧 PARAM_VALUE 都没收到：判定这台飞控未实现该协议（不是"参数为空"）'
      : (reason === 'complete'
        ? '读完了（param_index+1 >= param_count）'
        : (reason ? `未确认读完（${reason}），下面的数字是下界` : '未采集')),
  }
}

/** 机载两文件的体检卡：store 的 files 直接吃，字段缺失留 null */
export function fileSummary(files) {
  const src = files && files.value ? files.value : files
  if (!src || typeof src !== 'object') return []
  return Object.values(src).map((f) => ({
    key: f && f.key != null ? f.key : null,
    label: f && f.label != null ? f.label : null,
    remote: f && f.remote != null ? f.remote : null,
    present: !!(f && f.present),
    loaded: !!(f && f.loaded),
    size: numOrNull(f && f.size),
    crc32: (f && f.crc32Hex) || null,
    hasBom: !!(f && f.hasBom),
    dirty: !!(f && f.dirty),
    changes: Array.isArray(f && f.changes) ? f.changes.length : 0,
    error: (f && f.error) || null,
  }))
}

/**
 * /sys 目录列举结果归一：ftp.list 的具体返回形状还没实测（这正是 S0a 要答的问题之一），
 * 所以这里不假设，能认的形状都认，认不出就把键名报出来，别装作读懂了。
 */
export function sysListingSummary(result) {
  const shape = Array.isArray(result) ? 'array'
    : (result && typeof result === 'object' ? `object{${Object.keys(result).join(',')}}` : typeof result)
  const entries = Array.isArray(result) ? result
    : (result && (result.entries || result.files || result.list)) || []
  const list = Array.isArray(entries) ? entries : []
  return {
    shape,
    count: list.length,
    entries: list.map((e) => ({
      name: typeof e === 'string' ? e : (e && (e.name ?? e.filename) != null ? String(e.name ?? e.filename) : null),
      size: numOrNull(e && e.size),
      directory: e ? (e.isDirectory ?? e.is_dir ?? e.dir ?? null) : null,
    })),
  }
}

/**
 * 控制台会话探针：只发过 `version` 这种只读命令。
 * 有回显只说明"这条串口是 shell 且能收发"，不代表任何命令执行成功。
 */
export function consoleProbeSummary(probe) {
  const p = probe || {}
  const text = typeof p.text === 'string' ? p.text : ''
  const responded = text.trim().length > 0
  return {
    sent: p.sent ?? null,
    waitedMs: numOrNull(p.ms),
    bytes: text.length > 0 ? new TextEncoder().encode(text).length : 0,
    lines: responded ? text.split(/\r?\n/).filter((l) => l.trim() !== '').length : 0,
    responded,
    raw: text,
    note: responded
      ? '会话有回显：控制台通道可用（校准/电机测试/重启这类动作要走它，见 D-5）'
      : '等待窗口内没有任何回显：会话未建立，或该串口不是 shell',
  }
}

/** 链路身份快照：全来自 HEARTBEAT，没 detected 就都是 null 而不是猜一个 */
export function identitySummary(vehicle, stats, baudRate, heartbeatAgeMs) {
  const v = vehicle || {}
  const s = stats || {}
  const age = numOrNull(heartbeatAgeMs)
  return {
    detected: !!v.detected,
    sysid: v.detected ? numOrNull(v.sysid) : null,
    compid: v.detected ? numOrNull(v.compid) : null,
    type: v.detected ? numOrNull(v.type) : null,
    autopilot: v.detected ? numOrNull(v.autopilot) : null,
    customMode: v.detected ? numOrNull(v.customMode) : null,
    modeCode: v.modeCode ?? null,
    modeName: v.modeName ?? null,
    armed: !!v.armed,
    heartbeatAgeMs: age,
    heartbeatAlive: age != null && age >= 0 && age < 2000,
    baudRate: numOrNull(baudRate),
    link: {
      frames: numOrNull(s.frames),
      rxMsgs: numOrNull(s.rxMsgs),
      rxBytes: numOrNull(s.rxBytes),
      crcErrors: numOrNull(s.crcErrors),
      learnedCrcExtra: numOrNull(s.learned),
    },
  }
}

/** 关注清单：每条消息"窗口内有没有在发" */
export function telemetryFindings(rows) {
  const byName = new Map((rows || []).map((r) => [r.name, r]))
  return CENSUS_WATCHLIST.map((name) => {
    const r = byName.get(name)
    const inWindow = r ? numOrNull(r.rxInWindow) ?? 0 : 0
    return {
      name,
      msgid: r ? numOrNull(r.msgid) : null,
      rxInWindow: inWindow,
      rateHz: r && inWindow > 0 ? numOrNull(r.rateHz) : null,
      present: inWindow > 0,
      note: inWindow > 0
        ? '窗口内收到'
        : (r ? '窗口内没有新帧（累计收到过 ' + (numOrNull(r.rxTotal) ?? 0) + ' 条）' : '从未收到该消息：飞控不发送，或需要接上对应硬件'),
    }
  })
}

/** 汇总报告：字段缺失就是 null，导出的 JSON 与界面所见必须一致 */
export function buildReport(parts) {
  const p = parts || {}
  return {
    schema: REPORT_SCHEMA,
    generatedAt: nowIso(p.generatedAt),
    gcs: GCS_NAME,
    panel: PANEL_NAME,
    safety: '本页全程只读：未写参数、未写文件、未发送任何执行类命令（仅 version 只读探针）',
    identity: p.identity ?? null,
    files: p.files ?? [],
    sysListing: p.sysListing ?? null,
    params: p.params ?? null,
    paramShape: p.paramShape ?? null,
    /* 白名单必须与调用方传进来的字段一一对应：漏一个字段就是静默丢数据，
       比抛错更坏——paramAudit 第一次真机实测时面板上有、导出 JSON 里没有。 */
    paramList: p.paramList ?? null,
    paramAudit: p.paramAudit ?? null,
    telemetry: p.telemetry ?? null,
    findings: p.findings ?? [],
    consoleProbe: p.consoleProbe ?? null,
    notMeasured: [
      'RC 输入真值（无接收机）',
      '电机输出与 act 会话（无电调/电机）',
      '校准会话完整流程（需接收机/静置台）',
      '板载日志目录与格式（待 M4 前实测）',
    ],
    errors: p.errors ?? [],
  }
}

/** 采集过程中的错误原文，逐条留痕（不许吞异常） */
export function noteError(errors, step, e) {
  if (!Array.isArray(errors)) return
  errors.push({
    step,
    at: nowIso(Date.now()),
    error: e && e.message ? String(e.message) : String(e),
    name: (e && e.name) || null,
  })
}

/** 导出前的 JSON 安全化：把 Uint8Array / Map 之类换成可读标记，避免导出失败 */
export function jsonSafe(v, depth = 0) {
  if (depth > 6) return '[深度上限]'
  if (v == null) return null
  if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.length}B]`
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => jsonSafe(x, depth + 1))
  const out = {}
  for (const k of Object.keys(v)) {
    if (typeof v[k] === 'function') continue
    out[k] = jsonSafe(v[k], depth + 1)
  }
  return out
}

/** 复制用的中文摘要：只报有依据的事实，逐行短，便于贴在聊天里 */
export function reportDigest(report) {
  const r = report || {}
  const id = r.identity || {}
  const lines = []
  lines.push(`链路体检 ${r.generatedAt || '时间未知'}（schema ${r.schema}）`)
  lines.push(`身份：sysid ${id.sysid ?? '?'} compid ${id.compid ?? '?'} 型号 ${id.type ?? '?'} autopilot ${id.autopilot ?? '?'}｜模式 ${id.modeName || id.modeCode || '未知'}｜解锁 ${id.armed ? '是' : '否'}`)
  const link = id.link || {}
  lines.push(`链路：${link.frames ?? '?'} 帧 / ${link.rxMsgs ?? '?'} 条 / CRC 错 ${link.crcErrors ?? '?'} / 自愈 ${link.learnedCrcExtra ?? 0} 项`)
  for (const f of r.files || []) {
    lines.push(`文件 ${f.remote}：${f.present ? '存在' : '不存在'} ${f.size ?? '?'}B crc ${f.crc32 || '未知'}${f.error ? ' 错误：' + f.error : ''}`)
  }
  if (r.sysListing) lines.push(`/sys 目录：${r.sysListing.count} 项（返回形状 ${r.sysListing.shape}）`)
  const pm = r.params
  if (pm) lines.push(`参数：读到 ${pm.got}/${pm.total ?? '?'} 原因 ${pm.reason}（${pm.ms ?? '?'}ms）— ${pm.note}`)
  if (r.paramShape) {
    lines.push(`参数名形态：带下划线 ${r.paramShape.withUnderscore} / 不带 ${r.paramShape.withoutUnderscore}｜前缀种类 ${r.paramShape.prefixKinds}｜最长 ${r.paramShape.maxLength} 字节，逼近 16 上限 ${r.paramShape.nearParamIdLimit} 条`)
    lines.push(`前缀样例：${r.paramShape.topPrefixes.map((x) => `${x.prefix}(${x.count})`).join(' ') || '无'}`)
  }
  const au = r.paramAudit
  if (au) {
    const dist = (au.byType || []).map((b) => `${b.text || b.type}(${b.count})`).join(' ')
    const dup = au.duplicatedFrames == null
        ? ''
        : `｜重名帧 ${au.duplicatedFrames}（${au.frames} 帧去重后剩 ${au.total} 名）`
    lines.push(`参数类型分布：${dist || '无'}｜整型 ${au.intTyped} 条链路读不出可信值｜两种读法分歧 ${au.divergingCount} 条${dup}`)
    if ((au.diverging || []).length) {
      lines.push(`分歧样例：${au.diverging.slice(0, 3).map((d) => `${d.name} float=${d.float} 整型=${d.typed}`).join('；')}`)
    }
  }
  const yes = (r.findings || []).filter((x) => x.present).map((x) => x.name)
  const no = (r.findings || []).filter((x) => !x.present).map((x) => x.name)
  lines.push(`窗口内在发：${yes.join(' ') || '无'}`)
  lines.push(`窗口内没收到：${no.join(' ') || '无'}`)
  if (r.consoleProbe) lines.push(`控制台：${r.consoleProbe.responded ? `有回显 ${r.consoleProbe.bytes}B/${r.consoleProbe.lines} 行` : '无回显'}｜${r.consoleProbe.note}`)
  if ((r.errors || []).length) lines.push(`错误 ${r.errors.length} 条：${r.errors.map((e) => `${e.step}=${e.error}`).join('；')}`)
  return lines.join('\n')
}
