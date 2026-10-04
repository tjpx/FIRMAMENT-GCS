// P0 起飞前检查规则：纯函数，输入事实快照，输出可解释的检查结果。
// 规则不猜测未上报数据；unknown 必须由界面显示为“未验证”。

export const CHECK_LEVEL = Object.freeze({ BLOCK: 'block', WARN: 'warn', INFO: 'info' })

function result(key, label, level, status, detail, action, route = '') {
  return { key, label, level, status, detail, action, route }
}

export function evaluatePreflight(snapshot = {}) {
  const online = snapshot.phase === 'online' && snapshot.heartbeatHealthy === true
  const identity = snapshot.identityDetected === true
  const configLoaded = snapshot.configLoaded === true
  const configClean = snapshot.configDirty === false
  const sensorsReported = snapshot.sensorsReported === true
  const sensorsHealthy = snapshot.sensorsHealthy === true
  const sensorsAgeOk = snapshot.sensorsAgeMs == null || snapshot.sensorsAgeMs <= 3000
  const receiverReported = snapshot.receiverReported === true
  const receiverHealthy = snapshot.receiverHealthy === true && (snapshot.receiverAgeMs == null || snapshot.receiverAgeMs <= 1500)
  const batteryReported = snapshot.batteryReported === true
  const batteryHealthy = snapshot.batteryHealthy === true && (snapshot.batteryAgeMs == null || snapshot.batteryAgeMs <= 3000)
  const armed = snapshot.armed === true
  const modelRecognized = snapshot.modelRecognized === true
  const configurationConfirmed = snapshot.configurationConfirmed === true

  const checks = [
    snapshot.portConfirmed === true
      ? result('ports', '端口与外设', CHECK_LEVEL.BLOCK, 'pass', '端口配置已读取并确认', '继续检查')
      : result('ports', '端口与外设', CHECK_LEVEL.BLOCK, 'unknown', '尚未完成端口与外设能力确认', '打开端口页确认', '/port'),
    online
      ? result('link', '飞控链路', CHECK_LEVEL.BLOCK, 'pass', '已连接且 HEARTBEAT 在有效时间内', '继续检查')
      : result('link', '飞控链路', CHECK_LEVEL.BLOCK, 'block', '没有有效 HEARTBEAT，不能确认飞控在线', '连接飞控并等待 HEARTBEAT'),
    identity && modelRecognized
      ? result('identity', '设备与机型识别', CHECK_LEVEL.BLOCK, 'pass', `已识别 SYS ${snapshot.sysid} / COMP ${snapshot.compid}`, '继续检查')
      : identity
        ? result('identity', '设备与机型识别', CHECK_LEVEL.BLOCK, 'unknown', '设备身份已收到，但机型/固件识别证据不足', '返回设备工作台')
        : result('identity', '设备与机型识别', CHECK_LEVEL.BLOCK, 'unknown', '没有收到 HEARTBEAT 身份证据', '返回设备工作台'),
    configLoaded && configClean && configurationConfirmed
      ? result('config', '配置快照', CHECK_LEVEL.BLOCK, 'pass', '两份配置已读取且没有未保存修改', '继续检查')
      : configLoaded && configClean
        ? result('config', '配置快照', CHECK_LEVEL.BLOCK, 'unknown', '配置已读取，但保存/重启/回读确认状态不足', '打开全局保存条')
      : configLoaded
        ? result('config', '配置快照', CHECK_LEVEL.BLOCK, 'block', '存在未保存修改，必须先通过全局保存条写回并回读', '打开参数页保存', '/parameter')
        : result('config', '配置快照', CHECK_LEVEL.BLOCK, 'unknown', '尚未从飞控完整读取 sysconfig.toml / param.xml', '等待配置读取'),
    sensorsReported && sensorsHealthy && sensorsAgeOk
      ? result('sensors', '传感器健康', CHECK_LEVEL.BLOCK, 'pass', 'SYS_STATUS 报告传感器健康', '继续检查')
      : sensorsReported
        ? result('sensors', '传感器健康', CHECK_LEVEL.BLOCK, 'block', '存在未健康或未启用的传感器', '打开传感器页校准', '/sensor')
        : result('sensors', '传感器健康', CHECK_LEVEL.BLOCK, 'unknown', '尚未收到传感器健康状态', '等待 SYS_STATUS'),
    receiverReported
      ? receiverHealthy
        ? result('receiver', '接收机输入', CHECK_LEVEL.BLOCK, 'pass', 'RC_CHANNELS 持续上报且 RSSI/通道状态可用', '继续检查')
        : result('receiver', '接收机输入', CHECK_LEVEL.BLOCK, 'block', '接收机已上报但输入不健康或已失联', '打开接收机页确认', '/rc')
      : result('receiver', '接收机输入', CHECK_LEVEL.BLOCK, 'unknown', '未收到 RC_CHANNELS；不能确认接收机安全', '打开接收机页确认', '/rc'),
    batteryReported
      ? batteryHealthy
        ? result('battery', '电池遥测', CHECK_LEVEL.WARN, 'pass', '已收到有效电池电压/电流数据', '继续检查')
        : result('battery', '电池遥测', CHECK_LEVEL.WARN, 'unknown', '已收到 SYS_STATUS，但电池数值未达到可判定条件', '打开仪表盘确认', '/dashboard')
      : result('battery', '电池遥测', CHECK_LEVEL.WARN, 'unknown', '未收到有效电池电压/电流数据', '打开仪表盘确认', '/dashboard'),
    !armed
      ? result('armed', '解锁状态', CHECK_LEVEL.BLOCK, 'pass', '飞控当前未解锁', '继续检查')
      : result('armed', '解锁状态', CHECK_LEVEL.BLOCK, 'block', '飞控处于已解锁状态，禁止开始准备流程', '先锁定飞控'),
    snapshot.motorOutputConfirmed === true
      ? result('motor', '电机/输出安全', CHECK_LEVEL.BLOCK, 'pass', '输出回读已收到，动力测试门禁满足', '继续检查')
      : result('motor', '电机/输出安全', CHECK_LEVEL.BLOCK, 'unknown', '未确认输出回读；未验证断链后的固件行为，禁止远程动力测试', '打开电机页确认', '/motor'),
  ]

  const blocks = checks.filter((item) => item.level === CHECK_LEVEL.BLOCK && item.status !== 'pass')
  const warnings = checks.filter((item) => item.level === CHECK_LEVEL.WARN && item.status !== 'pass')
  return {
    checks,
    blocks,
    warnings,
    canTakeoff: blocks.length === 0,
    summary: blocks.length ? `有 ${blocks.length} 项阻断` : warnings.length ? `可继续，但有 ${warnings.length} 项警告` : '检查通过，可进入下一步',
  }
}

export function preflightReport(snapshot, evaluation = evaluatePreflight(snapshot)) {
  return {
    generatedAt: new Date().toISOString(),
    device: { sysid: snapshot.sysid ?? null, compid: snapshot.compid ?? null, phase: snapshot.phase || 'unknown' },
    summary: evaluation.summary,
    canTakeoff: evaluation.canTakeoff,
    checks: evaluation.checks,
  }
}
