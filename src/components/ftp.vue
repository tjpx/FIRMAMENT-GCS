<!-- views/Ftp.vue —— 文件传输（改造后，不再自己开串口） -->
<template>
  <div class="mavlink-ftp">
    <el-card class="control-card">
      <template #header>
        <div class="card-header">
          <span>MAVLink FTP（共享飞控连接）</span>
          <el-tag :type="mav.connected.value ? 'success' : 'info'" size="small">
            {{ mav.connected.value ? '已连接' : '未连接' }}
          </el-tag>
        </div>
      </template>

      <el-space wrap>
        <el-button :disabled="!mav.connected.value" :loading="loading" @click="refresh">刷新目录</el-button>
        <el-button type="success" :disabled="!mav.canWrite.value || uploading || downloading || loading"
                   :loading="uploading" @click="chooseUpload">上传到当前目录</el-button>
        <el-button :disabled="!mav.connected.value" @click="resetSessions">重置 FTP 会话</el-button>
        <input ref="fileInput" type="file" style="display:none" @change="onFileChange" />
      </el-space>
    </el-card>

    <TypedConfirm ref="uploadConfirm" />
    <TaskProgress v-if="loading || downloading || uploading" :title="uploading ? '上传并回读校验' : downloading ? '下载文件' : '读取目录'" :percentage="loading ? null : progress" evidence="来自真实 MAVFTP 请求；上传只有整文件回读 CRC32 匹配才完成" />
    <EmptyStateAction v-if="!mav.connected.value" title="尚未连接飞控" reason="文件浏览与传输需要真实连接。" action-label="连接飞控" @action="$emit('open-connect')" />
    <EmptyStateAction v-else-if="transferError" title="文件操作失败" :reason="transferError" action-label="重新读取目录" :action-disabled="loading || uploading || downloading" @action="refresh" />
    <EmptyStateAction v-else-if="!loading && !files.length" title="当前目录没有可显示项目" reason="仅展示飞控真实返回的目录，不填充演示文件。" action-label="刷新目录" @action="refresh" />
    <el-card class="file-card">
      <template #header>
        <div class="card-header">
          <span>飞控 SD 卡文件</span>
          <div class="path-bar">
            <el-button size="small" :disabled="currentPath === '/'" @click="goUp">上级</el-button>
            <el-tag type="info">{{ currentPath }}</el-tag>
            <el-progress v-if="downloading || uploading" :percentage="progress"
                         :stroke-width="12" style="width: 220px; margin-left: 10px;" />
          </div>
        </div>
      </template>

      <el-table :data="files" v-loading="loading" @row-dblclick="onRowDblClick" row-key="name">
        <el-table-column label="类型" width="100">
          <template #default="s">{{ s.row.type === 'dir' ? '文件夹' : '文件' }}</template>
        </el-table-column>
        <el-table-column prop="name" label="名称" />
        <el-table-column label="大小" width="140">
          <template #default="s">{{ s.row.type === 'file' ? formatSize(s.row.size) : '' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="s">
            <el-button v-if="s.row.type === 'dir'" size="small" link type="primary" @click="enterDir(s.row)">进入</el-button>
            <el-button v-if="s.row.type === 'file'" size="small" link type="success"
                       :loading="downloading" @click="downloadFile(s.row)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="log-card">
      <template #header>
        <div class="card-header">
          <span>日志</span>
          <el-button size="small" @click="logs = []">清空</el-button>
        </div>
      </template>
      <div class="log-list">
        <div v-for="(item, i) in logs" :key="i" :class="['log-item', item.type]">
          [{{ item.time }}] {{ item.msg }}
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, inject, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import TypedConfirm from './typed-confirm.vue'
import TaskProgress from './task-progress.vue'
import EmptyStateAction from './empty-state-action.vue'
import { normalizeRemotePath, ftpWritePolicy, ftpUploadVerified } from '../utils/operation-safety.js'
const emit = defineEmits(['open-connect', 'open-config-review'])
const uploadConfirm = ref(null)
const transferError = ref('')

const mav = inject('mavlink')

const loading = ref(false)
const downloading = ref(false)
const uploading = ref(false)
const progress = ref(0)
const currentPath = ref('/')
const files = ref([])
const logs = ref([])
const fileInput = ref(null)

function addLog(type, msg) {
  logs.value.push({ time: new Date().toLocaleTimeString(), type, msg })
  if (logs.value.length > 300) logs.value.splice(0, logs.value.length - 300)
}

function joinPath(p, n) { return normalizeRemotePath(`${p}/${n}`) }

