<template>
  <div class="dsh-shell">
    <el-container class="dsh-frame">
      <!-- 顶部状态栏：中性面 + 主色只留品牌点。
           原先整条顶栏刷成主色（而且主色是 EP 默认蓝），夜间模式等于一条发亮的蓝杠，
           还把"外壳"和"飞行数据"混成一团；外壳退到背景，数据才显眼。 -->
      <el-header class="dsh-header">
        <el-row :gutter="8" align="middle" style="height: 100%">
          <el-col :span="3" class="dsh-brand">
            <span class="dsh-brand-mark" aria-hidden="true"></span>
            <strong>FIRMAMENT GCS</strong>
          </el-col>
          <el-col :span="12" class="status-bar">
            <!-- 电池：本固件不周期发送 BATTERY_STATUS，电压/电量一律来自 SYS_STATUS -->
            <span class="status-item">
              <el-tag size="small" :type="batteryTag.type" effect="plain" :title="batteryTag.title">
                {{ batteryTag.text }}
              </el-tag>
            </span>
            <!-- 传感器健康：按 SYS_STATUS 的 present/enabled/health 位展开，不写死标签 -->
            <span v-for="s in sensors" :key="s.key" class="status-item">
              <el-tag size="small" :type="s.type" :effect="s.effect" :title="s.title">{{ s.text }}</el-tag>
            </span>
            <span v-if="sensorsEmpty" class="status-item">
              <el-tag size="small" type="info" effect="plain">传感器状态未上报</el-tag>
            </span>
            <!-- GPS：定位质量文案取自生成表枚举，3D 及以上判定可用 -->
            <span class="status-item">
              <el-tag size="small" :type="data.gps.usable ? 'success' : 'info'" effect="plain" :title="gpsTitle">
                GPS {{ data.gps.satellitesVisible }}
              </el-tag>
            </span>
            <!-- 解锁与飞行模式：HEARTBEAT 的 base_mode 解锁位 + PX4 主/子模式编码 -->
            <span class="status-item">
              <el-tag
                size="small"
                :type="vehicle.armed ? 'danger' : 'success'"
                :effect="vehicle.armed ? 'dark' : 'plain'"
              >
                {{ vehicle.armed ? '已解锁' : '未解锁' }}
              </el-tag>
            </span>
            <span class="status-item">
              <el-tag size="small" :effect="vehicle.detected ? 'dark' : 'plain'" type="info" :title="vehicle.modeCode">
                {{ vehicle.detected ? vehicle.modeName : '模式 --' }}
              </el-tag>
            </span>
          </el-col>
          <el-col :span="9" class="head-right">
            <!-- 三态主题开关。原先藏在页脚一个二态按钮里，多数人根本找不到入口；
                 现在跟随系统 / 日间 / 夜间 三档并排，当前档高亮，悬停说明白。 -->
            <div class="dsh-theme-switch" role="group" aria-label="界面主题">
              <el-tooltip v-for="m in MODE_ORDER" :key="m" :content="MODE_TIP[m]" placement="bottom" :show-after="200">
                <button
                  type="button"
                  class="dsh-theme-btn"
                  :class="{ 'is-active': mode === m }"
                  :aria-pressed="mode === m ? 'true' : 'false'"
                  @click="setMode(m)"
                >
                  <el-icon :size="14"><component :is="MODE_ICON[m]" /></el-icon>
                </button>
              </el-tooltip>
            </div>
            <el-tag
              v-if="motorTestState.active || motorTestState.uncertain"
              class="dsh-danger-breathe"
              size="small"
              type="danger"
              effect="dark"
              >{{ motorTestState.uncertain ? '电机停止未确认' : '电机测试中' }}</el-tag
            >
            <el-tag
              v-else-if="crcAlarm"
              class="dsh-danger-breathe"
              size="small"
              type="danger"
              effect="dark"
              title="最近一秒至少20帧，CRC错误占比超过5%"
              >CRC 错误率过高</el-tag
            >
            <span class="conn-text" :data-state="connState">
              <i class="dsh-dot" aria-hidden="true"></i>{{ statusText }}
            </span>
            <el-tag v-if="linkWarn" size="small" type="warning" effect="dark">{{ linkWarn }}</el-tag>
            <el-button v-if="data.statusLogs.length" size="small" plain @click="alertOpen = true"
              >告警 {{ data.statusLogs.length }}</el-button
            >
            <!-- 飞控最新一条 STATUSTEXT：等级决定配色，故障不再和调试信息长一个样 -->
            <el-tag
              v-if="lastStatus"
              size="small"
              :type="lastStatus.type"
              effect="light"
              class="status-msg"
              :title="`${lastStatus.severityLabel} · ${lastStatus.time ? new Date(lastStatus.time).toLocaleTimeString() : ''}`"
            >
              {{ lastStatus.text }}
            </el-tag>
            <el-button v-if="mav.reconnecting.value" @click="mav.disconnect()" plain size="small" type="danger"
              >取消重连</el-button
            >
            <el-button
              v-else-if="!connected"
              :disabled="mav.firmwareExclusive.value"
              class="!ml-0"
              plain
              @click="connectDialog = true"
              size="small"
            >
              连接飞控
            </el-button>
            <el-button v-else @click="mav.disconnect()" plain size="small" type="danger"> 断开连接 </el-button>
          </el-col>
        </el-row>
      </el-header>

      <el-container style="flex: 1; overflow: hidden; padding: 0">
        <!-- 左侧导航：图标 + 文字的行式条目，当前项有主色指示条。
             原先是 12 个主色实心按钮（蓝药丸墙）：没图标、没当前页感，找页面只能逐个读中文。 -->
        <el-aside v-if="!onHomeWorkspace" class="dsh-nav">
          <nav class="dsh-nav-list" aria-label="功能导航">
            <router-link
              v-for="item in visibleMenu"
              :key="item.path"
              :to="item.path"
              custom
              v-slot="{ href, navigate, isExactActive }"
            >
              <a
                class="dsh-nav-item"
                :class="{ 'is-active': isExactActive }"
                :href="href"
                :aria-current="isExactActive ? 'page' : undefined"
                @click="navigate"
              >
                <el-icon class="dsh-nav-icon" :size="15"><component :is="NAV_ICONS[item.path]" /></el-icon>
                <span class="dsh-nav-label">{{ item.label }}</span>
              </a>
            </router-link>
          </nav>
        </el-aside>

        <!-- 主内容 -->
        <el-main class="dsh-main">
          <ConnectionStateNotice
            v-if="!onHomeWorkspace"
            :state="
              !connected ? 'disconnected' : deviceState.phase === 'stale' ? 'stale' : canOperate ? 'online' : 'waiting'
            "
            :cleared="false"
          />
          <el-alert
            v-if="motorTestState.uncertain"
            title="电机输出停止未确认"
            type="error"
            :closable="false"
            show-icon
            description="断链、超时或离开页面不能保证电机停止。请先物理切断动力并确认停止。"
          >
            <el-button size="small" type="danger" plain @click="confirmPhysicalStop">确认已物理断开动力</el-button>
          </el-alert>
          <PageFunctionHelp />
          <router-view
            @open-connect="connectDialog = true"
            @motor-test-state="updateMotorTestState"
            @open-config-review="saveBarRef?.showPanel()"
          />
        </el-main>
      </el-container>

      <!-- 底部：链路账目 + 当前主题读数。主题切换入口已上移到顶栏，这里只报状态。 -->
      <el-footer class="dsh-footer">
        <el-row align="middle" class="dsh-foot-row">
          <el-col :span="17" class="dsh-foot-left">
            <span class="foot-stat">应用版本 v{{ appVersion }}</span>
            <el-button size="small" text @click="searchRef?.open()" title="搜索参数（/）">搜索 /</el-button>
            <el-button size="small" text @click="quickFtp" :disabled="!connected">下载机载文件</el-button>
            <el-button
              v-if="!connected && mav.hasPreviousPort.value"
              size="small"
              text
              :loading="connecting"
              :disabled="mav.reconnecting.value"
              @click="reconnectPrevious"
              >重连上次串口</el-button
            >
            <span v-if="connected" class="foot-stat dsh-num">{{ rxStallText }}</span>
          </el-col>
          <el-col :span="7" class="dsh-foot-right">
            <SaveBar
              ref="saveBarRef"
              v-show="connected || mav.reconnecting.value || mav.reconnectStatus.value === 'failed'"
              @saved="finishSaveAndLeave"
              @save-failed="leaveConfig.settle(false)"
            />
            <span class="foot-stat" :title="'主题：' + modeText + '（切换入口在顶栏右侧）'">
              {{ modeText }}
            </span>
          </el-col>
        </el-row>
      </el-footer>
    </el-container>

    <ConfigSearch ref="searchRef" @navigate="navigateSearch" />
    <el-drawer v-model="alertOpen" title="告警中心" size="380px">
      <el-alert
        v-for="(entry, i) in [...data.statusLogs].reverse()"
        :key="`${entry.time}-${i}`"
        :type="entry.type || 'info'"
        :closable="false"
        show-icon
        class="alert-entry"
        :title="entry.text || '未提供文字'"
      >
        <template #default
          ><div class="alert-detail">
            {{ entry.severityLabel || '未知等级' }} ·
            {{ entry.time ? new Date(entry.time).toLocaleTimeString() : '时间未知' }}
          </div>
          <el-button v-if="entry.type === 'danger'" size="small" text type="danger" @click="goPreflight"
            >打开准备飞行检查</el-button
          ></template
        >
      </el-alert>
      <EmptyStateAction
        v-if="!data.statusLogs.length"
        title="尚无状态告警"
        reason="当前会话尚未收到 STATUSTEXT；空列表不代表安全检查通过。"
      />
    </el-drawer>

    <el-dialog
      :model-value="leaveConfig.visible"
      title="离开前处理配置改动"
      width="min(480px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      @update:model-value="
        (value) => {
          if (!value) leaveConfig.settle(false)
        }
      "
    >
      <p>
        当前有 <strong class="dsh-num">{{ fcConfig.changeList.length }}</strong> 项未保存修改。
      </p>
      <p class="tip">
        保存并离开会将运行参数写入飞控并执行 param
        save，核对持久化结果后离开，不重启；系统配置文件修改校验通过后才自动重启重连。丢弃只还原本地草稿，不撤销已发生的机载
        RAM 写入。
      </p>
      <template #footer>
        <el-button size="small" @click="leaveConfig.settle(false)">留在本页</el-button>
        <el-button size="small" type="danger" plain :disabled="!!fcConfig.busy" @click="discardAndLeave"
          >丢弃改动并离开</el-button
        >
        <el-button size="small" type="primary" :disabled="!connected || !!fcConfig.busy" @click="reviewAndLeave"
          >保存并离开</el-button
        >
      </template>
    </el-dialog>

    <!-- 连接对话框 -->
    <el-dialog v-model="connectDialog" title="连接飞控" width="420px" :close-on-click-modal="false">
      <el-form label-width="80px">
        <el-form-item label="传输方式">
          <el-radio-group v-model="transportType">
            <el-radio value="webserial">Web Serial</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="波特率">
          <el-select v-model="baudRate" style="width: 160px">
            <el-option v-for="b in baudRates" :key="b" :label="String(b)" :value="b" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标 ID">
          <el-input-number v-model="targetSys" :min="1" :max="255" size="small" />
          <span style="margin: 0 6px">/</span>
          <el-input-number v-model="targetComp" :min="1" :max="255" size="small" />
          <span class="tip">（自动识别时无需修改）</span>
        </el-form-item>
        <el-alert v-if="mav.error" type="error" :closable="false" :title="mav.error" style="margin-top: 8px" />
      </el-form>
      <template #footer>
        <el-button @click="connectDialog = false">取消</el-button>
        <el-button type="primary" :loading="connecting" @click="handleConnect"> 连接串口 </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onBeforeUnmount, provide, inject, watch } from 'vue'
