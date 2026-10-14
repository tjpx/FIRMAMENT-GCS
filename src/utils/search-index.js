/** 搜索索引只枚举已下载文档；绑定表只提供标签/位置，绝不补造参数。 */
import {
  cardOf,
  labelOf,
  PILOT_DEVICE,
  PILOT_DEVICE_FIELDS,
  PILOT_MODE,
  PILOT_MODE_FIELDS,
  PILOT_COMMAND,
  PILOT_COMMAND_FIELDS,
} from './config-bindings.js'
import { rankFuzzy } from './fuzzy.js'

export const paramSearchKey = (group, name) => `param:${group || ''}:${name}`
export const tomlSearchKey = (keyPath) => `toml:${keyPath}`
export function searchValue(value) {
  if (value === undefined || value === null) return '--'
  return Array.isArray(value) ? JSON.stringify(value) : String(value)
}

export function buildConfigSearchIndex(fc) {
  const entries = []
  if (!fc?.doc) return entries
  const param = fc.files?.param?.loaded ? fc.doc('param') : null
  for (const row of param?.list() || []) {
    const group = row.group || '',
      focus = paramSearchKey(group, row.name)
    const powerField =
      group === 'POWER' && ['BAT_V_DIV', 'BAT_A_PER_V', 'BAT_N_CELLS', 'CAPACITY_OF_BAT'].includes(row.name)
    const failsafeField = group === 'FMS' && ['MC_LOST_RETURN_TIME', 'MC_LOST_RETURN_EN'].includes(row.name)
    const path = powerField
      ? '/power'
      : failsafeField
        ? '/failsafe'
        : group === 'CONTROL'
          ? '/pid'
          : group === 'RC'
            ? '/rc'
            : '/parameter'
    entries.push({
      key: focus,
      name: row.name,
      label: labelOf(row.name),
      value: row.value,
      group,
      file: 'param',
      path,
      query: { focus, file: 'param', group, ...(path === '/parameter' ? {} : { card: cardOf(group, row.name) }) },
    })
  }
  const toml = fc.files?.sysconfig?.loaded ? fc.doc('sysconfig') : null
  if (toml)
    for (const section of toml.sections()) {
      const tables = toml.tablesOf(section)
      const append = (key, value, arrayIndex) => {
        const keyPath = `${section}${arrayIndex == null ? '' : `[${arrayIndex}]`}${section ? '.' : ''}${key}`
        const fields =
          section === PILOT_DEVICE
            ? PILOT_DEVICE_FIELDS
            : section === PILOT_MODE
              ? PILOT_MODE_FIELDS
              : section === PILOT_COMMAND
                ? PILOT_COMMAND_FIELDS
                : []
        const field = fields.find((item) => item.key === key)
        const mapped = !!field || (section === 'pilot-cmd' && key === 'stick-channel')
        const focus = tomlSearchKey(keyPath)
        entries.push({
          key: focus,
          name: keyPath,
          label: field?.label || keyPath,
          value,
          group: section,
          file: 'sysconfig',
          path: mapped ? '/rc' : '/parameter',
          query: { focus, file: 'sysconfig', group: section },
        })
      }
      if (tables.length)
        tables.forEach((table, index) => table.keys.forEach((key) => append(key, table.fields[key], index)))
      else toml.keys(section).forEach((key) => append(key, toml.get(section, key)?.value))
    }
  return entries
}
export function searchConfigIndex(entries, query) {
  return rankFuzzy(entries, query, (entry) => [entry.name, entry.label, entry.group, searchValue(entry.value)])
}

/** 父组件唯一的 / 快捷键判据：输入、组合输入、弹层内均不抢按键。 */
export function shouldOpenConfigSearch(event) {
  if (
    event.key !== '/' ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.shiftKey
  )
    return false
  const target = event.target
  if (
    target?.isContentEditable ||
    target?.closest?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="dialog"], .el-overlay, .el-popper'
    )
  )
    return false
  // 弹层打开但焦点暂时落到 body 时也不打开另一个搜索面板。
  const dialogs = target?.ownerDocument?.querySelectorAll?.('[role="dialog"][aria-modal="true"]') || []
  return ![...dialogs].some((dialog) => dialog.getClientRects?.().length > 0)
}
