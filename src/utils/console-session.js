// src/utils/console-session.js
// 控制台会话层：不依赖 DOM，供页面命令和 CLI 终端共用。
// 固件 shell 是单一、可被打断的会话；这里不伪造命令成功，只根据实际回显结束。

const DEFAULT_PROMPT = /(?:^|\n)msh\s[^\r\n>]*>\s*$/

/**
 * 创建一个控制台会话：把飞控 shell 当成**一条独占、可被打断、单次只能有一条命令**的通道。
 *
 * 为什么要有这一层：SERIAL_CONTROL 桥接过去之后，飞控那侧只有**一个** shell。若两个页面（比如
 * 用户在 CLI 里敲命令的同时，参数页在跑 `param save`）各发各的，回显会互相串——最坏的结果是把
 * A 命令的输出当成 B 命令的成功证据。所以这里做三件事：
 *
 * 1. **串行化**：`active` 一次只挂一条命令，重复进入直接以 `CONSOLE_BUSY` 拒绝，而不是排队。
 *    排队会让"点下去等了 30 秒才执行"这种危险情形变得不可见，明确拒绝更好。
 * 2. **不伪造成功**：完成条件只有两个——匹配到 `until` / 提示符，或静默 `idleMs` 且**确实收到过
 *    回显**（`job.seen`）。超时、发送失败、取消一律 `ok: false`。`seen` 这个条件专门排除
 *    "命令根本没发出去、于是也永远没有回显"被当成成功。
 * 3. **事务独占**：`withTransaction` 期间其他来源一律拒绝，事务内部可以用同一个 owner 连续发多条
 *    命令（参数保存就是这种形态）。
 *
 * 已知的固件行为（`cancel()` 里那条 700ms 兜底）：`act` / `mcn` 收到任意键后会恢复提示符，但
 * 提示符未必回传；如果不设兜底，一次取消就能把锁永久占住，整个控制台再也发不出命令。
 *
 * @param {object} options
 * @param {(text:string, meta?:{owner?:unknown})=>unknown} options.send 实际写串口的函数；可以返回
 *   Promise（异步写），此时回显会先缓冲，等写完成后再喂给匹配逻辑
 * @param {() => boolean} [options.isConnected] 链路是否可用；返回 false 时发命令直接拒绝
 * @param {number} [options.idleMs=350] 静默多少毫秒后认为命令结束（0 表示不用这个判据）
 * @param {number} [options.defaultTimeoutMs=6000] 单条命令的硬超时
 * @param {string} [options.stopByte='\x03'] 取消时发送的中断字节
 * @param {RegExp} [options.prompt] 提示符判据，默认 `msh ... >`
 * @returns 会话对象：`run` / `hold` / `feed` / `cancel` / `reset` / `withTransaction` /
 *   `canSend(owner)` / `transactionLocked` / `state` / `subscribe` / `transcript`
 */
