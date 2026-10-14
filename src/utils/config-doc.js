/**
 * 配置文件文档模型：对 /sys/sysconfig.toml 与 /sys/param.xml 做「保留原文的定点读写」。
 *
 * 为什么不用一个现成 TOML 库解析完再整体序列化？
 * 1. 飞控上那份 sysconfig.toml 是带满注释的样板（固件 target/<板型>/config/sysconfig.toml），
 *    用户会拿编辑器直接看它。整档重新序列化会抹掉注释、空行、缩进和键顺序，
 *    之后地面站就没有资格把这份文件写回去了——那是拿用户的配置文件当我们的临时缓冲区。
 * 2. 固件解析配置时遇到认识的键之外的东西会直接失败（pilot_cmd_config.c:596
 *    「unknown key」→ return FMT_ERROR），所以我们只能改值、只能按固件认识的键增删项。
 *
 * 因此这里的模型是：解析出坐标，改哪个键就只重写那一处文本；
 * **未修改时 serialize() 必须逐字节等于原文**（自测里把这条锁死）。
 *
 * 与同目录两个既有工具的分工，别用错：
 *   src/utils/toml.js    —— parseToml/stringifyToml：解析成对象再整体序列化，
 *                           给「只读展示、本地另存为新文件」用；会丢注释，不能写回飞控。
 *   src/utils/paramXml.js—— DOMParser 版 param.xml 解析 + prettifyXml：浏览器里的通用参数表。
 *   本模块              —— 定点补丁模型，产出直接经 MAVFTP 上传回 /sys/，注释与格式零损失。
 *
 * 事实来源（FMT-Firmware）：
 *   /sys/sysconfig.toml  SYS_CONFIG_FILE       target/sieon/s1/board/board.c:70
 *   /sys/param.xml       PARAM_FILE_NAME       src/module/param/param.h:33
 *   param.xml 的写法                    src/module/param/param.c:583-637（param_save）
 *   param.xml 的读法                    src/module/param/param.c:650+（yxml 状态机，只认 group/param/value）
 */

/** 地面站上/下载用的固定远端路径。HIL/SIH 版本固件用的是另外的文件名。 */
export const REMOTE_FILES = {
  sysconfig: '/sys/sysconfig.toml',
  param: '/sys/param.xml',
}

/* ------------------------------------------------------------------ */
/* 公共小工具                                                          */
/* ------------------------------------------------------------------ */

function splitLines(text) {
  // 保留行尾风格：飞控写出来的文件是 \n，用户在 Windows 上编辑过可能是 \r\n。
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r\n|\n/)
  return { lines, eol }
}

/**
 * 按固件 param_save 的格式格式化数值：
 * 浮点走 %f（6 位小数），整数保持整数，布尔按 0/1 写。
 */
export function formatNumber(value, isFloat) {
  if (typeof value === 'boolean') return value ? '1' : '0'
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`不是一个合法数值：${value}`)
  if (isFloat || !Number.isInteger(n)) return n.toFixed(6)
  return String(n)
}

/* ------------------------------------------------------------------ */
/* TOML 文档                                                           */
/* ------------------------------------------------------------------ */

