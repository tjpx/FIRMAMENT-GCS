// 定位以实际 DOM 字段键为准，不执行任何写入。观察器有界且可取消。
export function focusSearchField(root, key, { timeoutMs = 2000 } = {}) {
  if (!key || !root) return () => {}
  let observer, timer, done = false
  const cleanup = () => { done = true; observer?.disconnect(); clearTimeout(timer) }
  const attempt = () => {
    if (done) return
    const row = [...root.querySelectorAll('[data-search-key]')].find(el => el.dataset.searchKey === key && el.getClientRects().length)
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: 'instant' })
    const target = row.matches('input,select,textarea,button') ? row : row.querySelector('input,select,textarea,button,[tabindex]') || row
    if (!target.hasAttribute('tabindex') && target === row) target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
    cleanup()
  }
  observer = new MutationObserver(attempt)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-search-key', 'style'] })
  timer = setTimeout(cleanup, timeoutMs)
  attempt()
  return cleanup
}
