/** 子序列搜索：只匹配实际传入的文字；分数越高越靠前，不改写原始数据。 */
export function fuzzyScore(query, text) {
  const needle = Array.from(String(query ?? '').trim().toLocaleLowerCase())
  const haystack = Array.from(String(text ?? '').toLocaleLowerCase())
  if (!needle.length) return 0
  if (!haystack.length) return null
  const q = needle.join(''), h = haystack.join('')
  if (q === h) return 10000
  const contiguous = h.indexOf(q)
  if (contiguous >= 0) return 8000 - contiguous * 2 - haystack.length
  let cursor = 0, first = -1, last = -1, gaps = 0, boundaries = 0
  for (const char of needle) {
    let found = -1
    for (let i = cursor; i < haystack.length; i++) {
      if (haystack[i] === char) { found = i; break }
    }
    if (found < 0) return null
    if (first < 0) first = found
    if (last >= 0) gaps += found - last - 1
    if (found === 0 || /[\s_.:/\-[\]]/.test(haystack[found - 1])) boundaries++
    last = found
    cursor = found + 1
  }
  return 4000 + boundaries * 12 - gaps * 8 - first * 2 - haystack.length
}

/** 多字段取最佳分数；同分保留文档顺序，空搜索不改变原顺序。 */
export function rankFuzzy(items, query, fields = (item) => [item]) {
  const results = []
  for (const [index, item] of items.entries()) {
    const texts = fields(item)
    const scores = (Array.isArray(texts) ? texts : [texts]).map((text) => fuzzyScore(query, text)).filter((score) => score !== null)
    if (scores.length) results.push({ item, score: Math.max(...scores), index })
  }
  return results.sort((a, b) => b.score - a.score || a.index - b.index).map(({ item }) => item)
}