const RE_HEADER_ARRAY = /^\s*\[\[\s*([A-Za-z0-9_.\-]+)\s*\]\s*\]\s*(?:#.*)?$/
const RE_HEADER_TABLE = /^\s*\[\s*([A-Za-z0-9_.\-]+)\s*\]\s*(?:#.*)?$/

/**
 * 把一行 `key = value   # 注释` 拆开。
 * 值部分用扫描而不是正则截断：数组里可以带逗号和中括号，字符串里可以带 #。
 */
function splitKeyValue(line) {
  const m = /^(\s*)([A-Za-z0-9_.\-"]+)(\s*=\s*)/.exec(line)
  if (!m) return null
  const rest = line.slice(m[0].length)
  let depth = 0
  let quote = null
  let end = rest.length
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (quote) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '[' || c === '{') {
      depth++
      continue
    }
    if (c === ']' || c === '}') {
      depth--
      continue
    }
    if (c === '#' && depth === 0 && i > 0 && /\s/.test(rest[i - 1])) {
      end = i
      break
    }
  }
  const value = rest.slice(0, end).replace(/\s+$/, '')
  return {
    indent: m[1],
    key: m[2],
    sep: m[3],
    value,
    comment: rest.slice(end),
    // 值在这一行里的字符区间，改写时只替换这一段，注释与缩进原样不动
    valueStart: m[0].length,
    valueEnd: m[0].length + value.length,
  }
}

/** 把 TOML 右值文本解析成 JS 值，同时告诉调用者它原本是什么形状。 */
export function parseTomlValue(raw) {
  const t = String(raw).trim()
  if (t === 'true') return { type: 'bool', value: true }
  if (t === 'false') return { type: 'bool', value: false }
  if (/^-?\d+$/.test(t)) return { type: 'int', value: Number(t) }
  if (/^-?\d*\.\d+(e[-+]?\d+)?$/i.test(t) || /^-?\d+(\.\d+)?e[-+]?\d+$/i.test(t)) {
    return { type: 'float', value: Number(t) }
  }
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
    (t.startsWith("'") && t.endsWith("'") && t.length > 1)
  ) {
    const inner = t.slice(1, -1)
    return { type: 'string', value: t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner }
  }
  if (t.startsWith('[')) {
    // 一维数组（本项目的配置里只有 [4,3,1,2] 和 [1000,1300] 这种）
    const inner = t.slice(1, t.lastIndexOf(']'))
    const parts = []
    let depth = 0,
      quote = null,
      cur = ''
    for (const c of inner) {
      if (quote) {
        cur += c
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        cur += c
        continue
      }
      if (c === '[') depth++
      if (c === ']') depth--
      if (c === ',' && depth === 0) {
        parts.push(cur)
        cur = ''
        continue
      }
      cur += c
    }
    if (cur.trim() !== '') parts.push(cur)
    return { type: 'array', value: parts.map((p) => parseTomlValue(p).value) }
  }
  return { type: 'raw', value: t }
}

function formatTomlValue(v) {
  if (Array.isArray(v)) return `[${v.map((x) => formatTomlValue(x)).join(',')}]`
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`不是一个合法数值：${v}`)
    return Number.isInteger(v) ? String(v) : v.toFixed(6)
  }
  if (v === null || v === undefined) throw new Error('配置值不能为空')
  if (typeof v === 'string') {
    // TOML 的字符串没有"裸写"这一说（裸标识符会被解析成未知类型，固件直接报解析失败），
    // 所以字符串一律加双引号；样板里 name = "serial3" 本来就是这个形态。
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  throw new Error(`不支持写入的配置值类型：${typeof v}`)
}

/* 操作历史不是净差异。用不可变行身份重放剩余补丁，避免数组下标漂移或同名键
 * 把后续操作落到另一项上；任何依赖丢失都原子拒绝，不猜测、不覆盖。 */
