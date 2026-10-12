<!-- views/Cli.vue —— 交互式控制台（SERIAL_CONTROL 桥接飞控 shell） -->
<template>
  <div class="terminal-container">
    <el-card class="terminal-header" shadow="hover">
      <div class="header-left">
        <el-icon><Monitor /></el-icon>
        <span class="title">
          交互式控制台
          <el-tag size="small" :type="mav.connected.value ? 'success' : 'info'" style="margin-left: 8px;">
            {{ mav.connected.value ? '已连接' : '未连接' }}
          </el-tag>
        </span>
      </div>
      <div class="header-right">
        <!-- 飞控 shell 若自带回显，本地回显就会出现双字符；这里给个开关而不是替用户猜 -->
        <el-switch v-model="localEcho" size="small" active-text="本地回显"
                   title="开启：按回车才发送，输入在你自己这边显示（设备不回显时用）。关闭：每键直发，字符由飞控回显。"
                   @change="onEchoChange" />
        <el-button size="small" :icon="Refresh" @click="clearTerminal">清空</el-button>
      </div>
    </el-card>

    <el-alert v-if="!mav.connected.value" type="info" :closable="false" show-icon
              title="未连接飞控：输入不会送达，此处只展示历史输出" style="margin: 0;" />

    <el-card class="terminal-body">
      <div ref="terminalContainer" class="xterm-wrapper"></div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick, inject } from 'vue'
// 终端已迁到 @xterm 作用域包：老包 xterm / xterm-addon-fit 自 2023 起不再维护
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Monitor, Refresh } from '@element-plus/icons-vue'
import { getCliHistory } from '../utils/cli-history.js'

const mav = inject('mavlink')
const cliHistory = getCliHistory(mav)

const terminalContainer = ref(null)
const localEcho = ref(localStorage.getItem('gcs.cli.localEcho') !== '0')

/* 终端实例不进响应式：xterm 内部状态被 reactive 代理后行为不可预期 */
let term = null
let fit = null
let ro = null
let unsubscribeHistory = null
let themeObserver = null
let motionQuery = null
let inputDisposable = null
let lineBuf = ''
/* 行内编辑的光标位置（0..lineBuf.length）。←/→ 的转义序列必须在这里拦下：
   它们若漏到粘贴过滤器，ESC 被剥掉后 "[C"/"[D" 会当文本插进行里，光标也只能待在行尾。 */
let cursorPos = 0
const commandHistory = []
let historyIndex = -1

function writeToTerminal(text) {
  if (!term) return
  term.write(String(text))
}

function doFit() {
  try { fit?.fit() } catch { /* 容器被隐藏时宽高为 0，fit 会抛错，忽略即可 */ }
}

function onEchoChange(v) {
  localStorage.setItem('gcs.cli.localEcho', v ? '1' : '0')
  if (term) term.options.disableStdin = !mav.connected.value
}

/* 行模式：攒够一行再走 SERIAL_CONTROL，避免每个字符一条协议消息 */
function sendLine() {
  if (!mav.connected.value || !term) return
  const line = lineBuf
  lineBuf = ''; cursorPos = 0
  historyIndex = -1
  if (line.trim()) { commandHistory.unshift(line); if (commandHistory.length > 50) commandHistory.pop() }
  if (localEcho.value) term.write('\r\n')
  mav.cli.send(line + '\r')
}
function replaceInput(text) {
  if (!localEcho.value) return
  term.write(`\r\x1b[2K${text}`)
  lineBuf = text
  cursorPos = text.length // 历史召回后光标停在行尾，接着改末尾是最常见动作
}
/* 整行重画并把光标放回 cursorPos：行中插入/删除后靠它复位，简单但总是正确 */
function paintLine() {
  term.write(`\r\x1b[2K${lineBuf}`)
  if (cursorPos < lineBuf.length) term.write(`\x1b[${lineBuf.length - cursorPos}D`)
}
function moveCursor(delta) {
  const next = Math.min(Math.max(cursorPos + delta, 0), lineBuf.length)
  if (next === cursorPos) return
  cursorPos = next
  paintLine()
}

