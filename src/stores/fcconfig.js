// src/stores/fcconfig.js
// ================================================================
// 飞控配置文件的全站单一来源（docs/DEVELOPMENT_PLAN.zh-CN.md §三 S1；写通道唯一路径见 §〇 D-2）
// ----------------------------------------------------------------
// 为什么需要这个 store：
//   连上飞控的那一刻就把 /sys/sysconfig.toml 与 /sys/param.xml 拉下来解析好，
//   遥控 / 端口 / PID / 传感器四页读的是**同一份内存文档**。任何一页都不许自己再下一遍：
//   两处各改各的，最后保存的人会把别人的改动静默覆盖掉。右下角保存统一走 saveAll。
//   参数走分组 shell 写 RAM → param save → FTP 回读落盘值；只有 sysconfig 走上传。
//
// 三条物理事实决定了这里的接口形状（出处见文档 §一 1.2 与 §三 S1）：
//   1. sysconfig.toml 只在飞控开机时被 board.c 读一次 ⇒ 上传成功 ≠ 生效，界面上必须提示重启；
//   2. 飞控上执行 `param save` 会用 RAM 里的值整体重写 param.xml ⇒ 上传后不许把本地缓存当飞控现值；
//   3. 只有整文件回读校验过的上传才可以说「已写入飞控」（ftp.upload 默认 verify:'crc' 会回读比对）。
//
// 所以这里没有任何乐观假设：状态只由 pull()/uploadAll() 的真实结果驱动，
// 失败原因原样带给界面；没下载成功就禁止编辑（宁可报"拿不到"，也不给一个空文档让人乱改）。
// ================================================================
import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'

import { useMavlink } from '../composables/useMavlink.js'
import { crc32, crc32Hex } from '../utils/crc32.js'
import { REMOTE_FILES, parseParamXmlDoc, parseTomlDoc } from '../utils/config-doc.js'
// 回传闸门（S1）：为什么"有改动"不等于"可以写回去"，判据与理由都写在模块顶部
import { gateUploadFile, planUpload } from '../utils/upload-gate.js'
import { uploadEvidence } from '../utils/save-evidence.js'
import { planParameterChanges, saveParameters } from '../utils/parameter-save.js'

/** 两个远端文件的元信息：顺序就是上传顺序（先参数后配置，参数改错了重启也不影响端口） */
const FILES = [
  { key: 'param', label: 'param.xml', remote: REMOTE_FILES.param, kind: 'xml' },
  { key: 'sysconfig', label: 'sysconfig.toml', remote: REMOTE_FILES.sysconfig, kind: 'toml' },
]

const BOM = [0xef, 0xbb, 0xbf]
const encoder = new TextEncoder()

function parseDoc(kind, text) {
  return kind === 'toml' ? parseTomlDoc(text) : parseParamXmlDoc(text)
}

function emptyFileState(f) {
  return {
    key: f.key,
    label: f.label,
    remote: f.remote,
    kind: f.kind,
    present: false, // 飞控上到底有没有这个文件（下载被拒绝就是没有，不猜）
    loaded: false, // 内存里有没有可编辑的文档
    loading: false,
    hasBom: false, // 原文带 UTF-8 BOM 的话，回传要原样带上，不能悄悄改编码
    size: 0,
    crc32Hex: '', // 下载那一刻的文件指纹，用来解释「我们看到的和飞控上的是不是同一份」
    dirty: false,
    changes: [], // config-doc 的定点变更清单，保存对话框直接列它
    error: '',
  }
}

function initialState() {
  return Object.fromEntries(FILES.map((f) => [f.key, emptyFileState(f)]))
}

