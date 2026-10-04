import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import pkg from './package.json'

// 这里曾经挂着 vite-plugin-node-polyfills（注入 Buffer / global / process，并把
// buffer、events、stream、util 打进来），外加 `buffer: 'buffer/'` 别名和
// optimizeDeps.include: ['node-mavlink', 'buffer']。
//
// 现在全部撤掉，理由是可验证的：src 下 grep 不到任何 `Buffer`、`process.`、
// `require(`、以及 node-mavlink / mavlink2js / events 的 import——
// MAVLink 编解码（src/utils/mavlink-protocol.js）、FTP、TOML 解析都是纯浏览器实现，
// 终端用 @xterm，3D 用 three，UI 用 element-plus，没有一个需要 Node 运行时。
// 留着它的代价是每个依赖都要过一遍 polyfill 注入，主包凭空变胖且构建时间变长。
export default defineConfig({
  plugins: [vue()],
  optimizeDeps: {
    // 为什么要显式列全：路由组件是懒加载的（src/router/index.js 里每个页面一个
    // () => import(...)），而 three / chart.js/auto / @xterm/* / @element-plus/icons-vue
    // 各自只在某一个页面里被 import。dev 服务器启动时只预打包了入口能看到的依赖，
    // 于是每进一个新页面就会“发现新依赖”→ 重新预打包（终端里反复出现的
    // bundling dependencies...）→ Vite 强制整页 reload。这个 reload 会把用户的
    // 页面状态和正在进行的切换一起打断，表现就是“切页失效”。
    // 一次列全之后预打包只在启动时做一次，进页面只做普通的动态 chunk 加载。
    include: [
      'vue',
      'vue-router',
      'pinia',
      'element-plus',
      '@element-plus/icons-vue',
      'three',
      'chart.js/auto',
      '@xterm/xterm',
      '@xterm/addon-fit',
    ],
  },
  define: {
    // 版本号只在 package.json 写一次，页面通过编译期常量读取。
    // 不要在 .vue 里 import package.json —— 那会把整份依赖清单打进前端包。
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
