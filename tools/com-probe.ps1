# tools/com-probe.ps1
# ================================================================
# 串口直读探针：不经过浏览器，直接看飞控 UART 上到底在发什么。
# 用来回答三类问题（界面上的数字对不对，最终只有这里能定论）：
#   1) 波特率与链路是否活着；
#   2) 飞控在周期推送哪些消息、频率多少（不猜，数出来）；
#   3) 某条消息的原值和界面显示是否一致（例如姿态轴序、符号）。
#
# 实测记录（FMT 数传口接在 COM20，飞控上电、未连接地面站）：
#   57600/38400/921600 都能收到大量 0xFD，但只有 115200 能连续走出合法帧
#   （seq 递增、HEARTBEAT 字段自洽），所以波特率是 115200。
#
# 安全边界：本脚本只做被动接收，不发送任何字节，也不拉 DTR/RTS
# （不少 STM32 板子用 DTR+RTS 组合进 bootloader，拉一下就把飞控复位了）。
#
# 用法（默认 COM20 / 115200 / 采 4 秒）：
#   $Port='COM20'; $Seconds=4; iex (Get-Content -Raw -Encoding UTF8 tools/com-probe.ps1)
# 只想扫波特率时：
#   $Port='COM20'; $Bauds=@(57600,115200,921600); $Seconds=2; iex (Get-Content -Raw -Encoding UTF8 tools/com-probe.ps1)
# ================================================================

$ErrorActionPreference = 'Stop'

if (-not $Port) { $Port = 'COM20' }
if (-not $Bauds) { $Bauds = @(115200) }
if (-not $Seconds) { $Seconds = 4 }

# 常见消息的 msgid，仅用于把日志写成人能读的样子；不认识的一律照实打印编号。
$NAMES = @{
  0   = 'HEARTBEAT';          1   = 'SYS_STATUS';       22  = 'PARAM_VALUE'
  24  = 'GPS_RAW_INT';        30  = 'ATTITUDE';         32  = 'LOCAL_POSITION_NED'
  33  = 'GLOBAL_POSITION_INT';36  = 'SERVO_OUTPUT_RAW'; 65  = 'RC_CHANNELS'
  74  = 'VFR_HUD';            76  = 'COMMAND_LONG';     77  = 'COMMAND_ACK'
  110 = 'FTP_PROTOCOL';       126 = 'SERIAL_CONTROL';   147 = 'BATTERY_STATUS'
  245 = 'EXTENDED_SYS_STATE'; 253 = 'STATUSTEXT'
}

function Get-Float([byte[]]$b, [int]$at) {
  $tmp = New-Object byte[] 4
  [Array]::Copy($b, $at, $tmp, 0, 4)
  return [System.BitConverter]::ToSingle($tmp, 0)
}
function Get-U16([byte[]]$b, [int]$at) { return [int]$b[$at] -bor ([int]$b[$at + 1] -shl 8) }
function Get-U32([byte[]]$b, [int]$at) {
  return [int]$b[$at] -bor ([int]$b[$at + 1] -shl 8) -bor ([int]$b[$at + 2] -shl 16) -bor ([int]$b[$at + 3] -shl 24)
}