function onKey(data) {
  if (!mav.connected.value) {
    // 未连接时 disableStdin 已经拦住了大部分输入，这里兜住粘贴等旁路
    return
  }
  if (data === '\r') {
    if (localEcho.value) sendLine()
    else { mav.cli.send('\r'); lineBuf = '' }
    return
  }
  if (localEcho.value) {
    // 行内编辑键：只在本地回显（行模式）下有意义；透传模式这些序列原样交给飞控 shell
    if (data === '\x1b[D' || data === '\x1bOD') { moveCursor(-1); return } // ←
    if (data === '\x1b[C' || data === '\x1bOC') { moveCursor(1); return }  // →
    if (data === '\x1b[H' || data === '\x1b[1~') { cursorPos = 0; paintLine(); return } // Home
    if (data === '\x1b[F' || data === '\x1b[4~') { cursorPos = lineBuf.length; paintLine(); return } // End
    if (data === '\x1b[3~') { // Delete：删光标处的字符
      if (cursorPos < lineBuf.length) {
        lineBuf = lineBuf.slice(0, cursorPos) + lineBuf.slice(cursorPos + 1)
        paintLine()
      }
      return
    }
  }
  if (data === '\x7f' || data === '\b') { // Backspace：删光标前一个字符（不是只删行尾）
    if (localEcho.value) {
      if (cursorPos > 0) {
        lineBuf = lineBuf.slice(0, cursorPos - 1) + lineBuf.slice(cursorPos)
        cursorPos--
        paintLine()
      }
    } else {
      mav.cli.send('\x7f')
    }
    return
  }
  if (data === '\x03') { // 固件约定回车打断；保留 Ctrl+C 兼容发送回车
    mav.cli.send('\r')
    lineBuf = ''; cursorPos = 0
    return
  }
  if (data === '\x1b[A' || data === '\x1b[B') {
    if (localEcho.value && commandHistory.length) {
      historyIndex = data === '\x1b[A' ? Math.min(historyIndex + 1, commandHistory.length - 1) : Math.max(historyIndex - 1, -1)
      replaceInput(historyIndex < 0 ? '' : commandHistory[historyIndex])
    }
    return
  }
  if (data === '\t') {
    mav.cli.send('\t')
    return
  }
  // 过滤粘贴带进来的控制字符，串口 shell 收到会乱
  const printable = localEcho.value
    ? data.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    : data
  if (!printable) return
  if (localEcho.value) {
    // 插到光标位置：光标在行尾时直接续写（常规打字零重画），行中插入才整行重画
    lineBuf = lineBuf.slice(0, cursorPos) + printable + lineBuf.slice(cursorPos)
    cursorPos += printable.length
    if (cursorPos === lineBuf.length) term.write(printable)
    else paintLine()
  } else {
    mav.cli.send(printable)
  }
}

function terminalTheme() {
  const css = getComputedStyle(terminalContainer.value)
  const token = name => css.getPropertyValue(name).trim()
  return {
    background: token('--dsh-console-bg'),
    foreground: token('--dsh-console-fg'),
    cursor: token('--dsh-console-fg'),
    selectionBackground: token('--dsh-console-hi'),
    brightBlack: token('--dsh-console-dim'),
  }
}
function updateTheme() { if (term) term.options.theme = terminalTheme() }
function updateMotion() { if (term) term.options.cursorBlink = !motionQuery?.matches }

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  term = new Terminal({
    theme: terminalTheme(),
    fontSize: 14,
    convertEol: true,
    cursorBlink: !motionQuery.matches,
    scrollback: 10000,
    fontFamily: '"Fira Code", "Cascadia Code", Menlo, monospace',
    // 未连接时不接键盘，比"输入被静默丢弃"诚实
    disableStdin: !mav.connected.value,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(terminalContainer.value)
  inputDisposable = term.onData(onKey)
  motionQuery.addEventListener('change', updateMotion)
  themeObserver = new MutationObserver(updateTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })

  nextTick(() => {
    if (!term || !terminalContainer.value) return
    doFit()
    // 侧栏折叠/窗口缩放都要重新 fit，只听 window.resize 会漏
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(doFit)
      ro.observe(terminalContainer.value)
    }
  })

  // App captures real CLI events even while this route is unmounted.
  writeToTerminal(cliHistory.snapshot())
  unsubscribeHistory = cliHistory.subscribe(change => {
    if (change.type === 'reset') {
      term?.reset()
      lineBuf = ''; cursorPos = 0
      historyIndex = -1
    }
    writeToTerminal(change.text)
  })
})

// 连接状态变化时同步键盘可用性
watch(() => mav.connected.value, (v) => {
  if (term) term.options.disableStdin = !v
  if (!v) { lineBuf = ''; cursorPos = 0 }
})

onBeforeUnmount(() => {
  // 之前这里把 dispose 注释掉了：切页面会漏掉整个终端实例与其监听
  unsubscribeHistory?.()
  inputDisposable?.dispose()
  themeObserver?.disconnect()
  motionQuery?.removeEventListener('change', updateMotion)
  ro?.disconnect()
  ro = null
  term?.dispose()
  term = null
  fit = null
  unsubscribeHistory = null
  inputDisposable = null
  themeObserver = null
  motionQuery = null
})

function clearTerminal() { cliHistory.clear() }
</script>

<style scoped>
.terminal-container { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.terminal-header { display: flex; justify-content: space-between; align-items: center; }
.header-left { display: flex; align-items: center; gap: 10px; }
.header-left .title { font-size: 16px; font-weight: bold; color: var(--dsh-text-1); display: flex; align-items: center; }
.header-right { display: flex; align-items: center; gap: 12px; }
.terminal-body { width: 100%; border-radius: 8px; overflow: hidden; padding: 0 !important; background: var(--dsh-console-bg); }
:deep(.terminal-body .el-card__body) { padding: 0 !important; background: var(--dsh-console-bg); }
.xterm-wrapper { width: 100%; height: 66vh; box-sizing: border-box; padding: 8px; background: var(--dsh-console-bg); border-radius: 0 0 8px 8px; }
</style>
