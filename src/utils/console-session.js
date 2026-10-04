// src/utils/console-session.js
// 控制台会话层：不依赖 DOM，供页面命令和 CLI 终端共用。
// 固件 shell 是单一、可被打断的会话；这里不伪造命令成功，只根据实际回显结束。

const DEFAULT_PROMPT = /(?:^|\n)msh\s[^\r\n>]*>\s*$/

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
  const publish = (event) => listeners.forEach((fn) => { try { fn(event) } catch {} })
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
    if (transaction && transaction !== owner) return Promise.reject(Object.assign(new Error('控制台正忙：参数保存事务'), { code: 'CONSOLE_BUSY' }))
    if (active) return Promise.reject(Object.assign(new Error('控制台正忙：已有命令会话'), { code: 'CONSOLE_BUSY' }))
    if (!isConnected()) return Promise.reject(Object.assign(new Error('控制台未连接'), { code: 'CONSOLE_OFFLINE' }))
    const commandText = String(command)
    const opts = options || {}
    let resolve
    const promise = new Promise((r) => { resolve = r })
    const job = {
      id: ++seq, command: commandText, text: '', seen: false, done: false,
      resolve, idleTimer: null, timeoutTimer: null,
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
        sent.then(() => {
          if (active !== job || job.done) return
          job.sending = false
          if (job.buffered) { const text = job.buffered; job.buffered = ''; feed(text, false) }
        }, e => finish(job, { ok: false, reason: 'send-error', error: e, text: job.text }))
      }
    } catch (e) { finish(job, { ok: false, reason: 'send-error', error: e, text: '' }); return promise }
    job.timeoutTimer = setTimeout(() => finish(job, { ok: false, reason: 'timeout', text: job.text }), job.timeoutMs)
    return promise
  }

  function feed(text, record = true) {
    if (!text) return
    if (record) remember(text, 'rx')
    if (!active) return
    if (active.sending) { active.buffered = (active.buffered || '') + text; return }
    active.seen = true
    active.text += text
    if (!active.hold && (matcher(active.until, active.text) || (!active.until && prompt.test(active.text)))) {
      finish(active, { ok: true, reason: 'matched', text: active.text })
      return
    }
    armIdle(active)
  }

  function run(command, options = {}) { return createJob(command, options, 'request') }
  function hold(command, options = {}) { return createJob(command, { ...options, hold: true }, 'stream') }

  function cancel(reason = 'cancelled') {
    const job = active
    if (!job || job.done) return false
    try { send(stopByte) } catch {}
    publish({ type: 'cancel', command: job.command, reason })
    // act/mcn 的固件收到任意键后会恢复提示符；提示符未回传时也不能永远占锁。
    setTimeout(() => finish(job, { ok: false, reason, text: job.text }), 700)
    return true
  }

  async function withTransaction(callback) {
    if (active || transaction) throw Object.assign(new Error('控制台正忙：已有命令会话'), { code: 'CONSOLE_BUSY' })
    if (!isConnected()) throw Object.assign(new Error('控制台未连接'), { code: 'CONSOLE_OFFLINE' })
    const owner = {}
    transaction = owner
    setBusy(true, '参数保存事务', 'transaction')
    try {
      return await callback({ run(command, options = {}) {
        if (transaction !== owner) return Promise.reject(new Error('参数保存事务已失效'))
        return createJob(command, options, 'transaction', owner)
      } })
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
    get transactionLocked() { return !!transaction },
    canSend(owner) { return !transaction || transaction === owner },
    state,
    run,
    hold,
    feed,
    cancel,
    reset,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    transcript() { return transcript.slice() },
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
  const selected = mask == null ? ((1 << channels.length) - 1) : Number(mask)
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

export function calibrationListCommand() { return 'param list CALIB' }
export function calibrationSaveCommand() { return 'param save' }

export function replySaysDisarmed(text) {
  return /(?:act set command only allowed when disarmed|dshot commands are only allowed when disarmed)/i.test(String(text || ''))
}