function formatSize(size) {
  if (!Number.isFinite(size)) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
}

async function refresh() {
  if (!mav.connected.value) return
  loading.value = true; transferError.value = ''
  try {
    const list = await mav.ftp.list(currentPath.value)
    files.value = list.map(i => ({ ...i, fullPath: joinPath(currentPath.value, i.name) }))
    addLog('info', `目录 ${currentPath.value} 刷新成功，共 ${list.length} 项`)
  } catch (e) {
    transferError.value = e.message || String(e)
    addLog('error', transferError.value)
    ElMessage.error(`目录列表失败：${e.message}`)
  } finally { loading.value = false }
}

function enterDir(row) { if (row.type === 'dir') { currentPath.value = row.fullPath; refresh() } }
function onRowDblClick(row) { if (row.type === 'dir') enterDir(row) }
function goUp() {
  if (currentPath.value === '/') return
  const parts = currentPath.value.split('/').filter(Boolean); parts.pop()
  currentPath.value = parts.length ? `/${parts.join('/')}` : '/'
  refresh()
}

async function downloadFile(row) {
  if (!mav.connected.value || downloading.value) return
  downloading.value = true; progress.value = 0
  try {
    const blob = await mav.ftp.download(row.fullPath, p => {
      if (p != null) progress.value = Math.round(p * 100)
    })
    mav.saveBlob(blob, row.name)
    addLog('info', `下载完成：${row.name}`)
    ElMessage.success('下载完成')
  } catch (e) {
    transferError.value = e.message || String(e)
    addLog('error', transferError.value)
    ElMessage.error(`下载失败：${e.message}`)
  } finally { downloading.value = false; progress.value = 0 }
}

function chooseUpload() { if (mav.canWrite.value && !uploading.value && !downloading.value && !loading.value) fileInput.value.click() }

async function onFileChange(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file || uploading.value || downloading.value || !mav.canWrite.value) return
  uploading.value = true; progress.value = 0; transferError.value = ''
  try {
    const policy = ftpWritePolicy(joinPath(currentPath.value, file.name))
    if (policy.blocked) {
      const text = `${policy.path} 只能通过配置工作流与右下角保存，不允许 FTP 覆盖。请在配置页导入或编辑后点击「保存到飞控」。`
      addLog('info', text); ElMessage.warning(text)
      emit('open-config-review', { path: policy.path, source: 'ftp' }); return
    }
    const accepted = await uploadConfirm.value.confirm({ title: policy.system ? '系统路径危险覆盖' : '文件覆盖二次确认', description: `目标 ${policy.path}。此操作会覆盖同名文件；${policy.system ? '系统文件可能影响启动与飞行安全。' : '请确认已经备份原文件。'}`, expected: policy.confirmation, confirmText: '确认上传覆盖' })
    if (!accepted) return
    // 用户确认期间链路、全局配置闸可能变化，发送前必须再次复核。
    if (!mav.canWrite.value) throw new Error('当前不可安全写入，已取消上传')
    const res = await mav.ftp.upload(file, policy.path, {
      overwrite: true, verify: 'crc',
      onProgress: p => { if (p != null) progress.value = Math.round(p * 100) },
    })
    if (!ftpUploadVerified(res)) throw new Error('上传结果缺少完整回读 CRC32 匹配证据，不能确认成功')
    addLog('info', `上传完成并回读校验通过：${file.name}（${res.size} 字节，CRC32 ${res.crc32Hex}）`)
    ElMessage.success('上传完成，整文件回读 CRC32 匹配')
    await refresh()
  } catch (e) {
    transferError.value = e.message || String(e)
    addLog('error', transferError.value)
    ElMessage.error(`上传未确认成功：${transferError.value}`)
  } finally { uploading.value = false; progress.value = 0 }
}

async function resetSessions() {
  try { await mav.ftp.reset(); ElMessage.success('已发送重置 FTP 会话请求') }
  catch (e) { ElMessage.error(e.message || '重置失败') }
}

onMounted(() => { if (mav.connected.value) refresh() })
</script>

<style scoped>
.mavlink-ftp { display: flex; flex-direction: column; gap: 12px; padding: 8px; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.path-bar { display: flex; align-items: center; gap: 8px; }
.log-list { max-height: 240px; overflow: auto; font-family: monospace; font-size: 12px; }
.log-item { margin-bottom: 4px; }
.log-item.error { color: var(--dsh-danger-vivid); }
.log-item.info { color: var(--dsh-text-3); }
</style>
