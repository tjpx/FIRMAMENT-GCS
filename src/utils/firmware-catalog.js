// 分发地址暂未配置；后续清单按机架、板型和版本匹配，不根据文件名猜兼容性。
export const FIRMWARE_DISTRIBUTION_URL = null
export const FIRMWARE_AIRFRAMES = Object.freeze([
  { value: 'multicopter', label: '多旋翼' },
  { value: 'fixedwing', label: '固定翼' },
  { value: 'rover', label: '无人车' },
])
export const FIRMWARE_BOARDS = Object.freeze([{ value: 'sieon-s1', label: 'Sieon S1', boardId: 1188 }])
export function firmwareDistributionState() {
  return { available: false, reason: '在线固件暂未开放，请选择本地固件。' }
}