export const useFcConfigStore = defineStore('fcconfig', () => {
  /**
   * 解析出来的文档本体。故意用 shallowRef + markRaw：
   * config-doc 内部是 Map 和方法，做成深层响应式既没必要（Map 的变化追不到）
   * 也会把每行文本都包一层代理。脏标志与变更清单靠 revision 手动触发重算。
   */
  const docs = shallowRef({ sysconfig: null, param: null })
  const files = ref(initialState())
  const revision = ref(0) // 每次定点修改 +1，驱动 dirty/changes 这些派生值
  const restoreRevision = ref(0) // 仅还原时变化，用于清除页面尚未提交的输入草稿
  const busy = ref('') // '' | 'pulling' | 'uploading'
  const status = ref('idle') // idle | pulling | ready | partial | error | uploading
  const lastPullAt = ref(0)
  const lastPullError = ref('')
  const lastUploadNote = ref('')

  let saveGeneration = 0 // 断开/重置使所有在途保存证据失效
  let link = null
  let detachHandlers = null
  let armed = false // 每次连接只自动拉取一遍，心跳 1Hz 重复触发要挡住

  /* ---------- 链路 ---------- */

  function resolveLink(maybe) {
    const l = maybe || link
    if (l) {
      link = l
      return l
    }
    // 浏览器里页面忘了 attach 就退回单例；自测一律显式传替身，绝不碰真串口
    link = useMavlink()
    return link
  }

  function isOnline(l) {
    return l?.connected?.value === true
  }

  /* ---------- 拉取 ---------- */

  async function pullOne(l, f) {
    const st = files.value[f.key]
    st.loading = true
    st.error = ''
    try {
      const blob = await l.ftp.download(f.remote)
      const buf = new Uint8Array(await blob.arrayBuffer())
      let body = buf
      let hasBom = false
      if (buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2]) {
        hasBom = true
        body = buf.subarray(3)
      }

      // fatal:true：解码失败就说明它不是 UTF-8 文本，这时候改一个字都可能改坏整份文件
      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body)
      } catch {
        throw new Error(`${f.remote} 不是 UTF-8 文本，地面站不敢编辑也不敢回传，请先确认文件编码`)
      }

      const doc = parseDoc(f.kind, text)
      docs.value = Object.assign(Object.create(null), docs.value, { [f.key]: markRaw(doc) })

      st.present = true
      st.loaded = true
      st.hasBom = hasBom
      st.size = buf.length
      st.crc32Hex = crc32Hex(crc32(buf))
      return { ok: true, size: buf.length, crc32Hex: st.crc32Hex }
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e)
      // 丢掉上一台飞控的文档，绝不允许"下载失败了界面上还能改"
      docs.value = Object.assign(Object.create(null), docs.value, { [f.key]: null })
      st.present = false
      st.loaded = false
      st.size = 0
      st.crc32Hex = ''
      st.hasBom = false
      st.error = /不存在|not found|no such|ENOENT|ErrCode\s*\(?\s*2\b|2\s*\(no such/i.test(msg)
          ? `飞控上没有 ${f.remote}`
          : msg
      return { ok: false, error: st.error }
    } finally {
      st.loading = false
      st.dirty = false
      st.changes = []
    }
  }

  /**
   * 连接后一次性拉取两个配置文件。串行，不并发——串口只有一条，FTP 会话也不许重叠。
   * @param {{link?: object}} [opts] link 仅自测注入替身；正常由 attach() 提供
   */
  async function pullAll(opts = {}) {
    const l = resolveLink(opts.link)
    if (!isOnline(l)) {
      const err = '飞控未连接，配置文件没法拉取'
      lastPullError.value = err
      status.value = 'error'
      return { ok: false, reason: 'not-connected', error: err }
    }
    if (busy.value) {
      return { ok: false, reason: 'busy', error: '正在忙，请稍后再试' }
    }

    busy.value = 'pulling'
    status.value = 'pulling'
    lastPullError.value = ''
    try {
      const results = {}
      let okCount = 0
      for (const f of FILES) {
        results[f.key] = await pullOne(l, f)
        if (results[f.key].ok) okCount++
      }
      const errors = FILES.map((f) => results[f.key]).filter((r) => !r.ok).map((r) => r.error)
      lastPullError.value = errors.join('；')
      status.value = okCount === FILES.length ? 'ready' : okCount ? 'partial' : 'error'
      lastPullAt.value = Date.now()
      return { ok: okCount === FILES.length, okCount, total: FILES.length, results, error: lastPullError.value }
    } finally {
      busy.value = ''
    }
  }

  /* ---------- 编辑（页面只能走这几个方法，不许直接碰 docs） ---------- */

  let editSource = '其他配置'

  function setEditSource(source) {
    editSource = typeof source === 'string' && source.trim() ? source.trim() : '其他配置'
  }

  function requireIdle() {
    if (busy.value) throw new Error('正在读取或保存飞控配置，不能修改或放弃改动，请稍后再试')
  }

  function requireDoc(key, editing = false) {
    if (editing) requireIdle()
    const doc = docs.value[key]
    if (!doc) {
      throw new Error(`${files.value[key]?.label || key} 还没从飞控下载成功，不能编辑`)
    }
    return doc
  }

  const reviewMetadata = new WeakMap()
  let nextChangeId = 1

  function afterEdit(key) {
    revision.value++
    const doc = docs.value[key]
    const st = files.value[key]
    const changes = doc ? doc.changes() : []
    const metadata = doc ? (reviewMetadata.get(doc) || []) : []
    while (metadata.length < changes.length) metadata.push({ changeId: nextChangeId++, source: editSource })
    metadata.length = changes.length
    if (doc) reviewMetadata.set(doc, metadata)
    st.dirty = !!doc && doc.dirty()
    st.changes = changes.map((c, i) => ({ ...c, ...metadata[i] }))
    return st.changes.length
  }

  function setToml(path, key, value) {
    const doc = requireDoc('sysconfig', true)
    doc.set(path, key, value)
    return afterEdit('sysconfig')
  }

  function setTomlTableField(path, index, key, value) {
    const doc = requireDoc('sysconfig', true)
    doc.setTableField(path, index, key, value)
    return afterEdit('sysconfig')
  }

  function appendTomlTable(path, fields, comment) {
    const doc = requireDoc('sysconfig', true)
    doc.appendTable(path, fields, comment)
    return afterEdit('sysconfig')
  }

  function removeTomlTable(path, index) {
    const doc = requireDoc('sysconfig', true)
    doc.removeTable(path, index)
    return afterEdit('sysconfig')
  }

  function setParam(group, name, value, opts) {
    const doc = requireDoc('param', true)
    doc.set(group, name, value, opts)
    return afterEdit('param')
  }

  function addParam(group, name, value, opts) {
    const doc = requireDoc('param', true)
    doc.add(group, name, value, opts)
    return afterEdit('param')
  }

  /** 读值：文档没下载下来就返回 undefined，界面据此显示「未配置」而不是 0 */
  function tomlValue(path, key) {
    const doc = docs.value.sysconfig
    return doc && doc.has(path) ? doc.getValue(path, key) : undefined
  }

  function tomlTables(path) {
    const doc = docs.value.sysconfig
    return doc && doc.has(path) ? doc.tablesOf(path) : []
  }

  function paramValue(group, name) {
    const doc = docs.value.param
    if (!doc) return undefined
    const e = doc.get(group, name)
    return e ? e.value : undefined
  }

  /* ---------- 保存（上传） ---------- */

  function serialize(key) {
    const doc = requireDoc(key)
    const bytes = encoder.encode(doc.text())
    if (!files.value[key].hasBom) return bytes
    const out = new Uint8Array(bytes.length + 3)
    out.set(BOM, 0)
    out.set(bytes, 3)
    return out
  }

  /** 现在准备写回去的字节数（BOM 原样算在内）。没有文档就回 0，让闸门去拦，不在这里抛。 */
  function byteLengthOf(key) {
    if (!docs.value[key]) return 0
    try {
      return serialize(key).length
    } catch {
      return 0
    }
  }

  /** 把"下载那一刻记下的事实"和"现在要写的文本"凑成闸门判据；present/loaded/size 只能来自下载。 */
  function gateFiles(keep = (f) => files.value[f.key].dirty) {
    return FILES.filter(keep).map((f) => {
      const st = files.value[f.key]
      return {
        key: f.key,
        label: f.label,
        remote: f.remote,
        loaded: st.loaded,
        present: st.present,
        error: st.error,
        size: st.size,
        bytes: byteLengthOf(f.key),
        changeCount: (st.changes || []).length,
      }
    })
  }

  /**
   * 单个文件的回传预检，给不走本 store 编辑通路的页面用（/parameter 是整本重新序列化）。
   * 长度基线一律取那次逐字节核对过长度的下载：任何通路产出的文本，都得先证明自己来自完整原文。
   * @param {string} key 'param' | 'sysconfig'
   * @param {number} bytes 准备写回去的字节数
   * @param {number} changeCount 拿得出的改动条数（0 且长度变了 ⇒ 来源不明，拦）
   */
  function gateFor(key, bytes, changeCount = 0, opts = {}) {
    const [d] = gateFiles((f) => f.key === key)
    if (!d) {
      return {
        code: 'unknown-file',
        allowed: false,
        reason: `不认识配置文件 ${key}，禁止回传`,
        warn: '',
        key,
        label: key,
        remote: '',
        size: 0,
        bytes,
        changeCount,
        shortfall: 0,
      }
    }
    return gateUploadFile({ ...d, bytes, changeCount, force: opts.force === true })
  }

  /** 右下角保存条用的预检：一个字节都不写，只回答"现在能不能保存、不能是因为哪个文件"。 */
  function previewUpload(opts = {}) {
    const l = resolveLink(opts.link)
    return planUpload({
      connected: isOnline(l),
      busy: busy.value,
      force: opts.force === true,
      files: gateFiles(),
    })
  }

  /**
   * @deprecated 仅保留旧测试/API 兼容；应用主保存必须使用 saveAll，禁止参数文件上传。
   * 只上传真的有改动、**且通过回传闸门**的文件；每个文件都由 ftp.upload 整文件回读比 CRC32，
   * 校验不过它会抛错，这里就把错原样带出去——不许出现无证据的「保存成功」。
   * @param {{link?: object, force?: boolean, onProgress?: (p:{key:string,progress:number})=>void}} [opts]
   */
  async function uploadAll(opts = {}) {
    const l = resolveLink(opts.link)
    /* S1 回传闸门：先判"这些待保存的文本是不是从飞控完整下载的原文改出来的"。
       被拦下的文件保持脏着、理由原样交给界面——把一份不确定完整的文本覆盖到 /sys/，
       飞控下次开机读到的就是残缺配置，比一次保存失败严重得多，所以这里宁可一个都不写。 */
    const plan = planUpload({
      connected: isOnline(l),
      busy: busy.value,
      force: opts.force === true,
      files: gateFiles(),
    })
    const blocked = plan.blocked
    if (!plan.ready) {
      return {
        ok: false,
        reason: plan.code || 'nothing-to-save',
        error: plan.error,
        results: {},
        blocked,
        warns: [],
        notes: [],
      }
    }
    // 只写闸门放行的那些；被拦的那份留脏，等用户核对改动明细或重新读取
    const targets = FILES.filter((f) => plan.allowed.some((a) => a.remote === f.remote))

    busy.value = 'uploading'
    status.value = 'uploading'
    lastUploadNote.value = ''
    const results = {}
    try {
      for (const f of targets) {
        const st = files.value[f.key]
        try {
          const bytes = serialize(f.key)
          opts.onStage?.({ key: f.key, stage: 'uploading' })
          const r = await l.ftp.upload(bytes, f.remote, {
            verify: 'crc',
            onProgress: (p) => {
              opts.onProgress?.({ key: f.key, progress: p })
              if (p >= 1) opts.onStage?.({ key: f.key, stage: 'verifying' })
            },
          })
          if (!uploadEvidence(r)) throw new Error('未取得完整回读 CRC32 一致的证据，保留本地改动，请重试或核对飞控文件')
          opts.onStage?.({ key: f.key, stage: 'verified' })
          // 回读 CRC32 已经一致，才把本地基线换成新内容（否则脏标记消失是在骗人）
          docs.value = Object.assign(Object.create(null), docs.value, {
            [f.key]: markRaw(parseDoc(f.kind, requireDoc(f.key).text())),
          })
          st.size = r.size
          st.crc32Hex = r.crc32Hex
          st.error = ''
          results[f.key] = {
            ok: true,
            verified: true,
            remote: r.remotePath || f.remote,
            size: r.size,
            localCrc32: r.crc32Hex,
            remoteCrc32: r.remoteCrc32Hex || '',
            verifyMode: r.verifyMode,
          }
        } catch (e) {
          // 上传失败：飞控上多半是半截文件，本地基线与脏改动都保持原样，让用户重试或放弃
          st.error = e?.message ? String(e.message) : String(e)
          results[f.key] = { ok: false, error: st.error }
        }
        afterEdit(f.key)
      }
    } finally {
      busy.value = ''
    }

    const allOk = !blocked.length && targets.every((f) => results[f.key]?.ok)
    const notes = []
    if (results.sysconfig?.ok) notes.push('sysconfig.toml 已写入飞控文件，但固件只在开机时读它——重启飞控后才生效')
    if (results.param?.ok) notes.push('param.xml 已写入飞控文件；若之后在飞控上执行 param save，会用内存里的值覆盖这份文件')
    // 闸门放行但有警告的（缩短 2%~10%），也把数字留在结果里，别让它悄悄过去
    notes.push(...plan.warns.map((w) => w.warn))
    lastUploadNote.value = notes.join('；')
    status.value = allOk ? 'ready' : 'error'
    const errs = [
      ...targets.map((f) => results[f.key]?.error).filter(Boolean),
      ...blocked.map((b) => b.reason),
    ]
    return { ok: allOk, results, blocked, warns: plan.warns.map((w) => w.warn), notes, error: errs.join('；') }
  }

  /** 新保存通路：参数只走分组 shell + 固件落盘，配置仍走整文件 CRC。 */
  function previewSave(opts = {}) {
    const l = resolveLink(opts.link)
    const base = { ok: false, ready: false, code: '', error: '', allowed: [], blocked: [], warns: [], byKey: {} }
    if (!isOnline(l)) return { ...base, code: 'not-connected', error: '飞控未连接，不能保存' }
    if (busy.value) return { ...base, code: 'busy', error: '正在忙，请等当前保存结束' }
    if (l.canWrite?.value !== true) return { ...base, code: 'not-writable', error: '当前连接不允许写入，请确认心跳正常且飞控未解锁' }
    const rows = []
    if (files.value.param.dirty) {
      const row = { key: 'param', label: 'param.xml', remote: REMOTE_FILES.param, method: 'param-save', allowed: false, code: 'parameter-save-blocked', reason: '', warn: '', changeCount: 0 }
      try {
        if (!files.value.param.loaded || !files.value.param.present) throw new Error('参数尚未完整下载')
        if (typeof l.session?.withTransaction !== 'function') throw new Error('控制台缺少独占事务能力，禁止参数保存')
        const targets = planParameterChanges(docs.value.param)
        if (!targets.length) throw new Error('参数没有数值净改动，仅格式差异不执行 param save；请还原本地格式改动')
        row.targets = targets
        row.changeCount = targets.length
        row.allowed = true
        row.code = 'ok'
      } catch (e) { row.reason = e.message }
      rows.push(row)
    }
    if (files.value.sysconfig.dirty) rows.push(gateFor('sysconfig', byteLengthOf('sysconfig'), files.value.sysconfig.changes.length, opts))
    if (!rows.length) return { ...base, code: 'nothing-to-save', error: '没有待保存的改动' }
    const blocked = rows.filter(r => !r.allowed), allowed = rows.filter(r => r.allowed)
    return { byKey: Object.fromEntries(rows.map(r => [r.key, r])), allowed, blocked, warns: allowed.filter(r => r.warn), ok: !blocked.length, ready: !blocked.length && !!allowed.length, code: blocked[0]?.code || 'ok', error: blocked.map(r => r.reason).join('；') }
  }

  async function saveAll(opts = {}) {
    const l = resolveLink(opts.link)
    const plan = previewSave({ ...opts, link: l })
    if (!plan.ready) return { ok: false, needsReboot: false, reason: plan.code, error: plan.error, results: {}, blocked: plan.blocked, warns: [], notes: [] }
    const session = l.session
    const sessionId = l.deviceState?.sessionId
    const generation = saveGeneration
    const results = {}, notes = []
    const assertCurrent = () => {
      if (!isOnline(l) || l.canWrite?.value !== true || l.session !== session || l.deviceState?.sessionId !== sessionId || saveGeneration !== generation) throw new Error('连接或写入权限已变化，保存中止；保留本地改动')
    }
    busy.value = 'uploading'
    status.value = 'uploading'
    lastUploadNote.value = ''
    let activeKey = plan.byKey.param ? 'param' : 'sysconfig'
    try {
      const sequence = async tx => {
        assertCurrent()
        if (plan.byKey.param) {
          activeKey = 'param'
          const saved = await saveParameters({ tx, ftp: l.ftp, targets: plan.byKey.param.targets, assertCurrent, onStage: opts.onStage, timeoutMs: opts.timeoutMs })
          assertCurrent()
          // 只能用实际落盘回读作为新基线，不能把本地序列化当成固件文件。
          docs.value = Object.assign(Object.create(null), docs.value, { param: markRaw(saved.doc) })
          const st = files.value.param
          st.size = saved.bytes.length
          st.hasBom = saved.bytes[0] === BOM[0] && saved.bytes[1] === BOM[1] && saved.bytes[2] === BOM[2]
          st.crc32Hex = crc32Hex(crc32(saved.bytes))
          st.error = ''
          results.param = saved.result
          afterEdit('param')
          opts.onStage?.({ key: 'param', stage: 'verified' })
          notes.push('参数 RAM 回读和 /sys/param.xml 落盘值已确认；各模块运行生效时机由固件决定')
        }
        if (plan.byKey.sysconfig) {
          activeKey = 'sysconfig'
          assertCurrent()
          const bytes = serialize('sysconfig')
          opts.onStage?.({ key: 'sysconfig', stage: 'uploading' })
          const r = await l.ftp.upload(bytes, REMOTE_FILES.sysconfig, { verify: 'crc', onProgress: p => {
            opts.onProgress?.({ key: 'sysconfig', progress: p })
            if (p >= 1) opts.onStage?.({ key: 'sysconfig', stage: 'verifying' })
          } })
          assertCurrent()
          if (!uploadEvidence(r)) throw new Error('未取得 sysconfig 完整回读 CRC32 一致的证据，保留本地改动')
          docs.value = Object.assign(Object.create(null), docs.value, { sysconfig: markRaw(parseTomlDoc(requireDoc('sysconfig').text())) })
          files.value.sysconfig.size = r.size
          files.value.sysconfig.crc32Hex = r.crc32Hex
          files.value.sysconfig.error = ''
          results.sysconfig = { ok: true, verified: true, remote: REMOTE_FILES.sysconfig, size: r.size, localCrc32: r.crc32Hex, remoteCrc32: r.remoteCrc32Hex, verifyMode: r.verifyMode }
          afterEdit('sysconfig')
          opts.onStage?.({ key: 'sysconfig', stage: 'verified' })
          notes.push('sysconfig.toml 已校验写入，需重启飞控后生效')
        }
      }
      if (plan.byKey.param) await session.withTransaction(sequence)
      else await sequence(null)
      assertCurrent()
    } catch (e) {
      const error = String(e?.message || e)
      results[activeKey] = { ok: false, error, runtimeChanged: !!e.runtimeChanged }
      if (saveGeneration === generation) files.value[activeKey].error = error
      if (e.runtimeChanged) notes.push('参数 RAM 可能已经部分改变，持久化未确认；本地改动全部保留，不自动回滚')
    } finally {
      busy.value = ''
    }
    const ok = plan.allowed.every(row => results[row.key]?.ok) && !hasChanges.value
    const needsReboot = ok && results.sysconfig?.ok === true
    const error = Object.values(results).filter(r => !r.ok).map(r => r.error).join('；')
    lastUploadNote.value = notes.join('；')
    status.value = ok ? 'ready' : 'error'
    return { ok, needsReboot, results, blocked: plan.blocked, warns: plan.warns.map(r => r.warn), notes, error }
  }

  /** 逐项还原当前审阅行；changeId 可拒绝索引重排后的过期行。 */
  function revertChange(row) {
    requireIdle()
    const f = FILES.find((f) => f.label === row?.file || f.key === row?.file)
    if (!f) throw new Error('不认识此变更所属的配置文件，请刷新审阅列表')
    const doc = requireDoc(f.key)
    const index = row?.changeIndex
    const current = files.value[f.key].changes[index]
    if (!Number.isInteger(index) || !current ||
        (row.changeId !== undefined && row.changeId !== current.changeId) ||
        ['op', 'where', 'from', 'to'].some((key) => row[key] !== undefined && row[key] !== current[key])) {
      throw new Error('此审阅行已失效，请刷新审阅列表后重试')
    }
    doc.revertChange(index)
    restoreRevision.value++
    reviewMetadata.get(doc)?.splice(index, 1)
    return afterEdit(f.key)
  }

  /** 放弃本地改动，回到下载时的原文（保存对话框里的「放弃」按钮） */
  function discardAll() {
    requireIdle()
    restoreRevision.value++
    for (const f of FILES) {
      const doc = docs.value[f.key]
      if (doc) doc.reset()
      afterEdit(f.key)
    }
    lastUploadNote.value = ''
  }

  function reset() {
    saveGeneration++
    docs.value = Object.assign(Object.create(null), { sysconfig: null, param: null })
    files.value = initialState()
    revision.value++
    status.value = 'idle'
    lastPullAt.value = 0
    lastPullError.value = ''
    lastUploadNote.value = ''
  }

  /* ---------- 派生值 ---------- */

  const hasChanges = computed(() => {
    revision.value // 依赖计数器重算：文档本身不是响应式的
    return FILES.some((f) => files.value[f.key].dirty)
  })

  const changeList = computed(() => {
    revision.value
    return FILES.flatMap((f) => files.value[f.key].changes.map((c, changeIndex) => ({ ...c, file: f.label, changeIndex, source: c.source || '其他配置' })))
  })

  const loaded = computed(() => FILES.every((f) => files.value[f.key].loaded))
  const busyLabel = computed(() => (busy.value === 'pulling' ? '正在读取飞控配置' : busy.value === 'uploading' ? '正在保存' : ''))

  /* ---------- 连接即拉取 ---------- */

  /**
   * 在 App.vue 里调用一次：监听首次 HEARTBEAT 自动拉取，断开时清空（不残留上一台飞控的配置）。
   * @param {ReturnType<typeof useMavlink>} mav
   * @param {{auto?: boolean, delayMs?: number, timer?: (fn:Function, ms:number)=>number}} [opts]
   */
  function attach(mav, opts = {}) {
    if (!mav) return
    resolveLink(mav)
    if (detachHandlers) return // 幂等：热重载或多次挂载不重复注册
    if (typeof mav.on !== 'function') return

    const onHeartbeat = () => {
      if (!mav.connected?.value || mav.reconnecting?.value) return
      if (opts.auto === false || armed) return
      armed = true // 端口刚开时飞控未必已经能服务 FTP，晚一点再拉，且每次连接只做一次
      const later = opts.timer || ((fn, ms) => setTimeout(fn, ms))
      later(() => {
        if (mav.connected?.value) pullAll().catch(() => {})
      }, opts.delayMs ?? 600)
    }

    mav.on('HEARTBEAT', onHeartbeat)
    const stop = watch(
        () => mav.connected?.value,
        (v) => {
          if (!v) {
            armed = false
            reset()
          }
        },
    )
    detachHandlers = () => {
      mav.off?.('HEARTBEAT', onHeartbeat)
      stop()
    }
  }

  async function reloadAfterReconnect() {
    armed = true
    return pullAll()
  }

  function detach() {
    detachHandlers?.()
    detachHandlers = null
    armed = false
  }

  return {
    // 状态
    files,
    status,
    busy,
    busyLabel,
    revision,
    restoreRevision,
    lastPullAt,
    lastPullError,
    lastUploadNote,
    // 派生
    hasChanges,
    changeList,
    loaded,
    // 动作
    attach,
    detach,
    pullAll,
    reloadAfterReconnect,
    saveAll,
    previewSave,
    uploadAll,
    previewUpload,
    gateFor,
    discardAll,
    revertChange,
    setEditSource,
    reset,
    // 编辑口
    setToml,
    setTomlTableField,
    appendTomlTable,
    removeTomlTable,
    setParam,
    addParam,
    // 读值口
    tomlValue,
    tomlTables,
    paramValue,
    doc: (key) => docs.value[key] || null,
  }
})
