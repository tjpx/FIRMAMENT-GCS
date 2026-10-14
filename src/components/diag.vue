<!--
  src/components/diag.vue
  ================================================================
  链路体检（开发计划 §三 S0a；只读边界见 §〇 D-3，验收口径见附 B）
  ----------------------------------------------------------------
  这页存在的唯一理由：计划里有一串"只能由真机回答"的问题（附A），而后面每个页面
  的实现都在猜答案。猜错不是小 bug——参数名到底带不带组前缀（D-6）、`/sys/param.xml`
  支持不支持（D-2 的前提）、控制台是不是 SERIAL_CONTROL 通道（D-5），猜错就得整页重做。
  所以先把猜测一次性换成事实，导出 JSON 交回来即可开工 S1～S8。

  六个探针，全部只读：
    ① 身份：HEARTBEAT 的 sysid/compid/type/autopilot/模式，外加 AUTOPILOT_VERSION 是否在发
    ② 机载配置：/sys/sysconfig.toml 与 /sys/param.xml 在不在、多大、CRC32 多少
    ③ /sys 目录：里面还有什么（板载日志、固件版本文件的线索）
    ④ 参数表：PARAM_REQUEST_LIST 能不能用、多少条、**名字形态**（是否带组前缀、是否逼近 16 字节）
    ⑤ 遥测清单：5 秒窗口内每种消息各收到多少条、频率、CRC 错误
    ⑥ 控制台：SERIAL_CONTROL 会话能不能进（只发 version 这类只读命令，见 D-5）

  本页不写参数、不写文件、不发执行命令；采不到的字段一律留空并注明原因，不补 0、不报成功。
  ================================================================
