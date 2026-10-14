// src/composables/useMavlink.js
// ================================================================
// 统一 MAVLink 地面站管理器
// - WebSerial 连接管理（唯一连接，全局共享）
// - MAVLink 消息解析 + 事件总线分发
// - HEARTBEAT 保活
// - SERIAL_CONTROL（Shell / CLI）
// - FTP 文件传输（list / download / upload / remove / mkdir / reset）
//
// 使用方式（在任意组件中）：
//   const mav = inject('mavlink')
//   mav.connect(57600)
//   mav.on('ATTITUDE', (p) => { ... })
//   mav.cli.send('help\r')
//   const files = await mav.ftp.list('/')
// ================================================================

import { ref, reactive, readonly, computed } from 'vue'
import {
  MAVLINK_MSG_ID,
  SERIAL_CONTROL_DEV,
  SERIAL_CONTROL_FLAG,
  Mavlink2Parser,
  MavlinkLink,
  decodeSerialControl,
  FTP_OP,
  FTP_ERR,
  POSIX_ERRNO_TEXT,
  __ftpInternal,
} from '../utils/mavlink-protocol.js'

// 协议真相只有一处：vendor 头文件生成的字段表/枚举表（scripts/gen-mavlink-table.mjs）。
// 这里不再手写任何偏移与倍率——偏移写错的典型症状是"高度显示成了相对高度"，
// 数字看着完全正常，却能把人带偏；换算一律交给 decodeMessage。
import { decodeMessage, encodeFields, messageName } from '../protocol/mav-decoder.js'
import { createConsoleSession } from '../utils/console-session.js'
import { ENUMS as PROTOCOL_ENUMS } from '../protocol/mavlink-table.generated.js'
/* 下载完整性与参数类型解码都是纯函数，单独成模块：
   真机出过「截断的文件被当成下载成功」的事故，这类判断必须能在 selftest 里直接跑到，
   不能只靠下一次接飞控才发现。 */
import { createDownloadState, acceptBurstPacket, assertDownloadComplete } from '../utils/ftp-download.js'
import { decodeParamValue } from '../utils/param-value.js'
import { attitudeFromQuaternion } from '../utils/attitude-quat.js'
import { describeMode, isArmed, systemState, severity, gpsFix, landedState, vtolState } from '../protocol/mav-labels.js'

import { createRebootReconnect, rebootError } from '../utils/reboot-reconnect.js'
import { crc32, crc32Hex } from '../utils/crc32.js'

const { buildFtpPayload, parseFtpPayload } = __ftpInternal

/* --------- 单例实例（整个 App 共享同一个串口） --------- */
// ── 日志节流 ──────────────────────────────────────────────────────────
// 连上真机之后，FTP 的迟到回包、解析不了的消息、页面回调抛错都可能"每包一次"地打印。
// 逐条 console 在 DevTools 打开时足以把主线程吃光，症状就是切页卡死、数字不动。
// 规则：同类只报第一次，之后每 1000 次汇总一句；真正的失败（console.error）不受影响。
const _warnOnce = new Map()
function warnOnce(key, ...args) {
  const n = (_warnOnce.get(key) || 0) + 1
  _warnOnce.set(key, n)
  if (n === 1) console.warn(...args)
  else if (n % 1000 === 0) {
    console.warn(`${String(args[0]).split('\n')[0]}（同类已累计 ${n} 次，不再逐条打印）`, ...args.slice(1))
  }
}

function ftpWarn(...args) {
  const head = String(args[0] ?? '')
    .replace(/\[[^\]]*\]/g, '')
    .slice(0, 48)
  warnOnce(`[ftp]${head}`, ...args)
}

// FTP 的过程性日志（每一步一条）默认不打印：它不参与任何判断，真机上只会刷屏。
// 要看的时候在控制台执行 localStorage.setItem('fmt.ftpLog', '1') 然后刷新页面。
const FTP_VERBOSE = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('fmt.ftpLog') === '1'
  } catch {
    return false
  }
})()
function ftpLog(...args) {
  if (FTP_VERBOSE) console.log(...args)
}

const _decodeWarned = new Set()
function warnDecodeFailure(msgid, e) {
  if (_decodeWarned.has(msgid)) return
  _decodeWarned.add(msgid)
  let name = `msgid=${msgid}`
  try {
    name = `${messageName(msgid)}(${msgid})`
  } catch {
    /* 取不到名字就用兜底文案 */
  }
  console.warn(`[mavlink] 解析 ${name} 失败（同一 msgid 只报一次，避免每包刷屏拖慢主线程）：`, e)
}
let _instance = null

export function useMavlink() {
  if (_instance) return _instance
  _instance = createInstance()
  return _instance
}

