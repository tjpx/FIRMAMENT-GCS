/* Independent implementation based on PX4/FMT uploader protocol:
 * https://raw.githubusercontent.com/Firmament-Autopilot/FMT-Firmware/master/target/sieon/s1/uploader.py
 * CRC reflected 0xEDB88320 seed zero, no final xor. No MAVLink or device opening.
 */
export const S1_BOARD_ID = 1188
export const S1_APP_BASE = 0x08020000
export const S1_APP_MAX_SIZE = 1966080
export const PX4_BOOTLOADER = Object.freeze({
  INSYNC: 0x12,
  OK: 0x10,
  FAILED: 0x11,
  INVALID: 0x13,
  BAD_SILICON_REV: 0x14,
  EOC: 0x20,
  GET_SYNC: 0x21,
  GET_DEVICE: 0x22,
  CHIP_ERASE: 0x23,
  PROG_MULTI: 0x27,
  GET_CRC: 0x29,
  REBOOT: 0x30,
  PROG_MULTI_MAX: 224,
  PROGRAM_CHUNK: 64,
})
const P = PX4_BOOTLOADER

/**
 * 引导器协议的失败信号。
 *
 * `destructive` 是本模块最重要的一个语义位，它回答的问题是「这次失败之后，飞控里的固件是否
 * 还有可能已经被改动」。上游 uploader 的擦除是**整片** erase：一旦擦除命令发出去，无论后面哪一步
 * 失败，应用区都可能已经是空的。所以失败必须能被上层分成两类，前者允许原样重试，后者只能让用户
 * 重新进引导器——界面据此决定显示"重试"还是"重新连接引导器"，两者混用会让人以为可以随便重来。
 *
 * - `destructive === false`：失败发生在擦除之前（识别板型、校验镜像、参数检查），飞控可照常启动。
 * - `destructive === true`：擦除已经开始或可能已经开始，**不要**自动重试。`flash()` 内部另有
 *   `failedDestructive` 闸门，会拒绝同一会话里的第二次擦写，这不是重复保险而是必要保险。
 *
 * `destructiveStarted` 是给界面用的同义字段：只要这个实例曾经把 destructive 置起，它就一直是
 * true，即使后续步骤成功也一样——因为擦除这个动作本身已经发生过了。
 */
export class BootloaderError extends Error {
  /**
   * @param {string} message 面向用户的中文原因（界面直接显示）
   * @param {boolean} [destructive=false] 见类注释：失败时飞控是否可能已被改动
   * @param {unknown} [cause] 原始异常，便于日志追溯
   */
  constructor(message, destructive = false, cause) {
    super(message, { cause })
    this.name = 'BootloaderError'
    this.destructive = destructive
    this.destructiveStarted = destructive
  }
}
function bytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw new TypeError('固件必须是 Uint8Array 或 ArrayBuffer')
}
function flashSizeValid(size) {
  return Number.isSafeInteger(size) && size >= 8 && size % 4 === 0 && size <= S1_APP_MAX_SIZE
}
export function alignFirmwareImage(input) {
  const image = bytes(input)
  const padded = new Uint8Array(Math.ceil(image.length / 4) * 4)
  padded.fill(0xff)
  padded.set(image)
  return padded
}
export function validateS1Image(input, flashSize = S1_APP_MAX_SIZE) {
  const image = bytes(input)
  if (!flashSizeValid(flashSize)) throw new BootloaderError('S1 引导器报告的可写容量无效或超出应用区')
  if (image.length < 8 || Math.ceil(image.length / 4) * 4 > flashSize)
    throw new BootloaderError('固件缺少向量表或超出可写容量')
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const stackPointer = view.getUint32(0, true)
  const resetVector = view.getUint32(4, true)
  if (stackPointer <= 0x24000000 || stackPointer > 0x24080000 || stackPointer % 8 !== 0)
    throw new BootloaderError('固件初始栈指针不在 S1 RAM 范围内')
  const resetAddress = resetVector & 0xfffffffe
  if (!(resetVector & 1) || resetAddress < S1_APP_BASE + 8 || resetAddress >= S1_APP_BASE + image.length)
    throw new BootloaderError('固件复位向量不属于 S1 应用区')
  return { stackPointer, resetVector, imageSize: image.length, alignedSize: Math.ceil(image.length / 4) * 4 }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})
