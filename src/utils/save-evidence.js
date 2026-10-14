// 保存结果只认来自同一次上传的完整回读证据，不把写入和运行生效混为一谈。
export function uploadEvidence(result) {
  const local = String(result?.crc32Hex || '').toUpperCase()
  const remote = String(result?.remoteCrc32Hex || '').toUpperCase()
  return (
    !!result?.verified &&
    result?.verifyMode === 'crc' &&
    !!local &&
    local === remote &&
    Number.isFinite(result?.size) &&
    result.size >= 0
  )
}

export function activationNotice(key) {
  return key === 'sysconfig'
    ? '需重启：固件仅在开机时读取 sysconfig.toml；文件校验通过不代表运行配置已生效。'
    : '运行生效未确认：param.xml 文件已更新，但运行内存未回读；后续 param save 可能覆盖此文件。'
}

export function reviewOutcome(changes, results = {}, blocked = []) {
  return changes.map((change) => {
    const key = change.file === 'sysconfig.toml' ? 'sysconfig' : 'param'
    const result = results[key]
    const block = blocked.find((item) => item.key === key || item.label === change.file)
    const ok = result?.ok === true && result?.verified === true
    return {
      ...change,
      ok,
      status: ok ? '整文件回读 CRC 已核对' : block ? '回传被拦截' : '未通过回读校验',
      detail: ok ? activationNotice(key) : block?.reason || result?.error || '未写入或尚无校验证据',
      localCrc32: result?.localCrc32 || '',
      remoteCrc32: result?.remoteCrc32 || '',
    }
  })
}
