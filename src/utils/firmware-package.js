// 固件包检查：只做浏览器可验证事实，不猜目标板或刷写协议。
export const FIRMWARE_EXTENSIONS = Object.freeze(['.bin', '.hex', '.dfu'])

export function extensionOf(name = '') {
  const i = String(name).lastIndexOf('.')
  return i < 0 ? '' : String(name).slice(i).toLowerCase()
}

export async function digestSha256(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function inspectFirmwareFile(file) {
  if (!file) return { ok: false, reason: '未选择固件文件' }
  const ext = extensionOf(file.name)
  if (!FIRMWARE_EXTENSIONS.includes(ext)) return { ok: false, reason: `不支持的文件类型 ${ext || '未知'}，仅接受 ${FIRMWARE_EXTENSIONS.join(' / ')}` }
  if (!file.size) return { ok: false, reason: '固件文件为空' }
  const buffer = await file.arrayBuffer()
  return { ok: true, name: file.name, size: file.size, extension: ext, sha256: await digestSha256(buffer), buffer }
}

export function assessFirmwareTarget({ detected, expected, packageName } = {}) {
  if (!detected) return { status: 'unknown', text: '尚未识别目标板，不能确认兼容性' }
  if (!expected) return { status: 'unknown', text: `目标板已识别为 ${detected}，固件包未声明目标板` }
  if (String(detected).toLowerCase() !== String(expected).toLowerCase()) return { status: 'block', text: `目标板不匹配：当前 ${detected}，固件包声明 ${expected}` }
  return { status: 'pass', text: `目标板匹配：${detected}${packageName ? ` · ${packageName}` : ''}` }
}