export function bootloaderCrc32(input, seed = 0) {
  let state = seed >>> 0
  for (const byte of bytes(input)) state = (crcTable[(state ^ byte) & 0xff] ^ (state >>> 8)) >>> 0
  return state
}
export function firmwareCrc32(input, flashSize) {
  const image = bytes(input)
  if (!flashSizeValid(flashSize) || image.length > flashSize) throw new BootloaderError('CRC 可写容量无效')
  let state = bootloaderCrc32(image)
  for (let i = image.length; i < flashSize; i++) state = (crcTable[(state ^ 0xff) & 0xff] ^ (state >>> 8)) >>> 0
  return state
}
/**
 * 创建一个「固件烧录器」会话：在一条已打开的串口上传送 PX4/FMT 引导器协议。
 *
 * Transport io.write(bytes), io.readExact(count, timeoutMs) enforces deadlines,
 * assembles split serial reads and owns device exclusively. ACKs are sequential.
 * No retry/automatic erase. Observer failures do not interrupt device commands.
 *
 * 契约（改动前请逐条读完，这几条都是实测踩出来的）：
 *
 * 1. **不碰 MAVLink，也不自己开串口**。本模块只认 `write` / `readExact`，端口归属与超时由
 *    `bootloader-serial.js` 负责；这样纯逻辑可以在 Node 里用假 io 全覆盖（`scripts/px4-bootloader.test.mjs`）。
 * 2. **擦写前必须显式确认**。`flash()` 的第二参 `confirmed` 必须严格等于 `true`，否则直接抛错且
 *    一个字节都不发。这不是形式检查：`CHIP_ERASE` 一发出，芯片就已经被擦了。
 * 3. **擦除开始之前就把 `destructive` 置起**（见 `flash()` 里的注释）。因为"写失败"不等于"没写
 *    进去"，直到收到引导器 ACK 之前都无法排除擦除已生效。
 * 4. **擦写失败后同一实例不再重试**。`failedDestructive` 一旦置起，后续 `identify()` / `flash()`
 *    都会被拒；用户必须重新进引导器，避免在未知状态下二次擦除。
 * 5. **CRC 不匹配时禁止重启**。校验是"发 GET_CRC 与本地对整片 flash（含 0xff 填充）算出的值比对"，
 *    不一致就抛 `destructive: true` 且**不发送 REBOOT**——宁可停在一个可救的状态，也不让飞控带着
 *    半截固件启动。
 * 6. **成功路径不等待重启 ACK**：上游 uploader 就是这么做的，等它只会卡到超时。
 * 7. **观察者（`onStage` / `onProgress`）抛错不影响设备命令**：界面画进度时出错不该把烧写带崩。
 *
 * @param {{write:(bytes:Uint8Array)=>Promise<unknown>, readExact:(count:number, timeoutMs:number)=>Promise<Uint8Array>}} io
 *   独占的字节传输接口；`readExact` 必须自己满足超时与粘包处理
 * @param {{commandTimeoutMs?:number, eraseTimeoutMs?:number, crcTimeoutMs?:number}} [timeouts]
 *   三个阶段的超时；擦除（整片）与 CRC（遍历整片 flash）天然比普通命令慢得多，故默认 30s / 10s
 * @returns {{identify:()=>Promise<object>, flash:(image:Uint8Array|ArrayBuffer, options?:{confirmed?:boolean,onStage?:Function,onProgress?:Function})=>Promise<object>}}
 *   冻结的会话对象；两个方法都经 `exclusive()` 串行化，并发调用会抛「烧录器事务进行中」
 */