// 图标按需具名导入（不整包引入）。名字全部核对过 @element-plus/icons-vue 的组件清单：
// first-aid-panel 这类不存在的名字不能用，链路体检页改走 Histogram。
import {
  Connection,
  Cpu,
  Document,
  FolderOpened,
  Histogram,
  Monitor,
  Moon,
  Odometer,
  Upload,
  PartlyCloudy,
  Setting,
  SetUp,
  Share,
  Sunny,
  Tickets,
  VideoPlay,
  List,
  House,
  Collection,
  Lightning,
  Warning,
  CircleCheck,
  DataLine,
} from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useMavlink } from './composables/useMavlink.js'
// 飞控配置文件的全站单一来源：连接即拉取 sysconfig.toml / param.xml
import { useFcConfigStore } from './stores/fcconfig.js'
import { useConfigLeaveStore } from './stores/config-leave.js'
// 右下角全局保存条（S1）：全站唯一的配置写盘出口，四个编辑页只改文档不各存各的
import { canVisitWithoutDevice } from './utils/page-access.js'
import { shouldOpenConfigSearch } from './utils/search-index.js'
import { focusSearchField } from './utils/search-focus.js'
import ConfigSearch from './components/config-search.vue'
import { attachCliHistory } from './utils/cli-history.js'
import SaveBar from './components/save-bar.vue'
import EmptyStateAction from './components/empty-state-action.vue'
import ConnectionStateNotice from './components/connection-state-notice.vue'
import PageFunctionHelp from './components/page-function-help.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
// 顶栏不再写死 GYR/ACC/MAG 之类标签：位定义与中文名都取自固件生成的枚举表
import { sensorBits } from './protocol/mav-labels.js'

