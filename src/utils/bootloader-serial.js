// A timeout poisons this bootloader session: late ACKs cannot be reused.
export async function openBootloaderSerial(port, { baudRate = 115200 } = {}) {
  let reader, writer, loop, pending, failure, closePromise
  let closed = false,
    opened = false,
    buffer = new Uint8Array()
  const timeoutOf = (options, fallback = 3000) => {
    const ms = typeof options === 'number' ? options : (options?.timeoutMs ?? fallback)
    if (!Number.isFinite(ms) || ms <= 0) throw new TypeError('超时必须为正数')
    return ms
  }
  function fail(error) {
    failure ||= error instanceof Error ? error : new Error(String(error))
    buffer = new Uint8Array()
    if (pending) {
      const p = pending
      pending = null
      clearTimeout(p.timer)
      p.reject(failure)
    }
  }
  function check() {
    if (failure) throw failure
    if (closed) throw new Error('烧录串口已关闭')
  }
  function satisfy() {
    if (!pending || buffer.length < pending.count) return
    const p = pending
    pending = null
    clearTimeout(p.timer)
    const bytes = buffer.slice(0, p.count)
    buffer = buffer.slice(p.count)
    p.resolve(bytes)
  }
  const disconnect = () => fail(new Error('烧录设备已断开'))
  function bounded(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`${label}超时`)
        fail(error)
        reject(error)
      }, ms)
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          fail(error)
          reject(error)
        }
      )
    })
  }
  try {
    // If opening times out, close the port when its underlying open eventually settles.
    const opening = port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' })
    Promise.resolve(opening).then(
      () => {
        if (failure && !opened) void port.close().catch(() => {})
      },
      () => {}
    )
    try {
      await bounded(opening, 10000, '打开烧录串口')
    } catch (error) {
      if (failure?.message.includes('超时')) error.ownershipUncertain = true
      throw error
    }
    opened = true
    if (!port.readable || !port.writable) throw new Error('烧录串口不可读写')
    reader = port.readable.getReader()
    writer = port.writable.getWriter()
    port.addEventListener?.('disconnect', disconnect)
    loop = (async () => {
      try {
        while (!closed && !failure) {
          const { value, done } = await reader.read()
          if (closed || failure) break
          if (done) {
            fail(new Error('烧录串口读取结束'))
            break
          }
          if (!value?.length) continue
          const next = new Uint8Array(buffer.length + value.length)
          next.set(buffer)
          next.set(value, buffer.length)
          buffer = next
          satisfy()
        }
      } catch (error) {
        if (!closed) fail(error)
      }
    })()
  } catch (error) {
    try {
      if (reader) await bounded(reader.cancel(), 3000, '取消读取')
    } catch {}
    try {
      reader?.releaseLock()
    } catch {}
    try {
      writer?.releaseLock()
    } catch {}
    if (opened) {
      try {
        await bounded(port.close(), 3000, '关闭串口')
      } catch {
        error.ownershipUncertain = true
      }
    }
    throw error
  }
  return {
    async write(bytes, options) {
      check()
      const ms = timeoutOf(options)
      if (!(bytes instanceof Uint8Array)) throw new TypeError('写入内容必须为 Uint8Array')
      await bounded(writer.write(bytes), ms, '烧录写入')
      check()
    },
    readExact(count, options) {
      try {
        check()
        if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('读取长度必须为非负整数')
        if (pending) throw new Error('不允许并行读取烧录响应')
        const ms = timeoutOf(options)
        if (!count) return Promise.resolve(new Uint8Array())
        return new Promise((resolve, reject) => {
          pending = { count, resolve, reject, timer: setTimeout(() => fail(new Error('烧录读取超时')), ms) }
          satisfy()
        })
      } catch (error) {
        return Promise.reject(error)
      }
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      fail(new Error('烧录串口已关闭'))
      closePromise = (async () => {
        port.removeEventListener?.('disconnect', disconnect)
        try {
          await bounded(reader.cancel(), 3000, '取消烧录读取')
        } catch {}
        try {
          await bounded(loop, 3000, '结束烧录读取')
        } catch {}
        try {
          reader.releaseLock()
        } catch {}
        try {
          await bounded(writer.abort(), 3000, '结束烧录写入')
        } catch {}
        try {
          writer.releaseLock()
        } catch {}
        await bounded(port.close(), 3000, '关闭烧录串口')
      })()
      return closePromise
    },
  }
}
