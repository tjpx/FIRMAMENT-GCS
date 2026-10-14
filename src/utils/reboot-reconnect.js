// 重启流程独立于传输层，自测无需真实串口。
export function rebootError(code, message) {
  return Object.assign(new Error(message), { code })
}

// USB 型号并非唯一身份：优先此前同一个已授权对象，否则只允许唯一型号匹配。
export function selectAuthorizedPort(ports, previous, info = {}) {
  if (ports.includes(previous)) return previous
  const keys = ['usbVendorId', 'usbProductId', 'bluetoothServiceClassId'].filter((k) => info[k] != null)
  if (!keys.length) return null
  const matches = ports.filter((port) => {
    const next = port.getInfo()
    return keys.every((k) => next[k] === info[k])
  })
  return matches.length === 1 ? matches[0] : null
}

export function createRebootReconnect(io, { timeoutMs = 30000, gapMs = 3500, retryMs = 500 } = {}) {
  let active = null
  function cancel() {
    active?.abort.abort(rebootError('RECONNECT_CANCELLED', '自动重连已取消'))
  }
  async function run({ onStage } = {}) {
    if (active) throw rebootError('RECONNECT_BUSY', '正在重启并重连')
    io.assertSafe()
    const abort = new AbortController()
    active = { abort }
    let timer, waitTimer, unsubscribe
    const stage = (value) => {
      io.setStage(value)
      try {
        onStage?.(value)
      } catch {
        /* 界面回调不影响安全流程 */
      }
    }
    const signal = abort.signal
    // 所有等待（写入、打开、获取授权端口）共享取消信号和总时限。
    const bounded = (promise) =>
      new Promise((resolve, reject) => {
        const stop = () => reject(signal.reason)
        if (signal.aborted) return stop()
        signal.addEventListener('abort', stop, { once: true })
        Promise.resolve(promise)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', stop))
      })
    const sleep = () =>
      bounded(
        new Promise((resolve) => {
          waitTimer = setTimeout(resolve, retryMs)
        })
      )
    let sentAt = 0,
      lastAt = 0,
      evidence = false,
      fresh = false
    try {
      const target = io.capture()
      // 发送前订阅，避免漏掉快速 USB 失联。
      unsubscribe = io.subscribe((event) => {
        if (event.type === 'lost') {
          evidence = true
          return
        }
        if (event.type !== 'heartbeat' || !sentAt || event.sysid !== target.sysid || event.compid !== target.compid)
          return
        const at = event.at
        if (at - Math.max(lastAt, sentAt) >= gapMs) evidence = true
        if (evidence && at >= sentAt) fresh = true
        lastAt = at
      })
      timer = setTimeout(
        () => abort.abort(rebootError('RECONNECT_TIMEOUT', '重启后未在限时内确认新的飞控心跳')),
        timeoutMs
      )
      io.setActive(true)
      stage('sending-reboot')
      await bounded(io.sendReboot(signal)) // 必须等待 writer.write 完成，入队不算发出。
      sentAt = Date.now()
      lastAt = sentAt
      stage('waiting-offline')
      while (!fresh) {
        if (signal.aborted) throw signal.reason
        if (!io.isConnected()) {
          evidence = true
          stage('reconnecting')
          // 自动重连禁止 requestPort，只使用浏览器已授权端口。
          const ports = await bounded(io.getPorts())
          const port = selectAuthorizedPort(ports, target.port, target.info)
          if (port) {
            try {
              await bounded(io.connect(port, signal))
              stage('waiting-heartbeat')
            } catch (err) {
              if (signal.aborted) throw signal.reason
              // 端口暂时失联或打开失败，在总时限内重试。
            }
          }
        } else if (Date.now() - Math.max(lastAt, sentAt) >= gapMs) {
          evidence = true
          stage('waiting-heartbeat')
        }
        if (!fresh) await sleep()
      }
      stage('online')
      return { ok: true, reason: 'heartbeat', reconnected: true }
    } catch (err) {
      stage(err.code === 'RECONNECT_CANCELLED' ? 'cancelled' : 'failed')
      throw err
    } finally {
      clearTimeout(timer)
      clearTimeout(waitTimer)
      unsubscribe?.()
      active = null
      io.setActive(false)
      // 结束或取消也会使尚未完成的端口打开操作失效。
      abort.abort(rebootError('RECONNECT_FINISHED', '自动重连流程已结束'))
    }
  }
  return { run, cancel }
}
