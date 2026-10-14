// 参数必须先进入固件 RAM，再由 param save 落盘；绝不能上传本地 XML。
// 命令和回显依据 FMT-Firmware/src/module/syscmd/cmd_param.c 的 get/set/save。
import { parseParamXmlDoc, REMOTE_FILES } from './config-doc.js'
import { CONSOLE_REPLY } from './console-session.js'

const identity = (p) => `${p.group}\0${p.name}`
const token = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

function entries(doc) {
  const text = doc.text()
  // 文档模型是定点编辑器，不是严格 XML 解析器；保存证据额外要求完整闭合。
  const stack = []
  const tags = text.replace(/<\?xml[^?]*\?>|<!--[\s\S]*?-->/g, '').match(/<[^>]*>/g) || []
  for (const tag of tags) {
    const m = /^<(\/)?(param_list|group|param|value)(?:\s+name="[^"]*")?\s*>$/.exec(tag)
    if (!m) throw new Error('参数 XML 包含不支持的结构')
    if (m[1]) {
      if (stack.pop() !== m[2]) throw new Error('参数 XML 未完整闭合')
    } else {
      const parent = stack.at(-1)
      const expected = { param_list: undefined, group: 'param_list', param: 'group', value: 'param' }
      if (parent !== expected[m[2]]) throw new Error('参数 XML 层级不完整')
      stack.push(m[2])
    }
  }
  if (stack.length || !/^\s*(?:<\?xml[^?]*\?>\s*)?<param_list>[\s\S]*<\/param_list>\s*$/.test(text))
    throw new Error('参数 XML 未完整闭合')
  const list = doc.list()
  if (
    !list.length ||
    list.length !== tags.filter((t) => /^<param\s/.test(t)).length ||
    list.length !== tags.filter((t) => /^<value>/.test(t)).length
  )
    throw new Error('参数 XML 缺少完整数值')
  const map = new Map()
  for (const p of list) {
    if (!token.test(p.group) || !token.test(p.name) || !numeric.test(p.raw) || !Number.isFinite(Number(p.raw)))
      throw new Error(`参数 ${p.group}.${p.name} 名称或数值不支持安全 shell 写入`)
    if (map.has(identity(p))) throw new Error(`参数 ${p.group}.${p.name} 重复，不能确定写入目标`)
    map.set(identity(p), p)
  }
  return map
}

export function planParameterChanges(doc) {
  if (!doc) throw new Error('参数尚未从飞控完整下载')
  if (doc.changes().some((c) => c.op !== '改值'))
    throw new Error('参数 XML 新增、删除或结构改动不支持保存；请先还原结构改动')
  const baseline = entries(parseParamXmlDoc(doc.original))
  const current = entries(doc)
  if (
    baseline.size !== current.size ||
    [...baseline.keys()].some((k) => !current.has(k)) ||
    JSON.stringify(parseParamXmlDoc(doc.original).groups()) !== JSON.stringify(doc.groups())
  )
    throw new Error('参数 XML 新增、删除或结构改动不支持保存')
  const targets = [...current]
    .filter(([key, p]) => Number(p.raw) !== Number(baseline.get(key).raw))
    .map(([, p]) => ({ ...p }))
  for (const p of targets) {
    if (
      p.type !== 'float' &&
      (!Number.isInteger(Number(p.raw)) || Number(p.raw) < -2147483648 || Number(p.raw) > 2147483647)
    )
      throw new Error(`参数 ${p.group}.${p.name} 超出安全 shell 整数范围`)
  }
  return targets
}

// 固件输出六位小数，float 还可能先经过 float32 舍入；不按 XML 字节或 CRC 判值。
export function parameterValueMatches(target, actual) {
  if (!numeric.test(String(actual))) return false
  const value = Number(actual),
    expected = Number(target.raw)
  if (!Number.isFinite(value)) return false
  if (target.type !== 'float') return value === expected
  return [expected, Math.fround(expected)].some((n) => Math.abs(value - Number(n.toFixed(6))) <= 0.500001e-6)
}

export function parseParameterGet(text, target, verify = true) {
  const escaped = target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `^\\s*(?:\\[\\*\\]\\s*)?(?:\\[r\\]\\s*)?${escaped}:\\s*([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)\\s*$`,
    'im'
  )
  const m = re.exec(String(text))
  if (!m || (verify && !parameterValueMatches(target, m[1])))
    throw new Error(`RAM 参数 ${target.group}.${target.name} 回读值不一致或无有效回显`)
  return Number(m[1])
}

export function verifyParameterFile(text, targets) {
  const doc = parseParamXmlDoc(text)
  const persisted = entries(doc)
  for (const target of targets) {
    const p = persisted.get(identity(target))
    if (!p || !parameterValueMatches(target, p.raw))
      throw new Error(`落盘参数 ${target.group}.${target.name} 回读值不一致或缺失`)
  }
  return doc
}

export async function saveParameters({ tx, ftp, targets, assertCurrent, onStage, timeoutMs = 6000 }) {
  let runtimeChanged = false
  try {
    const run = async (command) => {
      assertCurrent()
      const r = await tx.run(command, { idleMs: 0, until: CONSOLE_REPLY.prompt, timeoutMs })
      assertCurrent()
      if (!r?.ok || !CONSOLE_REPLY.prompt.test(String(r.text || '')))
        throw new Error(`参数命令未取得完整提示符回显：${r?.reason || command}`)
      return String(r.text)
    }
    onStage?.({ key: 'param', stage: 'parameter-writing' })
    for (const target of targets) {
      if (
        target.type !== 'float' &&
        (!Number.isInteger(Number(target.raw)) || Number(target.raw) < -2147483648 || Number(target.raw) > 2147483647)
      )
        throw new Error(`参数 ${target.group}.${target.name} 超出安全 shell 整数范围`)
      const before = await run(`param get ${target.group} ${target.name}`)
      if (/\[r\]/.test(before)) throw new Error(`参数 ${target.group}.${target.name} 为只读，不能保存`)
      // 预检只证明存在，不能要求当前 RAM 已等于尚未写入的目标。
      parseParameterGet(before, target, false)
    }
    for (const target of targets) {
      // 发出 set 后即认为 RAM 可能改变：超时并不等于固件没有执行。
      runtimeChanged = true
      const command = `param set ${target.group} ${target.name} ${target.raw}`
      const text = await run(command)
      const reply = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line !== command && !/^msh\s[^>]*>\s*$/.test(line))
      if (reply.length)
        throw new Error(`参数 ${target.group}.${target.name} RAM 写入失败或回显异常：${reply.join('；')}`)
      parseParameterGet(await run(`param get ${target.group} ${target.name}`), target)
    }
    onStage?.({ key: 'param', stage: 'parameter-persisting' })
    const saved = await run('param save')
    if (
      /parameter save fail/.test(saved) ||
      !saved.split(/\r?\n/).some((line) => line.trim() === 'parameter save to /sys/param.xml')
    )
      throw new Error('未取得 param save 成功证据')
    onStage?.({ key: 'param', stage: 'parameter-verifying' })
    assertCurrent()
    const blob = await ftp.download(REMOTE_FILES.param)
    assertCurrent()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    assertCurrent()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const doc = verifyParameterFile(text, targets)
    assertCurrent()
    return {
      doc,
      bytes,
      result: {
        ok: true,
        verified: true,
        method: 'param-save',
        count: targets.length,
        persisted: true,
        remote: REMOTE_FILES.param,
      },
    }
  } catch (error) {
    error.runtimeChanged = runtimeChanged
    throw error
  }
}
