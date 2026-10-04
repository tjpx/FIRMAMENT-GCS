// src/utils/paramXml.js
// ================================================================
// param.xml 解析 & 序列化工具（适配飞控典型参数文件格式）
//
// 飞控 param.xml 典型结构（PX4 / ArduPilot / FMT 这类固件的 param.xml 大多长这样）：
//
//   <?xml version="1.0" encoding="UTF-8"?>
//   <root>
//     <param name="xxx" value="yyy" type="INT32|FLOAT|STRING" default="yyy" .../>
//     <group name="Sensor">
//       <param name="GYR_..." value="..." type="FLOAT" .../>
//     </group>
//   </root>
//
// 也有固件把值写在子标签里：
//   <param name="X"><value>1.0</value><type>FLOAT</type></param>
//
// 本工具的目标：
//   1. 解析成扁平列表 [{ group, name, value, rawValue, type, default, _el }]
//   2. 修改 value 后序列化回原 DOM，尽量保留原文件结构与属性
//
// 地面站的立场：解析不出参数就必须报错，不能返回一张空表再提示"解析成功"。
// ================================================================

/**
 * 取出 XML 声明行（`<?xml ... ?>`），没有则返回空串。
 *
 * 这里曾经是个真 bug：`if (m) xmlHeader = m` 把正则的匹配数组当成了字符串，
 * 拼接到输出时变成 `<?xml ...?>,<?xml ...?>`（两份声明中间还有个逗号），
 * 上传回飞控后整个文件属于非法 XML——地面站显示"上传成功"，飞控却再也读不回来。
 */
export function extractXmlHeader(xmlText) {
  const m = String(xmlText ?? '').match(/^\s*(<\?xml[\s\S]*?\?>)/)
  return m ? m[1] : ''
}

/**
 * 判定 DOMParser 的返回是否真的是解析错误，是则返回错误文本，否则返回空串。
 *
 * 旧写法拿 `doc.getElementsByTagName('parsererror')` 的返回值直接读 `.textContent`，
 * 但那是个 HTMLCollection，没有 textContent，于是恒为空串、恒判定"无错误"：
 * 截断的、标签不闭合的、编码坏掉的 param.xml 会被解析成一张空参数表，
 * 界面再提示"✅ 解析成功，参数数量: 0"。检查 documentElement 才是可靠做法。
 */
export function findParseError(doc) {
  const root = doc?.documentElement
  if (!root) return '解析结果为空，没有根节点'
  if (String(root.tagName || '').toLowerCase() !== 'parsererror') return ''
  const text = String(root.textContent || '').trim()
  return text || 'XML 结构未被解析器接受（解析器未给出原因）'
}

/**
 * 解析 param.xml，返回：
 *  {
 *    doc, root,
 *    xmlHeader: '<?xml ...?>',    // 原始 XML 声明（供序列化时原样写回）
 *    rootTag, rootAttrs,
 *    params: [ { group, name, value, rawValue, type, default, hasValueAttr, _el } ],
 *  }
 *
 * 序列化时直接对 `_el` 就地更新再 XMLSerializer 输出，可最大限度保留原结构
 * （注释除外——DOMParser 不保留注释）。
 */
export async function parseParamXml(rawInput) {
  // 1. 类型兼容转换
  let xmlText = ''
  if (typeof rawInput === 'string') {
    xmlText = rawInput
  } else if (typeof Blob !== 'undefined' && rawInput instanceof Blob) {
    xmlText = await rawInput.text()
  } else if (rawInput instanceof Uint8Array) {
    xmlText = new TextDecoder('utf-8').decode(rawInput)
  } else {
    throw new TypeError(`不支持的输入类型: ${typeof rawInput}`)
  }

  // 2. 预处理清洗
  xmlText = xmlText.replace(/^\uFEFF/, '') // 移除 BOM
  xmlText = xmlText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 移除控制字符

  if (!xmlText.trim()) throw new Error('XML 文件内容为空')

  if (typeof DOMParser === 'undefined') {
    throw new Error('当前环境没有 DOMParser，无法解析 param.xml（需要浏览器或 Tauri Webview）')
  }

  // 3. 解析并判定错误
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parseErr = findParseError(doc)

  if (parseErr) {
    console.error('--- XML 解析失败详细诊断 ---')
    console.error('错误信息:', parseErr)

    const lineMatch = parseErr.match(/line (\d+)/i)
    if (lineMatch) {
      const lineNo = parseInt(lineMatch[1], 10)
      const lines = xmlText.split('\n')
      console.error(`出错行 (第 ${lineNo} 行) 附近:`)
      console.error(lines.slice(Math.max(0, lineNo - 3), lineNo + 2).join('\n'))
    } else {
      console.error('文件前 15 行预览:')
      console.error(xmlText.split('\n').slice(0, 15).join('\n'))
    }
    console.error('----------------------------')

    throw new Error(`XML 解析失败: ${parseErr}`)
  }

  const xmlHeader = extractXmlHeader(xmlText)

  const root = doc.documentElement
  const rootTag = root.tagName
  const rootAttrs = {}
  for (const attr of root.attributes) rootAttrs[attr.name] = attr.value

  const params = []
  collectParams(root, '', params)

  if (params.length === 0) {
    // 0 个参数不是"成功"：结构不认识或文件被截断时最容易这样，必须显眼地报出来
    console.warn(`[paramXml] 解析后一个参数都没有（根节点 ${rootTag}），请确认飞控的 param.xml 结构`)
  } else {
    console.log('[paramXml] 解析完成，根节点:', rootTag, '参数数量:', params.length)
  }

  return { doc, root, xmlHeader, rootTag, rootAttrs, params }
}