function createInstance() {
  /* ========== 响应式状态 ========== */

  const connected = ref(false)
  const connecting = ref(false)
  const reconnecting = ref(false)
  const firmwareExclusive = ref(false)
  const reconnectStatus = ref('idle')
  let lastAuthorizedPort = null
  let lastPortInfo = {}
  let cleanupPromise = Promise.resolve()
  let serialCloseError = null
  let shellOpenTimer = null
  let connectionGeneration = 0
  const error = ref('')
  const baudRate = ref(0)
  const deviceState = reactive({
    phase: 'idle',
    transport: null,
    connectedAt: 0,
    sessionId: 0,
    lastRxAt: 0,
    error: null,
    identity: {
      detected: false,
      sysid: null,
      compid: null,
      type: null,
      autopilot: null,
      systemStatus: null,
      systemStatusLabel: '—',
    },
    heartbeat: { lastAt: 0, ageMs: null, healthy: false },
    // attitude 由 ATTITUDE(30) 或 ATTITUDE_QUATERNION(31) 点亮（两者是同一件事的两个通道），
    // imu 是 SCALED_IMU/RAW_IMU/HIGHRES_IMU 的独立通道。
    // 两者过去共用一个键：飞控不推姿态时，读数照样被判成"新鲜"，死值 0 看着像实时值。
    freshness: { vfrHud: 0, attitude: 0, imu: 0, gps: 0, battery: 0, sysStatus: 0, rc: 0, servos: 0, statusText: 0 },
    valid: {
      vfrHud: false,
      attitude: false,
      imu: false,
      gps: false,
      battery: false,
      sysStatus: false,
      rc: false,
      servos: false,
    },
  })
  let deviceTicker = null

  /**
   * 姿态来源（权威源 + 降级）：
   * - 'quaternion'：收到过 ATTITUDE_QUATERNION(31)，它就是权威源（本固件的数传走这条）；
   * - 'euler'：只收到过 ATTITUDE(30)，按优先级降级到欧拉角通道；
   * - 'none'：整段会话都没收到姿态。
   * `lastAt` 只由权威源刷新：一旦权威源静默超过 ATTITUDE_AUTHORITY_STALE_MS，
   * 页面应当显示"最后已知姿态（来源已静默）"，而不是继续把旧值当实时读数。
   */
  const ATTITUDE_AUTHORITY_STALE_MS = 2500
  // reactive: 页面要能看到权威源什么时候切换/静默，普通对象改了不会触发渲染
  const _attSource = reactive({ authority: 'none', lastAt: 0, lastMsgId: null })

  /**
   * 乱序保护：只丢弃"小幅回退"的姿态帧（同一来源的乱序），其它情况一律接受。
   *
   * 三条经验，缺一条都会把正常帧丢掉、姿态整个卡死：
   *  1. 换来源时不比较——两条通道的 time_boot_ms 来自不同固件时基
   *     （本固件四元数那条是 systime_now_us() 截成 u32，见 task_comm.c:307），跨通道比较没有意义。
   *  2. 只有"略微回退"才算乱序（默认 <1 s）。因为 time_boot_ms 是 u32，约 49.7 天回绕一次；
   *     回绕时数值会从 42 亿掉到个位数，用无符号差值看其实是前进。反过来，如果某帧数值突然
   *     掉了几十亿（截断时钟重置/垃圾帧），那是坏帧，绝对不能覆盖当前姿态。
   *  3. 差值用 u32 回绕安全的有符号比较。
   */
  function isStaleAttitudeFrame(timeBootMs, msgid) {
    const prevSource = _attSource.lastMsgId
    if (prevSource !== msgid) return false // 换了来源：时基不可比，不比较
    const prev = data.attitude.timeBootMs
    if (!Number.isFinite(prev) || !prev) return false
    if (!Number.isFinite(timeBootMs)) return false
    const delta = (timeBootMs - prev) | 0 // u32 回绕安全
    if (delta >= 0) return false // 前进（含回绕后的前进）
    if (Math.abs(delta) > 1000) return false // 巨大回退＝坏帧，按"接受"处理，不能让姿态僵在旧值
    return true // 小幅回退＝同来源乱序，丢弃
  }

  // 飞控身份 + 飞行状态（全部来自 HEARTBEAT；顶栏解锁/模式显示就读这里）
  const vehicle = reactive({
    sysid: 1,
    compid: 1,
    detected: false,
    type: 0, // MAV_TYPE
    autopilot: 0, // MAV_AUTOPILOT
    baseMode: 0, // MAV_MODE_FLAG 位图
    customMode: 0, // PX4/FMT 编码的机载模式
    armed: false,
    modeCode: 'UNKNOWN_0', // 稳定标识，供页面 class/判断用（如 AUTO.RTL）
    modeName: '未知', // 中文文案（如「自动·返航」）
    systemStatus: 0,
    systemStatusLabel: '—',
    lastHeartbeatAt: 0, // 链路是否真的活着
  })

  // 常用实时数据。键名是页面契约：attitude / vfrHud / battery / gps / sysStatus 不可随意改
  const data = reactive({
    // 姿态：优先 ATTITUDE_QUATERNION(31)，没有它才降级用 ATTITUDE(30)（见 _attSource 与 handleMessage）
    attitude: {
      roll: 0,
      pitch: 0,
      yaw: 0,
      rollspeed: 0,
      pitchspeed: 0,
      yawspeed: 0,
      timeBootMs: 0,
      quat: null,
      quatOffsetApplied: false,
    },
    imu: {
      accel: [null, null, null],
      gyro: [null, null, null],
      mag: [null, null, null],
      timeBootMs: 0,
      source: '',
      lastAt: 0,
    },
    vfrHud: { airspeed: 0, groundspeed: 0, heading: 0, throttle: 0, alt: 0, climb: 0 },
    // 本固件不周期发送 BATTERY_STATUS，电压/电流/剩余量只能来自 SYS_STATUS（见 vendor 说明）
    battery: { voltage: 0, current: 0, percent: 0, source: 'SYS_STATUS' },
    sysStatus: {
      onboardControlSensorsPresent: 0,
      onboardControlSensorsEnabled: 0,
      onboardControlSensorsHealth: 0,
      load: 0,
      voltageBattery: 0,
      currentBattery: 0,
      batteryRemaining: 0,
      dropRateComm: 0,
      errorsComm: 0,
      errorsCount: [0, 0, 0, 0],
    },
    // 定位质量/卫星数来自 GPS_RAW_INT，平滑经纬度来自 GLOBAL_POSITION_INT，两者合并到同一个 gps
    gps: {
      fixType: 0,
      fixLabel: '无定位',
      usable: false,
      lat: 0,
      lon: 0,
      alt: 0,
      relAlt: 0,
      rawLat: 0,
      rawLon: 0,
      satellitesVisible: 0,
      hdop: 0,
      vdop: 0,
      speed: 0,
      cog: 0,
      heading: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      timeBootMs: 0,
    },
    altitude: { monotonic: 0, amsl: 0, local: 0, relative: 0, terrain: 0, bottomClearance: 0, timeUsec: 0 },
    localPosition: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, timeBootMs: 0 },
    extState: { vtolState: 0, vtolLabel: '—', landedState: 0, landedLabel: '—' },
    rcChannels: { rssi: 0, chancount: 0, timeBootMs: 0, channels: new Uint16Array(18) },
    // 飞控不周期发送 SERVO_OUTPUT_RAW：online=false 时页面必须显示"未接通"，禁止画假数据
    servos: { port: 0, timeUsec: 0, raw: new Uint16Array(16), online: false },
    statusText: '',
    statusLogs: [], // 最近 STATUSTEXT（含等级的环形缓冲）
  })

  // 解析器内部是普通对象（每帧都改会拖慢渲染），这里按帧同步成响应式供顶栏显示
  const linkStats = reactive({ frames: 0, crcErrors: 0, learned: 0, rxMsgs: 0, rxBytes: 0 })

  /* ========== 内部状态 ========== */

  // GCS 身份
  const GCS_SYSID = 255
  const GCS_COMPID = 190

  let parser = null
  let link = null
  let transport = null // { type:'webserial', port, reader, writer }
  let readPromise = null
  let heartbeatTimer = null
  let manualDisconnect = false

  // 发送队列
  let txQueue = []
  let pumping = false
  const TX_DELAY_MS = 2

  // 文本编解码
  const textEncoder = new TextEncoder()
  const textDecoder = new TextDecoder('utf-8', { fatal: false })

  // 事件总线: map<msgid|'*'|'cli', Set<fn>>
  const listeners = new Map()

  /* ========== 事件总线 API ========== */

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(handler)
    return () => off(event, handler)
  }
  function off(event, handler) {
    listeners.get(event)?.delete(handler)
  }
  function emit(event, payload) {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload)
      } catch (e) {
        warnOnce(
          '[mavlink] listener error: ' + ((e && e.message) || String(e)),
          '[mavlink] 页面回调出错（同类只报一次）:',
          e
        )
      }
    })
    // '*' 监听器接收所有原始消息
    if (event !== '*' && typeof event === 'number') {
      listeners.get('*')?.forEach((fn) => fn({ msgid: event, ...payload }))
    }
  }

  /* ========== CLI / Shell ========== */

  const cli = (() => {
    // 当前 shell 设备/flags 配置
    let shellDevice = SERIAL_CONTROL_DEV.SHELL
    let shellFlags = SERIAL_CONTROL_FLAG.REPLY | SERIAL_CONTROL_FLAG.EXCLUSIVE

    function _open() {
      if (session.transactionLocked) throw new Error('参数保存事务进行中，控制台暂不可打开')
      if (!connected.value) return
      enqueue(
        link.encodeSerialControl(new Uint8Array(0), {
          baudRate: 0,
          timeout: 100,
          flags: shellFlags,
          device: shellDevice,
        })
      )
    }

    /** 发送字符串（自动按 70 字节分片） */
    function send(text) {
      if (session.transactionLocked) throw new Error('参数保存事务进行中，控制台暂不可输入')
      if (!connected.value) return
      const bytes = textEncoder.encode(text)
      if (!bytes.length) {
        enqueue(
          link.encodeSerialControl(new Uint8Array(0), {
            baudRate: 0,
            timeout: 200,
            flags: shellFlags,
            device: shellDevice,
          })
        )
        return
      }
      for (let i = 0; i < bytes.length; i += 70) {
        enqueue(
          link.encodeSerialControl(bytes.slice(i, i + 70), {
            baudRate: 0,
            timeout: 200,
            flags: shellFlags,
            device: shellDevice,
          })
        )
      }
    }

    /** 发送换行命令（便捷方法） */
    function sendCommand(cmd) {
      send(cmd.endsWith('\r') ? cmd : cmd + '\r')
    }

    /** 设置 shell 目标设备（默认 SHELL=10） */
    function setDevice(device, flags) {
      shellDevice = device ?? shellDevice
      if (flags !== undefined) shellFlags = flags
    }

    return { send, sendCommand, open: _open, setDevice }
  })()

  const session = createConsoleSession({
    send: (text, options = {}) => {
      if (!options.owner) return cli.send(text)
      if (!session.canSend(options.owner)) throw new Error('参数保存事务已失效')
      const currentTransport = transport,
        currentLink = link,
        sessionId = deviceState.sessionId
      const check = () => {
        if (
          !session.canSend(options.owner) ||
          !session.transactionLocked ||
          transport !== currentTransport ||
          link !== currentLink ||
          deviceState.sessionId !== sessionId ||
          !connected.value ||
          deviceState.phase !== 'online' ||
          !deviceState.heartbeat.healthy ||
          vehicle.armed
        )
          throw new Error('参数保存安全条件或设备会话已改变')
      }
      check()
      const bytes = textEncoder.encode(text),
        pending = []
      for (let i = 0; i < bytes.length; i += 70)
        pending.push(
          enqueueWritten(
            currentLink.encodeSerialControl(bytes.slice(i, i + 70), {
              baudRate: 0,
              timeout: 200,
              flags: SERIAL_CONTROL_FLAG.REPLY | SERIAL_CONTROL_FLAG.EXCLUSIVE,
              device: SERIAL_CONTROL_DEV.SHELL,
            }),
            null,
            check
          )
        )
      return Promise.all(pending)
    },
    isConnected: () => connected.value,
  })

  /* ========== FTP ========== */

  /* ========== FTP ========== */

  const ftp = (() => {
    let targetSystem = 1
    let targetComponent = 1
    let ftpSeq = 0
    let pending = null
    /* BURST READ 的在途收集器：一个请求对应多包回流，与单请求 pending 互斥 */
    let burst = null

    /* FTP 是严格的请求/应答串行协议：同一时刻只允许一个在途请求。
       这里用 promise 链做互斥。旧实现是直接 reject 掉上一个请求
       （报"上一个 FTP 请求被新请求覆盖"），文件页与参数页同时用 FTP 就会随机失败。 */
    let ftpChain = Promise.resolve()

    /** 已超时请求的 seq：飞控可能只是慢，回包晚到时必须丢弃，
     *  否则迟到包会被下一个同 opcode 的请求按 opcode 认领，把数据串到别的文件上。 */
    const staleSeqs = new Set()

    /** MAVLink FTP 错误码，与飞控 ftp_manager.h:64-75（enum ErrorCode）一致 */
    const FTP_ERR_NONE = 0
    const FTP_ERR_FAIL = 1
    const FTP_ERR_FAIL_ERRNO = 2
    const FTP_ERR_EOF = 6
    const FTP_ERR_UNKNOWN_COMMAND = 7

    /** 飞控 ftp_manager.c:354-397 的 switch 只实现下列 opcode；
     *  其余 opcode 落入 default 分支返回 FMT_ENOTHANDLE，mavgcs.c:327 因而不回任何包，
     *  地面站只能干等到超时（例如 CALC_FILE_CRC32 要白等 8 秒）。这里直接快速失败。 */
    const FC_SUPPORTED_OPS = new Set([
      FTP_OP.NONE,
      FTP_OP.TERMINATE_SESSION,
      FTP_OP.RESET_SESSIONS,
      FTP_OP.LIST_DIRECTORY,
      FTP_OP.OPEN_FILE_RO,
      FTP_OP.READ_FILE,
      FTP_OP.CREATE_FILE,
      FTP_OP.WRITE_FILE,
      FTP_OP.OPEN_FILE_WO,
      FTP_OP.BURST_READ_FILE,
    ])

    /**
     * 把 NAK 错误码解释成"已经读到文件尾"。
     * 本固件的标准答案是 kErrEOF(6)；0/1/2 是对历史固件用 None/Fail 表示结束的兼容，
     * 且必须没有 errno——带着 errno 的 Fail/FailErrno 是真实故障（EIO、ENOSPC 等），
     * 当成 EOF 会把读失败伪装成读完成。
     */
    function isEofLikeNakCode(errCode, errno) {
      if (errCode === FTP_ERR_EOF) return true
      if (errCode === 234) return true // 旧版地面站约定，保留兼容
      if (errCode === FTP_ERR_NONE) return true
      if ((errCode === FTP_ERR_FAIL || errCode === FTP_ERR_FAIL_ERRNO) && (errno == null || errno === 0)) return true
      return false
    }

    const CHUNK = 239
    /* burst 由固件任务循环自发续流，地面站用「多久没收到新包」判定，不用总超时 */
    const BURST_IDLE_MS = 4000
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    function nextSeq() {
      ftpSeq = (ftpSeq + 1) & 0xffff
      return ftpSeq
    }

    function _sendFtpFrame(ftpPayload) {
      const frame = link.encodeFileTransfer(ftpPayload, targetSystem, targetComponent)
      enqueue(frame)
    }

    function setTarget(sys, comp) {
      targetSystem = Number(sys) || 1
      targetComponent = Number(comp) || 1
    }

    function _normalizeFtpData(obj, maxLen = CHUNK) {
      const declared = Number(obj?.size)
      let data = obj?.data instanceof Uint8Array ? obj.data : new Uint8Array(0)

      const safe = Math.min(Number.isFinite(declared) ? Math.max(0, declared) : data.length, maxLen)

      if (safe > data.length) {
        const padded = new Uint8Array(safe)
        padded.set(data)
        data = padded
      } else if (safe < data.length) {
        data = data.subarray(0, safe)
      }

      return { data, size: safe }
    }

    /** 对外唯一入口：排队串行发起一次 FTP 请求 */
    function request(opcode, reqData, options = {}) {
      const run = () => _request(opcode, reqData, options)
      // 不管上一个成功还是失败，都要接着排；链自身吞异常，结果交给调用方
      const next = ftpChain.then(run, run)
      ftpChain = next.then(
        () => {},
        () => {}
      )
      return next
    }

    async function _request(opcode, reqData, options = {}) {
      const { session = 0, offset = 0, size, timeout = 3500, force = false } = options

      if (reqData && !(reqData instanceof Uint8Array)) {
        reqData = Uint8Array.from(reqData)
      }

      if (reqData && reqData.length > CHUNK) {
        throw new Error(`FTP 单包数据不能超过 ${CHUNK} 字节`)
      }

      if (!FC_SUPPORTED_OPS.has(opcode) && !force) {
        const name = Object.keys(FTP_OP).find((k) => FTP_OP[k] === opcode) || opcode
        const e = new Error(`飞控未实现 FTP 操作 ${name}(opcode ${opcode})：发出去不会有任何应答，已直接失败`)
        e.code = 'UnsupportedOpcode'
        e.opcode = opcode
        throw e
      }

      if (pending) {
        // 有串行链本不该走到这里；真到了说明有代码绕过了 request()
        throw new Error('FTP 内部状态异常：仍有未完成的请求')
      }

      const seq = nextSeq()
      const payloadSize = typeof size === 'number' ? size : reqData ? reqData.length : 0

      const ftpPayload = buildFtpPayload({
        seq,
        session,
        opcode,
        size: payloadSize,
        offset,
        data: reqData,
      })

      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending && pending.seq === seq) {
            pending = null
            staleSeqs.add(seq)
            if (staleSeqs.size > 64) staleSeqs.clear()
            reject(new Error(`FTP 请求超时（opcode ${opcode}）`))
          }
        }, timeout)

        pending = { seq, opcode, resolve, reject, timer }
        _sendFtpFrame(ftpPayload)
      })
    }

    function handleIncoming(msg) {
      if (msg.msgid !== MAVLINK_MSG_ID.FILE_TRANSFER_PROTOCOL) return

      let p = msg.payload
      if (!p || p.length < 3) return

      if (p.length < 254) {
        const padded = new Uint8Array(254)
        padded.set(p)
        p = padded
      } else if (p.length > 254) {
        p = p.subarray(0, 254)
      }

      const ftpBytes = p.subarray(3, 254)

      let hdr
      try {
        hdr = parseFtpPayload(ftpBytes)
      } catch (e) {
        ftpWarn('[FTP] parse ftp payload error:', e)
        return
      }

      /* burst 回包一个请求多包、seq 每包自增，不能走单请求的 pending 认领 */
      if (burst && hdr.reqOpcode === FTP_OP.BURST_READ_FILE) {
        _onBurstPacket(hdr)
        return
      }

      if (!hdr || !pending) return

      // 超时请求的迟到回包（回包 seq = 请求 seq + 1）：丢弃，不让下一个请求认领
      if (staleSeqs.has((hdr.seq - 1) & 0xffff) || staleSeqs.has(hdr.seq)) {
        ftpWarn('[FTP] 丢弃已超时请求的迟到回包', { seq: hdr.seq, opcode: hdr.opcode })
        return
      }

      const pend = pending

      /* 回包匹配：飞控把请求 seq 自增 1 后回填（ftp_manager.c:399），个别实现直接回显，
         两种都算命中；req_opcode 回指请求 opcode，作为兜底。
         串行互斥已经保证同一时刻只有一个在途请求，所以兜底不会认错请求。 */
      const seqOk = hdr.seq === pend.seq || hdr.seq === ((pend.seq + 1) & 0xffff)
      const reqOpcodeOk = hdr.reqOpcode === pend.opcode
      if (!seqOk && !reqOpcodeOk) return
      if (!seqOk) {
        ftpWarn('[FTP] 回包 seq 与请求不匹配，已按 req_opcode 认领', {
          reqSeq: pend.seq,
          repSeq: hdr.seq,
          opcode: pend.opcode,
        })
      }

      clearTimeout(pend.timer)
      pending = null

      // NAK 不是文件数据，不能 resolve 给读取循环
      if (hdr.opcode === FTP_OP.NAK) {
        const norm = _normalizeFtpData(hdr, CHUNK)
        const errCode = norm.size > 0 ? norm.data[0] : -1
        const errName = FTP_ERR?.[errCode] || `Unknown(${errCode})`
        let errnoCode = null
        // kErrFailErrno(2) 时 errno 放在 data[1]（ftp_manager.c:410-413）
        if (errCode === FTP_ERR_FAIL_ERRNO && norm.size > 1) {
          errnoCode = norm.data[1]
        }
        const errnoText = errnoCode != null ? POSIX_ERRNO_TEXT?.[errnoCode] || '未知 errno' : ''
        const err = new Error(`FTP NAK: ${errName}${errnoCode != null ? ` errno=${errnoCode} (${errnoText})` : ''}`)
        err.code = errName
        err.errorCode = errCode
        err.errno = errnoCode
        err.isFtpNak = true
        err.reqOpcode = pend.opcode
        err.isEof = isEofLikeNakCode(errCode, errnoCode)
        if (errCode === FTP_ERR_UNKNOWN_COMMAND) {
          err.unsupported = true
          err.message += '（飞控不支持该操作）'
        }
        // 注意：NAK 的 size 被固件固定改写为 1（或 2），data 区里没有文件内容。
        // 早前版本把 padded 缓冲的剩余字节当作"尾部数据"交给下载逻辑，
        // 会在文件末尾追加一两百字节协议噪声，导致下载结果校验不过。
        pend.reject(err)
        return
      }
      // 只有 ACK / 正常响应才作为有效数据
      const norm = _normalizeFtpData(hdr, CHUNK)
      hdr.size = norm.size
      hdr.data = norm.data

      pend.resolve(hdr)
    }

    /* ---------- BURST READ：一个请求、多包回流 ----------
       固件的 READ_FILE 分支只在读满一整包时返回数据，尾部不足 239 字节会回
       errno=0 的 FailErrno（ftp_manager.c:256-261）；这个 NAK 落进地面的 EOF 兼容
       分支，长度不是 239 整数倍的文件就被静默截断到最后一个满包。
       BURST 分支才是本固件唯一把读取长度夹到剩余字节的读法
       （ftp_manager.c:467-468），最后一包带 burst_complete（:485-487），
       并由 mavproxy_cmd.c:871 的任务循环自发续流，不需要地面站逐包催包。 */

    function _armBurstTimer() {
      if (!burst) return
      if (burst.timer) clearTimeout(burst.timer)
      burst.timer = setTimeout(() => {
        const b = burst
        if (!b) return
        burst = null
        b.reject(
          new Error(`BURST READ 静默超过 ${BURST_IDLE_MS}ms：只收到 ${b.state.received}/${b.state.expectedSize} 字节`)
        )
      }, BURST_IDLE_MS)
    }

    function _failBurst(err) {
      const b = burst
      if (!b) return
      burst = null
      if (b.timer) clearTimeout(b.timer)
      b.reject(err)
    }

    function _finishBurst() {
      const b = burst
      if (!b) return
      burst = null
      if (b.timer) clearTimeout(b.timer)

      try {
        assertDownloadComplete(b.state, b.name)
      } catch (e) {
        ftpWarn('[FTP] BURST READ 长度校验未通过', { name: b.name, message: e.message })
        b.reject(e)
        return
      }

      ftpLog('[FTP] BURST READ 完成', {
        name: b.name,
        bytes: b.state.received,
        packets: b.state.packets,
        duplicates: b.state.duplicatePackets,
      })
      b.resolve(new Blob([b.state.bytes]))
    }

    function _onBurstPacket(hdr) {
      const b = burst
      if (!b) return

      /* 本固件 burst 包的 session 恒为 0（ftp_manager.c:447），能过滤的就过滤；
         超时后残留的流由 download() 的 finally TERMINATE_SESSION 关掉
         （ftp_manager.c:310-326 会同时 reset 流任务）。 */
      if (hdr.session !== b.session) {
        ftpWarn('[FTP] 丢弃 session 不匹配的 burst 包', { got: hdr.session, want: b.session })
        return
      }

      _armBurstTimer()

      if (hdr.opcode === FTP_OP.NAK) {
        const errCode = hdr.size > 0 ? hdr.data[0] : -1
        if (errCode === FTP_ERR_EOF) {
          _finishBurst()
          return
        }
        const errName = FTP_ERR?.[errCode] || `Unknown(${errCode})`
        const e = new Error(`BURST READ 被 NAK：${errName}`)
        e.errorCode = errCode
        e.isFtpNak = true
        if (errCode === FTP_ERR_UNKNOWN_COMMAND) {
          e.unsupported = true
          e.message += '（飞控不支持该操作）'
        }
        _failBurst(e)
        return
      }

      const r = acceptBurstPacket(b.state, hdr)
      if (r.duplicate) b.state.duplicatePackets++

      if (typeof b.onProgress === 'function') {
        try {
          b.onProgress(b.state.received / b.state.expectedSize)
        } catch {}
      }

      if (b.state.sawBurstComplete || b.state.received >= b.state.expectedSize) {
        _finishBurst()
      }
    }

    function _burstRead({ session, fileSize, onProgress, name = '' }) {
      if (pending || burst) {
        return Promise.reject(new Error('FTP 内部状态异常：仍有未完成的请求'))
      }

      let state
      try {
        state = createDownloadState({ expectedSize: fileSize, name })
      } catch (e) {
        return Promise.reject(e)
      }

      const seq = nextSeq()

      return new Promise((resolve, reject) => {
        burst = { seq, session, name, state, onProgress, resolve, reject, timer: null }
        _armBurstTimer()
        _sendFtpFrame(
          buildFtpPayload({
            seq,
            session,
            opcode: FTP_OP.BURST_READ_FILE,
            size: CHUNK,
            offset: 0,
          })
        )
      })
    }

    /** 与其它 FTP 请求共用串行链 */
    function burstRead(opts) {
      const run = () => _burstRead(opts)
      const next = ftpChain.then(run, run)
      ftpChain = next.then(
        () => {},
        () => {}
      )
      return next
    }

    function _encPath(path) {
      const t = new TextEncoder()
      const s = (path || '/').endsWith('\0') ? path : path + '\0'
      return t.encode(s)
    }

    function _parseList(data) {
      const entries = []
      let start = 0

      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) {
          if (i > start) {
            const s = textDecoder.decode(data.subarray(start, i))
            const e = _parseEntry(s)
            if (e) entries.push(e)
          }
          start = i + 1
        }
      }

      if (start < data.length) {
        const s = textDecoder.decode(data.subarray(start))
        const e = _parseEntry(s)
        if (e) entries.push(e)
      }

      return entries
    }

    function _parseEntry(s) {
      if (!s) return null

      let type = 'file'
      let rest = s

      if (s[0] === 'D') {
        type = 'dir'
        rest = s.slice(1)
      } else if (s[0] === 'F') {
        type = 'file'
        rest = s.slice(1)
      }

      let name = rest
      let size = null

      const tab = rest.lastIndexOf('\t')
      if (tab >= 0) {
        name = rest.slice(0, tab)
        const n = Number(rest.slice(tab + 1))
        if (Number.isFinite(n)) size = n
      }

      name = name.trim()
      if (!name || name === '.' || name === '..') return null

      return { type, name, size }
    }

    async function list(path = '/') {
      const entries = []
      let offset = 0
      const data = _encPath(path)

      for (let page = 0; page < 10; page++) {
        let res

        try {
          res = await request(FTP_OP.LIST_DIRECTORY, data, {
            offset,
            timeout: 4000,
          })
        } catch (e) {
          if (e?.isFtpNak && (e.errorCode === 234 || e.errorCode === 0 || e.code === 'EOF')) {
            break
          }

          if (page === 0) throw e
          break
        }

        if (!res || res.size === 0) break

        const pageEntries = _parseList(res.data)
        if (!pageEntries.length) break

        entries.push(...pageEntries)
        offset += pageEntries.length

        if (res.size < 230) break
      }

      return entries
    }

    async function _readWithSession({ session, fileSize = -1, onProgress, allowEmpty = false, isRetry = false }) {
      const chunks = []
      let offset = 0
      let totalBytes = 0
      let endedByEof = false

      const knownSize = Number.isFinite(fileSize) && fileSize >= 0

      const report = () => {
        if (!onProgress) return
        onProgress(knownSize ? Math.min(1, offset / fileSize) : null)
      }

      if (knownSize && fileSize === 0) {
        report()
        return new Blob([])
      }

      // 判定统一走 ftp 层的 isEofLikeNakCode，避免两处规则漂移
      const isEofLikeNak = (e) => !!e?.isFtpNak && isEofLikeNakCode(e.errorCode, e.errno)

      const readOnce = async (requestSize) => {
        let lastErr

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await request(FTP_OP.READ_FILE, null, {
              session,
              offset,
              size: requestSize,
              timeout: 4000,
            })
          } catch (e) {
            lastErr = e

            // NAK 通常不是临时抖动，直接抛给外层判断
            if (e?.isFtpNak) {
              throw e
            }

            if (attempt >= 2) {
              throw e
            }

            await sleep(100)
          }
        }

        throw lastErr
      }

      while (true) {
        if (knownSize && offset >= fileSize) break

        /* 每包都按标准 239 字节请求：文件尾不足 239 时飞控按实际剩余返回，
           只有越过文件尾才回 kErrEOF(6)（见 ftp_manager.c 的 _request_read）。
           早先这里有个"剩余不足就把 offset 退 1"的补丁，结果末尾字节被反复重读、
           offset 永远到不了 fileSize——非 239 整数倍的文件会在这里原地打转，
           把 chunks 越堆越大。 */
        const sizes = [CHUNK]

        let res = null
        let usedSize = CHUNK
        let eof = false
        let lastErr = null

        for (let i = 0; i < sizes.length; i++) {
          const requestSize = sizes[i]

          try {
            res = await readOnce(requestSize)
            usedSize = requestSize
            break
          } catch (e) {
            ftpWarn('[FTP] READ 失败，尝试下一个 size 或按 EOF 处理', {
              offset,
              totalBytes,
              fileSize,
              requestSize,
              errorCode: e?.errorCode,
              errno: e?.errno,
              message: e?.message,
            })

            if (e.isEof) {
              // NAK 载荷里不含文件数据（固件把 size 固定为 1/2），EOF 就表示"到尾部了"
              ftpLog('[FTP] 收到 EOF，按已读长度结束', { offset, totalBytes })
              endedByEof = true
            } else {
              // 非 EOF 错误必须抛出去：读失败不能被当成读完成
              throw e
            }
          }
        }

        if (eof) {
          endedByEof = true
          ftpWarn('[FTP] 固件在文件尾返回非标准 EOF/NAK，按已读长度结束', {
            offset,
            totalBytes,
            fileSize,
          })
          report()
          break
        }

        if (!res) {
          if (lastErr) throw lastErr
          break
        }

        const norm = _normalizeFtpData(res, usedSize)
        let len = Math.min(norm.size, norm.data.length)

        if (knownSize) {
          len = Math.min(len, fileSize - offset)
        }

        if (len <= 0) {
          ftpWarn('[FTP] READ 返回 0 字节', {
            offset,
            totalBytes,
            fileSize,
            usedSize,
          })

          // 如果已知文件大小，并且还没读完，不要直接 break
          if (knownSize && offset < fileSize && !allowEmpty) {
            const err = new Error(`FTP READ 返回 0 字节，但还差 ${fileSize - offset} 字节`)
            err.needReopen = !isRetry
            throw err
          }

          if (totalBytes > 0) break

          if (knownSize && fileSize > 0 && !allowEmpty) {
            const err = new Error('FTP READ 返回 0 字节，但文件大小不为 0')
            err.needReopen = !isRetry
            throw err
          }

          break
        }

        chunks.push(norm.data.slice(0, len))
        offset += len
        totalBytes += len
        report()

        if (knownSize) {
          if (offset >= fileSize) break
          continue
        }

        // 未知文件大小时，短包通常表示结束
        if (len < usedSize) break
      }

      if (totalBytes === 0) {
        if (knownSize && fileSize > 0 && !allowEmpty && !endedByEof) {
          throw new Error('FTP 下载结果为空')
        }

        ftpWarn('[FTP] 最终读取到 0 字节，返回空文件', {
          expectedSize: knownSize ? fileSize : null,
          endedByEof,
          allowEmpty,
          isRetry,
        })

        if (knownSize && fileSize > 0) {
          const err = new Error(
            `FTP 下载不完整：飞控报告 ${fileSize} 字节，实际读到 0 字节。` + '空结果不能当作有效文件使用。'
          )
          err.code = 'IncompleteDownload'
          err.expected = fileSize
          err.received = 0
          err.missing = fileSize
          throw err
        }

        return new Blob([])
      }

      if (knownSize && totalBytes < fileSize) {
        const missingBytes = fileSize - totalBytes
        ftpLog(`[FTP] 检测到文件尾部缺失${missingBytes}字节，发起补全读取 offset=${offset}`)
        try {
          // 单独发起一次精准的小尺寸读取，拉取剩余内容
          const fixReadResp = await readOnce(missingBytes)
          const fixNorm = _normalizeFtpData(fixReadResp, missingBytes)
          const fixLen = Math.min(fixNorm.size, missingBytes)
          if (fixLen > 0) {
            chunks.push(fixNorm.data.slice(0, fixLen))
            totalBytes += fixLen
            ftpLog(`[FTP] 尾部补全成功，新增${fixLen}字节，总字节数最终为${totalBytes}`)
          }
        } catch (e) {
          /* 这里原本是「EOF 就当读完了」，正是本次事故的出口：
             本固件 READ_FILE 读到不足一整包时回的是 errno=0 的 FailErrno
             （ftp_manager.c:256-261），它落进 isEofLikeNakCode 的兼容分支，
             于是 17570 字节的 param.xml 只拿到 239×73=17447 也算「下载成功」。
             这里只记一条告警，真正的判定交给下面的长度硬核对。 */
          if (!isEofLikeNak(e)) throw e
          ftpWarn('[FTP] 尾部补全返回 EOF，但飞控上报的长度没有凑齐', {
            fileSize,
            totalBytes,
            missingBytes,
          })
        }
      }

      /* 长度硬核对：少一个字节都不算成功。
         截断的 sysconfig.toml / param.xml 一旦被回传覆盖，就是直接损坏飞控配置。 */
      if (knownSize && totalBytes !== fileSize) {
        const err = new Error(
          `FTP 下载不完整：飞控报告 ${fileSize} 字节，实际读到 ${totalBytes} 字节，` +
            `缺 ${fileSize - totalBytes} 字节。` +
            '本固件的 READ_FILE 读不出不足一整包的尾部，应走 BURST READ。' +
            '禁止把这份内容当作完整文件使用，更不能回传覆盖。'
        )
        err.code = 'IncompleteDownload'
        err.expected = fileSize
        err.received = totalBytes
        err.missing = fileSize - totalBytes
        throw err
      }

      ftpLog('[FTP] READ 完成', {
        expectedSize: knownSize ? fileSize : null,
        totalBytes,
        endedByEof,
      })

      return new Blob(chunks)
    }

    async function download(remotePath, onProgress) {
      let fileSize = -1

      const pathParts = remotePath.split('/')
      const targetFileName = pathParts.pop()
      const parentDir = pathParts.join('/') || '/'

      try {
        const dirEntries = await list(parentDir)
        const targetFile = dirEntries.find((e) => e.name === targetFileName && e.type === 'file')

        if (targetFile && Number.isFinite(targetFile.size)) {
          fileSize = targetFile.size
        }

        ftpLog('[FTP] LIST 查询结果', {
          remotePath,
          parentDir,
          targetFileName,
          targetFile,
          fileSize,
        })
      } catch (e) {
        ftpWarn('[FTP] 无法获取目录列表，切换为纯 EOF 模式下载', e)
      }

      let openResp
      try {
        openResp = await request(FTP_OP.OPEN_FILE_RO, _encPath(remotePath), {
          timeout: 5000,
        })
      } catch (e) {
        throw new Error(`无法打开远程文件 [${remotePath}]: ${e.message}`)
      }

      let session = openResp.session
      if (session === undefined || session === null) {
        throw new Error('飞控未分配有效的 FTP Session ID')
      }

      ftpLog('[FTP] DOWNLOAD START', {
        remotePath,
        listFileSize: fileSize,
        openSession: session,
        openSize: openResp.size,
      })

      // 如果 LIST 没拿到大小，部分固件 OPEN 会返回文件大小
      if (fileSize < 0 && Number.isFinite(openResp.size) && openResp.size >= 0) {
        fileSize = openResp.size
      }

      // 只是提示不一致，不要强行覆盖 LIST 大小
      if (
        Number.isFinite(openResp.size) &&
        openResp.size >= 0 &&
        Number.isFinite(fileSize) &&
        openResp.size !== fileSize
      ) {
        ftpWarn('[FTP] LIST size 与 OPEN size 不一致', {
          listSize: fileSize,
          openSize: openResp.size,
        })
      }

      await sleep(50)

      /* 首选 BURST READ：本固件里它是唯一能把尾部夹到剩余字节的读法。
         只有飞控明确不支持时才退回 READ_FILE 逐包循环——退回之后仍然做长度硬核对。 */
      if (fileSize >= 0) {
        try {
          return await burstRead({ session, fileSize, onProgress, name: remotePath })
        } catch (e) {
          if (e?.unsupported || e?.code === 'UnsupportedOpcode') {
            ftpWarn('[FTP] 飞控不支持 BURST READ，退回 READ_FILE 逐包读取', e?.message)
          } else {
            throw e
          }
        }
      }

      try {
        try {
          return await _readWithSession({
            session,
            fileSize,
            onProgress,
            allowEmpty: false,
            isRetry: false,
          })
        } catch (e) {
          if (e?.needReopen) {
            ftpWarn('[FTP] 首次读取失败，重新打开并用纯 EOF 模式重试', e)

            try {
              await terminate(session)
            } catch {}

            openResp = await request(FTP_OP.OPEN_FILE_RO, _encPath(remotePath), {
              timeout: 5000,
            })

            session = openResp.session
            if (session === undefined || session === null) {
              throw new Error('飞控未分配有效的 FTP Session ID')
            }

            ftpLog('[FTP] REOPEN', {
              remotePath,
              session,
              openSize: openResp.size,
            })

            await sleep(50)

            /* 重开重试同样不许丢掉飞控上报的长度：一旦 fileSize:-1 + allowEmpty，
               就又回到「按 EOF 猜读完了」的老路，17570 变 17447 正是这么吞掉的。 */
            return await _readWithSession({
              session,
              fileSize,
              onProgress,
              allowEmpty: false,
              isRetry: true,
            })
          }

          throw e
        }
      } catch (e) {
        console.error('[FTP] 下载过程中出错，正在清理 Session...', e)
        throw e
      } finally {
        try {
          await request(FTP_OP.TERMINATE_SESSION, null, {
            session,
            timeout: 2000,
          })
        } catch (e) {
          ftpWarn('[FTP] 终止 Session 失败（可忽略）', e)
        }
      }
    }

    /**
     * 上传文件：CREATE_FILE → 分片 WRITE_FILE → TERMINATE_SESSION → 回读校验。
     *
     * 为什么不用 CALC_FILE_CRC32：飞控 ftp_manager.c:354-397 的 switch 里没有这个 opcode，
     * default 分支返回 FMT_ENOTHANDLE，mavgcs.c:327 于是不回包，地面站只能白等到超时；
     * 而且旧实现即使拿到值也只是 console.log 一下，从不比对，失败还标成"可忽略"。
     * 现在改成回读整份文件做逐字节 CRC32 比对，不一致就抛错——
     * 写坏的 /sys/sysconfig.toml 比不写更危险，静默通过是不可接受的。
     *
     * @param verify 'crc'（默认，回读并比 CRC32）| 'size'（只比大小）| false（不校验）
     * @returns {{remotePath: string, size: number, crc32: number, crc32Hex: string,
     *            verified: boolean, verifyMode: string, remoteSize?: number,
     *            remoteCrc32?: number, remoteCrc32Hex?: string}}
     */
    async function upload(fileOrBytes, remotePath, options = {}) {
      const {
        overwrite = true,
        onProgress,
        verify = 'crc',
        // 兼容旧参数名：verifyCrc: false 等价于 verify: false
        verifyCrc,
        maxRetries = 2,
      } = options
      const mode = verifyCrc === false ? false : verify

      const bytes = fileOrBytes instanceof Uint8Array ? fileOrBytes : new Uint8Array(await fileOrBytes.arrayBuffer())

      let session

      try {
        const c = await request(FTP_OP.CREATE_FILE, _encPath(remotePath), {
          timeout: 4000,
        })
        session = c.session
      } catch (e) {
        // 飞控的 CREATE_FILE 以 O_CREAT|O_TRUNC 打开（ftp_manager.c:371-373），
        // 同名文件本应被截断，正常不该回 FileExists(8)。
        // 真出现了就再试一次截断创建；这里绝不能走 REMOVE_FILE——飞控没实现该 opcode，
        // 发出去只会超时，旧代码把它当覆盖手段其实是无效等待。
        if (overwrite && e.code === 'FileExists') {
          ftpWarn('[FTP] CREATE_FILE 返回 FileExists，重试一次截断创建', remotePath)
          await sleep(300)

          try {
            const c = await request(FTP_OP.CREATE_FILE, _encPath(remotePath), {
              timeout: 4000,
            })
            session = c.session
          } catch (e2) {
            const err = new Error(`覆盖 ${remotePath} 失败：飞控拒绝创建同名文件（${e2.message}）`)
            err.cause = e2
            throw err
          }
        } else {
          throw e
        }
      }

      try {
        if (bytes.length === 0 && onProgress) onProgress(1)

        for (let off = 0; off < bytes.length; off += CHUNK) {
          const chunk = bytes.subarray(off, off + CHUNK)
          let writeSuccess = false

          for (let retry = 0; retry < maxRetries; retry++) {
            try {
              const ackRes = await request(FTP_OP.WRITE_FILE, chunk, {
                session,
                offset: off,
                size: chunk.length,
                timeout: 5000,
              })

              if (Number(ackRes.offset) !== off) {
                throw new Error(`分片偏移不匹配，期望${off}，返回${ackRes.offset}`)
              }

              writeSuccess = true
              break
            } catch (e) {
              if (retry >= maxRetries - 1) throw e
              await sleep(300)
            }
          }

          if (!writeSuccess) throw new Error(`分片写入失败，偏移量${off}`)
          if (onProgress) onProgress((off + chunk.length) / bytes.length)
        }
      } finally {
        await terminate(session).catch(() => {})
      }

      const localCrc = crc32(bytes)
      const result = {
        remotePath,
        size: bytes.length,
        crc32: localCrc,
        crc32Hex: crc32Hex(localCrc),
        verified: false,
        verifyMode: mode || 'none',
      }

      if (!mode) return result

      // 写会话已在 finally 里终止，这里按只读会话回读整份文件
      let back
      try {
        back = await download(remotePath)
      } catch (e) {
        const err = new Error(`上传后回读失败，无法确认 ${remotePath} 是否写入正确：${e.message}`)
        err.cause = e
        err.code = 'VerifyReadbackFailed'
        throw err
      }

      const backBytes = new Uint8Array(await back.arrayBuffer())
      result.remoteSize = backBytes.length

      if (backBytes.length !== bytes.length) {
        const err = new Error(`上传校验不通过：飞控上读到 ${backBytes.length} 字节，本地是 ${bytes.length} 字节`)
        err.code = 'VerifySizeMismatch'
        throw err
      }

      if (mode === 'crc') {
        const remoteCrc = crc32(backBytes)
        result.remoteCrc32 = remoteCrc
        result.remoteCrc32Hex = crc32Hex(remoteCrc)

        if (remoteCrc !== localCrc) {
          const err = new Error(
            `上传校验不通过：CRC32 不一致（本地 ${result.crc32Hex}，飞控 ${result.remoteCrc32Hex}）`
          )
          err.code = 'VerifyCrcMismatch'
          throw err
        }
      }

      result.verified = true
      ftpLog('[FTP] 上传校验通过', result)
      return result
    }

    /* 下面三个操作飞控都没有实现（ftp_manager.c 的 switch 没有对应 case，
       走 default 不回包），所以会由能力门禁立即失败并给出中文原因。
       保留这些函数是为了文件管理页能把"该飞控不支持"讲清楚，而不是藏着。 */
    async function remove(remotePath) {
      await request(FTP_OP.REMOVE_FILE, _encPath(remotePath), { timeout: 3500 })
    }

    async function mkdir(path) {
      await request(FTP_OP.CREATE_DIRECTORY, _encPath(path), { timeout: 3500 })
    }

    async function rmdir(path) {
      await request(FTP_OP.REMOVE_DIRECTORY, _encPath(path), { timeout: 3500 })
    }

    /** 飞控 FTP 能力表，供界面禁用不支持的操作 */
    const capabilities = {
      supportedOps: Array.from(FC_SUPPORTED_OPS),
      canWrite: FC_SUPPORTED_OPS.has(FTP_OP.WRITE_FILE),
      canRead: FC_SUPPORTED_OPS.has(FTP_OP.READ_FILE),
      canList: FC_SUPPORTED_OPS.has(FTP_OP.LIST_DIRECTORY),
      canDelete: FC_SUPPORTED_OPS.has(FTP_OP.REMOVE_FILE),
      canMkdir: FC_SUPPORTED_OPS.has(FTP_OP.CREATE_DIRECTORY),
      canCalcCrc32: FC_SUPPORTED_OPS.has(FTP_OP.CALC_FILE_CRC32),
    }

    async function terminate(session) {
      await request(FTP_OP.TERMINATE_SESSION, null, { session, timeout: 2000 })
    }

    async function reset() {
      await request(FTP_OP.RESET_SESSIONS, null, { timeout: 2500 })
    }

    return {
      setTarget,
      burstRead,
      list,
      download,
      upload,
      remove,
      mkdir,
      rmdir,
      terminate,
      reset,
      capabilities,
      _handleMessage: handleIncoming,
    }
  })()

  /* ========== 参数（PARAM_REQUEST_* / PARAM_SET / PARAM_VALUE） ========== */

  /**
   * 参数内核：整表读取、单点读取、单点写入（带回声校验）、批量应用。
   * 出站消息一律经 encodeFields 走生成表，不手写偏移、不手写消息号。
   *
   * 这层最关键的约定是「没收到回声就不算写成功」。PARAM_SET 在 MAVLink 里没有专用 ACK，
   * 规范做法是飞控把该参数的 PARAM_VALUE 再发一遍，所以写入结果只有三种：
   *   verified  —— 回声值与目标值一致（唯一能说「已生效」的情况）
   *   mismatch  —— 飞控回了但值不同（被限幅或被拒绝，必须报警）
   *   no-echo   —— 超时无回声（可能是这台飞控不支持 PARAM 协议）
   * 界面只能按 reason 说真话，不许统一弹「写入成功」。
   *
   * 另外：本飞控是否实现 PARAM 协议未实测。第一次 readAll 若一帧 PARAM_VALUE 都没收到，
   * state.supported 置 false，界面据此改口（不能把空列表显示成「飞控没有参数」）。
   */
  const param = (() => {
    const PT = PROTOCOL_ENUMS.MAV_PARAM_TYPE || {}

    let explicitTarget = null // { sys, comp }；不设置就跟随 HEARTBEAT 识别到的飞控地址
    let taskChain = Promise.resolve()
    let tapLink = null // 仅自测替身路径使用，真链路的 link 在 connect() 里创建

    const store = new Map() // name -> { name, value, type, typeName, index, count, at }
    const waiters = new Map() // name -> { resolve, timer }
    let listSession = null

    const state = reactive({
      fetching: false,
      supported: null,
      total: 0,
      got: 0,
      lastError: '',
      lastSyncAt: 0,
    })

    /** param_id 是 char[16]：解码可能给字符串也可能给字节，统一成去掉尾部 NUL 的文本 */
    function nameOf(v) {
      if (typeof v === 'string') return v.split('\0')[0].trim()
      if (v instanceof Uint8Array) return textDecoder.decode(v).split('\0')[0].trim()
      if (Array.isArray(v))
        return String.fromCharCode(...v.map((b) => b & 0xff))
          .split('\0')[0]
          .trim()
      return ''
    }

    /** 类型名从头文件枚举反查（数值 → 'UINT16'），代码里不出现手抄的类型值 */
    function typeName(type) {
      for (const [k, v] of Object.entries(PT)) if (v === type) return k.replace(/^MAV_PARAM_TYPE_/, '')
      return ''
    }
    function typeId(name) {
      return PT[`MAV_PARAM_TYPE_${name}`]
    }
    function typeKind(type) {
      const n = typeName(type)
      const m = /^(U?INT)(8|16|32|64)$/.exec(n)
      if (m) return { kind: 'int', bits: Number(m[2]), signed: m[1] === 'INT', name: n }
      if (/^REAL(32|64)$/.test(n)) return { kind: 'float', name: n }
      return { kind: 'unknown', name: n || `type=${type}` }
    }

    /** 写入值的准备：整型四舍五入并查范围；PARAM_SET 的数值字段是 float32，
     *  超过 2^24 的整数已经无法精确表示，宁可拒绝也不能悄悄写进去一个错值。 */
    function prepareValue(value, type) {
      const num = Number(value)
      if (!Number.isFinite(num)) throw new Error(`参数值不是有限数字：${value}`)
      const info = typeKind(type)
      if (info.kind === 'int') {
        const r = Math.round(num)
        const max = info.signed ? 2 ** (info.bits - 1) - 1 : 2 ** info.bits - 1
        const min = info.signed ? -(2 ** (info.bits - 1)) : 0
        if (r < min || r > max) {
          throw new Error(`${info.name} 的取值范围是 ${min}…${max}，传入 ${num} 超出范围（不做截断写入）`)
        }
        if (Math.abs(r) > 2 ** 24) {
          throw new Error('PARAM_SET 的数值字段是 float32，超过 2^24 的整数无法精确传输，请改用配置文件写入')
        }
        return r
      }
      if (info.kind === 'float') return num
      throw new Error(`参数类型 ${info.name} 还没有地面站映射，拒绝按猜测写入`)
    }

    function valuesMatch(wanted, echoed, type) {
      if (typeof echoed !== 'number') return false
      const info = typeKind(type)
      if (info.kind === 'int') return Math.round(wanted) === Math.round(echoed)
      const tol = Math.max(1e-6, Math.abs(wanted) * 1e-6) // float32 往返误差
      return Math.abs(wanted - echoed) <= tol
    }

    function _target() {
      if (explicitTarget) return explicitTarget
      return { sys: vehicle.sysid, comp: vehicle.compid }
    }

    function _link() {
      if (link) return link
      if (!txTap) throw new Error('未连接')
      if (!tapLink) tapLink = new MavlinkLink({ sysid: GCS_SYSID, compid: GCS_COMPID })
      return tapLink
    }

    function _sendParam(msgid, values) {
      if (!txTap && !connected.value) throw new Error('未连接：参数请求不会凭空发出')
      enqueue(_link().encode(msgid, encodeFields(msgid, values)))
    }

    /** 参数事务串行：整表读取期间插入写入会让回声配对错乱 */
    function _serialize(task) {
      const run = () => task()
      const next = taskChain.then(run, run)
      taskChain = next.then(
        () => undefined,
        () => undefined
      )
      return next
    }

    function _waitFor(name, timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(name)
          resolve(null)
        }, timeoutMs)
        waiters.set(name, { resolve, timer })
      })
    }

    function _settle(name, entry) {
      const w = waiters.get(name)
      if (!w) return
      waiters.delete(name)
      clearTimeout(w.timer)
      w.resolve(entry)
    }

    /** 由 _handleMessage 的 PARAM_VALUE 分支调用 */
    function _onParamValue(raw) {
      const name = nameOf(raw?.param_id)
      if (!name) return
      const type = typeof raw?.param_type === 'number' ? raw?.param_type : null
      const float = typeof raw?.param_value === 'number' ? raw.param_value : null
      /* 飞控对整型参数是把原始字节 memcpy 进 float 字段（mavlink_param.c:430-458），
         直接按 float 用会看到 1.401298464324817e-45 这种数；而另一张参数表里
         声明为整型的参数发的又是数值 float（CAL_GYRO0_ID=125 按整型读是 11 亿）。
         两种编码在链路上无法逐参数判定，所以两个读法都存下来：value 保持原来的
         float 不动（现有页面不受影响），整型/布尔参数的权威值一律以 param.xml 为准。 */
      const decoded = decodeParamValue(float, type)
      const prev = store.get(name)
      const entry = {
        name,
        value: float,
        typed: decoded.typed,
        agrees: decoded.agrees,
        encoding: decoded.encoding,
        reliable: decoded.reliable,
        note: decoded.note,
        /* 同一个 param_id 收到多帧 = 两张参数表重名，后到的一帧覆盖了前面的值 */
        hits: (prev?.hits || 0) + 1,
        type,
        typeName: type == null ? '' : typeName(type),
        index: typeof raw?.param_index === 'number' ? raw.param_index : null,
        count: typeof raw?.param_count === 'number' ? raw.param_count : null,
        at: Date.now(),
      }
      store.set(name, entry)
      state.got = store.size
      if (entry.count) state.total = entry.count
      _settle(name, entry)
      if (listSession) listSession.onEntry(entry)
    }

    function setTarget(sys, comp) {
      explicitTarget = { sys: Number(sys) || 1, comp: Number(comp) || 1 }
    }

    function get(name) {
      return store.get(nameOf(name)) || null
    }

    function list() {
      return [...store.values()].sort((a, b) => a.name.localeCompare(b.name))
    }

    function clear() {
      store.clear()
      state.got = 0
      state.total = 0
    }

    /**
     * 整表读取。完成条件有三个，全部由飞控实际行为决定：
     *  - 收到 param_index+1 >= param_count 的帧 → complete（读完了）
     *  - 已经收到过帧但静默超过 idleTimeout → idle（飞控不再往下发）
     *  - 一帧都没等到 firstResponseTimeout → no-response（判定这台飞控不支持 PARAM 协议）
     */
    function readAll(options = {}) {
      const timeout = Number(options.timeout) || 20000
      const idleTimeout = Number(options.idleTimeout) || 3000
      const firstTimeout = Number(options.firstTimeout) || 4000
      return _serialize(async () => {
        state.fetching = true
        state.lastError = ''
        store.clear()
        state.got = 0
        state.total = 0
        const started = Date.now()
        let lastAt = started
        return await new Promise((resolve) => {
          let settled = false
          let poll = 0
          const finish = (reason) => {
            if (settled) return
            settled = true
            listSession = null
            clearInterval(poll)
            state.fetching = false
            state.supported = store.size > 0
            if (store.size) state.lastSyncAt = Date.now()
            const out = list()
            resolve({
              list: out,
              count: out.length,
              total: state.total || out.length,
              reason,
              ms: Date.now() - started,
            })
          }
          listSession = {
            onEntry: (entry) => {
              lastAt = Date.now()
              if (entry.index != null && entry.count && entry.index + 1 >= entry.count) finish('complete')
            },
          }
          const { sys, comp } = _target()
          try {
            _sendParam(MSG.PARAM_REQUEST_LIST, { target_system: sys, target_component: comp })
          } catch (e) {
            listSession = null
            state.fetching = false
            state.lastError = String(e?.message || e)
            finish('send-failed')
            return
          }
          poll = setInterval(() => {
            const now = Date.now()
            if (now - started > timeout) return finish('timeout')
            if (!store.size && now - started > firstTimeout) return finish('no-response')
            if (store.size && now - lastAt > idleTimeout) return finish('idle')
          }, 100)
        })
      })
    }

    /** 单点读取：param_index=-1 表示「按名字读」（协议规定，飞控不需要知道下标） */
    function read(name, options = {}) {
      const timeout = Number(options.timeout) || 3000
      return _serialize(async () => {
        const key = nameOf(name)
        if (!key) throw new Error('参数名不能为空')
        const { sys, comp } = _target()
        waiters.delete(key)
        _sendParam(MSG.PARAM_REQUEST_READ, {
          target_system: sys,
          target_component: comp,
          param_id: key,
          param_index: -1,
        })
        const entry = await _waitFor(key, timeout)
        if (!entry) {
          state.lastError = `读取 ${key} 无回包`
          return { ok: false, reason: 'no-echo', name: key }
        }
        return { ok: true, reason: 'verified', ...entry }
      })
    }

    /**
     * 写入核（不排队）：只认飞控回发的 PARAM_VALUE 回声。
     * 拆成核 + 排队壳是因为 apply() 要连续调用多次写入：如果 apply 排一次队、
     * 里面的 write 又排一次队，就会出现「自己等自己」的死锁。
     */
    async function _writeCore(key, value, options = {}) {
      const timeout = Number(options.timeout) || 3000
      if (!key) throw new Error('参数名不能为空')
      const known = store.get(key)
      const type = typeof options.type === 'number' ? options.type : known?.type
      if (type == null) {
        throw new Error(`不知道参数 ${key} 的类型：先 readAll() 或显式传 type（按猜测写类型会写坏配置）`)
      }
      const wire = prepareValue(value, type)
      const { sys, comp } = _target()
      waiters.delete(key)
      _sendParam(MSG.PARAM_SET, {
        target_system: sys,
        target_component: comp,
        param_id: key,
        param_value: wire,
        param_type: type,
      })
      const echo = await _waitFor(key, timeout)
      if (!echo) {
        state.lastError = `写入 ${key} 无回包`
        return { ok: false, reason: 'no-echo', name: key, wanted: wire, type }
      }
      const same = valuesMatch(wire, echo.value, type)
      if (!same) state.lastError = `写入 ${key} 回声不符：期望 ${wire}，飞控回 ${echo.value}`
      return {
        ok: same,
        reason: same ? 'verified' : 'mismatch',
        name: key,
        wanted: wire,
        echoed: echo.value,
        type,
        typeName: typeName(type),
      }
    }

    /** 单点写入 */
    function write(name, value, options = {}) {
      const key = nameOf(name)
      return _serialize(() => _writeCore(key, value, options))
    }

    /**
     * 批量应用：整批占一个事务，逐条写并逐条等回声。一条失败不中断其余
     * （否则第 3 条失败会让后面 20 条根本没发出去，界面却只能说「部分失败」——
     * 不如把每一条的结果都交回去）。
     */
    function apply(entries, options = {}) {
      return _serialize(async () => {
        const results = []
        for (const e of entries || []) {
          try {
            results.push(await _writeCore(nameOf(e?.name), e.value, { ...options, type: e.type }))
          } catch (err) {
            results.push({ ok: false, reason: 'error', name: nameOf(e?.name), error: String(err?.message || err) })
          }
        }
        const okCount = results.filter((r) => r.ok).length
        return {
          results,
          okCount,
          failed: results.length - okCount,
          // 只有全部拿到一致回声，才允许界面说「已写入飞控」
          allVerified: results.length > 0 && okCount === results.length,
        }
      })
    }

    const MSG = {
      PARAM_REQUEST_LIST: MAVLINK_MSG_ID.PARAM_REQUEST_LIST,
      PARAM_REQUEST_READ: MAVLINK_MSG_ID.PARAM_REQUEST_READ,
      PARAM_SET: MAVLINK_MSG_ID.PARAM_SET,
    }

    return {
      state: readonly(state),
      setTarget,
      readAll,
      read,
      write,
      apply,
      list,
      get,
      clear,
      typeName,
      typeId,
      typeKind,
      _onParamValue,
      /** 自测用的纯函数集合：类型判定与取值准备都不碰链路 */
      __paramInternal: { nameOf, prepareValue, valuesMatch, typeKind, typeName },
    }
  })()

  /* ========== 消息分发与解析 ========== */

  /** rad -> deg */
  const R2D = 180 / Math.PI
  /** STATUSTEXT 环形缓冲上限：顶栏只显示最新一条，日志面板显示这一窗 */
  const STATUS_LOG_MAX = 50
  /** 协议用 UINT16_MAX / UINT8_MAX 表示"未知"，不能当成真实读数 */
  const UNKNOWN16 = 0xffff
  const UNKNOWN8 = 0xff

  /** 安全取值：白名单外表、v2 截尾（尾部 0 被省略）时字段可能不存在，统一退回 0 而不是 NaN */
  const R = (raw, name) => (raw && typeof raw[name] === 'number' ? raw[name] : 0)
  const S = (si, name) => (si && typeof si[name] === 'number' ? si[name] : 0)

  /** 追加一条 STATUSTEXT 到环形缓冲（保序，超上限从头丢弃） */
  function pushStatusLog(entry) {
    const logs = data.statusLogs
    logs.push(entry)
    if (logs.length > STATUS_LOG_MAX) logs.splice(0, logs.length - STATUS_LOG_MAX)
  }

  function _handleMessage(msg) {
    // 自动识别只接受 HEARTBEAT；其它消息不能伪造设备身份。
    if (msg.sysid === GCS_SYSID && msg.compid === GCS_COMPID) return

    // FTP 自带 msgid 过滤，走原始 payload，先于通用解码分发
    ftp._handleMessage(msg)

    // 按生成表解码：raw=协议原值（位图/计数用），si=按单位标注换算后的展示值
    const d = decodeMessage(msg.msgid, msg.payload, { version: msg.version })
    if (d) {
      d.sysid = msg.sysid
      d.compid = msg.compid
    }
    const freshnessKey = {
      [MAVLINK_MSG_ID.VFR_HUD]: 'vfrHud',
      [MAVLINK_MSG_ID.ATTITUDE]: 'attitude',
      [MAVLINK_MSG_ID.ATTITUDE_QUATERNION]: 'attitude', // 这台 FMT 的实际姿态走四元数（31）而非欧拉角（30），二者点亮同一个 attitude 新鲜度
      // 这三条只写 data.imu（原始加计/陀螺/磁力计），从不写 data.attitude，所以它们不能证明
      // 姿态解算在输出。单独记到 'imu'，"飞控到底有没有推 ATTITUDE"才在界面上看得出来。
      [MAVLINK_MSG_ID.SCALED_IMU]: 'imu',
      [MAVLINK_MSG_ID.RAW_IMU]: 'imu',
      [MAVLINK_MSG_ID.HIGHRES_IMU]: 'imu',
      [MAVLINK_MSG_ID.GPS_RAW_INT]: 'gps',
      [MAVLINK_MSG_ID.SYS_STATUS]: 'sysStatus',
      [MAVLINK_MSG_ID.RC_CHANNELS]: 'rc',
      [MAVLINK_MSG_ID.SERVO_OUTPUT_RAW]: 'servos',
    }[msg.msgid]
    if (freshnessKey) {
      deviceState.freshness[freshnessKey] = Date.now()
      if (freshnessKey === 'sysStatus') deviceState.freshness.battery = deviceState.freshness.sysStatus
      if (Object.prototype.hasOwnProperty.call(deviceState.valid, freshnessKey)) deviceState.valid[freshnessKey] = true
      if (freshnessKey === 'sysStatus') deviceState.valid.battery = true
    }
    const raw = d ? d.raw : null
    const si = d ? d.si : null

    try {
      switch (msg.msgid) {
        case MAVLINK_MSG_ID.HEARTBEAT: {
          if (!d || !raw) break
          emit('reconnect-evidence', { type: 'heartbeat', at: Date.now(), sysid: msg.sysid, compid: msg.compid })
          vehicle.sysid = msg.sysid
          vehicle.compid = msg.compid
          vehicle.detected = true
          deviceState.identity = {
            detected: true,
            sysid: msg.sysid,
            compid: msg.compid,
            type: R(raw, 'type'),
            autopilot: R(raw, 'autopilot'),
            systemStatus: R(raw, 'system_status'),
            systemStatusLabel: systemState(R(raw, 'system_status')).label,
          }
          vehicle.type = R(raw, 'type')
          vehicle.autopilot = R(raw, 'autopilot')
          vehicle.baseMode = R(raw, 'base_mode')
          vehicle.customMode = R(raw, 'custom_mode')
          vehicle.armed = isArmed(vehicle.baseMode)
          const md = describeMode(vehicle.baseMode, vehicle.customMode)
          vehicle.modeCode = md.code
          vehicle.modeName = md.label
          const st = systemState(R(raw, 'system_status'))
          vehicle.systemStatus = R(raw, 'system_status')
          vehicle.systemStatusLabel = st.label
          vehicle.lastHeartbeatAt = Date.now()
          deviceState.heartbeat.lastAt = vehicle.lastHeartbeatAt
          deviceState.heartbeat.ageMs = 0
          deviceState.heartbeat.healthy = true
          deviceState.phase = 'online'
          if (!deviceState.connectedAt) deviceState.connectedAt = Date.now()
          break
        }
        case MAVLINK_MSG_ID.SCALED_IMU:
        case MAVLINK_MSG_ID.RAW_IMU:
        case MAVLINK_MSG_ID.HIGHRES_IMU: {
          const imu = data.imu
          const name = messageName(msg.msgid) || ''
          const pick = (field) => (si?.[field] == null ? null : Number(si[field]))
          imu.accel = [pick('xacc'), pick('yacc'), pick('zacc')]
          imu.gyro = [pick('xgyro'), pick('ygyro'), pick('zgyro')]
          imu.mag = [pick('xmag'), pick('ymag'), pick('zmag')]
          imu.timeBootMs = raw?.time_boot_ms ?? raw?.time_usec ?? 0
          imu.source = name
          imu.lastAt = Date.now()
          break
        }
        case MAVLINK_MSG_ID.ATTITUDE: {
          // 降级通道：新固件优先推 31，只有老固件/对端不发四元数时这条才会来（见下面的 _attSource）。
          // 权威源一旦收到过 31，就不再让 30 抢显示。
          const a = data.attitude
          const t30 = R(raw, 'time_boot_ms')
          if (isStaleAttitudeFrame(t30, MAVLINK_MSG_ID.ATTITUDE)) break
          a.timeBootMs = t30
          a.roll = R(raw, 'roll') * R2D
          a.pitch = R(raw, 'pitch') * R2D
          a.yaw = R(raw, 'yaw') * R2D
          a.rollspeed = R(raw, 'rollspeed') * R2D
          a.pitchspeed = R(raw, 'pitchspeed') * R2D
          a.yawspeed = R(raw, 'yawspeed') * R2D
          if (_attSource.authority !== 'quaternion') {
            _attSource.authority = 'euler'
            _attSource.lastAt = Date.now()
            _attSource.lastMsgId = MAVLINK_MSG_ID.ATTITUDE
          }
          break
        }
        case MAVLINK_MSG_ID.ATTITUDE_QUATERNION: {
          // 这台 FMT 的数传固件推四元数（msgid 31）而不推欧拉角（msgid 30）。
          // 转换公式与 repr_offset_q 语义都固定在 utils/attitude-quat.js，并与固件
          // module/math/quaternion.c:148-167 的 quaternion_toEuler 逐项对齐。
          const a = data.attitude
          const att = attitudeFromQuaternion(raw)
          if (!att) break // 四元数非法（模长≈0/含 NaN）：不覆盖上一帧，也不冒充合法姿态
          const t31 = R(raw, 'time_boot_ms')
          if (isStaleAttitudeFrame(t31, MAVLINK_MSG_ID.ATTITUDE_QUATERNION)) break
          a.timeBootMs = t31
          a.roll = att.roll
          a.pitch = att.pitch
          a.yaw = att.yaw
          a.rollspeed = R(raw, 'rollspeed') * R2D
          a.pitchspeed = R(raw, 'pitchspeed') * R2D
          a.yawspeed = R(raw, 'yawspeed') * R2D
          a.quat = att.quat
          a.quatOffsetApplied = att.offsetApplied
          _attSource.authority = 'quaternion'
          _attSource.lastAt = Date.now()
          _attSource.lastMsgId = MAVLINK_MSG_ID.ATTITUDE_QUATERNION
          break
        }
        case MAVLINK_MSG_ID.VFR_HUD: {
          const h = data.vfrHud
          h.airspeed = S(si, 'airspeed')
          h.groundspeed = S(si, 'groundspeed')
          h.alt = S(si, 'alt')
          h.climb = S(si, 'climb')
          h.heading = S(si, 'heading') // [deg]：旧代码在这里读成了 int16 偏移 8（那是 heading 的原始位置，
          // 但字段类型是 uint16，且 throttle 紧随其后），现在由表给出
          h.throttle = S(si, 'throttle') // [%]
          break
        }
        case MAVLINK_MSG_ID.SYS_STATUS: {
          const s = data.sysStatus
          s.onboardControlSensorsPresent = R(raw, 'onboard_control_sensors_present') >>> 0
          s.onboardControlSensorsEnabled = R(raw, 'onboard_control_sensors_enabled') >>> 0
          s.onboardControlSensorsHealth = R(raw, 'onboard_control_sensors_health') >>> 0
          s.load = R(raw, 'load') // 保持协议原值（0.1%），仪表盘按 /10 显示
          s.voltageBattery = S(si, 'voltage_battery') // V
          s.currentBattery = S(si, 'current_battery') // A
          s.batteryRemaining = R(raw, 'battery_remaining')
          s.dropRateComm = S(si, 'drop_rate_comm') // %
          s.errorsComm = R(raw, 'errors_comm')
          s.errorsCount = [
            R(raw, 'errors_count1'),
            R(raw, 'errors_count2'),
            R(raw, 'errors_count3'),
            R(raw, 'errors_count4'),
          ]
          data.battery.voltage = s.voltageBattery
          data.battery.current = s.currentBattery
          data.battery.percent = s.batteryRemaining
          data.battery.source = 'SYS_STATUS'
          break
        }
        case MAVLINK_MSG_ID.GLOBAL_POSITION_INT: {
          const g = data.gps
          g.timeBootMs = R(raw, 'time_boot_ms')
          g.lat = S(si, 'lat') // [degE7] -> deg（插值后的平滑位置）
          g.lon = S(si, 'lon')
          g.alt = S(si, 'alt') // [mm] -> m，海拔（MSL）
          g.relAlt = S(si, 'relative_alt') // [mm] -> m，相对起飞点
          g.vx = S(si, 'vx')
          g.vy = S(si, 'vy')
          g.vz = S(si, 'vz') // [cm/s] -> m/s
          g.heading = S(si, 'hdg') // [cdeg] -> deg
          break
        }
        case MAVLINK_MSG_ID.GPS_RAW_INT: {
          const g = data.gps
          g.fixType = R(raw, 'fix_type')
          const fx = gpsFix(g.fixType)
          g.fixLabel = fx.label
          g.usable = fx.usable
          g.satellitesVisible = R(raw, 'satellites_visible') === UNKNOWN8 ? 0 : R(raw, 'satellites_visible')
          g.rawLat = S(si, 'lat')
          g.rawLon = S(si, 'lon')
          // eph/epv 在本版本的头文件注释里写作 unitless（未标单位），沿用 1/100 约定当 HDOP/VDOP 显示；
          // 旧代码把 GLOBAL_POSITION_INT 的 vz 当成 hdop，那个数字是升降速度，不是定位质量
          g.hdop = R(raw, 'eph') === UNKNOWN16 ? 0 : R(raw, 'eph') / 100
          g.vdop = R(raw, 'epv') === UNKNOWN16 ? 0 : R(raw, 'epv') / 100
          g.speed = R(raw, 'vel') === UNKNOWN16 ? 0 : S(si, 'vel') // [cm/s] -> m/s
          g.cog = R(raw, 'cog') === UNKNOWN16 ? 0 : R(raw, 'cog') / 100 // 注释标 [cdeg]，表里无标注，按 1/100
          break
        }
        case MAVLINK_MSG_ID.ALTITUDE: {
          const al = data.altitude
          al.timeUsec = R(raw, 'time_usec')
          al.monotonic = S(si, 'altitude_monotonic')
          al.amsl = S(si, 'altitude_amsl')
          al.local = S(si, 'altitude_local')
          al.relative = S(si, 'altitude_relative')
          al.terrain = S(si, 'altitude_terrain')
          al.bottomClearance = S(si, 'bottom_clearance')
          break
        }
        case MAVLINK_MSG_ID.LOCAL_POSITION_NED: {
          const p = data.localPosition
          p.timeBootMs = R(raw, 'time_boot_ms')
          p.x = S(si, 'x')
          p.y = S(si, 'y')
          p.z = S(si, 'z') // NED，m
          p.vx = S(si, 'vx')
          p.vy = S(si, 'vy')
          p.vz = S(si, 'vz') // m/s
          break
        }
        case MAVLINK_MSG_ID.EXTENDED_SYS_STATE: {
          const e = data.extState
          e.vtolState = R(raw, 'vtol_state')
          e.vtolLabel = vtolState(e.vtolState).label
          e.landedState = R(raw, 'landed_state')
          e.landedLabel = landedState(e.landedState).label
          break
        }
        case MAVLINK_MSG_ID.RC_CHANNELS: {
          const r = data.rcChannels
          r.timeBootMs = R(raw, 'time_boot_ms')
          r.chancount = R(raw, 'chancount')
          r.rssi = R(raw, 'rssi')
          for (let i = 0; i < 18; i++) r.channels[i] = R(raw, `chan${i + 1}_raw`)
          break
        }
        case MAVLINK_MSG_ID.SERVO_OUTPUT_RAW: {
          const s = data.servos
          s.timeUsec = R(raw, 'time_usec')
          s.port = R(raw, 'port')
          for (let i = 0; i < 16; i++) s.raw[i] = R(raw, `servo${i + 1}_raw`)
          s.online = true
          break
        }
        // 参数的回声：写入是否生效只认这一条，具体配对逻辑在 param 内核里
        case MAVLINK_MSG_ID.PARAM_VALUE: {
          param._onParamValue(raw)
          break
        }
        case MAVLINK_MSG_ID.SERIAL_CONTROL: {
          const sc = decodeSerialControl(msg.payload)
          if (sc.count > 0) {
            const text = textDecoder.decode(sc.data, { stream: true })
            emit('cli', text)
            session.feed(text)
          }
          break
        }
        case MAVLINK_MSG_ID.STATUSTEXT: {
          const sev = R(raw, 'severity')
          const meta = severity(sev)
          const text = typeof raw?.text === 'string' ? raw.text : ''
          data.statusText = text
          // 等级以前被读出来又丢掉了，故障告警和调试信息在界面上长得一模一样
          pushStatusLog({ time: Date.now(), severity: sev, severityLabel: meta.label, type: meta.type, text })
          break
        }
      }
    } catch (e) {
      // 只影响这一条消息：msgid + 消息名一起打出来，才不至于在日志里只剩一个 "parse error"
      warnDecodeFailure(msg?.msgid, e)
    }

    // 链路统计：解析器用的是普通对象（每帧写响应式字段代价低，但字段少才好读）
    if (parser?.stats) {
      linkStats.frames = parser.stats.frames
      linkStats.crcErrors = parser.stats.crcErrors
      linkStats.learned = parser.stats.learned
    }
    linkStats.rxMsgs++
    deviceState.lastRxAt = Date.now()
    linkStats.rxBytes += msg.payload.length + 10 // +10：帧头/序号/CRC 的估算开销

    // 按 msgid 分发原始 payload（老代码依赖这个），再按协议消息名分发解码结果
    emit(msg.msgid, msg.payload)
    if (d) emit(d.name, d)
    // 兼容旧事件名（新代码请用协议消息名，如 on('GLOBAL_POSITION_INT', …)）
    if (msg.msgid === MAVLINK_MSG_ID.GLOBAL_POSITION_INT) emit('GPS', data.gps)
    if (msg.msgid === MAVLINK_MSG_ID.SERVO_OUTPUT_RAW) emit('SERVO_OUTPUT', data.servos)
  }

  /* ========== 发送队列 ========== */

  /** 自测/调试台用的发送替身：设置后出站帧交给它，不写串口。生产路径保持 null。 */
  let txTap = null
  function setTxTap(fn) {
    txTap = typeof fn === 'function' ? fn : null
  }

  /** 入队一帧。所有发送都走这里，保证同一条链路上的写入串行且顺序确定。 */
  function enqueue(frame) {
    assertFirmwareAvailable()
    if (txTap) {
      txTap(frame)
      return
    }
    txQueue.push({ frame })
    if (!pumping) void _pump()
  }

  function discardQueue(err) {
    for (const item of txQueue) item.reject?.(err)
    txQueue = []
  }

  function enqueueWritten(frame, signal, check) {
    if (firmwareExclusive.value)
      return Promise.reject(rebootError('FIRMWARE_EXCLUSIVE', '固件烧写占用设备，MAVLink 暂不可发送'))
    if (txTap || !transport?.writer) return Promise.reject(rebootError('NOT_WRITABLE', '没有真实可写串口'))
    return new Promise((resolve, reject) => {
      txQueue.push({ frame, resolve, reject, signal, check })
      if (!pumping) void _pump()
    })
  }

  async function _pump() {
    pumping = true
    const pumpTransport = transport
    try {
      while (txQueue.length && transport && transport === pumpTransport) {
        const item = txQueue.shift()
        if (item.signal?.aborted) {
          item.reject?.(item.signal.reason)
          continue
        }
        try {
          item.check?.()
          await _writeRaw(item.frame)
          item.resolve?.()
        } catch (e) {
          item.reject?.(e)
          if (transport !== pumpTransport) break
          /* 写失败说明链路已经坏了，队列里剩下的帧属于上一次会话。
             留着不管的话，重连后它们会被写进新链路，把新会话（FTP/参数）搅乱，
             所以连同当前帧一起丢弃。 */
          const dropped = txQueue.length
          discardQueue(e)
          error.value = `发送失败：${e?.message || e}`
          if (dropped) console.warn(`[tx] 发送失败，丢弃队列中残留的 ${dropped} 帧`)
          break
        }
        if (TX_DELAY_MS > 0) await new Promise((r) => setTimeout(r, TX_DELAY_MS))
      }
    } finally {
      // 任何异常路径都要复位，否则 pumping 卡在 true，之后再也没有人启动泵
      pumping = false
      if (txQueue.length && transport) void _pump()
    }
  }

  async function _writeRaw(bytes) {
    assertFirmwareAvailable()
    if (!transport) throw new Error('未连接')
    if (transport.type === 'webserial') {
      await transport.writer.write(bytes)
    } else if (transport.type === 'websocket') {
      if (transport.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket 未打开')
      transport.ws.send(bytes)
    } else {
      throw new Error('未知链路类型')
    }
  }

  /** 主动发送任意 MAVLink 消息（给外部扩展用） */
  function sendMessage(msgid, payload, options) {
    if (!connected.value) throw new Error('未连接')
    enqueue(link.encode(msgid, payload, options))
  }

  /* ========== 接收循环 ========== */

  function _onBytes(bytes) {
    try {
      parser.push(bytes)
    } catch (e) {
      error.value = `MAVLink 解析错误：${e?.message || e}`
    }
  }

  async function _readWebSerial(reader) {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) _onBytes(value)
      }
    } catch (e) {
      if (!manualDisconnect) error.value = `串口读取错误：${e?.message || e}`
    } finally {
      try {
        reader.releaseLock()
      } catch {}
      if (!manualDisconnect) _onTransportLost()
    }
  }

  /* ========== 连接管理 ========== */

  async function connect(baud = baudRate.value, authorizedPort = null, signal = null) {
    assertFirmwareAvailable()
    if (reconnecting.value && !signal) throw rebootError('RECONNECT_BUSY', '正在自动重连')
    if (connected.value || connecting.value) return
    const generation = connectionGeneration
    await cleanupPromise
    assertFirmwareAvailable()
    if (signal?.aborted || generation !== connectionGeneration)
      throw signal?.reason || rebootError('RECONNECT_CANCELLED', '连接已取消')
    manualDisconnect = false
    connecting.value = true
    error.value = ''
    baudRate.value = baud

    try {
      parser = new Mavlink2Parser({ onMessage: _handleMessage })
      link = new MavlinkLink({ sysid: GCS_SYSID, compid: GCS_COMPID })
      discardQueue(new Error('连接会话已更换'))

      await _connectWebSerial(baud, authorizedPort, signal, generation)
      connected.value = true
      deviceState.phase = 'serial-open'
      deviceState.transport = transport?.type || 'webserial'
      deviceState.connectedAt = Date.now()
      deviceState.sessionId += 1
      deviceState.error = null
      error.value = ''

      _startHeartbeat()
      _startDeviceTicker()
      // 连接后自动打开 shell
      if (!reconnecting.value)
        shellOpenTimer = setTimeout(() => {
          shellOpenTimer = null
          if (connected.value) cli.open()
        }, 150)
    } catch (e) {
      error.value = e?.message || String(e)
      await _cleanup()
      throw e
    } finally {
      connecting.value = false
    }
  }

  async function _connectWebSerial(baud, authorizedPort, signal, generation) {
    if (!('serial' in navigator)) {
      throw new Error('当前浏览器不支持 Web Serial API，请使用 Chrome/Edge，或改用 WebSocket 桥。')
    }
    const port = authorizedPort || (await navigator.serial.requestPort())
    if (signal?.aborted || generation !== connectionGeneration)
      throw signal?.reason || rebootError('RECONNECT_CANCELLED', '连接已取消')
    await port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' })
    if (signal?.aborted || generation !== connectionGeneration) {
      try {
        await port.close()
      } catch {}
      throw signal?.reason || rebootError('RECONNECT_CANCELLED', '连接已取消')
    }
    if (!port.readable || !port.writable) {
      try {
        await port.close()
      } catch {}
      throw new Error('串口不可读写')
    }
    lastAuthorizedPort = port
    serialCloseError = null
    lastPortInfo = { ...port.getInfo() }
    const writer = port.writable.getWriter()
    const reader = port.readable.getReader()

    transport = { type: 'webserial', port, reader, writer }
    try {
      port.addEventListener('disconnect', _onTransportLost)
    } catch {}
    readPromise = _readWebSerial(reader)
  }

  async function reconnectLast() {
    assertFirmwareAvailable()
    if (reconnecting.value || connected.value || connecting.value) return
    if (!lastAuthorizedPort || !navigator.serial?.getPorts)
      throw new Error('没有可复用的串口授权，请点击连接飞控选择设备')
    const ports = await navigator.serial.getPorts()
    const port = ports.includes(lastAuthorizedPort) ? lastAuthorizedPort : null
    if (!port) throw new Error('上次串口未出现或授权已失效，请点击连接飞控重新选择')
    return connect(baudRate.value, port)
  }

  function resetDeviceState(reason = 'disconnect') {
    deviceState.sessionId += 1
    deviceState.phase = 'idle'
    deviceState.transport = null
    deviceState.connectedAt = 0
    deviceState.lastRxAt = 0
    deviceState.error =
      reason === 'disconnect' ? null : { code: reason, message: error.value || reason, at: Date.now() }
    deviceState.identity = {
      detected: false,
      sysid: null,
      compid: null,
      type: null,
      autopilot: null,
      systemStatus: null,
      systemStatusLabel: '—',
    }
    deviceState.heartbeat = { lastAt: 0, ageMs: null, healthy: false }
    Object.keys(deviceState.freshness).forEach((key) => {
      deviceState.freshness[key] = 0
    })
    Object.keys(deviceState.valid).forEach((key) => {
      deviceState.valid[key] = false
    })
    vehicle.sysid = 1
    vehicle.compid = 1
    vehicle.detected = false
    vehicle.type = 0
    vehicle.autopilot = 0
    vehicle.baseMode = 0
    vehicle.customMode = 0
    vehicle.armed = false
    vehicle.modeCode = 'UNKNOWN_0'
    vehicle.modeName = '未知'
    vehicle.systemStatus = 0
    vehicle.systemStatusLabel = '—'
    vehicle.lastHeartbeatAt = 0
    // 姿态来源跟着设备会话一起清：换一台飞控后不能拿上一台的"权威源"结论继续用
    _attSource.authority = 'none'
    _attSource.lastAt = 0
    _attSource.lastMsgId = null
    data.statusText = ''
    data.statusLogs.splice(0)
  }

  function assertFirmwareAvailable() {
    if (firmwareExclusive.value) throw rebootError('FIRMWARE_EXCLUSIVE', '固件烧写占用设备，MAVLink 暂不可连接或发送')
  }

  async function acquireFirmwareExclusive() {
    assertFirmwareAvailable()
    if (connecting.value || reconnecting.value) throw rebootError('CONNECT_BUSY', '连接或重连进行中，不能开始固件烧写')
    if (session.transactionLocked || session.state.busy)
      throw rebootError('CONSOLE_BUSY', '控制台或参数保存事务正忙，不能开始固件烧写')
    if (connected.value && vehicle.armed) throw rebootError('ARMED', '飞控已解锁，禁止固件烧写')
    firmwareExclusive.value = true
    let released = false
    const release = () => {
      if (released) return
      released = true
      firmwareExclusive.value = false
    }
    try {
      await disconnect()
      await cleanupPromise
      if (serialCloseError)
        throw rebootError('SERIAL_RELEASE_FAILED', `串口释放失败：${serialCloseError.message || serialCloseError}`)
      return release
    } catch (error) {
      error.ownershipUncertain = true
      throw error
    }
  }

  async function disconnect() {
    rebootReconnect.cancel()
    connectionGeneration += 1
    manualDisconnect = true
    await _cleanup()
    session.reset('disconnect')
    connected.value = false
    _stopHeartbeat()
    resetDeviceState('disconnect')
  }

  function _onTransportLost() {
    if (manualDisconnect || !connected.value) return
    emit('reconnect-evidence', { type: 'lost' })
    connected.value = false
    session.reset('transport-lost')
    _stopHeartbeat()
    resetDeviceState('transport-lost')
    void _cleanup()
  }

  function _cleanup() {
    clearTimeout(shellOpenTimer)
    shellOpenTimer = null
    const run = async () => {
      _stopHeartbeat()
      if (!transport) return
      const t = transport
      const reading = readPromise
      readPromise = null
      transport = null
      discardQueue(new Error('串口已关闭'))
      try {
        if (t.type === 'webserial') {
          try {
            t.port.removeEventListener('disconnect', _onTransportLost)
          } catch {}
          try {
            await t.reader.cancel()
          } catch {}
          if (reading) {
            try {
              await reading
            } catch {}
          }
          try {
            await t.writer.close()
          } catch {}
          try {
            t.writer.releaseLock()
          } catch {}
          try {
            await t.port.close()
            serialCloseError = null
          } catch (error) {
            serialCloseError = error
          }
        } else if (t.type === 'websocket') {
          t.ws.onclose = t.ws.onerror = t.ws.onmessage = null
          try {
            t.ws.close()
          } catch {}
        }
      } catch {}
    }
    cleanupPromise = cleanupPromise.then(run, run)
    return cleanupPromise
  }

  function assertRebootSafe() {
    if (
      !connected.value ||
      !transport?.writer ||
      txTap ||
      deviceState.phase !== 'online' ||
      !deviceState.heartbeat.healthy ||
      Date.now() - vehicle.lastHeartbeatAt > 3000
    ) {
      throw rebootError('NOT_WRITABLE', '链路不可写或飞控心跳不新鲜，不能重启')
    }
    if (vehicle.armed) throw rebootError('ARMED', '飞控已解锁，禁止重启')
    if (session.state.busy) throw rebootError('CONSOLE_BUSY', '控制台会话正忙，不能重启')
  }
  const rebootReconnect = createRebootReconnect({
    assertSafe: assertRebootSafe,
    capture: () => ({ port: lastAuthorizedPort, info: lastPortInfo, sysid: vehicle.sysid, compid: vehicle.compid }),
    subscribe: (fn) => on('reconnect-evidence', fn),
    setActive: (value) => {
      reconnecting.value = value
    },
    setStage: (stage) => {
      reconnectStatus.value = stage
    },
    isConnected: () => connected.value,
    getPorts: () => navigator.serial.getPorts(),
    connect: (port, signal) => connect(baudRate.value, port, signal),
    sendReboot: (signal) =>
      enqueueWritten(
        link.encodeSerialControl(textEncoder.encode('reboot\r'), {
          baudRate: 0,
          timeout: 200,
          flags: SERIAL_CONTROL_FLAG.REPLY | SERIAL_CONTROL_FLAG.EXCLUSIVE,
          device: SERIAL_CONTROL_DEV.SHELL,
        }),
        signal,
        assertRebootSafe
      ),
  })
  const rebootAndReconnect = (options) => {
    assertFirmwareAvailable()
    return rebootReconnect.run(options)
  }

  /* ========== 心跳 ========== */

  /** 队列积压到这个程度说明正在传批量数据（FTP/参数），心跳让路，避免把主通道占死 */
  const HEARTBEAT_QUEUE_LIMIT = 200

  function _startHeartbeat() {
    _stopHeartbeat()
    if (!connected.value) return
    const send = () => {
      if (firmwareExclusive.value || !connected.value || !transport) return
      // 走发送队列而不是直接 _writeRaw：与其它 TX 共用一条串行通道，
      // 顺序可预期，也遵守 TX_DELAY_MS 的节拍，不会把心跳和 FTP 分片挤在同一片时间片里
      if (txQueue.length >= HEARTBEAT_QUEUE_LIMIT) return
      try {
        enqueue(link.encodeHeartbeat())
      } catch (e) {
        error.value = `心跳编码失败：${e?.message || e}`
      }
    }
    send()
    heartbeatTimer = setInterval(send, 1000)
  }
  function _stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (deviceTicker) {
      clearInterval(deviceTicker)
      deviceTicker = null
    }
  }

  function _startDeviceTicker() {
    if (deviceTicker) clearInterval(deviceTicker)
    deviceTicker = setInterval(() => {
      if (!deviceState.heartbeat.lastAt) return
      deviceState.heartbeat.ageMs = Date.now() - deviceState.heartbeat.lastAt
      deviceState.heartbeat.healthy = deviceState.heartbeat.ageMs <= 3000
      if (deviceState.phase === 'online' && !deviceState.heartbeat.healthy) deviceState.phase = 'stale'
      if (deviceState.phase === 'stale' && deviceState.heartbeat.healthy) deviceState.phase = 'online'
    }, 1000)
  }

  /* ========== 工具 ========== */

  /** 触发浏览器下载 Blob（供 ftp.download 使用） */
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /** 销毁（通常不需要） */
  function destroy() {
    disconnect()
    listeners.clear()
    _instance = null
  }

  return {
    // 状态（只读）
    connected: readonly(connected),
    connecting: readonly(connecting),
    reconnecting: readonly(reconnecting),
    firmwareExclusive: readonly(firmwareExclusive),
    reconnectStatus: readonly(reconnectStatus),
    error: readonly(error),
    baudRate: readonly(baudRate),
    vehicle: readonly(vehicle),
    data: readonly(data),

    // 链路统计：解析帧数 / CRC 错误数 / 自愈学到的 crc_extra 数（协议健康度看这里）
    stats: readonly(linkStats),
    deviceState: readonly(deviceState),
    /**
     * 姿态来源：优先 ATTITUDE_QUATERNION(31)，没有才降级到 ATTITUDE(30)。
     * 页面用它如实标注读数来自哪条消息，避免"换了固件之后姿态其实一直是 0"没人发现。
     */
    attitudeSource: computed(() => ({
      authority: _attSource.authority,
      lastMsgId: _attSource.lastMsgId,
      lastAt: _attSource.lastAt,
      ageMs: _attSource.lastAt ? Date.now() - _attSource.lastAt : null,
      stale:
        _attSource.authority !== 'none' &&
        (!_attSource.lastAt || Date.now() - _attSource.lastAt > ATTITUDE_AUTHORITY_STALE_MS),
      label:
        _attSource.authority === 'quaternion'
          ? 'ATTITUDE_QUATERNION(31)'
          : _attSource.authority === 'euler'
            ? 'ATTITUDE(30) 降级'
            : '未收到姿态',
    })),
    canOperate: computed(
      () =>
        !firmwareExclusive.value &&
        !reconnecting.value &&
        deviceState.phase === 'online' &&
        deviceState.heartbeat.healthy
    ),
    canWrite: computed(
      () =>
        !firmwareExclusive.value &&
        !reconnecting.value &&
        deviceState.phase === 'online' &&
        deviceState.heartbeat.healthy &&
        !vehicle.armed
    ),
    // 链路体检（S0a）：按 msgid 的累计收发快照，解析器自己维护，页面每次现取，不留副本
    msgCensus: () => {
      const by = parser && parser.stats ? parser.stats.byMsgid : null
      if (!by) return []
      return Object.entries(by).map(([id, v]) => ({
        msgid: Number(id),
        name: (v && v.name) || 'MSG_' + id,
        rx: (v && v.rx) || 0,
        bad: (v && v.bad) || 0,
      }))
    },

    // 注入一条已解析的消息：供自测与调试台使用，正常链路不要直接调用
    handleMessage: _handleMessage,

    // 连接 API
    connect,
    disconnect,
    rebootAndReconnect,
    reconnectLast,
    acquireFirmwareExclusive,
    hasPreviousPort: computed(() => deviceState.sessionId > 0 && !!lastAuthorizedPort),

    // 事件 API
    on,
    off,

    // 发送任意消息
    sendMessage,

    // 子模块
    cli,
    session,
    ftp,
    param,

    // 自测/调试台钩子：把出站帧接到替身而不写串口，生产代码不要用
    setTxTap,

    // 工具
    saveBlob,
    destroy,
  }
}
