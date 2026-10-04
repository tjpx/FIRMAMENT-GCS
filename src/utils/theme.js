/**
 * 主题令牌与对比度契约（纯逻辑，无 DOM，浏览器与自测共用一份）。
 *
 * 为什么把这个文件单独抽出来：配色最容易出的事故不是"不好看"，而是**看不清**——
 * 主题色 #66ccff 压白底只有 1.90:1，当正文或链接用，现场光照下就是
 * "看得见有个蓝条、看不见写了什么"。业主 2026-07-31 明确选定仍要那个观感（见下），
 * 于是这个文件的职责从"替设计挡一道"变成"**把真实比值记在纸上**"：
 * 把"哪个颜色能压在哪个颜色上、最低多少倍"写成数据，由 scripts/selftest.mjs 第 23 组
 * 逐条算 WCAG 相对亮度比值。没过的组合要么改，要么在这里写明是谁定的、为什么。
 *
 * 两套主题的职责分工（与 docs/UI-THEME.md §2、README「界面与配色」同步维护）：
 *   --dsh-accent       #66ccff  FMT 主题色：填充与图形（主按钮底、开关、滑块、色条、图表线）
 *   --dsh-accent-ink   #66ccff  两套主题的文字类强调（业主选定，日间 1.90:1 记在契约里）
 *   --dsh-accent-deep  日间 #0a6fa8 / 夜间 #66ccff：结构线专用——焦点环、输入框聚焦描边。
 *                      这类"看不见就是故障"的东西不跟着观感翻，翻了就没人能用键盘走位
 *   中性面             日间近白、夜间深蓝灰，主色大面积不上身（问答里选的就是"背景中性"）
 */

/** 主题模式：auto 跟随系统，light/dark 手动锁定。 */
export const MODES = ['auto', 'light', 'dark']

/** localStorage 键。改名过一次的都在这，迁移逻辑见 useTheme.js。 */
export const THEME_STORAGE_KEY = 'dsh.theme'
export const LEGACY_THEME_KEYS = ['app-theme']

/** 手动锁定时的循环顺序：auto → light → dark → auto（自动是默认，最后回到它）。 */
export const MODE_CYCLE = ['auto', 'light', 'dark']

/** 模式文案（给界面 title/tooltip 用，避免每页各写一套）。 */
export const MODE_LABEL = {
  auto: '跟随系统',
  light: '日间',
  dark: '夜间',
}

/** 归一化：非法值、旧值（app-theme 里存的是 light/dark）一律收敛到三个合法模式。 */
export function normalizeMode(value) {
  return MODES.includes(value) ? value : 'auto'
}

/** 把模式解析成实际生效的明暗：只有 auto 需要看系统偏好。 */
export function resolveMode(mode, systemDark) {
  const m = normalizeMode(mode)
  if (m !== 'auto') return m
  return systemDark ? 'dark' : 'light'
}

/** 下一次循环的目标模式。 */
export function nextMode(mode) {
  const i = MODE_CYCLE.indexOf(normalizeMode(mode))
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length]
}

/* ───────── 颜色数学（WCAG 2.1 相对亮度） ───────── */

/** #rgb / #rrggbb → {r,g,b}（0~255）。解析不了就抛，不做静默兜底。 */
export function hexToRgb(hex) {
  const h = String(hex).trim().replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`不是十六进制颜色：${hex}`)
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

/** 相对亮度：线性化后按 0.2126/0.7152/0.0722 加权。 */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex)
  const lin = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** 对比度比值，1~21。顺序无关（自动取大比值）。 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/* ───────── 调色板（CSS 里同名变量必须与此处一致，第 23 组会逐条比对） ───────── */

export const PALETTE = {
  light: {
    canvas: '#f2f5f9',
    surface: '#ffffff',
    surface2: '#f7f9fc',
    surface3: '#eef2f8',
    border: '#dde3ec',
    borderStrong: '#c3cbd8',
    divider: '#e8ecf2',
    text1: '#1b2431',
    text2: '#48556b',
    text3: '#68758a',
    placeholder: '#9aa5b4',
    accent: '#66ccff',
    accentInk: '#66ccff',
    accentDeep: '#0a6fa8',
    accentSoft: '#e6f4ff',
    success: '#1a7a3f',
    warning: '#a1620a',
    warningFill: '#f0b429',
    danger: '#c53d3d',
    dangerVivid: '#e0454b',
    info: '#5b6b80',
    inkOnAccent: '#061826',
  },
  dark: {
    canvas: '#0f1520',
    surface: '#151d2b',
    surface2: '#1b2534',
    surface3: '#202c3e',
    border: '#2b384c',
    borderStrong: '#3d4d66',
    divider: '#243044',
    text1: '#e6edf6',
    text2: '#c1ccdb',
    text3: '#93a2b5',
    placeholder: '#6c7b8f',
    accent: '#66ccff',
    accentInk: '#66ccff',
    accentDeep: '#66ccff',
    accentSoft: '#123045',
    success: '#5dc98f',
    warning: '#e9b949',
    warningFill: '#e9b949',
    danger: '#ff7b72',
    dangerVivid: '#ff5d5d',
    info: '#8fa3bd',
    inkOnAccent: '#061826',
  },
}