-->
<template>
  <div class="diag">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="链路体检：只读普查，不写参数、不写文件、不发执行命令"
      description="采集飞控身份、配置文件、目录、参数、遥测消息与控制台连接状态，可导出报告用于排查。未收到的数据会注明原因；本页不进行校准、电机测试或重启。"
    />

    <div class="diag-bar">
      <el-button type="primary" :disabled="!connected || busy !== ''" :loading="busy === 'all'" @click="runAll"
        >全部执行（约 {{ totalTimeSec }} 秒）</el-button
      >
      <el-button :disabled="!collected" @click="exportReport">导出体检 JSON</el-button>
      <el-button :disabled="!collected" @click="copyDigest">复制中文摘要</el-button>
      <span v-if="!connected" class="diag-hint">未连接飞控，请先在顶栏选择设备串口并连接</span>
      <span v-else-if="fv(fc.busyLabel)" class="diag-hint">{{ fv(fc.busyLabel) }}</span>
      <span class="diag-hint diag-flex"></span>
      <span class="diag-hint">已采集 {{ doneCount }}/6</span>
    </div>

    <el-collapse v-model="opened" class="diag-steps">
      <!-- ① 身份 -->
      <el-collapse-item name="identity">
        <template #title>
          <span class="diag-title">① 飞控身份（HEARTBEAT）</span>
          <el-tag size="small" :type="tagType(steps.identity.status)" class="diag-tag">{{
            tagText(steps.identity.status)
          }}</el-tag>
        </template>
        <div class="diag-tools">
          <el-button size="small" :disabled="!connected || busy !== ''" @click="runStep('identity')"
            >单独执行</el-button
          >
          <span class="diag-hint"
            >AUTOPILOT_VERSION 靠飞控主动上报，这里只听 {{ AUTOPILOT_LISTEN_MS / 1000 }} 秒，不发请求命令。</span
          >
        </div>
        <div v-if="steps.identity.error" class="diag-error">{{ steps.identity.error }}</div>
        <div v-if="steps.identity.data" class="diag-kv">
          <div v-for="row in identityRows(steps.identity.data)" :key="row.k" class="diag-kvrow">
            <span class="diag-k">{{ row.k }}</span
            ><span class="diag-v">{{ row.v }}</span>
          </div>
        </div>
      </el-collapse-item>

      <!-- ② 机载配置文件 -->
      <el-collapse-item name="files">
        <template #title>
          <span class="diag-title">② 机载配置文件（MAVFTP 只读下载）</span>
          <el-tag size="small" :type="tagType(steps.files.status)" class="diag-tag">{{
            tagText(steps.files.status)
          }}</el-tag>
        </template>
        <div class="diag-tools">
          <el-button size="small" :disabled="!connected || busy !== ''" @click="runStep('files')">单独执行</el-button>
          <span class="diag-hint">读取机载配置文件；下载失败时显示错误原因，不能视为空文件。</span>
        </div>
        <div v-if="steps.files.error" class="diag-error">{{ steps.files.error }}</div>
        <el-table v-if="steps.files.data" :data="steps.files.data" size="small" class="diag-table">
          <el-table-column prop="remote" label="远端路径" width="170" />
          <el-table-column label="存在" width="70">
            <template #default="{ row }">{{ row.present ? '是' : '否' }}</template>
          </el-table-column>
          <el-table-column prop="size" label="字节" width="90">
            <template #default="{ row }">{{ row.size === null ? '—' : row.size }}</template>
          </el-table-column>
          <el-table-column prop="crc32" label="CRC32" width="120">
            <template #default="{ row }">{{ row.crc32 || '—' }}</template>
          </el-table-column>
          <el-table-column label="BOM" width="60">
            <template #default="{ row }">{{ row.hasBom ? '有' : '无' }}</template>
          </el-table-column>
          <el-table-column label="解析" width="80">
            <template #default="{ row }">{{ row.loaded ? '已解析' : '未解析' }}</template>
          </el-table-column>
          <el-table-column prop="error" label="错误原文">
            <template #default="{ row }">{{ row.error || '' }}</template>
          </el-table-column>
        </el-table>
      </el-collapse-item>

      <!-- ③ /sys 目录 -->
      <el-collapse-item name="sys">
        <template #title>
          <span class="diag-title">③ /sys 目录列举</span>
          <el-tag size="small" :type="tagType(steps.sys.status)" class="diag-tag">{{
            tagText(steps.sys.status)
          }}</el-tag>
        </template>
        <div class="diag-tools">
          <el-button size="small" :disabled="!connected || busy !== ''" @click="runStep('sys')">单独执行</el-button>
          <span class="diag-hint">查看机载目录内容；无法识别的信息保留在诊断报告中。</span>
        </div>
        <div v-if="steps.sys.error" class="diag-error">{{ steps.sys.error }}</div>
        <div v-if="steps.sys.data" class="diag-hint">
          共 {{ steps.sys.data.count }} 项 · 实际返回形状 {{ steps.sys.data.shape }}
        </div>
        <el-table
          v-if="steps.sys.data && steps.sys.data.count"
          :data="steps.sys.data.entries"
          size="small"
          class="diag-table"
        >
          <el-table-column prop="name" label="名称">
            <template #default="{ row }">{{ row.name || '—' }}</template>
          </el-table-column>
          <el-table-column prop="size" label="字节" width="110">
            <template #default="{ row }">{{ row.size === null ? '—' : row.size }}</template>
          </el-table-column>
          <el-table-column prop="directory" label="目录" width="90">
            <template #default="{ row }">{{ row.directory === null ? '—' : row.directory ? '是' : '否' }}</template>
          </el-table-column>
        </el-table>
      </el-collapse-item>

      <!-- ④ 参数表 -->
      <el-collapse-item name="params">
        <template #title>
          <span class="diag-title">④ 参数表普查（PARAM_REQUEST_LIST）</span>
          <el-tag size="small" :type="tagType(steps.params.status)" class="diag-tag">{{
            tagText(steps.params.status)
          }}</el-tag>
        </template>
        <div class="diag-tools">
          <el-button size="small" :disabled="!connected || busy !== ''" @click="runStep('params')">单独执行</el-button>
          <span class="diag-hint">读取参数列表，查看参数数量、名称、类型及读取完整性。</span>
        </div>
        <div v-if="steps.params.error" class="diag-error">{{ steps.params.error }}</div>
        <div v-if="steps.params.data" class="diag-kv">
          <div class="diag-kvrow">
            <span class="diag-k">读到 / 声称总数</span>
            <span class="diag-v"
              >{{ steps.params.data.summary.got }} /
              {{ steps.params.data.summary.total === null ? '未告知' : steps.params.data.summary.total }}</span
            >
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">结束原因</span
            ><span class="diag-v">{{ steps.params.data.summary.reason || '未采集' }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">耗时</span>
            <span class="diag-v">{{
              steps.params.data.summary.ms === null ? '—' : steps.params.data.summary.ms + ' ms'
            }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">结论</span><span class="diag-v">{{ steps.params.data.summary.note }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">名字带下划线 / 不带</span>
            <span class="diag-v"
              >{{ steps.params.data.shape.withUnderscore }} / {{ steps.params.data.shape.withoutUnderscore }}</span
            >
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">首段前缀种类</span
            ><span class="diag-v">{{ steps.params.data.shape.prefixKinds }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">前缀分布</span><span class="diag-v">{{ prefixText(steps.params.data.shape) }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">最长名字 / 逼近 16 字节</span>
            <span class="diag-v"
              >{{ steps.params.data.shape.maxLength }} 字节 / {{ steps.params.data.shape.nearParamIdLimit }} 条</span
            >
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">名字样例</span
            ><span class="diag-v">{{ steps.params.data.shape.samples.join(' 、 ') || '—' }}</span>
          </div>
          <div class="diag-kvrow" v-if="steps.params.data.audit">
            <span class="diag-k">类型分布</span>
            <span class="diag-v">{{ auditTypeText(steps.params.data.audit) }}</span>
          </div>
          <div class="diag-kvrow" v-if="steps.params.data.audit">
            <span class="diag-k">整型参数</span>
            <span class="diag-v"
              >{{ steps.params.data.audit.intTyped }} 条（float 与整型两种读法分歧
              {{ steps.params.data.audit.divergingCount }} 条，不可仅凭链路定值
              {{ steps.params.data.audit.unreliable }} 条）</span
            >
          </div>
          <div class="diag-kvrow" v-if="steps.params.data.audit && steps.params.data.audit.duplicatedFrames !== null">
            <span class="diag-k">重名帧数</span>
            <span class="diag-v"
              >{{ steps.params.data.audit.duplicatedFrames }} 帧（收到 {{ steps.params.data.audit.frames }} 帧、去重后
              {{ steps.params.data.audit.total }} 个名字）</span
            >
          </div>
          <div class="diag-kvrow" v-if="steps.params.data.audit && steps.params.data.audit.diverging.length">
            <span class="diag-k">分歧样例</span>
            <span class="diag-v">{{ auditDivergeText(steps.params.data.audit) }}</span>
          </div>
        </div>
        <el-table
          v-if="steps.params.data && steps.params.data.rows.length"
          :data="steps.params.data.rows"
          size="small"
          max-height="260"
          class="diag-table"
        >
          <el-table-column prop="index" label="#" width="60" />
          <el-table-column prop="name" label="参数名（飞控原样）" width="200" />
          <el-table-column prop="type" label="类型码" width="80">
            <template #default="{ row }">{{ row.type === null ? '—' : row.type }}</template>
          </el-table-column>
          <el-table-column prop="value" label="值">
            <template #default="{ row }">{{ row.value === null ? '—' : row.value }}</template>
          </el-table-column>
        </el-table>
        <div
          v-if="steps.params.data && steps.params.data.summary.got > steps.params.data.rows.length"
          class="diag-hint"
        >
          界面只列前 {{ steps.params.data.rows.length }} 条，全表在导出的 JSON 里。
        </div>
      </el-collapse-item>

      <!-- ⑤ 遥测清单 -->
      <el-collapse-item name="telemetry">
        <template #title>
          <span class="diag-title">⑤ 遥测消息清单（{{ CENSUS_MS / 1000 }} 秒窗口）</span>
          <el-tag size="small" :type="tagType(steps.telemetry.status)" class="diag-tag">{{
            tagText(steps.telemetry.status)
          }}</el-tag>
        </template>
        <div class="diag-tools">
          <el-button size="small" :disabled="!connected || busy !== ''" @click="runStep('telemetry')"
            >单独执行</el-button
          >
          <span class="diag-hint">统计采集窗口内收到的各类消息数量与频率。</span>
        </div>
        <div v-if="steps.telemetry.error" class="diag-error">{{ steps.telemetry.error }}</div>
        <div v-if="steps.telemetry.data" class="diag-kv">
          <div class="diag-kvrow">
            <span class="diag-k">窗口</span><span class="diag-v">{{ steps.telemetry.data.windowMs }} ms</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">种类数</span><span class="diag-v">{{ steps.telemetry.data.rows.length }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">窗口内增量字节</span>
            <span class="diag-v">{{
              steps.telemetry.data.bytesInWindow === null ? '—' : steps.telemetry.data.bytesInWindow
            }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">窗口内 CRC 错误</span><span class="diag-v">{{ steps.telemetry.data.crcErrors }}</span>
          </div>
        </div>
        <el-table v-if="steps.telemetry.data" :data="steps.telemetry.data.findings" size="small" class="diag-table">
          <el-table-column prop="name" label="关注消息" width="190" />
          <el-table-column label="窗口内条数" width="110">
            <template #default="{ row }">{{ row.rxInWindow }}</template>
          </el-table-column>
          <el-table-column label="频率" width="100">
            <template #default="{ row }">{{ row.rateHz === null ? '—' : row.rateHz + ' Hz' }}</template>
          </el-table-column>
          <el-table-column prop="note" label="说明" />
        </el-table>
        <el-table
          v-if="steps.telemetry.data && steps.telemetry.data.rows.length"
          :data="steps.telemetry.data.rows"
          size="small"
          max-height="260"
          class="diag-table"
        >
          <el-table-column prop="msgid" label="msgid" width="80" />
          <el-table-column prop="name" label="消息名" width="200" />
          <el-table-column prop="rxInWindow" label="窗口条数" width="100" />
          <el-table-column prop="rateHz" label="频率(Hz)" width="90">
            <template #default="{ row }">{{ row.rateHz }}</template>
          </el-table-column>
          <el-table-column prop="rxTotal" label="累计" width="90" />
          <el-table-column prop="crcErrorsInWindow" label="CRC 错" width="90" />
        </el-table>
      </el-collapse-item>

      <!-- ⑥ 控制台 -->
      <el-collapse-item name="console">
        <template #title>
          <span class="diag-title">⑥ 控制台会话探针（只发只读命令）</span>
          <el-tag size="small" :type="tagType(steps.console.status)" class="diag-tag">{{
            tagText(steps.console.status)
          }}</el-tag>
        </template>
        <div class="diag-tools">
          <el-button size="small" :disabled="!connected || busy !== ''" @click="runStep('console')">单独执行</el-button>
          <span class="diag-hint">仅发送 version 查询命令；回显只说明控制台有响应，不代表其他命令执行成功。</span>
        </div>
        <div v-if="steps.console.error" class="diag-error">{{ steps.console.error }}</div>
        <div v-if="steps.console.data" class="diag-kv">
          <div class="diag-kvrow">
            <span class="diag-k">回显</span><span class="diag-v">{{ steps.console.data.responded ? '有' : '无' }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">字节 / 行数</span
            ><span class="diag-v">{{ steps.console.data.bytes }} / {{ steps.console.data.lines }}</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">等待窗口</span><span class="diag-v">{{ steps.console.data.waitedMs }} ms</span>
          </div>
          <div class="diag-kvrow">
            <span class="diag-k">结论</span><span class="diag-v">{{ steps.console.data.note }}</span>
          </div>
        </div>
        <pre v-if="steps.console.data && steps.console.data.raw" class="diag-raw">{{ steps.console.data.raw }}</pre>
      </el-collapse-item>
    </el-collapse>

    <div v-if="errors.length" class="diag-block">
      <div class="diag-h">采集过程中的错误（{{ errors.length }} 条，原文保留）</div>
      <div v-for="(e, i) in errors" :key="i" class="diag-error">
        {{ e.step }} · {{ e.at }} · {{ e.name ? e.name + '：' : '' }}{{ e.error }}
      </div>
    </div>

    <div class="diag-block">
      <div class="diag-h">诊断范围与限制</div>
      <ul class="diag-ul">
        <li>接收机配置需要连接实际接收机并核对输入；收到 RC_CHANNELS 消息不代表配置正确。</li>
        <li>本页不验证电调、电机输出或机体动作。</li>
        <li>传感器与接收机校准需在对应页面按设备说明完成。</li>
        <li>飞行日志分析请使用日志分析工具。</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  buildReport,
  censusRates,
  consoleProbeSummary,
  fileSummary,
  identitySummary,
  jsonSafe,
  noteError,
  normalizeParamList,
  paramNameShape,
  paramAudit,
  paramReadSummary,
  reportDigest,
  sysListingSummary,
  telemetryFindings,
} from '../utils/diag-report.js'

const mav = inject('mavlink')
const fc = inject('fcconfig')

/* fcconfig 可能是 Pinia store（属性已解包）或原始 ref 对象，两种都能读 */
function fv(x) {
  return x && typeof x === 'object' && 'value' in x ? x.value : x
}

/* 窗口时长：5 秒够看清 10/20/50 Hz 的差别，又不至于让"全部执行"等太久 */
const CENSUS_MS = 5000
const AUTOPILOT_LISTEN_MS = 2000
const CONSOLE_WAIT_MS = 2500
const PARAM_PREVIEW = 20

const connected = computed(() => mav?.connected?.value === true)
const busy = ref('')
const opened = ref(['identity'])
const errors = ref([])

const steps = reactive({
  identity: { status: 'idle', data: null, error: '' },
  files: { status: 'idle', data: null, error: '' },
  sys: { status: 'idle', data: null, error: '' },
  params: { status: 'idle', data: null, error: '' },
  telemetry: { status: 'idle', data: null, error: '' },
  console: { status: 'idle', data: null, error: '' },
})

const doneCount = computed(() => Object.values(steps).filter((s) => s.status === 'ok').length)
const collected = computed(() => doneCount.value > 0)
const totalTimeSec = computed(() => Math.round((CENSUS_MS + AUTOPILOT_LISTEN_MS + CONSOLE_WAIT_MS) / 1000))

const timers = new Set()
const cleanups = new Set()
const sleep = (ms) =>
  new Promise((resolve) => {
    const h = setTimeout(() => {
      timers.delete(h)
      resolve()
    }, ms)
    timers.add(h)
  })

function tagType(s) {
  return s === 'ok' ? 'success' : s === 'run' ? 'warning' : s === 'fail' ? 'danger' : 'info'
}
function tagText(s) {
  return s === 'ok' ? '已采集' : s === 'run' ? '采集中' : s === 'fail' ? '失败' : '未执行'
}
function identityRows(d) {
  const id = d.identity || {}
  const av = d.autopilotVersion || {}
  const link = id.link || {}
  return [
    { k: 'sysid / compid', v: `${fmt(id.sysid)} / ${fmt(id.compid)}` },
    { k: 'type / autopilot', v: `${fmt(id.type)} / ${fmt(id.autopilot)}` },
    { k: '模式', v: fmt(id.modeName) + (id.modeCode === null ? '' : `（custom_mode ${id.modeCode}）`) },
    { k: '是否解锁', v: id.armed ? '已解锁（本页不会替你解锁）' : '未解锁' },
    {
      k: '心跳距今',
      v:
        id.heartbeatAgeMs === null
          ? '—'
          : `${id.heartbeatAgeMs} ms ${id.heartbeatAlive ? '（新鲜）' : '（超时：链路可能已断）'}`,
    },
    { k: '波特率', v: fmt(id.baudRate) },
    {
      k: '链路统计',
      v: `帧 ${fmt(link.frames)} · 消息 ${fmt(link.rxMsgs)} · 字节 ${fmt(link.rxBytes)} · CRC 错 ${fmt(link.crcErrors)} · 协议表自愈 ${fmt(link.learnedCrcExtra)}`,
    },
    {
      k: 'AUTOPILOT_VERSION',
      v: av.seen
        ? '在主动上报（字段进导出 JSON）'
        : `窗口内未上报（${av.waitedMs} ms）：要拿固件版本得发请求命令，属副作用，未获批`,
    },
  ]
}
function fmt(v) {
  return v === null || v === undefined || v === '' ? '—' : String(v)
}
function prefixText(shape) {
  if (!shape || !shape.topPrefixes || !shape.topPrefixes.length) return '—'
  return shape.topPrefixes.map((x) => `${x.prefix}(${x.count})`).join(' ')
}

async function withStep(key, fn) {
  const st = steps[key]
  st.status = 'run'
  st.error = ''
  busy.value = key
  try {
    st.data = await fn()
    st.status = 'ok'
  } catch (e) {
    st.status = 'fail'
    st.error = e && e.message ? String(e.message) : String(e)
    noteError(errors.value, key, e)
  } finally {
    busy.value = ''
  }
}

/* ① 身份：HEARTBEAT 已经在飞，这里只读缓存 + 听 AUTOPILOT_VERSION 两秒 */
function doIdentity() {
  const last = mav?.vehicle?.lastHeartbeatAt || 0
  const identity = identitySummary(mav?.vehicle, mav?.stats, fv(mav?.baudRate), last ? Date.now() - last : null)
  return new Promise(async (resolve) => {
    let seen = false
    let fields = null
    const off = mav.on('AUTOPILOT_VERSION', (p) => {
      seen = true
      // 解码结果是普通对象，字段原样留着，页面不解释（版本号语义属阶段四）
      fields = p && typeof p === 'object' ? { ...p } : null
    })
    if (typeof off === 'function') cleanups.add(off)
    await sleep(AUTOPILOT_LISTEN_MS)
    if (typeof off === 'function') {
      off()
      cleanups.delete(off)
    }
    resolve({ identity, autopilotVersion: { seen, fields, waitedMs: AUTOPILOT_LISTEN_MS } })
  })
}

/* ② 机载配置文件：连接时全局拉过就复用，没拉成就地拉一次（仍然只读） */
async function doFiles() {
  if (!fc) throw new Error('没有注入 fcconfig，取不到配置文件状态')
  if (!fv(fc.loaded)) await fc.pullAll()
  return fileSummary(fv(fc.files))
}

/* ③ /sys 目录：返回形状未知，交给 sysListingSummary 老实地记 */
async function doSys() {
  if (!mav?.ftp?.list) throw new Error('内核没有提供 ftp.list')
  return sysListingSummary(await mav.ftp.list('/sys'))
}

/* ④ 参数表：整表读取（只读），并把名字形态一次性统计出来——这是 S0a 的核心问题 */
async function doParams() {
  if (!mav?.param?.readAll) throw new Error('内核没有提供 param.readAll')
  const result = await mav.param.readAll({ timeout: 30000 })
  const list = normalizeParamList(result)
  return {
    summary: paramReadSummary(result, list),
    audit: paramAudit(list, {
      frames: result?.rxTotal ?? result?.frames ?? result?.received ?? null,
    }),
    shape: paramNameShape(list),
    rows: list.slice(0, PARAM_PREVIEW),
    all: list,
  }
}

/* 体检里的类型分布与分歧样例，只在面板显示，全量数据在导出的 JSON 里 */
function auditTypeText(a) {
  return (a?.byType || []).map((b) => `${b.text || b.type}:${b.count}`).join(' 、 ') || '—'
}

function auditDivergeText(a) {
  return (
    (a?.diverging || [])
      .slice(0, 3)
      .map((d) => `${d.name} float=${d.float} 整型=${d.typed}`)
      .join(' ；') || '—'
  )
}

/* ⑤ 遥测清单：窗口前后各取一次 msgCensus 快照，差值算频率 */
async function doTelemetry() {
  if (typeof mav?.msgCensus !== 'function') throw new Error('内核没有提供 msgCensus()，无法按 msgid 普查')
  const bytesBefore = mav?.stats?.rxBytes ?? 0
  const prev = mav.msgCensus()
  const t0 = Date.now()
  await sleep(CENSUS_MS)
  const windowMs = Date.now() - t0
  const rows = censusRates(prev, mav.msgCensus(), windowMs)
  const bytesInWindow = (mav?.stats?.rxBytes ?? 0) - bytesBefore
  return {
    windowMs,
    rows,
    findings: telemetryFindings(rows),
    bytesInWindow: Number.isFinite(bytesInWindow) ? bytesInWindow : null,
    crcErrors: rows.reduce((s, r) => s + (r.crcErrorsInWindow || 0), 0),
  }
}

/* ⑥ 控制台：只发 version 这一条只读命令，收回显；无回显就直说 */
function doConsole() {
  if (!mav?.cli?.sendCommand) throw new Error('内核没有提供 cli.sendCommand')
  return new Promise(async (resolve) => {
    let text = ''
    const off = mav.on('cli', (chunk) => {
      text += String(chunk ?? '')
    })
    if (typeof off === 'function') cleanups.add(off)
    mav.cli.open()
    mav.cli.sendCommand('version')
    await sleep(CONSOLE_WAIT_MS)
    if (typeof off === 'function') {
      off()
      cleanups.delete(off)
    }
    resolve(consoleProbeSummary({ text, ms: CONSOLE_WAIT_MS, sent: 'version' }))
  })
}

const RUNNERS = {
  identity: doIdentity,
  files: doFiles,
  sys: doSys,
  params: doParams,
  telemetry: doTelemetry,
  console: doConsole,
}

function runStep(key) {
  if (!connected.value) return
  return withStep(key, RUNNERS[key])
}

/* 全部执行：身份和参数要放在最前面（后面几步依赖链路是否真的活着），
   遥测清单最后跑，这样统计窗口里覆盖到前面几步触发的回包。 */
async function runAll() {
  if (!connected.value || busy.value) return
  busy.value = 'all'
  errors.value = []
  for (const key of ['identity', 'sys', 'files', 'params', 'telemetry', 'console']) {
    const st = steps[key]
    st.status = 'run'
    st.error = ''
    busy.value = key
    try {
      st.data = await RUNNERS[key]()
      st.status = 'ok'
    } catch (e) {
      st.status = 'fail'
      st.error = e && e.message ? String(e.message) : String(e)
      noteError(errors.value, key, e)
    }
    busy.value = 'all'
  }
  busy.value = ''
  if (collected.value) ElMessage.success(`体检采集完成：${doneCount.value}/6 项已采集`)
}

function currentReport() {
  const p = steps.params.data
  const t = steps.telemetry.data
  return buildReport({
    identity: steps.identity.data ? steps.identity.data.identity : null,
    autopilotVersion: steps.identity.data ? steps.identity.data.autopilotVersion : null,
    files: steps.files.data ?? null,
    sysListing: steps.sys.data ?? null,
    params: p ? p.summary : null,
    paramShape: p ? p.shape : null,
    paramList: p ? p.all : null,
    paramAudit: p ? p.audit : null,
    telemetry: t
      ? { windowMs: t.windowMs, rows: t.rows, bytesInWindow: t.bytesInWindow, crcErrors: t.crcErrors }
      : null,
    findings: t ? t.findings : null,
    consoleProbe: steps.console.data ?? null,
    errors: errors.value,
  })
}

function exportReport() {
  if (!mav?.saveBlob) {
    ElMessage.error('内核没有提供导出通道')
    return
  }
  const report = jsonSafe({ ...currentReport(), paramList: steps.params.data ? steps.params.data.all : null })
  const text = JSON.stringify(report, null, 2)
  const name = `link-census-${String(report.generatedAt || '').replace(/[:.]/g, '-')}.json`
  mav.saveBlob(new Blob([text], { type: 'application/json' }), name)
  ElMessage.success(`已导出 ${name}（${report.panel}）`)
}

async function copyDigest() {
  const digest = reportDigest(currentReport())
  try {
    await navigator.clipboard.writeText(digest)
    ElMessage.success('中文摘要已复制')
  } catch (e) {
    ElMessage.warning(`剪贴板不可用，摘要已改为下载：${e?.message || e}`)
    if (mav?.saveBlob) mav.saveBlob(new Blob([digest], { type: 'text/plain' }), 'link-census-digest.txt')
  }
}

onBeforeUnmount(() => {
  for (const h of timers) clearTimeout(h)
  timers.clear()
  for (const off of cleanups) {
    try {
      off()
    } catch (e) {
      /* 解绑失败不影响卸载 */
    }
  }
  cleanups.clear()
})
</script>

<style scoped>
.diag {
  padding: 4px;
}
.diag-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}
.diag-flex {
  flex: 1;
}
.diag-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.diag-steps {
  margin-bottom: 12px;
}
.diag-title {
  margin-right: 8px;
  font-weight: 600;
}
.diag-tag {
  margin-left: 4px;
}
.diag-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.diag-table {
  width: 100%;
  margin: 6px 0;
}
.diag-kv {
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 2px 10px;
  font-size: 12px;
}
.diag-kvrow {
  display: contents;
}
.diag-k {
  color: var(--el-text-color-secondary);
}
.diag-v {
  word-break: break-all;
}
.diag-error {
  color: var(--el-color-danger);
  font-size: 12px;
  margin: 4px 0;
  word-break: break-all;
}
.diag-raw {
  background: var(--el-fill-color-light);
  padding: 6px 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 220px;
  overflow: auto;
}
.diag-block {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 8px 10px;
  margin: 10px 0;
}
.diag-h {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}
.diag-ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.8;
}
</style>