/* 版本号编译期注入（见 vite.config.js 的 define），与 package.json 单一来源 */
const appVersion = __APP_VERSION__

/* ============ 主题：跟随系统 / 日间 / 夜间 三态 ============ */
// 状态与 DOM 着色都收敛在 src/custom/useTheme.js（模块级单例），这里只取用。
// 兜底初值是有意义的：万一 provide 链断了，界面仍然可读，而不是整个不渲染。
let isDark = ref(false)
let mode = ref('auto'),
  setMode = () => {},
  modeText = ref('跟随系统')
try {
  const theme = inject('theme')
  if (theme) {
    isDark = theme.isDark
    mode = theme.mode
    setMode = theme.setMode
    modeText = theme.modeText
  }
} catch {}

/* 顶栏三态开关的展示资料：数组顺序就是按钮从左到右的顺序 */
const MODE_ORDER = ['auto', 'light', 'dark']
const MODE_ICON = { auto: PartlyCloudy, light: Sunny, dark: Moon }
const MODE_TIP = { auto: '跟随系统', light: '日间模式', dark: '夜间模式' }

/* 导航图标：键必须与 menuList 的路径一一对应（第 23 组会核对，缺一组就红）。
   /cells 不在这里：那张旧页早已从导航摘除，见第 17 组与第 21 组的禁令。 */