foreach ($baud in $Bauds) {
  $sp = $null
  try {
    $sp = New-Object System.IO.Ports.SerialPort
    $sp.PortName = $Port
    $sp.BaudRate = [int]$baud
    $sp.Parity = [System.IO.Ports.Parity]::None
    $sp.DataBits = 8
    $sp.StopBits = [System.IO.Ports.StopBits]::One
    $sp.DtrEnable = $false
    $sp.RtsEnable = $false
    $sp.ReadTimeout = 300
    $sp.Open()
  } catch {
    "[$Port @ $baud] 打开失败：$($_.Exception.Message)"
    '  （若提示 拒绝访问 / 正被使用：浏览器里的地面站还占着这个串口，先在页面上断开）'
    if ($sp) { $sp.Dispose() }
    continue
  }

  $buf = New-Object byte[] 262144
  $total = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    if ($total -ge $buf.Length) { break }
    try { $n = $sp.BaseStream.Read($buf, $total, ($buf.Length - $total)) }
    catch [TimeoutException] { $n = 0 }
    if ($n -gt 0) { $total += $n }
  }
  $sp.Dispose()

  "==== $Port @ $baud，$([math]::Round($sw.Elapsed.TotalSeconds,2)) 秒，共 $total 字节 ===="
  if ($total -lt 12) { '  字节太少，跳过解析'; continue }

  $counts = @{}
  $last = @{}
  $hb = @{}
  $bad = 0
  $i = 0
  while ($i -le $total - 12) {
    if ($buf[$i] -ne 0xFD) { $i++; continue }
    $len = [int]$buf[$i + 1]
    if ($len -lt 1 -or $len -gt 255 -or ($i + 12 + $len) -gt $total) { $bad++; $i++; continue }
    $msgid = [int]$buf[$i + 7] -bor ([int]$buf[$i + 8] -shl 8) -bor ([int]$buf[$i + 9] -shl 16)
    $p = $i + 10                      # 载荷起始：v2 头固定 10 字节
    $key = if ($NAMES.ContainsKey($msgid)) { $NAMES[$msgid] } else { "MSG_$msgid" }
    if (-not $counts.ContainsKey($key)) { $counts[$key] = 0 }
    $counts[$key] = $counts[$key] + 1
    $last[$key] = @{ sysid = [int]$buf[$i + 5]; compid = [int]$buf[$i + 6]; at = $sw.Elapsed.TotalSeconds }

    if ($msgid -eq 30 -and $len -ge 16) {
      # ATTITUDE：time_boot_ms(u32) roll pitch yaw rollspeed pitchspeed yawspeed，角度是弧度
      $hb['att'] = @(
        [math]::Round((Get-Float $buf ($p + 4)) * 180 / [math]::PI, 2),
        [math]::Round((Get-Float $buf ($p + 8)) * 180 / [math]::PI, 2),
        [math]::Round((Get-Float $buf ($p + 12)) * 180 / [math]::PI, 2))
    }
    if ($msgid -eq 0 -and $len -ge 9) {
      $hb['custom'] = Get-U32 $buf $p
      $hb['type'] = [int]$buf[$p + 4]; $hb['autopilot'] = [int]$buf[$p + 5]
      $hb['base'] = [int]$buf[$p + 6]; $hb['status'] = [int]$buf[$p + 7]
    }
    $i += 12 + $len                   # 整帧 = 10 字节 v2 头 + 载荷 + 2 字节 CRC
  }

  $dur = $sw.Elapsed.TotalSeconds
  '  消息种类（次数 / 约多少 Hz）：'
  $counts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    '    {0,-22} {1,4} 次  {2,6} Hz' -f $_.Key, $_.Value, [math]::Round($_.Value / $dur, 1)
  }
  if ($bad) { "  走帧时对不上的 0xFD 位置：$bad 处（未校验 CRC，仅供粗看）" }
  if ($hb.ContainsKey('custom')) {
    '  HEARTBEAT：custom_mode={0} type={1} autopilot={2} base_mode={3} status={4}' -f `
      $hb['custom'], $hb['type'], $hb['autopilot'], $hb['base'], $hb['status']
  }
  if ($hb.ContainsKey('att')) {
    '  ATTITUDE 最后一条（度）：roll={0} pitch={1} yaw={2}' -f $hb['att'][0], $hb['att'][1], $hb['att'][2]
    '    把飞控绕某个轴 tilt 一下再跑本脚本：只有被抬起的那个轴变化，才说明飞控的轴定义和界面标注一致。'
  }
  foreach ($k in $last.Keys) {
    "  {0,-22} sysid={1} compid={2}" -f $k, $last[$k].sysid, $last[$k].compid
  }
}
