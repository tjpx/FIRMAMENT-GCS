// 操作安全闸：纯逻辑，不访问串口、DOM 或持久化存储。
export function motorSafetyAllowed({ canWrite, armed, propsRemoved, mountSecured } = {}) {
  return canWrite === true && armed === false && propsRemoved === true && mountSecured === true
}

export function firmwarePreparationAllowed({ inspected, targetBlocked, targetConfirmed, backupConfirmed, typed } = {}) {
  return inspected === true && targetBlocked !== true && targetConfirmed === true && backupConfirmed === true && typed === '刷写'
}

// 飞控路径按 POSIX 规整；拒绝不可解释的字符，避免 .. 或反斜杠绕过系统路径判断。
export function normalizeRemotePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(path)) throw new Error('无效飞控绝对路径')
  const parts = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function ftpWritePolicy(path) {
  const normalized = normalizeRemotePath(path)
  const config = normalized === '/sys/sysconfig.toml' || normalized === '/sys/param.xml'
  const system = normalized === '/sys' || normalized.startsWith('/sys/')
  return { path: normalized, config, system, blocked: config, confirmation: system ? '/sys' : '覆盖' }
}

export function ftpUploadVerified(result) {
  return result?.verified === true && result.verifyMode === 'crc' &&
    Number.isInteger(result.crc32) && result.crc32 >= 0 && result.crc32 <= 0xffffffff &&
    Number.isInteger(result.remoteCrc32) && result.crc32 === result.remoteCrc32
}

export function motorResultState({ promptSeen, connected, reason } = {}) {
  if (promptSeen === true && connected === true) return { active: false, uncertain: false, phase: 'stopped', reason: '已收到真实控制台提示符' }
  return { active: false, uncertain: true, phase: 'uncertain', reason: reason || '未确认电机停止，请在现场检查并使用独立停机措施' }
}