const NAV_ICONS = {
  '/presets': Collection,
  '/power': Lightning,
  '/failsafe': Warning,
  '/preflight': CircleCheck,
  '/dashboard': Odometer,
  '/sensor': Cpu,
  '/port': Share,
  '/rc': Connection,
  '/pid': SetUp,
  '/motor': VideoPlay,
  '/parameter': Tickets,
  '/cli': Monitor,
  '/ftp': FolderOpened,
  '/monitor': DataLine,
}

/* ============ 路由 ============ */
const router = useRouter()
const searchRef = ref(null)
let cancelSearchFocus = () => {}
async function navigateSearch(target) {
  cancelSearchFocus()
  const failure = await router.push(target)
  if (failure) return
  await nextTick()
  cancelSearchFocus = focusSearchField(document.querySelector('.dsh-main'), String(target.query?.focus || ''))
}
function searchHotkey(event) {
  if (shouldOpenConfigSearch(event)) {
    event.preventDefault()
    searchRef.value?.open()
  }
}
window.addEventListener('keydown', searchHotkey)

/* ============ MAVLink 单例 ============ */
const mav = useMavlink()
const detachCliHistory = attachCliHistory(mav)

// 解构常用响应式状态（直接用于模板）
const { connected, connecting, error, data, vehicle, stats, deviceState, canOperate, canWrite } = mav

// 向所有子组件注入
provide('mavlink', mav)
// 连接即全局拉取：首次 HEARTBEAT 之后把 /sys/sysconfig.toml 与 /sys/param.xml 一次性取到内存，
// 遥控 / 端口 / PID / 传感器四页共用这一份文档，右下角「保存」上传的也是它。
// 断开连接时 store 自己清空，绝不残留上一台飞控的配置（见 stores/fcconfig.js 顶部注释）。
const fcConfig = useFcConfigStore()
provide('fcconfig', fcConfig)
fcConfig.attach(mav)