/**
 * 对比度契约。min 的取法（三档地板，不许临时发明第四档）：
 *   4.5 正文/标签文字（WCAG AA 小字）；3.0 图形与描边（图表线、色条、焦点环）；
 *   1.4 只有两类合法情况——① 业主明确选定的"亮填充 + 白字"；
 *   ② 业主明确选定"品牌蓝 #66ccff 直接当文字类强调"（压白底 1.90:1、压浅蓝底 1.61:1）。
 *   两类都是明知不过 AA 仍要这个观感，于是把真实比值写进 min 与 why，
 *   让它是个"看得见的决定"而不是一处漏网。其余文字组合一律 4.5：有人手滑闸门直接红。
 */
export const CONTRAST_CONTRACT = [
  // 日间：文字压在三档中性面上
  { mode: 'light', fg: 'text1', bg: 'canvas', min: 4.5, why: '页面底上的正文' },
  { mode: 'light', fg: 'text1', bg: 'surface', min: 4.5, why: '卡片上的正文' },
  { mode: 'light', fg: 'text2', bg: 'surface', min: 4.5, why: '次级说明文字' },
  { mode: 'light', fg: 'text3', bg: 'surface', min: 4.5, why: '辅助文字（表头、单位）' },
  { mode: 'light', fg: 'accentInk', bg: 'surface', min: 1.4, why: '链接/强调文字：业主选定就压品牌蓝（实测 1.90:1，不许偷偷改暗，要改就整体改 --dsh-accent-ink）' },
  { mode: 'light', fg: 'accentInk', bg: 'accentSoft', min: 1.4, why: '强调文字压主色浅底（导航当前页、标签）：同上，实测 1.61:1' },
  { mode: 'light', fg: 'accentDeep', bg: 'surface', min: 3.0, why: '焦点环/聚焦描边：浅底上必须看得见的结构线走加深档（5.45:1）' },
  { mode: 'light', fg: 'accentDeep', bg: 'accentSoft', min: 3.0, why: '同一档结构线压浅蓝底（4.87:1）' },
  { mode: 'light', fg: 'success', bg: 'surface', min: 4.5, why: '成功标签' },
  { mode: 'light', fg: 'warning', bg: 'surface', min: 4.5, why: '待保存/警告标签' },
  { mode: 'light', fg: 'danger', bg: 'surface', min: 4.5, why: '错误与炸机级提示' },
  { mode: 'light', fg: '#ffffff', bg: 'accentInk', min: 1.4, why: 'plain 悬停、effect=dark 标签、遗留填充按钮：白字压品牌蓝（1.80:1，与主按钮同一条决定）' },
  { mode: 'light', fg: '#ffffff', bg: 'danger', min: 4.5, why: '危险按钮：白字压在红上' },
  { mode: 'light', fg: 'inkOnAccent', bg: 'accent', min: 4.5, why: '近墨压亮蓝（这条能力保留着：想救可读性就把 --dsh-ink-on-fill 换成它）' },
  // 夜间：文字压在深蓝灰面上；主按钮反过来——亮蓝底 + 近墨字
  { mode: 'dark', fg: 'text1', bg: 'canvas', min: 4.5, why: '页面底上的正文' },
  { mode: 'dark', fg: 'text1', bg: 'surface', min: 4.5, why: '卡片上的正文' },
  { mode: 'dark', fg: 'text2', bg: 'surface', min: 4.5, why: '次级说明文字' },
  { mode: 'dark', fg: 'text3', bg: 'surface', min: 4.5, why: '辅助文字（表头、单位）' },
  { mode: 'dark', fg: 'placeholder', bg: 'surface', min: 3.0, why: '占位符只做低优先提示' },
  { mode: 'dark', fg: 'accentInk', bg: 'surface', min: 4.5, why: '链接/强调文字' },
  { mode: 'dark', fg: 'accentInk', bg: 'canvas', min: 4.5, why: '底色上的强调文字' },
  { mode: 'dark', fg: 'success', bg: 'surface', min: 4.5, why: '成功标签' },
  { mode: 'dark', fg: 'warning', bg: 'surface', min: 4.5, why: '待保存/警告标签' },
  { mode: 'dark', fg: 'danger', bg: 'surface', min: 4.5, why: '错误与炸机级提示' },
  { mode: 'dark', fg: 'inkOnAccent', bg: 'accent', min: 4.5, why: '主按钮：近墨字压在亮蓝上' },
  { mode: 'dark', fg: 'inkOnAccent', bg: 'danger', min: 4.5, why: 'effect=dark 标签：深字压在亮红上' },
  // 图形类（色条、描边、焦点环）按 3.0
  { mode: 'dark', fg: 'accent', bg: 'surface', min: 3.0, why: '激活条/色条/焦点环' },
  { mode: 'light', fg: 'accent', bg: 'canvas', min: 1.4, why: '亮蓝在浅底只做装饰性光晕（记录真实数字，不假装过线）' },
  // 以下三条是业主 2026-07-30 问答里定的观感：日间的彩色按钮要“亮蓝/亮黄 + 白字”。
  // 明知不过 AA（1.80 / 1.86），min 就按实测下界写、why 里写清是谁定的——
  // 记真实数字，后来人一眼能看出“这是批准过的权衡”，而不是有人手滑把主题色当文字色用了。
  { mode: 'light', fg: '#ffffff', bg: 'accent', min: 1.4, why: '主按钮：白字压亮蓝（1.80:1，业主选定，字重 600 兜一点）' },
  { mode: 'light', fg: '#ffffff', bg: 'warningFill', min: 1.4, why: '警告按钮：白字压亮黄（1.86:1，同上）' },
  { mode: 'dark', fg: 'inkOnAccent', bg: 'warningFill', min: 4.5, why: '夜间警告按钮：近墨字压亮黄（9.86:1）' },
]

