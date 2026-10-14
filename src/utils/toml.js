// src/utils/toml.js
// ================================================================
// 轻量 TOML 解析器 & 序列化器（适配飞控 sysconfig.toml 常见结构）
//
// 支持：
//   - [section] / [section.sub]  多级表
//   - key = "string"             字符串（支持 \n \t \\ \" 转义）
//   - key = 'literal'            字面量字符串（单引号，无转义）
//   - key = 123 / -1 / 0x1F      整数
//   - key = 1.23 / -0.5 / 1e-2   浮点数
//   - key = true / false         布尔
//   - key = [1, 2, "a"]          数组（支持简单嵌套的数组/对象）
//   - key = { a=1, b="x" }       内联表
//   - # 注释、空行
//
// 注意：不支持 array of tables（[[xxx]]）、多行字符串（"""..."""）、日期等——
// 飞控 sysconfig.toml 通常用不到这些，若后续遇到可再扩展。
// ================================================================

class TomlParseError extends Error {
  constructor(msg, line) {
    super(`TOML 解析错误 (第 ${line} 行): ${msg}`)
    this.name = 'TomlParseError'
    this.line = line
  }
}

/* ------------------------- 解析 ------------------------- */

export function parseToml(text) {
  // 1. 预处理：统一换行符
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const root = {}
  let current = root
  let currentPath = []

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let line = lines[i]

    // 2. 使用自定义函数去除注释
    line = stripComment(line)
    line = line.trim()

    // 跳过空行
    if (!line) continue

    // 3. 处理表数组 [[array.of.tables]]
    if (line.startsWith('[[') && line.endsWith(']]')) {
      const arrayName = line.slice(2, -2).trim()
      if (!arrayName) throw new TomlParseError('空的表数组名', lineNo)

      const pathParts = arrayName.split('.').map((s) => s.trim())
      if (pathParts.some((p) => !p)) throw new TomlParseError('无效的表数组路径', lineNo)

      currentPath = pathParts
      current = root

      for (let j = 0; j < pathParts.length; j++) {
        const part = pathParts[j]
        if (j === pathParts.length - 1) {
          // 最后一级：确保是数组，并推入一个新对象
          if (!Array.isArray(current[part])) current[part] = []
          const newEntry = {}
          current[part].push(newEntry)
          current = newEntry
        } else {
          // 中间级：确保是对象
          if (current[part] === undefined || typeof current[part] !== 'object' || Array.isArray(current[part])) {
            current[part] = {}
          }
          current = current[part]
        }
      }
      continue
    }

    // 4. 处理普通节 [section]
    if (line.startsWith('[') && line.endsWith(']')) {
      const sectionName = line.slice(1, -1).trim()
      if (!sectionName) throw new TomlParseError('空的节名', lineNo)

      currentPath = sectionName.split('.').map((s) => s.trim())
      if (currentPath.some((p) => !p)) throw new TomlParseError('无效的节路径', lineNo)

      current = root
      for (const key of currentPath) {
        if (current[key] === undefined || typeof current[key] !== 'object' || Array.isArray(current[key])) {
          current[key] = {}
        }
        current = current[key]
      }
      continue
    }

    // 5. 处理键值对 key = value
    const eqIdx = findUnquotedChar(line, '=')
    if (eqIdx < 0) {
      // 如果依然找不到等号，说明这行既不是注释也不是合法配置，直接跳过或报错
      // 为了健壮性，这里选择跳过非法行并警告，而不是直接崩溃
      console.warn(`TOML 第 ${lineNo} 行格式异常，已跳过: ${line}`)
      continue
    }

    const key = line.slice(0, eqIdx).trim()
    const rawVal = line.slice(eqIdx + 1).trim()

    if (!isValidKey(key)) throw new TomlParseError(`非法键名：${key}`, lineNo)
    if (!rawVal) throw new TomlParseError(`键 ${key} 缺少值`, lineNo)

    current[key] = parseValue(rawVal, lineNo)
  }

  return root
}

