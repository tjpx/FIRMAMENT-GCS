// 欢迎、资料与本地准备页面不需要飞控连接；设备操作页继续使用现有在线门禁。
export const OFFLINE_PAGE_PATHS = Object.freeze(['/', '/environment', '/presets', '/log', '/firmware', '/setting'])
export function canVisitWithoutDevice(path) { return OFFLINE_PAGE_PATHS.includes(path) }