/**
 * 逐条检查契约，返回不合格项（空数组 = 全部达标）。
 * 不抛异常：面板/自测都需要拿到"哪几条、差多少"才能写进文档。
 */
export function auditContrast(palette = PALETTE, contract = CONTRAST_CONTRACT) {
  const bad = []
  for (const c of contract) {
    const p = palette[c.mode]
    if (!p) { bad.push({ ...c, ratio: 0, reason: `没有 ${c.mode} 这套调色板` }); continue }
    const fg = c.fg.startsWith('#') ? c.fg : p[c.fg]
    const bg = c.bg.startsWith('#') ? c.bg : p[c.bg]
    if (!fg || !bg) { bad.push({ ...c, ratio: 0, reason: '色名不在调色板里' }); continue }
    const ratio = contrastRatio(fg, bg)
    if (ratio < c.min) bad.push({ ...c, fg, bg, ratio, reason: `实测 ${ratio.toFixed(2)} < 要求 ${c.min}` })
  }
  return bad
}

/** 把契约算成一张可打印的表（文档与探针里显示真实比值，不写"约"）。 */
export function contrastTable(palette = PALETTE, contract = CONTRAST_CONTRACT) {
  return contract.map((c) => {
    const p = palette[c.mode]
    const fg = c.fg.startsWith('#') ? c.fg : p[c.fg]
    const bg = c.bg.startsWith('#') ? c.bg : p[c.bg]
    return { ...c, fg, bg, ratio: contrastRatio(fg, bg), pass: contrastRatio(fg, bg) >= c.min }
  })
}

/**
 * 画布类控件（RC 通道条、姿态球、图表）取色用。
 * 线色不走 #66ccff：1~2px 的线压白底只有 1.90:1，而图形地板是 3.0，日间仍取加深一档。
 * 页面自己写死颜色的那批还没收编（见 docs/UI-THEME.md 的配色债清单），
 * 新画的图形一律从这里取，切换日夜才不会一边亮一边瞎。
 */
/** 次网格只降低不透明度，不引入另一套中性色。 */
function secondaryGrid(hex) {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, 0.7)`
}

export const CHART_COLORS = {
  light: {
    accent: '#0a6fa8',
    accentSoft: 'rgba(102, 204, 255, 0.55)',
    grid: PALETTE.light.divider, // 保留旧调用点，等同主网格
    gridPrimary: PALETTE.light.divider,
    gridSecondary: secondaryGrid(PALETTE.light.divider),
    axis: '#c3cbd8',
    text: '#48556b',
    center: '#68758a',
    success: '#1a7a3f',
    warning: '#a1620a',
    danger: '#c53d3d',
    channel: ['#0a6fa8', '#1a7a3f', '#a1620a', '#c53d3d'],
  },
  dark: {
    accent: '#66ccff',
    accentSoft: 'rgba(102, 204, 255, 0.38)',
    grid: PALETTE.dark.divider,
    gridPrimary: PALETTE.dark.divider,
    gridSecondary: secondaryGrid(PALETTE.dark.divider),
    axis: '#3d4d66',
    text: '#c1ccdb',
    center: '#93a2b5',
    success: '#5dc98f',
    warning: '#e9b949',
    danger: '#ff7b72',
    channel: ['#66ccff', '#5dc98f', '#e9b949', '#ff7b72'],
  },
}

/** 取当前明暗下的图形配色；mode 传 auto 时按 light 兜底（调用方应先 resolve）。 */
export function chartColors(mode, systemDark) {
  return CHART_COLORS[resolveMode(mode, systemDark) === 'dark' ? 'dark' : 'light']
}
