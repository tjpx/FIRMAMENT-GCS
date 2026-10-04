/* Independent implementation based on PX4/FMT uploader protocol:
 * https://raw.githubusercontent.com/Firmament-Autopilot/FMT-Firmware/master/target/sieon/s1/uploader.py
 * CRC reflected 0xEDB88320 seed zero, no final xor. No MAVLink or device opening.
 */
export const S1_BOARD_ID = 1188
export const S1_APP_BASE = 0x08020000
export const S1_APP_MAX_SIZE = 1966080
export const BOOTLOADER_BAUD_RATE = 115200
export const PX4_BOOTLOADER = Object.freeze({ INSYNC: 0x12, OK: 0x10, FAILED: 0x11, INVALID: 0x13, BAD_SILICON_REV: 0x14, EOC: 0x20, GET_SYNC: 0x21, GET_DEVICE: 0x22, CHIP_ERASE: 0x23, PROG_MULTI: 0x27, GET_CRC: 0x29, REBOOT: 0x30, PROG_MULTI_MAX: 224, PROGRAM_CHUNK: 64 })
const P = PX4_BOOTLOADER
export class BootloaderError extends Error {
  constructor(message, destructive = false, cause) { super(message, { cause }); this.name = 'BootloaderError'; this.destructive = destructive; this.destructiveStarted = destructive }
}
function bytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw new TypeError('固件必须是 Uint8Array 或 ArrayBuffer')
}
function flashSizeValid(size) { return Number.isSafeInteger(size) && size >= 8 && size % 4 === 0 && size <= S1_APP_MAX_SIZE }
export function alignFirmwareImage(input) {
  const image = bytes(input); const padded = new Uint8Array(Math.ceil(image.length / 4) * 4)
  padded.fill(0xff); padded.set(image); return padded
}
export function validateS1Image(input, flashSize = S1_APP_MAX_SIZE) {
  const image = bytes(input)
  if (!flashSizeValid(flashSize)) throw new BootloaderError('S1 引导器报告的可写容量无效或超出应用区')
  if (image.length < 8 || Math.ceil(image.length / 4) * 4 > flashSize) throw new BootloaderError('固件缺少向量表或超出可写容量')
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const stackPointer = view.getUint32(0, true); const resetVector = view.getUint32(4, true)
  if (stackPointer <= 0x24000000 || stackPointer > 0x24080000 || stackPointer % 8 !== 0) throw new BootloaderError('固件初始栈指针不在 S1 RAM 范围内')
  const resetAddress = resetVector & 0xfffffffe
  if (!(resetVector & 1) || resetAddress < S1_APP_BASE + 8 || resetAddress >= S1_APP_BASE + image.length) throw new BootloaderError('固件复位向量不属于 S1 应用区')
  return { stackPointer, resetVector, imageSize: image.length, alignedSize: Math.ceil(image.length / 4) * 4 }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1
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
/** Transport io.write(bytes), io.readExact(count, timeoutMs) enforces deadlines,
 * assembles split serial reads and owns device exclusively. ACKs are sequential.
 * No retry/automatic erase. Observer failures do not interrupt device commands.
 */
export function createPx4Bootloader(io, { commandTimeoutMs = 3000, eraseTimeoutMs = 30000, crcTimeoutMs = 10000 } = {}) {
  if (!io || typeof io.write !== 'function' || typeof io.readExact !== 'function') throw new TypeError('需要 write/readExact 传输接口')
  let busy = false; let destructive = false; let failedDestructive = false
  async function exact(count, timeout) {
    const result = bytes(await io.readExact(count, timeout))
    if (result.length !== count) throw new BootloaderError('引导器响应不完整', destructive)
    return result
  }
  async function ack(timeout) {
    const reply = await exact(2, timeout)
    if (reply[0] !== P.INSYNC) throw new BootloaderError('引导器响应不同步', destructive)
    if (reply[1] !== P.OK) {
      const status = ({ [P.FAILED]: '操作失败', [P.INVALID]: '无效操作', [P.BAD_SILICON_REV]: '芯片版本不支持烧录' })[reply[1]] ?? `未知状态 ${reply[1]}`
      throw new BootloaderError(`引导器：${status}`, destructive)
    }
  }
  async function command(opcode, payload = [], responseBytes = 0, timeout = commandTimeoutMs) {
    await io.write(Uint8Array.from([opcode, ...payload, P.EOC]))
    const data = responseBytes ? await exact(responseBytes, timeout) : null
    await ack(timeout); return data
  }
  async function info(selector) {
    const data = await command(P.GET_DEVICE, [selector], 4)
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
  }
  async function identifyInternal() {
    await command(P.GET_SYNC)
    const protocolRevision = await info(1)
    if (protocolRevision < 3 || protocolRevision > 5) throw new BootloaderError('仅支持引导器协议版本 3–5（CRC 校验）')
    const boardId = await info(2); const boardRevision = await info(3); const flashSize = await info(4)
    if (boardId !== S1_BOARD_ID) throw new BootloaderError(`板型不匹配：需要 ${S1_BOARD_ID}，实际 ${boardId}`)
    if (!flashSizeValid(flashSize)) throw new BootloaderError('S1 可写容量无效或超出应用区')
    return { protocolRevision, boardId, boardRevision, flashSize }
  }
  async function exclusive(operation) {
    if (busy) throw new BootloaderError('烧录器事务进行中', destructive)
    if (failedDestructive) throw new BootloaderError('上次擦写失败；请重新连接引导器，不自动重试', true)
    busy = true
    try { return await operation() }
    catch (cause) { if (destructive) failedDestructive = true; throw new BootloaderError(cause.message || String(cause), destructive, cause) }
    finally { busy = false }
  }
  return Object.freeze({
    identify: () => exclusive(identifyInternal),
    flash: (input, { confirmed = false, onStage, onProgress } = {}) => exclusive(async () => {
      if (confirmed !== true) throw new BootloaderError('擦除固件前必须显式确认')
      validateS1Image(input)
      const image = alignFirmwareImage(input)
      const device = await identifyInternal()
      validateS1Image(image, device.flashSize)
      const expectedCrc = firmwareCrc32(image, device.flashSize)
      let previousStage
      const notify = (stage, written = 0) => {
        const event = { stage, written, total: image.length }
        try { if (stage !== previousStage) onStage?.(event) } catch { /* observer */ }
        previousStage = stage
        try { onProgress?.(event) } catch { /* observer */ }
      }
      destructive = true // A rejected write can still have sent erase bytes.
      notify('erasing'); await command(P.CHIP_ERASE, [], 0, eraseTimeoutMs)
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
      return { ok: true, verified: true, rebootSent: true, device, expectedCrc, reportedCrc, programmedBytes: image.length }
    }),
  })
}
export async function identifyBootloader(io, options) { return createPx4Bootloader(io, options).identify() }
export async function flashS1Firmware(io, image, options = {}) { return createPx4Bootloader(io, options).flash(image, options) }
