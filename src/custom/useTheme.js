// 主题模式：三态（跟随系统 / 日间 / 夜间），唯一写 <html> 的地方。
//
// 为什么大改：原来这里只有 light/dark 两态、只写 data-theme 属性。Element Plus 的暗色
// 变量表是靠 html 上的 dark 类生效的，所以旧版切到"夜间"之后，卡片、表格、输入框、
// 菜单这些 EP 组件仍然是日间配色——夜模式只对两页手写过的地方有效。现在三个属性一起写：
//   data-theme=light|dark   给我们自己的 CSS（style.css 与页面 scoped 里 [data-theme=dark]）
//   class dark              给 Element Plus 的 dark/css-vars.css
//   color-scheme            给浏览器原生控件、滚动条、日期选择器
// 默认 auto 跟随系统，一旦用户手动点过就固定下来（存 localStorage），这是问答里定的行为。
import { computed, ref, watchEffect } from 'vue'
import {
  LEGACY_THEME_KEYS,
  MODE_LABEL,
  THEME_STORAGE_KEY,
  nextMode,
  normalizeMode,
  resolveMode,
} from '../utils/theme'

/** 读系统偏好。非浏览器环境（自测直接 import 时）没有 matchMedia，按日间兜底。 */
function systemPrefersDark() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

/** 读存的偏好；旧键（app-theme 只有 light/dark）读到时顺手迁到新键。 */
function readStoredMode() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v) return normalizeMode(v)
    for (const k of LEGACY_THEME_KEYS) {
      const legacy = localStorage.getItem(k)
      if (legacy === 'light' || legacy === 'dark') {
        localStorage.setItem(THEME_STORAGE_KEY, legacy)
        localStorage.removeItem(k)
        return legacy
      }
    }
  } catch {
    // 无痕模式/被禁用的 localStorage：读失败就用默认，不弹错也不拦住界面
  }
  return 'auto'
}

const mode = ref(readStoredMode())
const systemDark = ref(systemPrefersDark())

// 只有 auto 模式跟随系统；手动锁定后系统再变也不动（用户的选择优先）。
let media = null
let onSystemChange = null
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  media = window.matchMedia('(prefers-color-scheme: dark)')
  onSystemChange = (e) => { systemDark.value = e.matches }
  media.addEventListener('change', onSystemChange)
}

/** 实际生效的明暗（'light' | 'dark'）。 */
const resolved = computed(() => resolveMode(mode.value, systemDark.value))

// 写 DOM：属性 + 类 + color-scheme，一处生效，全站 CSS 与 EP 都跟着走。
watchEffect(() => {
  const dark = resolved.value === 'dark'
  if (typeof document !== 'undefined') {
    const el = document.documentElement
    el.setAttribute('data-theme', resolved.value)
    el.classList.toggle('dark', dark)
    el.style.colorScheme = dark ? 'dark light' : 'light dark'
    // 供 CSS 判断"当前是自动模式"（开关的高亮态要跟着三态走）
    el.setAttribute('data-theme-mode', mode.value)
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode.value)
  } catch {
    // 存不进去也只是下次回到默认，不影响本次使用
  }
})

export function useTheme() {
  const isDark = computed(() => resolved.value === 'dark')
  const modeText = computed(() => MODE_LABEL[mode.value])
  const setMode = (m) => { mode.value = normalizeMode(m) }
  const cycleMode = () => { mode.value = nextMode(mode.value) }
  // 兼容旧的两态调用点：不管当前是 auto 还是锁定态，都翻转成"手动锁定的另一态"，
  // 语义和以前的 日↔夜 一致，只是从此不再跟着系统跑（用户明确点过就听用户的）。
  const toggleTheme = () => { mode.value = isDark.value ? 'light' : 'dark' }
  return { mode, resolved, isDark, modeText, setMode, cycleMode, toggleTheme }
}

/** 组件里想只读不写时用它，避免各页自己拼文案。 */
export function useThemeView() {
  return { mode, isDark: computed(() => resolved.value === 'dark'), modeText }
}
