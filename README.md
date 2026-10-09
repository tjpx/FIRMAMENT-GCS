# FIRMAMENT GCS（FGC）

面向 **FMT 飞控**（fmtautopilot）的 Web 地面站

## 能做什么

- **实时遥测仪表盘**：姿态、高度、速度、GPS、系统状态（Chart.js + three.js 仪表）
- **CLI 控制台**：经 MAVLink `SERIAL_CONTROL` 直进飞控命令行（xterm.js）
- **文件传输**：MAVFTP 上传 / 下载飞控文件，上传后整文件回读比 CRC32 才算成功
- **配置编辑**：连接时一次性拉取 `/sys/sysconfig.toml` 与 `/sys/param.xml`，
  在端口 / PID / 遥控等页就地编辑，右下角一次性保存回飞控
- **链路体检**：`/diag` 页六个只读探针一次跑完并导出 JSON，把「只能真机回答的问题」变成数据

## 环境要求（先看这条，省一下午）

| 项 | 要求 |
| --- | --- |
| 浏览器 | **只有 Chrome / Edge**。Web Serial API 仅 Chromium 内核提供，Firefox / Safari 没有——页面能打开、串口是死的，这不是 bug。 |
| 打开地址 | 串口只在安全上下文可用：`http://localhost`、`http://127.0.0.1` 或 HTTPS。用局域网 IP（如 `http://192.168.x.x:5173`）打开时 `navigator.serial` 是 `undefined`，浏览器的硬规定。 |
| Node.js | **≥ 20.19 或 ≥ 22.12**（Vite 8 的要求）；开发机实测 v24 + npm 11。 |
| 串口驱动 | 飞控/数传常见为 CH340 / CP210x，**先装驱动**：设备管理器里能看到 COM 口才算准备好，否则端口下拉是空的，跟前端无关。 |

## 从克隆到跑起来

```bash
git clone https://github.com/tjpx/FIRMAMENT-GCS.git
cd FGC
npm install
npm run dev        # Vite 开发服务，默认 http://localhost:5173
```

用 Chrome / Edge 打开 `http://localhost:5173`，在页面里连接飞控，浏览器弹窗里授权具体串口即可。
本仓库只分发公开源码：`docs/`（设计与排期文档）、`vendor/mavlink/`（协议生成基准）、
`sample/`（配置夹具）、`scripts/`（生成器与自测脚本）不进公开仓库，
克隆后 `npm install` → `npm run dev` / `npm run build` 全流程照常可用。

### 命令一览

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发服务器 |
| `npm run build` | 生产构建，产物在 `dist/` |
| `npm run selftest` | 协议/内核层自测（无浏览器依赖，`node scripts/selftest.mjs`） |
| `npm run preview` | 本机起静态服务验证构建产物（`http://localhost:4173`，自带 SPA fallback） |

## 目录结构

```
src/
  App.vue / main.js              入口与布局：统一 provide mavlink 链路实例，挂全局保存条
  router/                        各功能页懒加载路由
  composables/useMavlink.js      链路核心：串口收发、帧解析、遥测状态、FTP、心跳、事件
  protocol/                      生成表 mavlink-table.generated.js + 模式/状态/指令名的中文标签字典
  utils/                         不依赖 DOM 的纯逻辑：帧编解码与 CRC16（mavlink-protocol.js）、
                                 MAVFTP 下载字节核算（ftp-download.js，缺一个字节就报错）、
                                 PARAM_VALUE 双编码判定（param-value.js）、TOML/XML 解析（toml.js / paramXml.js）、
                                 保注释的配置文件定点读写（config-doc.js）、上传回传闸门（upload-gate.js）、
                                 主题令牌（theme.js）、链路体检报告（diag-report.js）等
  stores/                        Pinia：连接时拉取的飞控配置（fcconfig.js）等
  components/                    各功能页一 .vue（仪表盘 / cli / ftp / parameter / rc / pid / port / diag / save-bar …）
  styles/                        设计令牌 tokens.css + Element Plus 主题覆写（明暗挂 :root[data-theme]）
tools/com-probe.ps1              Windows 串口排查辅助脚本
```

## 功能接通状态

| 能力 | 底层通道 | 状态 |
| --- | --- | --- |
| 仪表盘 / 顶栏 / 底栏 | SYS_STATUS、ATTITUDE、VFR_HUD、GLOBAL_POSITION_INT、GPS_RAW_INT、EXTENDED_SYS_STATE、STATUSTEXT | 已接通 |
| CLI 控制台 | SERIAL_CONTROL + xterm.js | 已接通 |
| FTP 文件 | FILE_TRANSFER_PROTOCOL；上传后整文件回读 CRC32 真校验（飞控不支持 `CALC_FILE_CRC32`，只认回读整份比 CRC32） | 已接通 |
| 配置文件工作流 | MAVFTP 读写 `/sys/sysconfig.toml`、`/sys/param.xml`，右下角全局保存条统一写回 | 拉取与写回已收口；端口 / PID / 接收机页已就地编辑，`/parameter` 仍是整本重写的老通路，待收编 |
| 链路体检 `/diag` | 六个只读探针 + JSON 导出 | 已接通 |
| 电机测试 | SERVO_OUTPUT_RAW 读数 | 读数已接通；MOTOR_TEST / COMMAND_LONG 指令未接通 |
| 电池 | SYS_STATUS 电压、电流、剩余电量 | 读数已接通；阈值写入未接通（旧 `/cells` 页已弃用重写） |
| 传感器 / 日志 等 | — | 原型页，页面内挂 `PrototypeNotice` 说明缺口 |

## 许可证

本项目采用 **Apache License 2.0** 开源，全文见 [LICENSE](LICENSE)。