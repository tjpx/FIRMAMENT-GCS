// src/utils/upload-gate.js
// ================================================================
// 回传闸门：任何往飞控 /sys/ 写配置文件的动作，都必须先过这里（S1）
// ----------------------------------------------------------------
// 为什么单独有这道闸：S0a 真机实测抓到过"缺尾巴的文件被当成完整文件用"——
// 飞控 LIST 上报 /sys/param.xml 是 17570 字节，地面站只拿到 17447。
// 下载侧已经由 ftp-download.js 的硬核对堵住了（长度不够直接抛 IncompleteDownload，
// 文件状态就不会 loaded），但**写侧还需要一道独立的闸**，因为还有别的通路能产出文本：
//   1. 内存里的文档是上一台飞控的（断开没清干净、或者手动改了缓存）；
//   2. 整本重新序列化（parameter.vue 那条老通路）丢了注释、丢了行、换了编码；
//   3. 下载失败但界面上仍然出现了"改动"，一保存就把飞控配置覆盖成近乎空的内容。
// 这三条的共性是：**我们并不确定这份文本是飞控那份文件的完整版**，那就一律不许写回去。
//
// 规则（按顺序判定，第一个命中的就是结论）：
//   NOT_LOADED       没有从飞控成功下载到过完整文件（present/loaded 任一为假，或带下载错误）
//   NO_SIZE          下载时飞控没上报过大小 ⇒ 长度核对无从谈起
//   EMPTY_CONTENT    要写回去的字节数是 0
//   UNEXPLAINED_DELTA 长度和下载时不一样，却拿不出任何一条定点改动 ⇒ 这文本不是从原文改出来的
//   SHRUNK           比下载到的原文短过阈值（默认 10%）⇒ 除非显式 force，一律拦
//   （只警告不拦）缩短 2%~10%、或变长，这些定点改动都可能出现，交给回读 CRC32 兜底
//
// 这里只有纯逻辑：不碰 Vue、不碰串口、不发 MAVLink，自测直接拿真机实测数字回归。
// 上传之后的"写对没写对"不归这里管：ftp.upload 会整份回读，先比字节数再比 CRC32
// （useMavlink.js:1242 与 :1255），因为飞控的 ftp_manager.c 不支持 CALC_FILE_CRC32。
// ================================================================

/** 缩短多少比例开始提示、多少比例直接拦（定点改动的字节差通常在 1% 以内） */
export const SHRINK_WARN_RATIO = 0.02
export const SHRINK_BLOCK_RATIO = 0.1

export const GATE_CODE = {
  OK: 'ok',
  NOT_CONNECTED: 'not-connected',
  BUSY: 'busy',
  NOT_LOADED: 'not-loaded',
  NO_SIZE: 'no-size',
  EMPTY_CONTENT: 'empty-content',
  UNEXPLAINED_DELTA: 'unexplained-delta',
  SHRUNK: 'shrunken-content',
}

const DASH = '—'

function num(v) {
  return Number.isFinite(v) ? v : NaN
}

function fmtBytes(v) {
  const n = num(v)
  return Number.isNaN(n) ? DASH : String(Math.trunc(n))
}

function fmtPct(part, whole) {
  if (!(whole > 0) || Number.isNaN(part)) return DASH
  return `${((part / whole) * 100).toFixed(1)}%`
}

/**
 * 单个文件的回传判定。
 * @param {object} f
 * @param {string} [f.label]        文件名（界面用），缺省退回 remote
 * @param {string} [f.remote]       远端路径
 * @param {boolean} [f.loaded]      内存里有没有从飞控下载成功的那份文档
 * @param {boolean} [f.present]     飞控上到底有没有这个文件（下载被拒就是没有）
 * @param {string} [f.error]        下载时留下的错误原文，有就一并写进理由，不藏
 * @param {number} [f.size]         下载那一刻飞控上报/实际拿到的字节数
 * @param {number} [f.bytes]        现在准备写回去的字节数
 * @param {number} [f.changeCount]  定点改动条数（长度变了却为 0 ⇒ 改动来源不明）
 * @param {boolean} [f.force]       明知缩短仍要写（默认 false，且界面不许给普通用户这个开关）
 * @returns {{code:string, allowed:boolean, reason:string, warn:string, label:string, remote:string, size:number, bytes:number, changeCount:number, shortfall:number}}
 */