const leaveConfig = useConfigLeaveStore()
const saveBarRef = ref(null)
const motorTestState = ref({ active: false, uncertain: false })
provide('motorTestSafety', motorTestState)
function updateMotorTestState(state) {
  motorTestState.value = { ...state }
}
watch(connected, (value) => {
  if (!value && motorTestState.value.active) motorTestState.value = { active: false, uncertain: true }
})
async function confirmPhysicalStop() {
  try {
    await ElMessageBox.confirm(
      '请确认已物理断开电机动力且所有电机停止。此确认只是操作者声明，不是飞控回读证据。',
      '确认物理停机',
      { type: 'warning', confirmButtonText: '已断动力并停止', cancelButtonText: '尚未确认' }
    )
    motorTestState.value = { active: false, uncertain: false }
  } catch {
    /* 未确认时继续保持红色提示 */
  }
}
const editPageNames = {
  '/power': '电池',
  '/failsafe': '失控保护',
  '/pid': 'PID 整定',
  '/rc': '接收机',
  '/sensor': '传感器',
  '/port': '端口配置',
  '/parameter': '参数配置',
  '/motor': '电机',
}
watch(
  () => router.currentRoute.value.path,
  (path) => fcConfig.setEditSource(editPageNames[path] || '其他配置'),
  { immediate: true, flush: 'sync' }
)
function discardAndLeave() {
  try {
    fcConfig.discardAll()
    leaveConfig.settle(true)
  } catch (error) {
    ElMessage.error(error?.message || '无法丢弃改动')
  }
}
function reviewAndLeave() {
  if (!saveBarRef.value) {
    leaveConfig.settle(false)
    return
  }
  leaveConfig.reviewing()
  saveBarRef.value.save()
}
function finishSaveAndLeave() {
  // 部分成功仍有脏项时不离开；关掉审阅也会取消挂起的导航。
  if (!fcConfig.hasChanges && !fcConfig.busy) leaveConfig.settle(true)
}
onBeforeUnmount(() => leaveConfig.settle(false))
watch(connected, (value) => {
  if (!value && !mav.reconnecting.value) leaveConfig.settle(false)
})

/* ============ 路由门禁 ============ */
router.beforeEach((to) => {
  if (mav.firmwareExclusive.value && to.path !== '/firmware') return false
  if (!canVisitWithoutDevice(to.path) && !mav.canOperate.value) return '/'
})
// 兼容老组件里 inject('AppMethods') 的写法
provide('AppMethods', {
  sendText: (t) => mav.cli.send(t),
  connect: mav.connect,
  disconnect: mav.disconnect,
  mav,
})

/* ============ 顶栏真值（全部来自生成表解出的字段） ============ */

// SYS_STATUS 位 → 顶栏短标签。只给"该在顶栏出现"的位起名，其余位默认不占地方，
// 但一旦不健康就会被下面的 unhealthy 分支捞出来显示。
const SENSOR_TAG = {
  MAV_SYS_STATUS_SENSOR_3D_GYRO: 'GYR',
  MAV_SYS_STATUS_SENSOR_3D_ACCEL: 'ACC',
  MAV_SYS_STATUS_SENSOR_3D_MAG: 'MAG',
  MAV_SYS_STATUS_SENSOR_ABSOLUTE_PRESSURE: 'BARO',
  MAV_SYS_STATUS_SENSOR_DIFFERENTIAL_PRESSURE: 'AIRSPD',
  MAV_SYS_STATUS_SENSOR_OPTICAL_FLOW: 'FLOW',
  MAV_SYS_STATUS_SENSOR_MOTOR_OUTPUTS: 'MOT',
  MAV_SYS_STATUS_SENSOR_RC_RECEIVER: 'RC',
  MAV_SYS_STATUS_SENSOR_BATTERY: 'BATT',
  MAV_SYS_STATUS_AHRS: 'AHRS',
  // 固件把这一位当作「预检功能位」恒置在 health 里，却从不置到 enabled（task_comm.c:253-254），
  // 所以它永远以「未启用」的灰标签出现。标签不能写成 PREARM，否则会被读成「预检失败/未校准」。
  MAV_SYS_STATUS_PREARM_CHECK: '检查位',
}

const sensors = computed(() => {
  const present = data.sysStatus.onboardControlSensorsPresent >>> 0
  const enabled = data.sysStatus.onboardControlSensorsEnabled >>> 0
  const health = data.sysStatus.onboardControlSensorsHealth >>> 0
  if (!vehicle.detected) return []
  const out = []
  for (const b of sensorBits(present | enabled)) {
    const named = !!SENSOR_TAG[b.key]
    const ok = (health & b.bit) !== 0
    const on = (enabled & b.bit) !== 0
    if (!named && ok) continue // 没名字又健康：不打扰顶栏
    out.push({
      key: b.key,
      text: named ? SENSOR_TAG[b.key] : b.label,
      type: !on ? 'info' : ok ? 'success' : 'danger',
      effect: on && !ok ? 'dark' : 'plain',
      title: `${b.label}：${on ? '已启用' : '未启用'} / ${ok ? '健康' : '不健康'}`,
    })
  }
  return out
})
const sensorsEmpty = computed(() => vehicle.detected && sensors.value.length === 0)