/** 递归收集 <param>/<parameter> 节点；遇到 <group> 记录分组名并继续下钻 */
function collectParams(parentEl, groupName, out) {
  for (const child of Array.from(parentEl.children || [])) {
    const tag = String(child.tagName || '').toLowerCase()

    if (tag === 'group') {
      collectParams(child, child.getAttribute('name') || groupName, out)
      continue
    }
    if (tag !== 'param' && tag !== 'parameter') continue

    const name = child.getAttribute('name') || ''
    // 无名节点跳过；同名节点以先出现的为准，否则表格里两行会互相覆盖
    if (!name || out.some(p => p.name === name)) continue

    // 值可能写在 value 属性上，也可能写在 <value> 子标签里；
    // hasValueAttr 记下来，序列化时才能写回原处（写错地方会让飞控读到旧值）
    const hasValueAttr = child.hasAttribute ? child.hasAttribute('value') : false
    let value = hasValueAttr ? child.getAttribute('value') : null
    if (value === null || value === undefined) {
      const valueChild = child.querySelector('value')
      value = valueChild
          ? String(valueChild.textContent || '').trim()
          : String(child.textContent || '').trim()
    }

    const type = String(child.getAttribute('type') || inferType(value)).toUpperCase()

    out.push({
      group: groupName,
      name,
      value: autoCast(value, type),
      rawValue: value,
      type,
      default: child.getAttribute('default'),
      hasValueAttr,
      _el: child,
    })
  }
}

function inferType(v) {
  if (v === null || v === undefined) return 'STRING'
  if (/^-?\d+$/.test(v)) return 'INT32'
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(v) || /^-?\d+[eE][+-]?\d+$/.test(v)) return 'FLOAT'
  if (v === 'true' || v === 'false') return 'BOOL'
  return 'STRING'
}

function autoCast(v, type) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (type === 'INT32' || type === 'INT16' || type === 'INT8' || type === 'UINT32' || type === 'UINT16' || type === 'UINT8') {
    const n = parseInt(s, 10)
    return Number.isFinite(n) ? n : 0
  }
  if (type === 'FLOAT' || type === 'DOUBLE') {
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : 0
  }
  if (type === 'BOOL' || type === 'BOOLEAN') {
    return s === 'true' || s === '1' || s === 1
  }
  return s
}

/**
 * 把修改过的 params 回写到 DOM，返回 XML 字符串。
 * 调用方可直接修改 params[i].value，然后调用本函数。
 */
export function stringifyParamXml(parsed) {
  const { doc, root, xmlHeader, params } = parsed

  for (const p of params) {
    const v = formatValue(p.value, p.type)
    const el = p._el
    if (!el || !el.setAttribute) continue

    if (p.hasValueAttr === false && !el.getAttribute('value')) {
      // 原本值在 <value> 子标签里：就地改子标签，别额外挂一个 value 属性，
      // 否则飞控按子标签读到的还是旧值，界面上的"已修改"就成了假象
      const valueChild = el.querySelector('value')
      if (valueChild) {
        valueChild.textContent = v
        continue
      }
    }
    el.setAttribute('value', v)
  }

  if (typeof XMLSerializer === 'undefined') {
    throw new Error('当前环境没有 XMLSerializer，无法序列化 param.xml')
  }
  const serializer = new XMLSerializer()
  let body = serializer.serializeToString(root)
  // 简单缩进美化（非严格，但飞控端通常能容忍任何空白）
  body = prettifyXml(body)
  return (xmlHeader ? xmlHeader + '\n' : '') + body + '\n'
}

/**
 * 数值按类型格式化回字符串。
 * 注意：非法数字会被折成 0（协议里 0 是合法值），所以界面上的输入校验
 * 必须自己挡住非数字，不能指望这里报错。
 */
function formatValue(v, type) {
  if (v === null || v === undefined) return ''
  if ((type && type.startsWith('INT')) || (type && type.startsWith('UINT'))) {
    return String(Math.trunc(Number(v) || 0))
  }
  if (type === 'FLOAT' || type === 'DOUBLE') {
    const n = Number(v)
    if (!Number.isFinite(n)) return '0'
    return String(n)
  }
  if (type === 'BOOL' || type === 'BOOLEAN') {
    return (v === true || v === 'true' || v === '1' || v === 1) ? 'true' : 'false'
  }
  return String(v)
}

/** 极简 XML 美化（2 空格缩进）——仅处理尖括号换行，不处理注释/CDATA，对 param.xml 足够 */
function prettifyXml(xml) {
  const PADDING = '  '
  const reg = /(>)(<)(\/*)/g
  let formatted = xml.replace(reg, '$1\n$2$3')
  let pad = 0
  const lines = formatted.split('\n')
  const out = []
  for (let line of lines) {
    let indent = 0
    if (/.+<\/\w[^>]*>$/.test(line)) {
      indent = pad
    } else if (/^<\/\w/.test(line) && pad > 0) {
      pad -= 1
      indent = pad
    } else if (/^<\w([^>]*[^/])?>.*$/.test(line)) {
      // 开标签（非自闭合）
      indent = pad
      pad += 1
      // 自闭合不增加缩进
      if (/\/>$/.test(line.trim())) pad -= 1
    } else {
      indent = pad
    }
    out.push(PADDING.repeat(Math.max(0, indent)) + line.trim())
  }
  return out.join('\n')
}

/** 供自测使用的内部纯函数集合（不依赖浏览器 DOM） */
export const __paramXmlInternal = {
  extractXmlHeader,
  findParseError,
  inferType,
  autoCast,
  formatValue,
  prettifyXml,
}
