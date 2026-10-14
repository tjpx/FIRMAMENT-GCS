// Beta 仅收录任务框架；来源和实机证据齐备前，不提供任何参数数值。
const framework = (id, title, aircraft, task, summary, prerequisites, checklist) =>
  Object.freeze({
    id,
    title,
    aircraft,
    task,
    summary,
    status: '待收录',
    author: '未提供',
    source: '待补充',
    firmware: '未声明',
    validation: '未实机验证',
    validated: 'none',
    parameters: Object.freeze([]),
    prerequisites: Object.freeze(prerequisites),
    safety: Object.freeze([
      '先拆桨或隔离动力，确认设备处于安全状态。',
      '核对机型、固件、接线和失控保护；框架不能代替实机验证。',
      '任何后续配置都需独立审查、地面验证和受控试验。',
    ]),
    checklist: Object.freeze(checklist),
  })

export const PRESET_CATALOG = Object.freeze([
  framework(
    'quad-start',
    '四旋翼入门',
    '四旋翼',
    '入门',
    '用于梳理首次装配与基础检查，不含调参建议。',
    ['确认机架布局、动力方向与遥控映射。', '准备对应固件资料和地面检查环境。'],
    ['核对电机编号与旋向', '检查遥控中位及失控行为', '记录地面检查结果']
  ),
  framework(
    'quad-imaging',
    '影像平稳',
    '四旋翼',
    '影像',
    '用于记录拍摄任务约束与振动检查需求。',
    ['明确载荷安装方式与拍摄任务。', '确认重心、云台固定与线缆不干涉。'],
    ['检查结构紧固与振动来源', '记录载荷状态', '制定受控拍摄试验计划']
  ),
  framework(
    'quad-endurance',
    '长航时',
    '四旋翼',
    '航时',
    '用于整理能量管理和返航条件，不承诺续航。',
    ['取得真实电池与动力系统资料。', '明确任务边界、返航条件和备降位置。'],
    ['核对电池监测读数', '检查低电量与失控保护', '记录真实能耗与任务条件']
  ),
  framework(
    'hex-payload',
    '六旋翼载荷',
    '六旋翼',
    '载荷',
    '用于梳理载荷装配、动力与安全检查。',
    ['确认六旋翼布局、载荷固定与重心。', '取得动力和载荷的真实规格资料。'],
    ['核对各动力通道', '检查载荷固定及释放风险', '制定地面载荷检查计划']
  ),
  framework(
    'plane-cruise',
    '固定翼巡航',
    '固定翼',
    '巡航',
    '用于整理舵面、任务航线及起降前提。',
    ['确认舵面方向、重心和起降场地。', '准备空域许可与适用固件资料。'],
    ['检查舵面与遥控映射', '核对任务航线和返航条件', '记录起降与失控处置方案']
  ),
  framework(
    'rover-inspection',
    '无人车巡检',
    '无人车',
    '巡检',
    '用于整理地面巡检路线和紧急停止检查。',
    ['确认转向、驱动和紧急停止方式。', '明确巡检区域与人员隔离条件。'],
    ['核对驱动与转向方向', '检查失联停车行为', '检查路线障碍与人员隔离']
  ),
])

export function filterPresets(catalog, { aircraft = '', task = '', search = '' } = {}) {
  const query = String(search ?? '')
    .trim()
    .toLocaleLowerCase()
  return catalog.filter(
    (item) =>
      (!aircraft || item.aircraft === aircraft) &&
      (!task || item.task === task) &&
      (!query ||
        [item.title, item.aircraft, item.task, item.summary, item.status].join(' ').toLocaleLowerCase().includes(query))
  )
}

// 只接受明确提供的有限数值。缺失当前值保持 undefined，绝不替换成零。
// 参数身份采用分组和名称二元组，避免不同分组的同名参数错误匹配。
export function comparePresetParameters(parameters = [], currentParameters = []) {
  return parameters
    .filter(
      (item) =>
        typeof item.group === 'string' &&
        typeof item.name === 'string' &&
        typeof item.value === 'number' &&
        Number.isFinite(item.value)
    )
    .map((item) => {
      const current = currentParameters.find((row) => row.group === item.group && row.name === item.name)
      const hasCurrent = current != null && current.value !== undefined && current.value !== null
      const currentValue = hasCurrent ? current.value : undefined
      return {
        group: item.group,
        name: item.name,
        presetValue: item.value,
        currentValue,
        hasCurrent,
        status: !hasCurrent ? 'missing' : Object.is(currentValue, item.value) ? 'same' : 'different',
      }
    })
}