export function createConsoleSession({
  send,
  isConnected = () => true,
  idleMs = 350,
  defaultTimeoutMs = 6000,
  stopByte = '\x03',
  prompt = DEFAULT_PROMPT,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('console session requires send()')

  const transcript = []
  const listeners = new Set()
  let active = null
  let seq = 0
  let transaction = null

  const state = { busy: false, command: '', startedAt: 0, kind: '', lastError: '' }
  const publish = (event) =>
    listeners.forEach((fn) => {
      try {
        fn(event)
      } catch {}
    })
  const setBusy = (value, command = '', kind = '') => {
    state.busy = value
    state.command = command
    state.startedAt = value ? Date.now() : 0
    state.kind = kind
    publish({ type: 'state', state: { ...state } })
  }
  const remember = (text, type = 'rx') => {
    if (!text) return
    transcript.push({ type, text, at: Date.now() })
    if (transcript.length > 500) transcript.splice(0, transcript.length - 500)
    publish({ type, text, transcript: transcript.slice() })
  }
  const clearTimers = (job) => {
    if (job.idleTimer) clearTimeout(job.idleTimer)
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer)
    job.idleTimer = null
    job.timeoutTimer = null
  }
  const finish = (job, result) => {
    if (!active || active !== job || job.done) return
    job.done = true
    clearTimers(job)
    active = null
    if (transaction) setBusy(true, '参数保存事务', 'transaction')
    else setBusy(false)
    publish({ type: 'done', result })
    job.resolve(result)
  }
  const armIdle = (job) => {
    if (job.idleMs <= 0) return
    if (job.idleTimer) clearTimeout(job.idleTimer)
    job.idleTimer = setTimeout(() => {
      if (!active || active !== job || job.done || job.hold) return
      if (!job.seen) return
      finish(job, { ok: true, reason: 'idle', text: job.text })
    }, job.idleMs)
  }
  const matcher = (until, text) => {
    if (!until) return false
    if (typeof until === 'function') return !!until(text)
    if (until instanceof RegExp) return until.test(text)
    return text.includes(String(until))
  }
  const createJob = (command, options, kind, owner = null) => {
    if (transaction && transaction !== owner)
      return Promise.reject(Object.assign(new Error('控制台正忙：参数保存事务'), { code: 'CONSOLE_BUSY' }))
    if (active) return Promise.reject(Object.assign(new Error('控制台正忙：已有命令会话'), { code: 'CONSOLE_BUSY' }))
    if (!isConnected()) return Promise.reject(Object.assign(new Error('控制台未连接'), { code: 'CONSOLE_OFFLINE' }))
    const commandText = String(command)
    const opts = options || {}
    let resolve
    const promise = new Promise((r) => {
      resolve = r
    })
    const job = {
      id: ++seq,
      command: commandText,
      text: '',
      seen: false,
      done: false,
      resolve,
      idleTimer: null,
      timeoutTimer: null,
      idleMs: opts.idleMs ?? idleMs,
      until: opts.until,
      hold: !!opts.hold,
      timeoutMs: opts.timeoutMs ?? defaultTimeoutMs,
    }
    active = job
    setBusy(true, commandText, kind)
    const wire = commandText.endsWith('\r') ? commandText : commandText + '\r'
    remember(wire, 'tx')
    try {
      const sent = send(wire, { owner })
      if (sent && typeof sent.then === 'function') {
        job.sending = true
        sent.then(
          () => {
            if (active !== job || job.done) return
            job.sending = false
            if (job.buffered) {
              const text = job.buffered
              job.buffered = ''
              feed(text, false)
            }
          },
          (e) => finish(job, { ok: false, reason: 'send-error', error: e, text: job.text })
        )
      }
    } catch (e) {
      finish(job, { ok: false, reason: 'send-error', error: e, text: '' })
      return promise
    }
    job.timeoutTimer = setTimeout(() => finish(job, { ok: false, reason: 'timeout', text: job.text }), job.timeoutMs)
    return promise
  }

  function feed(text, record = true) {
    if (!text) return
    if (record) remember(text, 'rx')
    if (!active) return
    if (active.sending) {
      active.buffered = (active.buffered || '') + text
      return
    }
    active.seen = true
    active.text += text
    if (!active.hold && (matcher(active.until, active.text) || (!active.until && prompt.test(active.text)))) {
      finish(active, { ok: true, reason: 'matched', text: active.text })
      return
    }
    armIdle(active)
  }

  /**
   * 发一条命令并等它结束。成功条件是"匹配到 until / 提示符"或"有回显且静默 idleMs"，
   * 失败会带 reason：`timeout` / `send-error` / `cancelled` / `transaction-ended`。
   * 同一条会话同时只允许一条，重复进入以 `CONSOLE_BUSY` 拒绝（不排队）。
   */
  function run(command, options = {}) {
    return createJob(command, options, 'request')
  }

  /**
   * 发一条**持续输出**的命令并立刻返回（不等结束）：`hold` 会跳过提示符/静默判据，只能由
   * `cancel()` 或 `reset()` 收尾。用途是波形、`param list` 这类会刷屏的命令——它们通常永远
   * 不会出现一次干净的提示符匹配，用 `run` 只会一路等到超时。
   */
  function hold(command, options = {}) {
    return createJob(command, { ...options, hold: true }, 'stream')
  }

  /**
   * 取消当前命令：先发中断字节，再在 700ms 后无条件结束任务（结果 `ok: false`）。
   *
   * 那 700ms 是兜底而不是等待：`act` / `mcn` 收到任意键后会恢复提示符，但提示符**未必**回传。
   * 没有这个兜底的话，一次取消就能把 `active` 永久占住——整个控制台之后再也发不出命令，
   * 且现象是"点了没反应"，非常难查。
   *
   * @returns {boolean} 是否真的取消了（没有活动任务时返回 false）
   */
  function cancel(reason = 'cancelled') {
    const job = active
    if (!job || job.done) return false
    try {
      send(stopByte)
    } catch {}
    publish({ type: 'cancel', command: job.command, reason })
    // act/mcn 的固件收到任意键后会恢复提示符；提示符未回传时也不能永远占锁。
    setTimeout(() => finish(job, { ok: false, reason, text: job.text }), 700)
    return true
  }

  /**
   * 独占式连续命令块：期间其他来源一律 `CONSOLE_BUSY`，只有回调拿到的 `run()` 能发命令。
   *
   * 参数保存用它，是因为"改一串参数然后 `param save`"必须整体成立：中途被别的页面插一条命令，
   * 回显就分不清是谁的，保存到底成功没有也就无从判断。owner 是一个新对象，用它区分
   * "事务内的自己人"和"事务外的别人"——事务结束后 owner 失配，回调若还留着 `run` 再用也会被拒。
   *
   * @param {(tx:{run:(command:string, options?:object)=>Promise<object>}) => Promise<unknown>} callback
   * @returns callback 的返回值
   * @throws `CONSOLE_BUSY`（已有会话或事务）/ `CONSOLE_OFFLINE`（未连接）
   */
  async function withTransaction(callback) {
    if (active || transaction) throw Object.assign(new Error('控制台正忙：已有命令会话'), { code: 'CONSOLE_BUSY' })
    if (!isConnected()) throw Object.assign(new Error('控制台未连接'), { code: 'CONSOLE_OFFLINE' })
    const owner = {}
    transaction = owner
    setBusy(true, '参数保存事务', 'transaction')
    try {
      return await callback({
        run(command, options = {}) {
          if (transaction !== owner) return Promise.reject(new Error('参数保存事务已失效'))
          return createJob(command, options, 'transaction', owner)
        },
      })
    } finally {
      if (transaction === owner) {
        transaction = null
        if (active) finish(active, { ok: false, reason: 'transaction-ended', text: active.text })
        setBusy(false)
      }
    }
  }

  function reset(reason = 'reset') {
    transaction = null
    const job = active
    if (job) finish(job, { ok: false, reason, text: job.text })
    else setBusy(false)
    transcript.length = 0
    publish({ type: 'reset', reason })
  }

  return {
    withTransaction,
    get transactionLocked() {
      return !!transaction
    },
    canSend(owner) {
      return !transaction || transaction === owner
    },
    state,
    run,
    hold,
    feed,
    cancel,
    reset,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    transcript() {
      return transcript.slice()
    },
  }
}