const batteryTag = computed(() => {
  const v = data.battery.voltage
  const p = data.battery.percent
  if (!vehicle.detected || !(v > 0)) {
    return { type: 'info', text: 'BAT --', title: '尚未收到 SYS_STATUS 的电压' }
  }
  // 协议里 battery_remaining 为负表示"未知"，不能显示成 -1%
  const pct = p >= 0 ? `${p}%` : '电量未知'
  const low = p >= 0 && p <= 20
  return {
    type: low ? 'danger' : 'success',
    text: `BAT ${v.toFixed(1)}V`,
    title: `${pct} · 电流 ${data.battery.current.toFixed(1)}A（来源 SYS_STATUS）`,
  }
})

const gpsTitle = computed(
  () =>
    `定位：${data.gps.fixLabel} · HDOP ${data.gps.hdop.toFixed(1)} · ` +
    `卫星 ${data.gps.satellitesVisible} · 海拔 ${data.gps.alt.toFixed(1)}m · 相对 ${data.gps.relAlt.toFixed(1)}m`
)

const lastStatus = computed(() => data.statusLogs[data.statusLogs.length - 1] || null)

// 1 秒心跳看门狗：连着串口不等于飞控还活着
const nowTick = ref(Date.now())
const rxStallText = computed(() => {
  if (!deviceState.lastRxAt) return 'RX 尚未收到消息'
  const age = Math.max(0, nowTick.value - deviceState.lastRxAt)
  return age >= 2000 ? `RX 停更 ${(age / 1000).toFixed(1)}s` : 'RX 接收中'
})
async function reconnectPrevious() {
  try {
    await mav.reconnectLast()
  } catch (error) {
    ElMessage.warning(error?.message || '重连失败，请重新选择串口')
    connectDialog.value = true
  }
}
const rxRate = ref('-- 帧/秒')
const crcAlarm = ref(false)
let crcPrev = { frames: stats.frames, errors: stats.crcErrors }
let ratePrev = { n: 0, t: Date.now() }
const ticker = setInterval(() => {
  nowTick.value = Date.now()
  const dt = (nowTick.value - ratePrev.t) / 1000
  if (dt >= 1) {
    const n = stats.rxMsgs
    rxRate.value = `${Math.max(0, Math.round((n - ratePrev.n) / dt))} 帧/秒`
    const frames = Math.max(0, stats.frames - crcPrev.frames)
    const errors = Math.max(0, stats.crcErrors - crcPrev.errors)
    crcAlarm.value = connected.value && frames + errors >= 20 && errors / (frames + errors) > 0.05
    crcPrev = { frames: stats.frames, errors: stats.crcErrors }
    ratePrev = { n, t: nowTick.value }
  }
}, 1000)

const linkWarn = computed(() => {
  if (deviceState.phase === 'serial-open') return '串口已打开，等待飞控心跳'
  if (deviceState.phase === 'stale') return `心跳丢失 ${Math.round((deviceState.heartbeat.ageMs || 0) / 1000)}s`
  if (deviceState.phase === 'error') return deviceState.error?.message || '链路错误'
  return ''
})
const contextState = computed(() =>
  deviceState.phase === 'online'
    ? 'live'
    : deviceState.phase === 'stale' || deviceState.phase === 'error'
      ? 'danger'
      : 'unknown'
)
const deviceIdentityText = computed(() =>
  deviceState.identity.detected
    ? `SYS ${deviceState.identity.sysid} / COMP ${deviceState.identity.compid}`
    : '设备未识别'
)
const heartbeatContext = computed(() =>
  deviceState.heartbeat.ageMs == null ? '心跳 —' : `心跳 ${Math.max(0, Math.round(deviceState.heartbeat.ageMs))} ms 前`
)