export function gateUploadFile(f = {}) {
  const label = f.label || f.remote || '配置文件'
  const remote = f.remote || ''
  const size = num(f.size)
  const bytes = num(f.bytes)
  const changes = Number.isFinite(num(f.changeCount)) ? Math.max(0, Math.trunc(f.changeCount)) : 0
  const force = f.force === true
  const errText = f.error ? String(f.error) : ''

  const make = (code, allowed, reason, warn = '') => ({
    code,
    allowed,
    reason,
    warn,
    key: f.key || '',
    label,
    remote,
    size: Number.isNaN(size) ? 0 : size,
    bytes: Number.isNaN(bytes) ? 0 : bytes,
    changeCount: changes,
    shortfall: Number.isNaN(size) || Number.isNaN(bytes) ? 0 : Math.max(0, size - bytes),
  })

  if (!f.loaded || !f.present) {
    const why = errText ? `下载记录：${errText}。` : ''
    return make(
      GATE_CODE.NOT_LOADED,
      false,
      `${label} 没有从飞控完整下载到过（present=${f.present ? '是' : '否'}，loaded=${f.loaded ? '是' : '否'}）。` +
        `${why}禁止回传：飞控上那份文件会被覆盖成一份我们并不确定完整的内容。` +
        '请先重新读取配置文件，确认下载成功再保存。'
    )
  }

  if (!(size > 0)) {
    return make(
      GATE_CODE.NO_SIZE,
      false,
      `${label} 下载时飞控没有上报文件大小，长度核对无从做起，禁止回传。` +
        '请重新读取配置文件（下载侧会硬核对字节数）。'
    )
  }

  if (!(bytes > 0)) {
    return make(
      GATE_CODE.EMPTY_CONTENT,
      false,
      `${label} 当前内容是空的（0 字节），禁止回传：这等于把飞控的配置文件清成空文件。`
    )
  }

  const delta = bytes - size
  const shortfall = delta < 0 ? -delta : 0
  const ratio = shortfall / size

  if (delta !== 0 && changes === 0) {
    return make(
      GATE_CODE.UNEXPLAINED_DELTA,
      false,
      `${label} 的文本长度与下载时不同（飞控 ${fmtBytes(size)} 字节 → 本地 ${fmtBytes(bytes)} 字节），` +
        '但一条定点改动都拿不出来：说明这份文本不是从飞控原文改出来的（多半是整本重新序列化丢了东西）。' +
        '禁止回传。'
    )
  }

  if (ratio >= SHRINK_BLOCK_RATIO && !force) {
    return make(
      GATE_CODE.SHRUNK,
      false,
      `${label} 比飞控上的原文短了 ${fmtBytes(shortfall)} 字节（${fmtPct(shortfall, size)}，` +
        `阈值 ${fmtPct(SHRINK_BLOCK_RATIO * size, size)}），改动 ${changes} 处。` +
        '这么大的缩短不像是改参数改出来的，禁止回传；请核对改动明细或放弃改动。'
    )
  }

  if (ratio >= SHRINK_BLOCK_RATIO && force) {
    return make(
      GATE_CODE.OK,
      true,
      `已强制回传 ${label}：内容比原文短 ${fmtBytes(shortfall)} 字节（${fmtPct(shortfall, size)}）。`,
      `强制放行：${label} 缩短 ${fmtBytes(shortfall)} 字节（${fmtPct(shortfall, size)}），飞控开机读配置时可能少参数。`
    )
  }

  if (ratio >= SHRINK_WARN_RATIO) {
    return make(
      GATE_CODE.OK,
      true,
      '',
      `${label} 比原文短 ${fmtBytes(shortfall)} 字节（${fmtPct(shortfall, size)}），` +
        `改动 ${changes} 处；上传后会整份回读比 CRC32。`
    )
  }

  return make(GATE_CODE.OK, true, '', '')
}

/**
 * 一批文件的回传计划。整批性阻断（未连接/正忙）时不再逐文件判定。
 * @param {{connected?:boolean, busy?:string|boolean, files?:Array, force?:boolean}} opts
 * @returns {{ok:boolean, ready:boolean, code:string, error:string, allowed:Array, blocked:Array, warns:Array}}
 */
export function planUpload(opts = {}) {
  const files = Array.isArray(opts.files) ? opts.files : []
  const empty = { ok: false, ready: false, code: '', error: '', allowed: [], blocked: [], warns: [], byKey: {} }

  if (opts.connected !== true) {
    return { ...empty, code: GATE_CODE.NOT_CONNECTED, error: '飞控未连接，不做任何上传' }
  }
  if (opts.busy) {
    return { ...empty, code: GATE_CODE.BUSY, error: '正在忙，请等当前传输结束' }
  }
  if (!files.length) {
    return { ...empty, code: 'nothing-to-save', error: '没有待保存的改动' }
  }

  const results = files.map((f) => gateUploadFile({ ...f, force: opts.force === true }))
  const allowed = results.filter((r) => r.allowed)
  const blocked = results.filter((r) => !r.allowed)
  const warns = allowed.filter((r) => r.warn)
  // 界面（右下角保存条）要按文件 key 取结论，不能让每个调用方自己再匹配一遍
  const byKey = Object.fromEntries(results.filter((r) => r.key).map((r) => [r.key, r]))

  return {
    byKey,
    ok: blocked.length === 0 && allowed.length > 0,
    ready: allowed.length > 0,
    code: blocked.length ? blocked[0].code : GATE_CODE.OK,
    error: blocked.map((r) => r.reason).join('；'),
    allowed,
    blocked,
    warns,
  }
}
