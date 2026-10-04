/**
 * src/utils/crc32.js —— CRC32（IEEE 802.3 / zlib 常用反射实现）
 *
 * 用途：MAVLink FTP 上传后的完整性校验。飞控 ftp_manager.c 的 kCmdCalcFileCRC32
 * 没有实现（它的 switch 只有 terminate/reset/list/open_ro/create/open_wo/read/
 * burst/write，见 ftp_manager.c:354-397），所以本地面站的校验方式是
 * "回读文件字节 + 比对 CRC32"，而不是发 CRC 请求等 8 秒超时。
 *
 * 参数：多项式 0xEDB88320（0x04C11DB7 的反射）、初值 0xFFFFFFFF、输出按位取反。
 * 基准向量：ASCII "123456789" -> 0xCBF43926，空输入 -> 0x00000000。
 */

/* 建表一次，模块级复用；逐字节的索引表比每次现算多项式快一个量级 */
const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[i] = c >>> 0
  }
  return t
})()

/**
 * 增量计算：把 chunk 追加到已有的 crc 后面。
 *
 * 约定传入/传出的都是"最终值"（已取反），所以可以边收边比，也可以分段累加：
 *   crc32Update(crc32(a), b) === crc32(concat(a, b))
 * 起始值用 0（等价于空输入的最终值），不要用 0xFFFFFFFF——那是内部态。
 *
 * @param {number} crc     上一段的 CRC32（最终值），首段传 0
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {number} 无符号 32 位整数
 */
export function crc32Update(crc, data) {
  const buf = data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)

  // 进入内部态：~crc；结束时再 ~ 回来
  let c = (~(crc >>> 0)) >>> 0
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (~c) >>> 0
}

/** 一次性计算 @returns {number} 无符号 32 位整数 */
export function crc32(data) {
  return crc32Update(0, data)
}

/** 8 位十六进制文本，UI 展示用（0x00000000 而不是 0x0） */
export function crc32Hex(value) {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/**
 * 判断两个 CRC32 是否相等。
 * 专门留个函数是为了把"有符号/无符号"这类坑集中在一处：
 * C 侧有时会返回 int32，DataView.getInt32 也可能是负数。
 */
export function crc32Equal(a, b) {
  return (a >>> 0) === (b >>> 0)
}

export default crc32
