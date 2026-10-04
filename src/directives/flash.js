// 仅真实接收更新且值变化时闪一次；挂载、重连和清空都不是数据变化证据。
export function shouldFlash(previous, next) {
  return !!previous && next?.enabled === true && previous.enabled === true &&
    next.session === previous.session && Number.isFinite(next.stamp) && next.stamp > previous.stamp &&
    next.value != null && previous.value != null && !Object.is(next.value, previous.value)
}
const states = new WeakMap()
export const flashOnChange = {
  mounted(el, binding) { states.set(el, { value: { ...binding.value }, timer: null }) },
  updated(el, binding) {
    const state = states.get(el)
    if (!state) return
    const next = binding.value || {}
    if (state.value.enabled === next.enabled && state.value.session === next.session && state.value.stamp === next.stamp && Object.is(state.value.value, next.value)) return
    clearTimeout(state.timer)
    el.classList.remove('dsh-flash')
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!reduced && shouldFlash(state.value, next)) {
      void el.offsetWidth
      el.classList.add('dsh-flash')
      state.timer = setTimeout(() => { el.classList.remove('dsh-flash'); state.timer = null }, 300)
    }
    state.value = { ...next }
  },
  unmounted(el) { clearTimeout(states.get(el)?.timer); el.classList.remove('dsh-flash'); states.delete(el) },
}