function createReviewHistory(initialLines, getLines, setLines) {
  let nextId = 0
  const token = (text) => ({ id: nextId++, text })
  const baseline = initialLines.map(token)
  let current = baseline.slice()
  let records = []

  function record(change, range = null) {
    const lines = getLines()
    let start = 0
    while (start < current.length && start < lines.length && current[start].text === lines[start]) start++
    let end = current.length,
      newEnd = lines.length
    while (end > start && newEnd > start && current[end - 1].text === lines[newEnd - 1]) {
      end--
      newEnd--
    }
    if (range) {
      start = range.start
      end = start + range.deleteCount
      newEnd = start + range.insertCount
    }
    const inserted = lines
      .slice(start, newEnd)
      .map((text, i) => (end - start === newEnd - start ? { id: current[start + i].id, text } : token(text)))
    const patch = {
      removed: current.slice(start, end),
      inserted,
      left: start ? current[start - 1].id : null,
      right: end < current.length ? current[end].id : null,
    }
    const before = current.slice()
    current = [...current.slice(0, start), ...inserted, ...current.slice(end)]
    records.push({ change: { ...change }, patch, before, after: current.slice() })
  }

  function replay(lines, patch) {
    if (!patch.removed.length && !patch.inserted.length) return lines.slice()
    let start
    if (patch.removed.length) {
      start = lines.findIndex((line) => line.id === patch.removed[0].id)
      if (
        start < 0 ||
        patch.removed.some((line, i) => lines[start + i]?.id !== line.id || lines[start + i]?.text !== line.text)
      )
        throw new Error('依赖冲突')
    } else {
      const left = patch.left === null ? -1 : lines.findIndex((line) => line.id === patch.left)
      const right = patch.right === null ? lines.length : lines.findIndex((line) => line.id === patch.right)
      if ((patch.left !== null && left < 0) || right < 0 || right !== left + 1) throw new Error('定位冲突')
      start = right
    }
    return [...lines.slice(0, start), ...patch.inserted, ...lines.slice(start + patch.removed.length)]
  }

  return {
    record,
    changes: () => records.map((r) => ({ ...r.change })),
    reset() {
      current = baseline.slice()
      records = []
      setLines(initialLines.slice())
    },
    revertChange(index) {
      if (!Number.isInteger(index) || index < 0 || index >= records.length)
        throw new Error('变更索引已失效，请刷新审阅列表后重试')
      let candidate = baseline.slice()
      const remaining = []
      for (let i = 0; i < records.length; i++) {
        if (i === index) continue
        const entry = records[i]
        const before = candidate.slice()
        try {
          candidate = replay(candidate, entry.patch)
        } catch {
          throw new Error(
            `无法安全还原此项：后续第 ${i + 1} 项「${entry.change.where}」依赖该改动或其文本位置，请先还原后续依赖项`
          )
        }
        remaining.push({ ...entry, before, after: candidate.slice() })
      }
      current = candidate
      records = remaining
      setLines(current.map((line) => line.text))
      return true
    },
  }
}

/**
 * 解析 sysconfig.toml。返回一个可定点读改的文档对象。
 */