export const CONSOLE_REPLY = Object.freeze({
  prompt: DEFAULT_PROMPT,
  actRunning: /Press any key to stop\.?/i,
  actDisarmed: /act set command only allowed when disarmed/i,
  dshotSent: /dshot .* sent to .* channel mask 0x[0-9a-f]+/i,
})

export function actSetCommand({ device = 'main_out', all, channels, mask } = {}) {
  if (!device) throw new TypeError('act device is required')
  if (all != null) return `act set -a -d ${device} ${Number(all)}`
  if (!Array.isArray(channels) || !channels.length) throw new TypeError('act channels are required')
  const selected = mask == null ? (1 << channels.length) - 1 : Number(mask)
  return `act set -d ${device} -c ${selected.toString(16)} ${channels.map(Number).join(' ')}`
}

export function actGetCommand({ device = 'main_out', mask = 'f' } = {}) {
  if (!device || !mask) throw new TypeError('act get device and mask are required')
  return `act get -d ${device} -c ${mask}`
}

export function dshotCommand({ command, device = 'main_out', all = false, mask = 'f' } = {}) {
  if (!/^(reverse|normal|save|beep[1-5])$/.test(command || '')) throw new TypeError('unsupported dshot command')
  return `dshot ${command} -${all ? 'a' : `c ${mask}`} -d ${device}`
}

export function calibrationListCommand() {
  return 'param list CALIB'
}
export function calibrationSaveCommand() {
  return 'param save'
}

export function replySaysDisarmed(text) {
  return /(?:act set command only allowed when disarmed|dshot commands are only allowed when disarmed)/i.test(
    String(text || '')
  )
}
