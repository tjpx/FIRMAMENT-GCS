/**
 * FTP 下载的字节核算（纯逻辑，无 DOM、无 MAVLink 依赖，便于 selftest 直接跑）。
 *
 * 为什么要有这个文件：飞控固件的 READ_FILE(5) 分支写死了
 *   br = read(fd, data, MAX_FTP_DATA_LEN);
 *   if (br != MAX_FTP_DATA_LEN) return kErrFailErrno;   // ftp_manager.c:256-261
 * 也就是**尾部不足一整包时不返回短包，而是返回 errno=0 的 FailErrno NAK**。
 * 地面站把 errno=0 的 Fail/FailErrno 当成"读完了"（这个兼容本身是为了历史固件），
 * 于是任何长度不是 239 整数倍的文件都会被静默截断到最后一个满包：
 * 真机实测 /sys/param.xml 应为 17570 字节，只拿到 17447 = 239×73；
 * /sys/sysconfig.toml 应为 3011 字节，只拿到 2868 = 239×12。
 * 配置文件被截断后再回传，就是直接损坏飞控配置——所以这里定死两条规则：
 *   1) 下载一律走 BURST_READ_FILE(15)，固件在该分支会把长度夹到剩余字节
 *      （ftp_manager.c:467-468）并在最后一包置 burst_complete（:485-487）；
 *   2) 收尾必须按飞控给出的 st_size 逐字节核对，缺一个字节就报错，绝不"按已读长度结束"。
 */

/**
 * 建立一次下载的状态。expectedSize 必须来自飞控（OPEN 的应答或 LIST 的 st_size），
 * 不接受"不知道多大就先下着看"——那正是截断能被吞掉的前提。
 */
export function createDownloadState({ expectedSize, name = '' } = {}) {
  if (!Number.isInteger(expectedSize) || expectedSize < 0) {
    throw new Error(
      `下载${name ? ` ${name}` : ''}需要飞控上报的文件大小（OPEN/LIST 的 st_size），` +
        '不能靠 EOF 猜长度——猜就会把读失败当成读完成'
    )
  }

  return {
    name,
    expectedSize,
    bytes: new Uint8Array(expectedSize),
    filled: new Uint8Array(expectedSize), // 每字节 0/1，用来识别重复包和缺口
    received: 0,
    packets: 0,
    duplicatePackets: 0,
    overflowBytes: 0,
    sawBurstComplete: false,
  }
}

/**
 * 认领一包 burst 数据。按包自带的 offset 落位，所以乱序、重发都不会错位。
 * @returns {{accepted:number, duplicate:boolean, skipped:boolean, received:number}}
 */
export function acceptBurstPacket(state, packet) {
  const offset = Number(packet?.offset) || 0
  const data = packet?.data
  const declared = Number(packet?.size)

  if (!state || !(data instanceof Uint8Array)) {
    return { accepted: 0, duplicate: false, skipped: true, received: state?.received ?? 0 }
  }

  // 有效长度：以包头声明的 size 为准，同时不超过 data 实长和文件尾
  let len = Number.isFinite(declared) && declared >= 0 ? Math.min(declared, data.length) : data.length

  if (offset + len > state.expectedSize) {
    const over = offset + len - state.expectedSize
    state.overflowBytes += over
    len -= over
  }

  if (len <= 0) {
    return { accepted: 0, duplicate: false, skipped: true, received: state.received }
  }

  let fresh = 0
  for (let i = 0; i < len; i++) {
    const at = offset + i
    if (!state.filled[at]) {
      state.filled[at] = 1
      fresh++
    }
  }

  state.bytes.set(data.subarray(0, len), offset)
  state.received += fresh
  state.packets++

  if (packet.burstComplete) state.sawBurstComplete = true

  return {
    accepted: fresh,
    duplicate: fresh === 0,
    skipped: false,
    received: state.received,
  }
}

/** 还缺哪些字节区间（返回前若干段，用于报错文案） */
export function missingRanges(state, maxRanges = 4) {
  const ranges = []
  let start = -1

  for (let i = 0; i < state.expectedSize; i++) {
    if (!state.filled[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      ranges.push([start, i - 1])
      start = -1
      if (ranges.length >= maxRanges) break
    }
  }

  if (start >= 0 && ranges.length < maxRanges) {
    ranges.push([start, state.expectedSize - 1])
  }

  return ranges
}

export function summarizeDownload(state) {
  if (!state) return null

  const missing = state.expectedSize - state.received

  return {
    name: state.name || null,
    expected: state.expectedSize,
    received: state.received,
    missing,
    ok: missing === 0,
    packets: state.packets,
    duplicatePackets: state.duplicatePackets,
    overflowBytes: state.overflowBytes,
    sawBurstComplete: state.sawBurstComplete,
    missingRanges: missing > 0 ? missingRanges(state) : [],
  }
}

/**
 * 收尾强校验：长度不符就抛错。
 * 尾包被固件报成 errno=0 的 FailErrno、然后被解释成 EOF，就是本次事故的成因；
 * 这里的错误文案必须把差值和区间写出来，方便一眼看出是"少了尾巴"还是"中间丢包"。
 */
export function assertDownloadComplete(state, label) {
  const s = summarizeDownload(state)
  const who = label || s.name || '远程文件'

  if (s.ok) return s

  const ranges = s.missingRanges.map(([a, b]) => `${a}-${b}`).join(', ')

  const err = new Error(
    `${who} 下载不完整：飞控报告 ${s.expected} 字节，只拿到 ${s.received} 字节，` +
      `缺 ${s.missing} 字节${ranges ? `（缺口 ${ranges}${s.missingRanges.length >= 4 ? '…' : ''}）` : ''}。` +
      '禁止把这份内容当作完整文件使用，更不能回传覆盖。'
  )
  err.code = 'IncompleteDownload'
  err.expected = s.expected
  err.received = s.received
  err.missing = s.missing
  throw err
}
