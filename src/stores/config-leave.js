import { ref } from 'vue'
import { defineStore } from 'pinia'

// 路由等待用户决定，界面负责打开主题内确认框；快速点击第二个导航时取消旧请求。
export const useConfigLeaveStore = defineStore('config-leave', () => {
  const visible = ref(false)
  const target = ref('')
  let resolvePending = null

  function settle(allowed = false) {
    const resolve = resolvePending
    resolvePending = null
    visible.value = false
    target.value = ''
    resolve?.(allowed === true)
  }

  function request(destination) {
    settle(false)
    target.value = destination
    visible.value = true
    return new Promise((resolve) => { resolvePending = resolve })
  }

  function reviewing() { visible.value = false }
  return { visible, target, request, settle, reviewing }
})