/* ============ 菜单 ============ */
const menuList = [
  { path: '/dashboard', label: '仪表盘' },
  { path: '/preflight', label: '准备飞行' },
  { path: '/power', label: '电池' },
  { path: '/failsafe', label: '失控保护' },
  { path: '/sensor', label: '传感器' },
  { path: '/port', label: '端口配置' },
  { path: '/rc', label: '接收机' },
  { path: '/pid', label: 'PID调参' },
  { path: '/motor', label: '电机' },
  { path: '/presets', label: '预设 · Beta' },
  { path: '/parameter', label: '参数' },
  { path: '/cli', label: '控制台' },
  { path: '/ftp', label: '文件' },
  { path: '/monitor', label: '监控' },
]
const visibleMenu = computed(() => menuList)

/* ============ 连接对话框状态 ============ */
const connectDialog = ref(false)
const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
const baudRate = ref(57600)
const transportType = ref('webserial')
const targetSys = ref(1)
const targetComp = ref(1)
const alertOpen = ref(false)

// 状态文案不带 emoji：不同平台字形宽度不一，挤在 34px 高的顶栏里会把后面的标签顶跑；
// 而且彩色状态点和 ✅/❌ 说的是同一件事，留一个就够。
const connState = computed(() => {
  if (connecting.value) return 'connecting'
  if (deviceState.phase === 'online') return 'ok'
  if (deviceState.phase === 'stale' || deviceState.phase === 'error') return 'error'
  if (deviceState.phase === 'serial-open') return 'connecting'
  return 'idle'
})
const statusText = computed(() => {
  if (mav.reconnecting.value) return `重启重连 · ${mav.reconnectStatus.value}`
  if (connecting.value) return '连接中…'
  if (deviceState.phase === 'serial-open') return '串口已打开 · 等待心跳'
  if (deviceState.phase === 'online')
    return `已连接 · SYS ${deviceState.identity.sysid}/COMP ${deviceState.identity.compid}`
  if (deviceState.phase === 'stale') return '链路过期 · 禁止操作'
  if (deviceState.phase === 'error') return deviceState.error?.message || String(error.value || '链路错误')
  return '等待连接'
})
const onHomeRoute = computed(() => router.currentRoute.value.path === '/')
const onHomeWorkspace = computed(() =>
  ['/', '/environment', '/log', '/firmware', '/setting'].includes(router.currentRoute.value.path)
)
watch(
  () => deviceState.phase,
  (value, oldValue) => {
    if (mav.reconnecting.value || mav.firmwareExclusive.value) return
    if (value === 'online' && oldValue !== 'online' && onHomeRoute.value) router.push('/dashboard')
    if (
      (value === 'idle' || value === 'stale' || value === 'error') &&
      oldValue === 'online' &&
      router.currentRoute.value.path !== '/'
    )
      router.push('/')
  }
)

async function handleConnect() {
  try {
    // 设置 FTP 目标
    mav.ftp.setTarget(targetSys.value, targetComp.value)
    await mav.connect(baudRate.value)
    connectDialog.value = false
  } catch (e) {
    // 错误已写入 mav.error，对话框保持打开
  }
}

function quickFtp() {
  // 跳转到 FTP 页面
  router.push('/ftp')
}

/**
 * 从告警条目跳到「准备飞行」检查页。
 *
 * 为什么单独成一个方法，而不是写在模板的 @click 里：这里本来就是两句——先跳转、再关抽屉。
 * 原先靠内联语句 + 逗号/分号分隔，而 prettier 会把内联的多语句表达式拆成换行并丢掉分隔符，
 * 结果是模板编译直接报 "Unexpected token, expected ','"（已验证）。放在 script 里既不受
 * 格式化影响，也顺带把「跳转 + 关抽屉必须成对发生」这条意图写清楚了。
 */
function goPreflight() {
  router.push('/preflight')
  alertOpen.value = false
}

/* ============ 生命周期 ============ */
onBeforeUnmount(() => {
  window.removeEventListener('keydown', searchHotkey)
  cancelSearchFocus()
  detachCliHistory()
  clearInterval(ticker)
  mav.disconnect()
})
</script>

<style scoped>
/* =========================================================
   外壳样式：只取令牌，不写字面色值。
   明暗差异一律走 var(--dsh-*)，所以这里不需要任何 [data-theme] 分支
   （唯一例外：主色本体在夜间才允许大面积上身，见 .dsh-theme-btn.is-active）。
   ========================================================= */
.dsh-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background-color: var(--dsh-canvas);
  color: var(--dsh-text-1);
}