function stripComment(line) {
  let inStr = null // ' or " or null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inStr) {
      if (ch === '\\' && inStr === '"') {
        i++
        continue
      }
      if (ch === inStr) inStr = null
    } else {
      if (ch === '"' || ch === "'") inStr = ch
      else if (ch === '#') return line.slice(0, i)
    }
  }
  return line
}

function findUnquotedChar(line, ch) {
  let inStr = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (c === '\\' && inStr === '"') {
        i++
        continue
      }
      if (c === inStr) inStr = null
    } else {
      if (c === '"' || c === "'") inStr = c
      else if (c === ch) return i
    }
  }
  return -1
}

function isValidKey(k) {
  // 允许纯字母数字下划线/连字符/带引号键。这里简单校验非空即可。
  return k.length > 0
}

function parseValue(raw, lineNo) {
  const v = raw.trim()
  if (!v) throw new TomlParseError('空值', lineNo)

  // 字符串
  if (v.startsWith('"')) return parseDoubleQuotedString(v, lineNo)
  if (v.startsWith("'")) return parseSingleQuotedString(v, lineNo)

  // 内联表 { a=1, b=2 }
  if (v.startsWith('{')) return parseInlineTable(v, lineNo)

  // 数组 [...]
  if (v.startsWith('[')) return parseArray(v, lineNo)

  // 布尔
  if (v === 'true') return true
  if (v === 'false') return false

  // 十六进制整数
  if (/^-?0x[0-9a-fA-F]+$/.test(v)) return parseInt(v, 16)
  // 八进制 / 二进制暂不做

  // 浮点数（含指数、小数点）
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(v) || /^-?\d+[eE][+-]?\d+$/.test(v)) {
    const f = parseFloat(v)
    if (!Number.isFinite(f)) throw new TomlParseError(`非法浮点：${v}`, lineNo)
    return f
  }
  // 整数
  if (/^-?\d+$/.test(v)) {
    const n = parseInt(v, 10)
    if (!Number.isSafeInteger(n)) return parseFloat(v)
    return n
  }
  // 无穷 / NaN（不常见但支持）
  if (v === 'inf' || v === '+inf') return Infinity
  if (v === '-inf') return -Infinity
  if (v === 'nan' || v === '+nan') return NaN

  // 裸字符串（兼容：有些飞控可能写不带引号的字符串）
  return v
}

function parseDoubleQuotedString(v, lineNo) {
  if (!v.endsWith('"') || v.length < 2) throw new TomlParseError('字符串未闭合', lineNo)
  const inner = v.slice(1, -1)
  // 处理转义
  return inner.replace(/\\([nrtbf"\\])|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (m, esc, u4, u8) => {
    if (esc) {
      return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\' }[esc]
    }
    if (u4) return String.fromCharCode(parseInt(u4, 16))
    if (u8) return String.fromCodePoint(parseInt(u8, 16))
    return m
  })
}

function parseSingleQuotedString(v, lineNo) {
  if (!v.endsWith("'") || v.length < 2) throw new TomlParseError('字面量字符串未闭合', lineNo)
  return v.slice(1, -1) // 字面量字符串无转义
}

function splitTopLevel(str, sep) {
  // 按 sep 分隔，但忽略 [] {} "" '' 内部的 sep
  const out = []
  let depth = 0,
    inStr = null,
    start = 0
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (inStr) {
      if (c === '\\' && inStr === '"') {
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") {
      inStr = c
      continue
    }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === sep && depth === 0) {
      out.push(str.slice(start, i))
      start = i + 1
    }
  }
  out.push(str.slice(start))
  return out
}