export function parseTomlDoc(text) {
  const { eol } = splitLines(text)
  const original = text
  const originalLines = original.split(/\r\n|\n/)
  let work = originalLines.slice()
  const history = createReviewHistory(
    originalLines,
    () => work,
    (lines) => {
      work = lines
    }
  )

  // 每次改完都重建索引：文件只有 100~200 行，重建比维护偏移量可靠得多。
  function index() {
    const blocks = []
    // 第一个表头之前的全局键（样板第 4 行的 target = "SIEON S1"）归到路径 '' 这个隐式段
    let cur = { path: '', array: false, start: -1, end: work.length, kv: new Map() }
    blocks.push(cur)
    for (let i = 0; i < work.length; i++) {
      const line = work[i]
      let m = RE_HEADER_ARRAY.exec(line)
      if (m) {
        cur.end = i
        cur = { path: m[1], array: true, start: i, end: work.length, kv: new Map() }
        blocks.push(cur)
        continue
      }
      m = RE_HEADER_TABLE.exec(line)
      if (m) {
        cur.end = i
        cur = { path: m[1], array: false, start: i, end: work.length, kv: new Map() }
        blocks.push(cur)
        continue
      }
      const kv = splitKeyValue(line)
      if (kv) cur.kv.set(kv.key, i)
    }
    return blocks
  }

  function findBlock(path, { arrayIndex = null } = {}) {
    const blocks = index()
    const hits = blocks.filter((b) => b.path === path)
    if (hits.length === 0) return null
    if (hits.length > 1 && arrayIndex === null) {
      throw new Error(`[${path}] 是数组表且有 ${hits.length} 项，请用 tablesOf/setTableField 指定第几项`)
    }
    return arrayIndex === null ? hits[0] : (hits[arrayIndex] ?? null)
  }

  function readAt(block, key) {
    const li = block.kv.get(key)
    if (li === undefined) return null
    const kv = splitKeyValue(work[li])
    if (!kv) return null
    const parsed = parseTomlValue(kv.value)
    return { raw: kv.value, type: parsed.type, value: parsed.value, line: li }
  }

  function writeAt(block, key, value, label) {
    const li = block.kv.get(key)
    if (li === undefined) {
      // 键不存在：插在本表最后一个键之后（没有键就紧跟表头），保持这一段仍是本表的成员
      const keys = [...block.kv.values()]
      const insertAt = keys.length ? Math.max(...keys) + 1 : block.start + 1
      const kvLines = [...block.kv.keys()]
      let indent = '    '
      if (kvLines.length) {
        const probe = splitKeyValue(work[block.kv.get(kvLines[0])])
        if (probe) indent = probe.indent
      }
      const text = `${indent}${key} = ${formatTomlValue(value)}`
      work.splice(insertAt, 0, text)
      history.record(
        { file: 'sysconfig.toml', op: '新增', where: `${label}.${key}`, from: '（原本没有这一项）', to: text.trim() },
        { start: insertAt, deleteCount: 0, insertCount: 1 }
      )
      return true
    }
    const kv = splitKeyValue(work[li])
    const before = kv.value
    const after = formatTomlValue(value)
    work[li] = work[li].slice(0, kv.valueStart) + after + work[li].slice(kv.valueEnd)
    history.record({ file: 'sysconfig.toml', op: '改值', where: `${label}.${key}`, from: before, to: after })
    return true
  }

  return {
    kind: 'toml',
    original,

    text() {
      return work.join(eol)
    },
    dirty() {
      return work.join(eol) !== originalLines.join(eol)
    },
    reset() {
      history.reset()
    },
    changes() {
      return history.changes()
    },
    revertChange(index) {
      return history.revertChange(index)
    },

    /** 某一段里出现过的所有键（给 UI 做校验：只认识固件支持的键） */
    keys(path) {
      const b = findBlock(path)
      return b ? [...b.kv.keys()] : []
    },

    /** 顶层段落名，按出现顺序去重（隐式全局段不算段落） */
    sections() {
      const seen = []
      for (const b of index()) if (b.path && !seen.includes(b.path)) seen.push(b.path)
      return seen
    },

    get(path, key) {
      const b = findBlock(path)
      return b ? readAt(b, key) : null
    },

    getValue(path, key) {
      const e = this.get(path, key)
      return e ? e.value : undefined
    },

    set(path, key, value) {
      const b = findBlock(path)
      if (!b) throw new Error(`配置里没有 [${path}] 这一段，不能凭空新增（固件会拒绝未知段落）`)
      return writeAt(b, key, value, path ? `[${path}]` : '(全局)')
    },

    /** 数组表的所有实例，例如 [[pilot-cmd.mode]] 的每一段 */
    tablesOf(path) {
      const blocks = index().filter((b) => b.path === path)
      return blocks.map((b, i) => ({
        index: i,
        path,
        array: b.array,
        keys: [...b.kv.keys()],
        fields: Object.fromEntries([...b.kv.keys()].map((k) => [k, readAt(b, k).value])),
        raws: Object.fromEntries([...b.kv.keys()].map((k) => [k, readAt(b, k).raw])),
      }))
    },

    setTableField(path, arrayIndex, key, value) {
      const b = findBlock(path, { arrayIndex })
      if (!b) throw new Error(`配置里没有第 ${arrayIndex + 1} 段 [${path}]`)
      return writeAt(b, key, value, `[[${path}]]#${arrayIndex + 1}`)
    },

    /**
     * 追加一段新表。放在文件末尾是安全的：TOML 的表头会重新绑定上下文，
     * 顺序不影响语义，而且这样绝不会插进别人的段落里把注释搞乱。
     */
    appendTable(path, fields = {}, comment = '') {
      const fieldLines = Object.entries(fields).map(([k, v]) => `    ${k} = ${formatTomlValue(v)}`)
      const beforeLength = work.length
      while (work.length && work[work.length - 1].trim() === '') work.pop()
      const patchStart = work.length
      if (work.length) work.push('')
      if (comment) work.push(`# ${comment}`)
      work.push(`[[${path}]]`)
      work.push(...fieldLines)
      history.record(
        {
          file: 'sysconfig.toml',
          op: '新增段',
          where: `[[${path}]]`,
          from: '（原本没有）',
          to: Object.entries(fields)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`)
            .join(' '),
        },
        { start: patchStart, deleteCount: beforeLength - patchStart, insertCount: work.length - patchStart }
      )
      return true
    },

    /** 删除数组表的第 N 段（连同它自己的行；上一行的注释留着，不替用户做主） */
    removeTable(path, arrayIndex) {
      if (!path) throw new Error('不能删除全局段')
      const blocks = index().filter((b) => b.path === path)
      const b = blocks[arrayIndex]
      if (!b) throw new Error(`配置里没有第 ${arrayIndex + 1} 段 [${path}]`)
      const removed = work.splice(b.start, b.end - b.start)
      history.record(
        {
          file: 'sysconfig.toml',
          op: '删除段',
          where: `[[${path}]]#${arrayIndex + 1}`,
          from: removed.filter((l) => l.trim() !== '').join(' / '),
          to: '（已删除）',
        },
        { start: b.start, deleteCount: b.end - b.start, insertCount: 0 }
      )
      return true
    },

    /** 是否存在某段（UI 用它决定「本板型没有这个段落，只读展示」还是「可编辑」） */
    has(path) {
      return index().some((b) => b.path === path)
    },
  }
}