export function createPx4Bootloader(
  io,
  { commandTimeoutMs = 3000, eraseTimeoutMs = 30000, crcTimeoutMs = 10000 } = {}
) {
  if (!io || typeof io.write !== 'function' || typeof io.readExact !== 'function')
    throw new TypeError('需要 write/readExact 传输接口')
  let busy = false
  let destructive = false
  let failedDestructive = false
  async function exact(count, timeout) {
    const result = bytes(await io.readExact(count, timeout))
    if (result.length !== count) throw new BootloaderError('引导器响应不完整', destructive)
    return result
  }
  async function ack(timeout) {
    const reply = await exact(2, timeout)
    if (reply[0] !== P.INSYNC) throw new BootloaderError('引导器响应不同步', destructive)
    if (reply[1] !== P.OK) {
      const status =
        { [P.FAILED]: '操作失败', [P.INVALID]: '无效操作', [P.BAD_SILICON_REV]: '芯片版本不支持烧录' }[reply[1]] ??
        `未知状态 ${reply[1]}`
      throw new BootloaderError(`引导器：${status}`, destructive)
    }
  }
  async function command(opcode, payload = [], responseBytes = 0, timeout = commandTimeoutMs) {
    await io.write(Uint8Array.from([opcode, ...payload, P.EOC]))
    const data = responseBytes ? await exact(responseBytes, timeout) : null
    await ack(timeout)
    return data
  }
  async function info(selector) {
    const data = await command(P.GET_DEVICE, [selector], 4)
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
  }
  async function identifyInternal() {
    await command(P.GET_SYNC)
    const protocolRevision = await info(1)
    if (protocolRevision < 3 || protocolRevision > 5) throw new BootloaderError('仅支持引导器协议版本 3–5（CRC 校验）')
    const boardId = await info(2)
    const boardRevision = await info(3)
    const flashSize = await info(4)
    if (boardId !== S1_BOARD_ID) throw new BootloaderError(`板型不匹配：需要 ${S1_BOARD_ID}，实际 ${boardId}`)
    if (!flashSizeValid(flashSize)) throw new BootloaderError('S1 可写容量无效或超出应用区')
    return { protocolRevision, boardId, boardRevision, flashSize }
  }
  async function exclusive(operation) {
    if (busy) throw new BootloaderError('烧录器事务进行中', destructive)
    if (failedDestructive) throw new BootloaderError('上次擦写失败；请重新连接引导器，不自动重试', true)
    busy = true
    try {
      return await operation()
    } catch (cause) {
      if (destructive) failedDestructive = true
      throw new BootloaderError(cause.message || String(cause), destructive, cause)
    } finally {
      busy = false
    }
  }
  return Object.freeze({
    identify: () => exclusive(identifyInternal),
    flash: (input, { confirmed = false, onStage, onProgress } = {}) =>
      exclusive(async () => {
        if (confirmed !== true) throw new BootloaderError('擦除固件前必须显式确认')
        validateS1Image(input)
        const image = alignFirmwareImage(input)
        const device = await identifyInternal()
        validateS1Image(image, device.flashSize)
        const expectedCrc = firmwareCrc32(image, device.flashSize)
        let previousStage
        const notify = (stage, written = 0) => {
          const event = { stage, written, total: image.length }
          try {
            if (stage !== previousStage) onStage?.(event)
          } catch {
            /* observer */
          }
          previousStage = stage
          try {
            onProgress?.(event)
          } catch {
            /* observer */
          }
        }
        destructive = true // A rejected write can still have sent erase bytes.
        notify('erasing')
        await command(P.CHIP_ERASE, [], 0, eraseTimeoutMs)
        notify('programming')
        for (let offset = 0; offset < image.length; offset += P.PROGRAM_CHUNK) {
          const chunk = image.subarray(offset, Math.min(offset + P.PROGRAM_CHUNK, image.length))
          await command(P.PROG_MULTI, [chunk.length, ...chunk])
          notify('programming', offset + chunk.length)
        }
        notify('verifying', image.length)
        const crcData = await command(P.GET_CRC, [], 4, crcTimeoutMs)
        const reportedCrc = new DataView(crcData.buffer, crcData.byteOffset, crcData.byteLength).getUint32(0, true)
        if (reportedCrc !== expectedCrc) throw new BootloaderError('固件 CRC 不匹配，禁止重启', true)
        notify('rebooting', image.length)
        // S1 upstream uploader intentionally does not wait for reboot ACK.
        await io.write(Uint8Array.of(P.REBOOT, P.EOC))
        return {
          ok: true,
          verified: true,
          rebootSent: true,
          device,
          expectedCrc,
          reportedCrc,
          programmedBytes: image.length,
        }
      }),
  })
}
export async function identifyBootloader(io, options) {
  return createPx4Bootloader(io, options).identify()
}
export async function flashS1Firmware(io, image, options = {}) {
  return createPx4Bootloader(io, options).flash(image, options)
}