function parseInlineTable(v, lineNo) {
  if (!v.endsWith('}')) throw new TomlParseError('内联表未闭合', lineNo)
  const inner = v.slice(1, -1).trim()
  if (!inner) return {}
  const obj = {}
  const parts = splitTopLevel(inner, ',')
  for (const p of parts) {
    const kv = p.trim()
    if (!kv) continue
    const eq = findUnquotedChar(kv, '=')
    if (eq < 0) throw new TomlParseError(`内联表语法错：${kv}`, lineNo)
    const k = kv.slice(0, eq).trim()
    const val = kv.slice(eq + 1).trim()
    obj[k] = parseValue(val, lineNo)
  }
  return obj
}

function parseArray(v, lineNo) {
  if (!v.endsWith(']')) throw new TomlParseError('数组未闭合', lineNo)
  const inner = v.slice(1, -1).trim()
  if (!inner) return []
  const parts = splitTopLevel(inner, ',')
  return parts
    .map((p) => p.trim())
    .filter((p) => p)
    .map((p) => parseValue(p, lineNo))
}

/* ------------------------- 序列化 ------------------------- */

export function stringifyToml(obj) {
  // 输出顺序：先根键（非对象），再各 section；section 内同样策略
  const lines = []
  writeSection(lines, [], obj)
  return lines.join('\n') + '\n'
}

function writeSection(lines, path, section) {
  const subSections = []
  const scalars = []
  for (const [k, v] of Object.entries(section)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      subSections.push([k, v])
    } else {
      scalars.push([k, v])
    }
  }
  // 写标量
  for (const [k, v] of scalars) {
    lines.push(`${k} = ${formatValue(v)}`)
  }
  // 写子表
  for (const [k, v] of subSections) {
    const full = [...path, k]
    if (lines.length > 0) lines.push('') // 空行分隔
    lines.push(`[${full.join('.')}]`)
    writeSection(lines, full, v)
  }
}

function formatValue(v) {
  if (v === null || v === undefined) return '""'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v)
    return String(v)
  }
  if (typeof v === 'string') return `"${escapeString(v)}"`
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`
  if (typeof v === 'object') {
    const entries = Object.entries(v).map(([k, val]) => `${k} = ${formatValue(val)}`)
    return `{ ${entries.join(', ')} }`
  }
  return `"${String(v)}"`
}

function escapeString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/* ------------------------- 工具：把嵌套 TOML 拍平为表格项 ------------------------- */

/**
 * 把解析后的 TOML 对象拍平成 [{keyPath, key, value, type}] 列表，便于表格编辑。
 *   keyPath: 如 "vehicle.type" / "serial0.baud"
 *   key: 最后一级键名
 *   value: 当前值（已根据类型转换好）
 *   type: 'string' | 'number' | 'boolean'
 */
export function flattenToml(obj, prefix = '') {
  const rows = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        // 适配表数组，将每个数组元素生成带索引的唯一keyPath
        v.forEach((item, idx) => {
          rows.push(...flattenToml(item, `${path}[${idx}]`))
        })
      } else {
        rows.push(...flattenToml(v, path))
      }
    } else {
      let type = 'string'
      let val = v
      if (typeof v === 'boolean') type = 'boolean'
      else if (typeof v === 'number') type = 'number'
      else if (Array.isArray(v)) {
        type = 'string'
        val = v.map((x) => String(x)).join(',')
      } else val = v == null ? '' : String(v)
      rows.push({ keyPath: path, key: k, value: val, type })
    }
  }
  return rows
}

/**
 * 把表格修改后的扁平列表还原为嵌套对象，交给 stringifyToml 输出。
 */
export function unflattenToml(rows) {
  const root = {}
  for (const row of rows) {
    const parts = row.keyPath.split('.')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === undefined || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    const last = parts[parts.length - 1]
    cur[last] = castValue(row.value, row.type)
  }
  return root
}

function castValue(v, type) {
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v
    return v === true || v === 'true' || v === '1' || v === 1
  }
  if (type === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (v === null || v === undefined) return ''
  return String(v)
}