/* ------------------------------------------------------------------ */
/* param.xml 文档                                                      */
/* ------------------------------------------------------------------ */

const RE_XML_GROUP = /^\s*<group\s+name="([^"]*)"\s*>/
const RE_XML_PARAM = /^\s*<param\s+name="([^"]*)"\s*>/
const RE_XML_VALUE = /^(\s*)<value>([\s\S]*?)<\/value>(\s*)$/

/**
 * 解析 /sys/param.xml。
 *
 * 注意这份文件里**只有名字和数值**：没有范围、没有单位、没有默认值、没有类型
 * （param.c:583-637 写出来就是这样）。所以界面上的范围/默认值/中文名只能来自
 * 地面站自己的参数词典，不能假装是飞控告诉我们的。
 */
export function parseParamXmlDoc(text) {
  const { eol } = splitLines(text)
  const original = text
  const originalLines = original.split(/\r\n|\n/)
  let work = originalLines.slice()
  const history = createReviewHistory(
    originalLines,
    () => work,
    (lines) => {
      work = lines
    }
  )

  function index() {
    const groups = []
    const params = []
    let g = null
    let p = null
    for (let i = 0; i < work.length; i++) {
      const line = work[i]
      let m = RE_XML_GROUP.exec(line)
      if (m) {
        g = { name: m[1], start: i, end: work.length, params: [] }
        groups.push(g)
        p = null
        continue
      }
      if ((m = RE_XML_PARAM.exec(line))) {
        p = { group: g ? g.name : '', name: m[1], valueLine: -1, value: '' }
        params.push(p)
        if (g) g.params.push(p)
        continue
      }
      m = RE_XML_VALUE.exec(line)
      if (m && p && p.valueLine < 0) {
        p.valueLine = i
        p.value = m[2].trim()
        p.indent = m[1]
        continue
      }
      if (/^\s*<\/group>/.test(line) && g) g.end = i
    }
    return { groups, params }
  }

  function key(group, name) {
    return `${group}\u0000${name}`
  }

  function find(group, name) {
    const { params } = index()
    return params.find((p) => (group ? p.group === group : true) && p.name === name) || null
  }

  return {
    kind: 'xml',
    original,

    text() {
      return work.join(eol)
    },
    dirty() {
      return work.join(eol) !== originalLines.join(eol)
    },
    reset() {
      history.reset()
    },
    changes() {
      return history.changes()
    },
    revertChange(index) {
      return history.revertChange(index)
    },

    groups() {
      return index().groups.map((g) => ({ name: g.name, count: g.params.length }))
    },

    /** 扁平清单：{group,name,value,type}，UI 直接拿来渲染 */
    list() {
      return index().params.map((p) => {
        const isFloat = /[.eE]/.test(p.value)
        return {
          group: p.group,
          name: p.name,
          raw: p.value,
          value: isFloat ? Number(p.value) : /^-?\d+$/.test(p.value) ? Number(p.value) : p.value,
          type: isFloat ? 'float' : /^-?\d+$/.test(p.value) ? 'int' : 'string',
        }
      })
    },

    get(group, name) {
      const p = find(group, name)
      if (!p) return null
      const isFloat = /[.eE]/.test(p.value)
      return {
        raw: p.value,
        value: isFloat || /^-?\d+$/.test(p.value) ? Number(p.value) : p.value,
        type: isFloat ? 'float' : 'int',
      }
    },

    has(group, name) {
      return !!find(group, name)
    },

    /**
     * 改一个参数的值。isFloat 决定写出格式：固件用 %f 落盘浮点，
     * 我们回填时保持同样形状，避免 param.xml 出现 7 这种"看起来变了"的抖动。
     */
    set(group, name, value, { isFloat } = {}) {
      const p = find(group, name)
      if (!p) throw new Error(`${group}.${name} 不在 param.xml 里（新增请用 add）`)
      const float = isFloat !== undefined ? isFloat : /[.eE]/.test(p.value)
      const after = formatNumber(value, float)
      const m = RE_XML_VALUE.exec(work[p.valueLine])
      work[p.valueLine] = `${m[1]}<value>${after}</value>${m[3]}`
      history.record({ file: 'param.xml', op: '改值', where: `${group}.${name}`, from: p.value, to: after })
      return true
    },

    /**
     * 往某个组里补一个参数（固件 param_load 只认已编译进去的名字，
     * 写了不认识的键会被静默忽略，所以新增项必须由词典担保）。
     */
    add(group, name, value, { isFloat } = false) {
      const { groups } = index()
      const g = groups.find((x) => x.name === group)
      if (!g) throw new Error(`param.xml 里没有 <group name="${group}">，不能凭空新增分组`)
      if (find(group, name)) throw new Error(`${group}.${name} 已经存在`)
      const last = g.params[g.params.length - 1]
      // 缩进照抄本组已有的 param 块；本组是空的就用 param_save 的默认 4/8 空格
      const pi = work.findIndex((l, i) => i >= g.start && i <= g.end && RE_XML_PARAM.test(l))
      const paramIndent = pi >= 0 ? /^(\s*)/.exec(work[pi])[1] || '    ' : '    '
      const valueIndent = last ? last.indent || `${paramIndent}    ` : `${paramIndent}    `
      // valueLine+1 是 </param>，+2 就是下一个 <param> 或本组的 </group>——两种情况都要插在那一行之前
      const insertAt = last ? last.valueLine + 2 : g.end
      const block = [
        `${paramIndent}<param name="${name}">`,
        `${valueIndent}<value>${formatNumber(value, isFloat)}</value>`,
        `${paramIndent}</param>`,
      ]
      work.splice(insertAt, 0, ...block)
      history.record(
        {
          file: 'param.xml',
          op: '新增',
          where: `${group}.${name}`,
          from: '（原本没有这一项）',
          to: formatNumber(value, isFloat),
        },
        { start: insertAt, deleteCount: 0, insertCount: block.length }
      )
      return true
    },
  }
}
