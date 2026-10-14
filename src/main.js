import { createApp } from 'vue'
import { useTheme } from './custom/useTheme'
import ElementPlus, { ElMessage } from 'element-plus'
import router, { installUnsavedGuard } from './router'
import 'element-plus/dist/index.css'
// EP 自带的暗色变量表（靠 html.dark 生效）。必须排在 EP 基础样式之后、我们的
// 令牌层之前——它的选择器是 html.dark(0-1-1)，我们的 :root[data-theme](0-2-0) 才压得住。
import 'element-plus/theme-chalk/dark/css-vars.css'
// 我们的三层：色值与密度 → EP 适配 → 全局重置/工具类。顺序不能调，同名变量后者赢。
import './styles/tokens.css'
import './styles/element-plus.css'
import './style.css'
import { createPinia } from 'pinia'
import { flashOnChange } from './directives/flash.js'
import App from './App.vue'

const app = createApp(App)
// 三态主题（跟随系统/日间/夜间）；整个对象 provide 下去，页面 inject('theme') 取同一份
const theme = useTheme()
const pinia = createPinia()

// 全局异常兜底。地面站最怕的不是某个图表画不出来，而是页面里一个未捕获的异常
// 把 Vue 的挂载/卸载流程打断——用户看到的就是"点了导航没反应"，而且原因只在
// console 里一闪而过。这里统一接住：说明是哪个组件、哪个阶段，并给出可见提示。
app.config.errorHandler = (err, instance, info) => {
  const name = instance?.$?.type?.__name || instance?.$options?.name || '匿名组件'
  console.error(`[FIRMAMENT GCS] 组件「${name}」在 ${info} 阶段抛出异常：`, err)
  ElMessage.error(`页面「${name}」出错（${info}）：${err?.message ?? err}`)
}

// 路由失败兜底。懒加载页面各自是一个独立 chunk，dev 服务器改变依赖预打包结果后
// 旧的 chunk URL 会失效，此时 router.push 的懒加载会 reject；不接住的话导航栏
// 看起来就是死的。判定为资源失效时自动重载一次（加锁避免来回刷），其余错误照实报。
let reloadingForChunkLoss = false
const isChunkLoadFailure = (e) => {
  const msg = String(e?.message ?? e ?? '')
  return /dynamically imported module|importing a module script failed|failed to fetch|error loading dynamically/i.test(
    msg
  )
}
router.onError((err, to) => {
  console.error('[FIRMAMENT GCS] 页面切换失败：', err)
  if (to && isChunkLoadFailure(err) && !reloadingForChunkLoss) {
    reloadingForChunkLoss = true
    ElMessage.warning('页面资源已更新，正在重新加载…')
    window.location.assign(to.fullPath)
    return
  }
  ElMessage.error(`页面切换失败：${err?.message ?? err}`)
})

app.directive('flash-on-change', flashOnChange)
app.use(pinia)
installUnsavedGuard()
app.use(ElementPlus)
app.use(router)
app.provide('theme', theme)
app.mount('#app')
