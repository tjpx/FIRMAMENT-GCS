import { watch } from 'vue'

export const CLI_HISTORY_MAX_CHARS = 256 * 1024
export const CLI_HISTORY_MAX_ENTRIES = 2000
export const CLI_SESSION_START = '\r\n\x1b[90m──── CLI 会话开始 ────\x1b[0m\r\n'
export const CLI_SESSION_END = '\r\n\x1b[90m──── CLI 会话结束：连接已断开 ────\x1b[0m\r\n'

/** Only device output and session boundaries belong here; never input or telemetry. */
export function createCliHistory({ maxChars = CLI_HISTORY_MAX_CHARS, maxEntries = CLI_HISTORY_MAX_ENTRIES } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1 || !Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('CLI history bounds must be positive integers')
  }
  const entries = []
  const subscribers = new Set()
  let size = 0
  let connected = false
  const snapshot = () => entries.join('')
  const notify = (change) => subscribers.forEach((listener) => listener(change))
  function append(output) {
    if (typeof output !== 'string' || !output) return
    let text = output
    let trimmed = false
    if (text.length > maxChars) {
      // Drop a partial oldest line where possible. Never remove ANSI from normal chunks.
      text = text.slice(-maxChars)
      const newline = text.indexOf('\n')
      if (newline >= 0 && newline < text.length - 1) text = text.slice(newline + 1)
      trimmed = true
    }
    entries.push(text)
    size += text.length
    while (size > maxChars || entries.length > maxEntries) {
      size -= entries.shift().length
      trimmed = true
    }
    notify(trimmed ? { type: 'reset', text: snapshot() } : { type: 'append', text })
  }
  return {
    snapshot,
    append,
    setConnected(value) {
      const next = value === true
      if (next === connected) return
      connected = next
      append(next ? CLI_SESSION_START : CLI_SESSION_END)
    },
    clear() {
      entries.length = 0
      size = 0
      notify({ type: 'reset', text: '' })
    },
    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
  }
}

const histories = new WeakMap()
const attachments = new WeakMap()
export function getCliHistory(mav) {
  if (!histories.has(mav)) histories.set(mav, createCliHistory())
  return histories.get(mav)
}

/** App owns this attachment, not the routed terminal. Call its cleanup at App teardown. */
export function attachCliHistory(mav) {
  if (attachments.has(mav)) return attachments.get(mav)
  const history = getCliHistory(mav)
  const unbindCli = mav.on('cli', (text) => history.append(text))
  const stopConnectionWatch = watch(
    () => mav.connected.value,
    (value) => history.setConnected(value),
    {
      immediate: true,
      flush: 'sync',
    }
  )
  let active = true
  const detach = () => {
    if (!active) return
    active = false
    unbindCli()
    stopConnectionWatch()
    attachments.delete(mav)
  }
  attachments.set(mav, detach)
  return detach
}