.dsh-frame {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ─── 顶栏（34px：比原来 32px 略高一点，为了容纳 20px 的主题开关而不挤字） ─── */
.dsh-header {
  --el-header-height: var(--dsh-shell-h);
  --el-header-padding: 0 10px;
  background-color: var(--dsh-chrome);
  border-bottom: 1px solid var(--dsh-border);
  line-height: 1.35;
  z-index: 3;
}

.dsh-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--dsh-font-md);
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.dsh-brand-mark {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background-color: var(--dsh-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsh-accent) 26%, transparent);
}

.head-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

.status-bar {
  display: flex;
  gap: 5px;
  align-items: center;
  height: 100%;
  overflow: hidden;
}

.status-item {
  display: inline-flex;
  align-items: center;
}
.tip {
  color: var(--dsh-text-3);
  font-size: var(--dsh-font-sm);
  margin-left: 4px;
}
/* 飞控告警可能很长，超出就截断，完整内容看 title */
.status-msg {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── 连接状态：一颗状态点承担颜色语义，文字只说事实 ─── */
.conn-text {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-size: var(--dsh-font-sm);
  color: var(--dsh-text-2);
}

.dsh-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--dsh-placeholder);
}

.conn-text[data-state='ok'] .dsh-dot {
  background-color: var(--dsh-success);
}
.conn-text[data-state='connecting'] .dsh-dot {
  background-color: var(--dsh-warning);
}
.conn-text[data-state='error'] .dsh-dot {
  background-color: var(--dsh-danger-vivid);
}

/* ─── 三态主题开关 ─── */
.dsh-theme-switch {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--dsh-border);
  border-radius: var(--dsh-radius-full);
  background-color: var(--dsh-surface-2);
}

.dsh-theme-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--dsh-radius-full);
  background-color: transparent;
  color: var(--dsh-text-3);
  cursor: pointer;
  transition:
    background-color var(--dsh-transition),
    color var(--dsh-transition);
}

.dsh-theme-btn:hover {
  color: var(--dsh-text-1);
  background-color: var(--dsh-hover);
}

.dsh-theme-btn.is-active {
  /* 当前档：亮蓝填充 + 填充字色，跟主按钮同一条决定（契约里记着日间 1.80:1）。
     以前日间是"浅蓝底压亮蓝字"，1.61:1，等于看不出当前选中的是哪一个档；
     夜间 --dsh-ink-on-fill 本来就是近墨，两套主题共用这一条就够。 */
  background-color: var(--dsh-accent);
  color: var(--dsh-ink-on-fill);
}

/* ─── 左侧导航（116px：足够放下"链路体检"四个字 + 一个 15px 图标） ─── */
.dsh-nav {
  --el-aside-width: var(--dsh-nav-w);
  background-color: var(--dsh-chrome);
  border-right: 1px solid var(--dsh-divider);
  padding: 6px 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.dsh-nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dsh-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  margin: 0 6px;
  padding: 0 8px;
  border-radius: var(--dsh-radius);
  color: var(--dsh-text-3);
  font-size: var(--dsh-font);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  transition:
    background-color var(--dsh-transition),
    color var(--dsh-transition);
}

.dsh-nav-item:hover {
  background-color: var(--dsh-hover);
  color: var(--dsh-text-1);
}

.dsh-nav-item.is-active {
  background-color: var(--dsh-accent-soft);
  color: var(--dsh-accent-ink);
  font-weight: 600;
}

.dsh-nav-item.is-active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 5px;
  bottom: 5px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background-color: var(--dsh-accent);
}

.dsh-nav-icon {
  flex: none;
  opacity: 0.9;
}
.dsh-nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─── 主区与页脚 ─── */
.dsh-main {
  --el-main-padding: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background-color: var(--dsh-canvas);
}

.dsh-footer {
  --el-footer-height: var(--dsh-foot-h);
  --el-footer-padding: 0 10px;
  background-color: var(--dsh-chrome);
  border-top: 1px solid var(--dsh-border);
  line-height: 1.2;
}

.dsh-foot-row {
  height: 100%;
}

.dsh-foot-left {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  overflow: hidden;
  white-space: nowrap;
}

.dsh-foot-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
  overflow: visible;
  padding-left: 10px;
}
.dsh-foot-right .save-bar {
  width: 100%;
}
.dsh-foot-right .save-bar {
  flex: 0 1 auto;
  min-width: 0;
}
.foot-stat {
  color: var(--dsh-text-3);
  font-size: var(--dsh-font-sm);
  white-space: nowrap;
}
</style>
