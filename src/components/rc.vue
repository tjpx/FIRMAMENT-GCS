<!--
  src/components/rc.vue
  ================================================================
  遥控器 / 接收机页。

  这一页的数据面（S4 起全部接飞控原文，不再放本地草案）：
    1. 实时遥测  mav.data.rcChannels（RC_CHANNELS，飞控 5 Hz 推送）
         chancount：飞控实际上报的有效通道数，超出部分一律显示 --，不补 0
         channels ：Uint16Array(18)，协议最多 18 路，界面展示前 16 路
         rssi     ：0~255，协议规定 UINT8_MAX 表示"接收机不上报"，这里也当未知
    2. 通道行程  /sys/param.xml 的 RC 组（RCn_MIN / MAX / REV / TRIM、RC_CHAN_CNT）
    3. 接收机配置  /sys/sysconfig.toml 的 [pilot-cmd] 与 [pilot-cmd.device]
    4. 模式与指令  [[pilot-cmd.mode]] / [[pilot-cmd.command]]

  两个文件的值都是连接飞控时自动读进来的（src/stores/fcconfig.js 的 attach → pullAll），
  本页只改内存里的定点位置，右下角「全局保存」才写回飞控；改完不保存就离开本页也不影响飞控。

  摇杆视图的排法（业主 2026-07-31 明确：ch1 右手横滚、ch2 右手俯仰、ch3 左手油门、ch4 左手航向）：
  这就是飞控 [pilot-cmd].stick-channel 原文 [4,3,1,2] 的次序，数组顺序是 [yaw, throttle, roll, pitch]。
  通道号由下面 stickMap 从原文解出来，读不到就用 DEFAULT_STICK_MAP，并在卡里写明用的是页面默认。

  立场：没接通的协议就不给按钮，也不留空壳。
    - "接收机对频"在当前固件里没有对应的 MAVLink / FMT 私有命令，
      早先的实现是按下按钮 3 秒后弹"对频成功"——那是演出来的；2026-07-31 业主让把这块删掉，
      于是整个页签连同那颗禁用按钮一起移除（不是留个灰色按钮给人看）。将来固件真给了命令，
      就连着"结果查得到"一起回来，不做只有过程的假界面。
    - 早先的"模式映射"是一张写死在前端的草案表（Angle/Horizon/Acro/Beeper…），
      和飞控上的 [[pilot-cmd.mode]] 一行都对不上，已整块删掉，换成原文的可编辑表格。
  字段归类、中文名与校验集中在 src/utils/config-bindings.js，自测第 22 组拿飞控原文核对。
-->
<template>
  <div class="rc-config-container">
    <TaskHeader
      eyebrow="RECEIVER / INPUT"
      title="接收机"
      description="实时显示飞控上报的 RC_CHANNELS，并编辑来自配置文件的通道映射。未上报数据保持未知。"
    />
    <!-- 顶部：这一页到底吃的是谁的数 -->
    <el-alert
      v-if="!fc.loaded"
      type="info"
      show-icon
      :closable="false"
      class="mb-3"
      title="连上飞控后地面站会自动把 /sys/sysconfig.toml 与 /sys/param.xml 读进来（约 1~3 秒）。下面几张表显示的就是飞控上的原文，不用手动读取。"
    >
      <template #default>
        <div class="foot-note">
          读取状态：{{ pullState }}
          <el-button v-if="!fc.busy" link type="primary" size="small" @click="reload">重新读取一次</el-button>
        </div>
      </template>
    </el-alert>
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      class="mb-3"
      :title="`已从飞控读取到原文：sysconfig.toml（${fmtBytes(fc.files.sysconfig.size)}）/ param.xml（${fmtBytes(fc.files.param.size)}）。本页改动只写在内存里，右下角「全局保存」才会写回飞控。`"
    />

    <el-tabs v-model="activeTab" type="border-card" class="config-tabs">
      <!-- 1. 遥控器校准（实时遥测，只观测） -->
      <el-tab-pane label="遥控器校准" name="calibration">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-card shadow="never" class="stick-viewer">
              <template #header>
                <div class="card-header">
                  <span>摇杆实时状态</span>
                  <el-tag size="small" :type="live ? 'success' : 'info'">
                    {{ live ? '实时' : mav.connected.value ? '无遥测' : '未连接' }}
                  </el-tag>
                </div>
              </template>
              <div class="sticks-layout">
                <!-- 摇杆的位置按美国手（Mode 2）：左手管油门与航向，右手管横滚与俯仰。
                     通道号不是写死的——从 [pilot-cmd].stick-channel 解出来（见下面 stickMap），
                     轴号是 RC_CHANNELS 的通道序，读到哪一路就画哪一路 -->
                <div class="stick-box">
                  <div class="stick-title">左手 · 油门 / 航向</div>
                  <div class="stick-base">
                    <div class="stick-knob" :style="getStickStyle(stickMap.yaw, stickMap.throttle)"></div>
                  </div>
                  <div class="stick-labels">
                    <span
                      >CH{{ stickMap.throttle }} 油门:
                      <b class="dsh-num" v-flash-on-change="rcFlash(valueOf(stickMap.throttle))">{{
                        fmt(valueOf(stickMap.throttle))
                      }}</b></span
                    >
                    <span
                      >CH{{ stickMap.yaw }} 航向:
                      <b class="dsh-num" v-flash-on-change="rcFlash(valueOf(stickMap.yaw))">{{
                        fmt(valueOf(stickMap.yaw))
                      }}</b></span
                    >
                  </div>
                </div>
                <div class="stick-box">
                  <div class="stick-title">右手 · 横滚 / 俯仰</div>
                  <div class="stick-base">
                    <div class="stick-knob" :style="getStickStyle(stickMap.roll, stickMap.pitch)"></div>
                  </div>
                  <div class="stick-labels">
                    <span
                      >CH{{ stickMap.roll }} 横滚:
                      <b class="dsh-num" v-flash-on-change="rcFlash(valueOf(stickMap.roll))">{{
                        fmt(valueOf(stickMap.roll))
                      }}</b></span
                    >
                    <span
                      >CH{{ stickMap.pitch }} 俯仰:
                      <b class="dsh-num" v-flash-on-change="rcFlash(valueOf(stickMap.pitch))">{{
                        fmt(valueOf(stickMap.pitch))
                      }}</b></span
                    >
                  </div>
                </div>
              </div>
              <div class="rc-preview-inline">
                <div class="preview-title">摇杆输入姿态预览</div>
                <Aircraft3D
                  :roll="rcAxis(stickMap.roll) * 18"
                  :pitch="rcAxis(stickMap.pitch) * -12"
                  :yaw="rcAxis(stickMap.yaw) * 20"
                  :throttle="pct(valueOf(stickMap.throttle))"
                  compact
                />
                <div class="model-readout">
                  横滚 {{ stickAngle(stickMap.roll) }}° · 俯仰 {{ stickAngle(stickMap.pitch) }}° · 仅显示遥控器输入
                </div>
              </div>
              <div class="mini-info">
                <span
                  >RSSI：<span class="dsh-num">{{ rssiText }}</span></span
                >
                <span
                  >有效通道：<span class="dsh-num">{{ rc.chancount || '--' }}</span></span
                >
                <span
                  >飞控时基：<span class="dsh-num">{{ rc.chancount ? rc.timeBootMs + ' ms' : '--' }}</span></span
                >
                <span>摇杆通道：{{ stickMapSource }}</span>
              </div>
            </el-card>
          </el-col>

          <el-col :span="12">
            <el-card shadow="never" class="channel-bars">
              <template #header>
                <div class="card-header">
                  <span>通道数值监控（PWM μs）</span>
                  <el-button size="small" @click="resetExtremes">清零本次极值</el-button>
                </div>
              </template>
              <div v-for="ch in SHOW_CHANNELS" :key="ch" class="channel-item">
                <span class="ch-label">CH{{ ch }}</span>
                <span class="ch-axis">{{ channelHint(ch) }}</span>
                <div class="ch-bar">
                  <el-progress
                    :percentage="pct(valueOf(ch))"
                    :color="getChannelColor(ch)"
                    :stroke-width="10"
                    :show-text="false"
                  />
                  <span v-if="extremes[ch - 1].min !== null" class="ch-range dsh-num">
                    {{ extremes[ch - 1].min }} ~ {{ extremes[ch - 1].max }}
                  </span>
                </div>
                <span class="ch-value dsh-num" v-flash-on-change="rcFlash(valueOf(ch))">{{ fmt(valueOf(ch)) }}</span>
              </div>
              <div class="calib-footer">
                <p class="foot-note">通道条按页面显示范围 1000–2000 μs 绘制；死区配置未知，不绘制推测斜纹。</p>
                <el-alert
                  type="info"
                  show-icon
                  :closable="false"
                  title="这一列只是本次会话的观测值。要改每路的行程/方向/中位，请到「通道行程」页（写的是 param.xml 的 RC 组）；要改接收机协议与通道数，请到「接收机配置」页（写的是 sysconfig.toml 的 [pilot-cmd]）。"
                />
              </div>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- 2. 通道行程：param.xml 的 RC 组 -->
      <el-tab-pane name="travel">
        <template #label>通道行程<el-badge v-if="dirtyParam" :value="dirtyParam" class="tab-badge" /></template>
        <EmptyStateAction
          v-if="!fc.loaded"
          title="配置尚未就绪"
          reason="还没从飞控读到 param.xml，不展示假数据"
          action-label="从飞控读取配置"
          :action-disabled="!mav.connected.value || !!fc.busy"
          @action="reload"
        />
        <template v-else>
          <el-alert
            class="mb-3"
            type="warning"
            show-icon
            :closable="false"
            title="行程写错会直接把舵量顶到底：MIN 必须小于 MAX、方向只能是 ±1、中位要落在本路行程之内，页面会拦住不合格的值。改完走右下角全局保存，重启飞控才生效（param.xml 只在开机时读）。"
          />
          <el-card v-for="card in rcCards" :key="card.card" shadow="never" class="pane-card">
            <template #header>
              <div class="card-header">
                <span>{{ card.title }}</span>
                <el-tag size="small" type="info">{{ card.items.length }} 项（param.xml RC 组原文）</el-tag>
              </div>
            </template>
            <p v-if="card.note" class="pane-note">{{ card.note }}</p>

            <!-- rc-channels 卡摊成一路一行 -->
            <el-table
              v-if="card.card === 'rc-channels'"
              :data="travel.channels"
              max-height="480"
              border
              size="small"
              style="width: 100%"
            >
              <el-table-column prop="label" label="通道" width="80" />
              <el-table-column label="当前 PWM" width="100" align="center">
                <template #default="s">
                  <span class="mono dsh-num" v-flash-on-change="rcFlash(valueOf(s.row.chan))">{{
                    fmt(valueOf(s.row.chan))
                  }}</span>
                </template>
              </el-table-column>
              <el-table-column label="本次极值" width="120" align="center">
                <template #default="s">
                  <span class="mono dsh-num">{{ extremeText(s.row.chan) }}</span>
                </template>
              </el-table-column>
              <el-table-column v-for="col in RC_COLUMNS" :key="col.key" :label="col.name" min-width="180">
                <template #default="s">
                  <template v-if="s.row.fields[col.key]">
                    <el-select
                      v-if="col.key === 'REV'"
                      :data-search-key="`param:RC:${s.row.fields[col.key].name}`"
                      v-model="drafts[s.row.fields[col.key].name]"
                      size="small"
                      clearable
                      :placeholder="`当前 ${s.row.fields[col.key].raw}`"
                      @change="commitParam(s.row.fields[col.key])"
                      ><el-option
                        v-for="option in RC_DIRECTION_OPTIONS"
                        :key="option.value"
                        :label="`${option.label}（${option.value}）`"
                        :value="option.value" /></el-select
                    ><el-input
                      v-else
                      :data-search-key="`param:RC:${s.row.fields[col.key].name}`"
                      v-model="drafts[s.row.fields[col.key].name]"
                      size="small"
                      :placeholder="`当前 ${s.row.fields[col.key].raw}`"
                      @keyup.enter="commitParam(s.row.fields[col.key])"
                      @blur="commitParam(s.row.fields[col.key])"
                    />
                    <div v-if="errors[s.row.fields[col.key].name]" class="draft-hit">
                      {{ errors[s.row.fields[col.key].name] }}
                    </div>
                    <div v-else-if="notes[s.row.fields[col.key].name]" class="draft-hit ok">
                      {{ notes[s.row.fields[col.key].name] }}
                    </div>
                    <div v-else-if="s.row.fields[col.key].hint" class="raw-hint">
                      {{ s.row.fields[col.key].hint }}
                    </div>
                  </template>
                  <span v-else class="raw-hint">飞控这一路没有这个键</span>
                </template>
              </el-table-column>
            </el-table>

            <!-- 其余卡（含 RC_CHAN_CNT 与兜底）按 pid 页的逐行形态显示 -->
            <el-table v-else :data="card.items" border size="small" max-height="480" style="width: 100%">
              <el-table-column prop="name" label="参数名" width="190">
                <template #default="s"
                  ><code class="mono">{{ s.row.name }}</code></template
                >
              </el-table-column>
              <el-table-column prop="label" label="名称" width="200" />
              <el-table-column label="飞控上的值" min-width="190">
                <template #default="s">
                  <el-input
                    :data-search-key="`param:RC:${s.row.name}`"
                    v-model="drafts[s.row.name]"
                    size="small"
                    :placeholder="`当前 ${s.row.raw}`"
                    @keyup.enter="commitParam(s.row)"
                    @blur="commitParam(s.row)"
                  />
                  <div v-if="errors[s.row.name]" class="draft-hit">{{ errors[s.row.name] }}</div>
                  <div v-else-if="notes[s.row.name]" class="draft-hit ok">{{ notes[s.row.name] }}</div>
                </template>
              </el-table-column>
              <el-table-column label="原文写法" width="130">
                <template #default="s">
                  <el-tooltip
                    content="写回时按原文形态回填：浮点是六位小数，整数保持裸写法，地面站不自己决定小数位"
                    placement="top"
                  >
                    <code class="mono">{{ s.row.raw }}</code>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="说明" min-width="230">
                <template #default="s">
                  <span>{{ s.row.hint || '按 param.xml 原文显示' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
          <div v-if="travel.channels.length === 0" class="foot-note">
            飞控的 RC 组里没有 RCn_MIN/MAX/REV/TRIM 这类条目（样例文件里有 4 路）。页面不替你补通道。
          </div>
        </template>
      </el-tab-pane>

      <!-- 3. 接收机配置：sysconfig.toml 的 [pilot-cmd] -->
      <el-tab-pane name="pilot">
        <template #label>接收机配置<el-badge v-if="dirtyToml" :value="dirtyToml" class="tab-badge" /></template>
        <EmptyStateAction
          v-if="!fc.loaded"
          title="配置尚未就绪"
          reason="还没从飞控读到 sysconfig.toml，不展示假数据"
          action-label="从飞控读取配置"
          :action-disabled="!mav.connected.value || !!fc.busy"
          @action="reload"
        />
        <template v-else>
          <el-alert
            class="mb-3"
            type="warning"
            show-icon
            :closable="false"
            title="sysconfig.toml 固件只在开机时读一次：右下角全局保存之后必须重启飞控才生效。协议、通道数、量程三者要对得上你的接收机，接错会让所有通道一起乱动。"
          />
          <el-card shadow="never" class="pane-card">
            <template #header>
              <div class="card-header">
                <span>输入源 [pilot-cmd.device]</span>
                <el-tag size="small" type="info">{{ PILOT_DEVICE_FIELDS.length }} 项（原文里都有这一行）</el-tag>
              </div>
            </template>
            <el-table :data="deviceRows" border size="small" max-height="480" style="width: 100%">
              <el-table-column prop="label" label="字段" width="150">
                <template #default="s">{{ s.row.field.label }}</template>
              </el-table-column>
              <el-table-column label="键名" width="140">
                <template #default="s"
                  ><code class="mono">{{ s.row.key }}</code></template
                >
              </el-table-column>
              <el-table-column label="飞控上的值" width="140">
                <template #default="s">
                  <el-tooltip content="保存时按这个形态写回原文（字符串带引号、数组写成 [a,b]）" placement="top">
                    <code class="mono">{{ s.row.rawText }}</code>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="改成" min-width="200">
                <template #default="s">
                  <el-select
                    v-if="s.row.field.kind === 'enum'"
                    :data-search-key="`toml:pilot-cmd.device.${s.row.key}`"
                    v-model="drafts[s.row.dk]"
                    size="small"
                    clearable
                    :placeholder="`当前 ${s.row.rawText}`"
                    @change="commitPilotField(PILOT_DEVICE, s.row)"
                  >
                    <el-option
                      v-for="opt in enumOptions(s.row.field, s.row.raw)"
                      :key="opt.value"
                      :label="enumOptionLabel(opt)"
                      :value="opt.value"
                    />
                  </el-select>
                  <el-input
                    v-else
                    :data-search-key="`toml:pilot-cmd.device.${s.row.key}`"
                    v-model="drafts[s.row.dk]"
                    size="small"
                    :placeholder="s.row.field.kind === 'range' ? `[1000,2000] 这样的两个整数` : `当前 ${s.row.rawText}`"
                    @keyup.enter="commitPilotField(PILOT_DEVICE, s.row)"
                    @blur="commitPilotField(PILOT_DEVICE, s.row)"
                  />
                  <div v-if="errors[s.row.dk]" class="draft-hit">{{ errors[s.row.dk] }}</div>
                  <div v-else-if="notes[s.row.dk]" class="draft-hit ok">{{ notes[s.row.dk] }}</div>
                </template>
              </el-table-column>
              <el-table-column label="依据 / 说明" min-width="240">
                <template #default="s">
                  <span>{{ s.row.field.hint || '按原文形态写回' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <el-card shadow="never" class="pane-card">
            <template #header
              ><div class="card-header"><span>摇杆通道映射 [pilot-cmd].stick-channel</span></div></template
            >
            <el-form inline class="mb-3" @submit.prevent>
              <el-form-item label="stick-channel（顺序是 [yaw, throttle, roll, pitch]）">
                <el-input
                  data-search-key="toml:pilot-cmd.stick-channel"
                  v-model="drafts.stick"
                  style="width: 220px"
                  size="small"
                  :placeholder="`当前 ${stickText}`"
                  @keyup.enter="commitStick"
                  @blur="commitStick"
                />
              </el-form-item>
            </el-form>
            <div v-if="errors.stick" class="draft-hit mb-3">{{ errors.stick }}</div>
            <div v-else-if="notes.stick" class="draft-hit ok mb-3">{{ notes.stick }}</div>
            <el-table :data="stickRows" border size="small" max-height="480" style="width: 100%">
              <el-table-column prop="axis" label="轴（按 [pilot-cmd] 注释的次序）" width="220" />
              <el-table-column label="映射通道" width="120" align="center">
                <template #default="s"
                  ><span class="mono dsh-num">CH{{ s.row.channel || '--' }}</span></template
                >
              </el-table-column>
              <el-table-column label="该通道当前 PWM" width="170" align="center">
                <template #default="s"
                  ><span class="mono dsh-num" v-flash-on-change="rcFlash(valueOf(s.row.channel))">{{
                    fmt(valueOf(s.row.channel))
                  }}</span></template
                >
              </el-table-column>
              <el-table-column label="本次极值" min-width="160" align="center">
                <template #default="s"
                  ><span class="mono dsh-num">{{ extremeText(s.row.channel) }}</span></template
                >
              </el-table-column>
            </el-table>
            <p class="foot-note">
              {{ auxState }} 页面不新增、也不删除 sysconfig 里的键：原文里被注释掉的行（例如
              <code class="mono"># aux-channel = [7,8]</code>）保持注释状态，需要启用请人工处理，免得把注释结构打乱。
            </p>
          </el-card>
        </template>
      </el-tab-pane>

      <!-- 4. 模式与指令：[[pilot-cmd.mode]] / [[pilot-cmd.command]] -->
      <el-tab-pane name="modes">
        <template #label>模式与指令<el-badge v-if="dirtyToml" :value="dirtyToml" class="tab-badge" /></template>
        <EmptyStateAction
          v-if="!fc.loaded"
          title="配置尚未就绪"
          reason="还没从飞控读到 sysconfig.toml，不展示假数据"
          action-label="从飞控读取配置"
          :action-disabled="!mav.connected.value || !!fc.busy"
          @action="reload"
        />
        <template v-else>
          <el-alert
            class="mb-3"
            type="error"
            show-icon
            :closable="false"
            title="模式分配是炸机级配置：区间互相重叠或通道拨错，解锁瞬间就可能进错模式。改完请先在地面、不上桨验证每个开关档，再考虑飞行。"
          />
          <el-card v-for="tbl in tables" :key="tbl.path" shadow="never" class="pane-card">
            <template #header>
              <div class="card-header">
                <span>{{ tbl.title }}</span>
                <span>
                  <el-tag size="small" type="info">{{ tbl.rows.length }} 行（原文同序）</el-tag>
                  <el-button size="small" class="mr-2" @click="addRow(tbl.path, tbl.fields)">按最后一行追加</el-button>
                </span>
              </div>
            </template>
            <p class="pane-note">{{ tbl.note }}</p>
            <el-table :data="tbl.rows" border size="small" max-height="480" style="width: 100%">
              <el-table-column label="#" width="46" align="center">
                <template #default="s">{{ s.$index + 1 }}</template>
              </el-table-column>
              <el-table-column v-for="f in tbl.fields" :key="f.key" :label="f.label" min-width="190">
                <template #default="s">
                  <el-select
                    v-if="f.kind === 'enum'"
                    :data-search-key="`toml:${tbl.path}[${s.$index}].${f.key}`"
                    v-model="drafts[s.row.dk[f.key]]"
                    size="small"
                    clearable
                    :placeholder="`当前 ${s.row.text[f.key]}`"
                    @change="commitTableField(tbl.path, s.row, f)"
                    ><el-option
                      v-for="option in enumOptions(f, s.row.raw[f.key])"
                      :key="option.value"
                      :label="enumOptionLabel(option)"
                      :value="option.value"
                  /></el-select>
                  <el-input
                    v-else
                    :data-search-key="`toml:${tbl.path}[${s.$index}].${f.key}`"
                    v-model="drafts[s.row.dk[f.key]]"
                    size="small"
                    :placeholder="`当前 ${s.row.text[f.key]}`"
                    @keyup.enter="commitTableField(tbl.path, s.row, f)"
                    @blur="commitTableField(tbl.path, s.row, f)"
                  />
                  <div v-if="errors[s.row.dk[f.key]]" class="draft-hit">{{ errors[s.row.dk[f.key]] }}</div>
                  <div v-else-if="notes[s.row.dk[f.key]]" class="draft-hit ok">{{ notes[s.row.dk[f.key]] }}</div>
                  <div v-else-if="f.hint" class="raw-hint">{{ f.hint }}</div>
                </template>
              </el-table-column>
              <el-table-column label="该通道现在的 PWM / 判定" width="200" align="center">
                <template #default="s">
                  <span class="mono dsh-num" v-flash-on-change="rcFlash(valueOf(s.row.raw.channel))">{{
                    fmt(valueOf(s.row.raw.channel))
                  }}</span>
                  <el-tag size="small" :type="rangeState(s.row.raw.range, s.row.raw.channel).type" class="ml-2">
                    {{ rangeState(s.row.raw.range, s.row.raw.channel).text }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80" align="center">
                <template #default="s">
                  <el-button link type="danger" size="small" @click="removeRow(tbl.path, s.$index, tbl.rows.length)">
                    删除
                  </el-button>
                </template>
              </el-table-column>
              <template #empty>
                <span class="foot-note">原文里这一段没有表项，页面不替你决定初值；要加行请先核对 sysconfig.toml。</span>
              </template>
            </el-table>
          </el-card>
          <p class="foot-note">
            「判定」是地面站拿当前遥测 PWM 与本行 range 比出来的显示结果，只说明此刻杆量落不落在区间里；
            飞控真正执行哪个模式以它自己的仲裁逻辑为准，本页不冒充飞控的状态机。
          </p>
        </template>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { computed, inject, reactive, ref, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import Aircraft3D from './aircraft-3d.vue'
import { useRoute } from 'vue-router'
import { useTheme } from '../custom/useTheme.js'
import { chartColors } from '../utils/theme.js'
import TaskHeader from './task-header.vue'
import EmptyStateAction from './empty-state-action.vue'
import {
  PILOT_COMMAND,
  PILOT_COMMAND_FIELDS,
  PILOT_COMMAND_NOTE,
  PILOT_DEVICE,
  PILOT_DEVICE_FIELDS,
  PILOT_MODE,
  PILOT_MODE_FIELDS,
  PILOT_MODES,
  PILOT_MODE_NOTE,
  PILOT_SECTION,
  RC_COLUMNS,
  RC_DIRECTION_OPTIONS,
  channelMatrix,
  fmtRaw,
  mapGroupToCards,
  validateParamInput,
  validatePilotField,
  validateStickChannel,
} from '../utils/config-bindings.js'
import { optionLabel, optionsWithCurrent } from '../protocol/fmt-enums.js'

const mav = inject('mavlink')
const fc = inject('fcconfig')

/* ---------- 状态 ---------- */
// 默认停在有真数据的页，避免打开就看见一个不会动的界面
const activeTab = ref('calibration')
const route = useRoute()
const { isDark } = useTheme()
const channelColors = computed(() => chartColors(isDark.value ? 'dark' : 'light'))
// 搜索定位先打开真实字段所在页签，焦点由全局搜索工具在 DOM 就绪后处理。
watch(
  () => route.query.focus,
  (key) => {
    if (typeof key !== 'string') return
    if (key.startsWith('param:RC:')) activeTab.value = 'travel'
    else if (key.startsWith('toml:pilot-cmd.mode[') || key.startsWith('toml:pilot-cmd.command['))
      activeTab.value = 'modes'
    else if (key.startsWith('toml:pilot-cmd')) activeTab.value = 'pilot'
  },
  { immediate: true }
)

const rc = mav.data.rcChannels
const servos = mav.data.servos
const rcAxis = (ch) => {
  const v = valueOf(ch)
  return v == null ? 0 : Math.max(-1, Math.min(1, (v - 1500) / 500))
}
const modelTransform = computed(() => ({
  transform: `rotateX(${rcAxis(stickMap.value.pitch) * -12}deg) rotateZ(${rcAxis(stickMap.value.roll) * -18}deg)`,
}))
function stickAngle(ch) {
  const v = valueOf(ch)
  return v == null ? '--' : `${(rcAxis(ch) * 30).toFixed(0)}°`
}
function propStyle(index) {
  const values = servos.online ? servos.raw : []
  const v = values[index - 1] || 0
  return { opacity: servos.online ? Math.min(1, 0.25 + v / 2400) : 0.35 }
}
const SHOW_CHANNELS = 16 // 协议最多 18 路，界面按遥控器实际常见的 16 路展示
const PWM_MIN = 1000
const PWM_MAX = 2000
const PWM_CENTER = 1500
/** 遥测停顿判定的心跳间隔：5 Hz 推送下留 3 个周期余量 */
const STALE_MS = 1500

const lastRxAt = ref(0)
const live = ref(false)

/* ---------- 取值：拿不到就说拿不到 ---------- */

/** 第 ch 路（1 基）的 PWM 值；飞控没上报该路时返回 null，界面显示 -- */
function valueOf(ch) {
  const n = rc.chancount | 0
  if (!n) return null
  const i = ch - 1
  if (i < 0 || i >= n) return null
  const v = rc.channels[i]
  return v > 0 ? v : null
}

const fmt = (v) => (v == null ? '--' : String(v))
const fmtBytes = (n) => (n ? `${n} 字节` : '未知')

/** 进度条百分比：无数据归 0，越界夹住（el-progress 不接受 NaN 或 >100） */
function pct(v) {
  if (v == null) return 0
  return Math.max(0, Math.min(100, ((v - PWM_MIN) / (PWM_MAX - PWM_MIN)) * 100))
}

/** 摇杆偏移：-1 ~ 1，无数据时回中 */
function stick(ch) {
  const v = valueOf(ch)
  if (v == null) return 0
  return Math.max(-1, Math.min(1, (v - PWM_CENTER) / 500))
}

function getStickStyle(chX, chY) {
  return {
    transform: `translate(${stick(chX) * 100}%, ${-stick(chY) * 100}%)`,
  }
}

/* ---------- 摇杆轴与通道号的对应（业主 2026-07-31 定的排法） ---------- */
// CH1 右手横滚、CH2 右手俯仰、CH3 左手油门、CH4 左手航向，即美国手 Mode 2。
// 飞控原文 [pilot-cmd].stick-channel = [4,3,1,2] 与这条排法同义；读到别的值时摇杆跟着原文走，
// 界面注释不作数。缺位或越界才退回默认，并且卡底会写明"页面默认"。
const AXIS_NAMES = { roll: '右手·横滚', pitch: '右手·俯仰', throttle: '左手·油门', yaw: '左手·航向' }
const STICK_KEYS = ['yaw', 'throttle', 'roll', 'pitch'] // sysconfig 那行注释给的次序
const DEFAULT_STICK_MAP = { roll: 1, pitch: 2, throttle: 3, yaw: 4 }

const stickMap = computed(() => {
  const out = { ...DEFAULT_STICK_MAP }
  const arr = Array.isArray(stickRaw.value) ? stickRaw.value : []
  for (let i = 0; i < STICK_KEYS.length; i++) {
    const ch = Number(arr[i])
    if (ch >= 1 && ch <= 18) out[STICK_KEYS[i]] = ch
  }
  return out
})

/** 摇杆卡底那一行：通道号从哪来的，得让人看见 */
const stickMapSource = computed(() =>
  Array.isArray(stickRaw.value) && STICK_KEYS.every((_, i) => Number(stickRaw.value[i]) >= 1)
    ? `飞控原文 ${fmtRaw(stickRaw.value)}`
    : '页面默认 [4,3,1,2]（飞控这条没读到）'
)

/** 第 ch 路是摇杆的哪根轴；不是摇杆的轴返回空串，界面就只写 CH 号 */
function channelHint(ch) {
  for (const k of STICK_KEYS) {
    if (stickMap.value[k] === ch) return AXIS_NAMES[k]
  }
  return ''
}

function getChannelColor(ch) {
  if (valueOf(ch) === null) return 'var(--dsh-placeholder)'
  // 通道分组只用于识别，不把绿色解释成接收机健康或有输出。
  return channelColors.value.channel[Math.floor((ch - 1) / 4) % channelColors.value.channel.length]
}

/** 闪烁只认当前会话真实 RC 帧，不由动画或定时器伪造数据活性。 */
function rcFlash(value) {
  return {
    value,
    enabled: mav.canOperate.value && mav.deviceState.valid.rc && value != null,
    stamp: mav.deviceState.freshness.rc,
    session: mav.deviceState.sessionId,
  }
}

/** RSSI：协议 0~255，0 与 255 都按"接收机不上报"处理 */
const rssiText = computed(() => {
  if (!rc.chancount) return '--'
  const v = rc.rssi
  if (v === 0 || v === 0xff) return '--'
  return `${Math.round((v / 255) * 100)}%`
})

/* ---------- 会话极值（只做观测，帮助判断行程与中值） ---------- */
const extremes = reactive(Array.from({ length: SHOW_CHANNELS }, () => ({ min: null, max: null })))

function extremeText(ch) {
  const e = extremes[(ch | 0) - 1]
  if (!e || e.min === null) return '--'
  return `${e.min} ~ ${e.max}`
}

function resetExtremes() {
  extremes.forEach((e) => {
    e.min = null
    e.max = null
  })
  ElMessage.info('已清零本页记录的会话极值（不影响飞控内数据）')
}

let aliveTimer = null

function sampleExtremes() {
  for (let i = 0; i < SHOW_CHANNELS; i++) {
    const v = valueOf(i + 1)
    if (v === null) continue
    const e = extremes[i]
    if (e.min === null || v < e.min) e.min = v
    if (e.max === null || v > e.max) e.max = v
  }
}

// 只在飞控时基往前走的时候记一次，避免同一帧被重复统计
watch(
  () => rc.timeBootMs,
  (t) => {
    if (t) {
      lastRxAt.value = Date.now()
      sampleExtremes()
    }
  }
)

onMounted(() => {
  aliveTimer = setInterval(() => {
    live.value = !!lastRxAt.value && Date.now() - lastRxAt.value < STALE_MS
  }, 500)
})

onUnmounted(() => {
  // 定时器必须清掉：切页后它还在跑就是内存泄漏
  if (aliveTimer) {
    clearInterval(aliveTimer)
    aliveTimer = null
  }
})

/* ================================================================
 * 以下是 S4 接上来的真数据：本地草稿 → 定点写进 store → 右下角全局保存
 * ================================================================ */

/**
 * 文档不是响应式的（shallowRef 里的普通对象），所以统一走 stamp：
 * revision 由每个 setter 递增，lastPullAt / crc32Hex 在重新拉取时变化。
 */
const stamp = computed(
  () => `${fc.revision}|${fc.lastPullAt}|${fc.files.sysconfig.crc32Hex}|${fc.files.param.crc32Hex}`
)

const drafts = reactive({})
const errors = reactive({})
const notes = reactive({})

function clearLocal() {
  for (const k of Object.keys(drafts)) delete drafts[k]
  for (const k of Object.keys(errors)) delete errors[k]
  for (const k of Object.keys(notes)) delete notes[k]
}

/**
 * 从飞控重新拉取会让本地草稿全部失效（旧值可能属于另一台飞控）。
 * 故意不监听 revision：自己改出来的提示要留在格子上，否则一写就消失看不见。
 */
watch(
  () => `${fc.lastPullAt}|${fc.files.sysconfig.crc32Hex}|${fc.files.param.crc32Hex}`,
  () => {
    clearLocal()
    ElMessage.info('本页表格已按飞控最新原文重新显示')
  }
)

const pullState = computed(() => {
  void stamp.value
  if (fc.busy) return fc.busyLabel || '正在处理'
  if (fc.lastPullError) return `上次读取失败：${fc.lastPullError}`
  if (!mav.connected.value) return '未连接飞控'
  return '等待自动读取…'
})

const dirtyToml = computed(() => {
  void stamp.value
  return (fc.files.sysconfig.changes || []).length
})
const dirtyParam = computed(() => {
  void stamp.value
  return (fc.files.param.changes || []).length
})

async function reload() {
  if (!mav.connected.value) {
    ElMessage.warning('没连上飞控，读不到配置文件')
    return
  }
  if (fc.hasChanges) {
    try {
      await ElMessageBox.confirm(
        `现在有 ${fc.changeList.length} 处本地改动还没保存。重新读取会丢掉这些改动（不会写回飞控）。`,
        '确认重新读取',
        { type: 'warning', confirmButtonText: '丢掉并重新读取', cancelButtonText: '先别动' }
      )
    } catch {
      return
    }
  }
  const r = await fc.pullAll()
  if (r.ok) ElMessage.success('已重新读取飞控配置')
  else ElMessage.error(`读取失败：${r.error}`)
}

/** 数字/数组/字符串的"值没变"判断：没变就不产生改动记录 */
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Number(x) === Number(b[i]))
    )
  }
  if (typeof a === 'number') return Number(b) === a
  return String(a) === String(b)
}

/**
 * 空格子一律当"没动过"。blur 事件会在用户只是点进来又点出去时触发，
 * 这时报「清空不算改动」是打扰；下拉框 clearable 清空同理，回退成原文显示。
 */
function isPristine(v) {
  return v === undefined || v === null || String(v).trim() === ''
}

function fail(key, message) {
  errors[key] = message
}

function ok(key, message) {
  delete drafts[key]
  delete errors[key]
  notes[key] = message
}

/* ---------- param.xml 的 RC 组：通道行程 ---------- */

const rcCards = computed(() => {
  void stamp.value
  const doc = fc.doc('param')
  return doc ? mapGroupToCards(doc, 'RC') : []
})

const travel = computed(() => {
  const card = rcCards.value.find((c) => c.card === 'rc-channels')
  return channelMatrix(card ? card.items : [])
})

/** 一格行程的落笔：校验 → 写 store → 留一条「还没写回飞控」的话 */
function commitParam(item) {
  if (!item || !item.name) return
  if (isPristine(drafts[item.name])) return
  const res = validateParamInput(item, drafts[item.name], (n) => fc.paramValue('RC', n))
  if (!res.ok) return fail(item.name, res.message)
  const cur = fc.paramValue('RC', item.name)
  if (typeof cur === 'number' && cur === res.value) return ok(item.name, '')
  try {
    fc.setParam('RC', item.name, res.value)
  } catch (e) {
    return fail(item.name, (e && e.message) || String(e))
  }
  ok(item.name, `已记在本地：${item.name} ${item.raw} → ${res.value}（写回时仍按原文的小数形态），右下角全局保存才生效`)
}

/* ---------- sysconfig 的 [pilot-cmd]：设备表与摇杆映射 ---------- */

const deviceRows = computed(() => {
  void stamp.value
  if (!fc.loaded) return []
  return PILOT_DEVICE_FIELDS.map((field) => {
    const raw = fc.tomlValue(PILOT_DEVICE, field.key)
    return {
      key: field.key,
      field,
      raw,
      dk: `device:${field.key}`,
      rawText: raw === undefined ? '未配置' : fmtRaw(raw),
    }
  })
})

const stickRaw = computed(() => {
  void stamp.value
  return fc.tomlValue(PILOT_SECTION, 'stick-channel')
})
const stickText = computed(() => (Array.isArray(stickRaw.value) ? fmtRaw(stickRaw.value) : '未配置'))
const stickRows = computed(() => {
  const arr = Array.isArray(stickRaw.value) ? stickRaw.value : []
  // 这一格只报原文读到的通道号：原文没有就显示 --，不拿页面默认冒充飞控配置
  return STICK_KEYS.map((k, i) => ({ axis: AXIS_NAMES[k] + '（' + k + '）', channel: Number(arr[i]) || 0 }))
})
const auxState = computed(() => {
  const v = fc.tomlValue(PILOT_SECTION, 'aux-channel')
  return v === undefined
    ? 'aux-channel 在原文里是注释掉的状态（页面按"未配置"显示）。'
    : `aux-channel 读到的原文是 ${fmtRaw(v)}。`
})

// 轴名与次序都在上面 AXIS_NAMES / STICK_KEYS（次序取自样例注释
// # channel mapping for [yaw, throttle, roll, pitch]），一张表说一件事

function commitStick() {
  if (isPristine(drafts.stick)) return
  const res = validateStickChannel(drafts.stick)
  if (!res.ok) return fail('stick', res.message)
  if (sameValue(stickRaw.value, res.value)) return ok('stick', '')
  try {
    fc.setToml(PILOT_SECTION, 'stick-channel', res.value)
  } catch (e) {
    return fail('stick', (e && e.message) || String(e))
  }
  ok(
    'stick',
    `已记在本地：stick-channel ${fmtRaw(stickRaw.value)} → ${fmtRaw(res.value)}（数组保持 [4,3,1,2] 的原文写法）`
  )
}

/** [pilot-cmd.device] 与两张表共用：校验并定点写回 sysconfig */
function enumOptions(field, current) {
  return optionsWithCurrent(field?.options || [], current, field?.label || '未知值')
}
function enumOptionLabel(option) {
  return optionLabel(option)
}

function commitPilotField(path, row) {
  const field = row.field
  const dk = row.dk || `${path}:${row.index}:${field.key}`
  const current = row.raw
  if (isPristine(drafts[dk])) return
  const res = validatePilotField(field, drafts[dk], current)
  if (!res.ok) return fail(dk, res.message)
  if (sameValue(current, res.value)) return ok(dk, '')
  try {
    if (row.index === undefined) fc.setToml(path, field.key, res.value)
    else fc.setTomlTableField(path, row.index, field.key, res.value)
  } catch (e) {
    return fail(dk, (e && e.message) || String(e))
  }
  ok(dk, `已记在本地：${field.key} ${fmtRaw(current)} → ${fmtRaw(res.value)}，右下角全局保存才写回`)
}

/* ---------- [[pilot-cmd.mode]] / [[pilot-cmd.command]] ---------- */

function tableRows(path, fields) {
  void stamp.value
  if (!fc.loaded) return []
  // store 的 tomlTables 返回的是 {index, keys, fields, raws}，不是摊平的对象：
  // fields 是当前值，raws 是原文写法，两者分开显示才不会把"值"和"格式"混成一件事
  return fc.tomlTables(path).map((t, index) => {
    const dk = {}
    const raw = {}
    const text = {}
    const src = t.fields || {}
    const srcRaw = t.raws || {}
    for (const f of fields) {
      dk[f.key] = `${path}:${index}:${f.key}`
      raw[f.key] = src[f.key]
      text[f.key] =
        srcRaw[f.key] !== undefined ? String(srcRaw[f.key]) : src[f.key] === undefined ? '未配置' : fmtRaw(src[f.key])
    }
    return { index, keys: t.keys || Object.keys(src), raw, text, dk }
  })
}

const tables = computed(() => [
  {
    path: PILOT_MODE,
    title: '飞行模式分配 [[pilot-cmd.mode]]',
    note: PILOT_MODE_NOTE,
    fields: PILOT_MODE_FIELDS,
    rows: tableRows(PILOT_MODE, PILOT_MODE_FIELDS),
  },
  {
    path: PILOT_COMMAND,
    title: '通道指令 [[pilot-cmd.command]]',
    note: PILOT_COMMAND_NOTE,
    fields: PILOT_COMMAND_FIELDS,
    rows: tableRows(PILOT_COMMAND, PILOT_COMMAND_FIELDS),
  },
])

/** 表格单元格里 commitPilotField 需要 index + raw，包一层取出来 */
function rangeDraft(row, field) {
  const value = row.raw[field.key]
  return Array.isArray(value) ? value.map(Number) : [1000, 2000]
}
function setRangeDraft(row, field, value) {
  drafts[row.dk[field.key]] = `[${value[0]},${value[1]}]`
  commitTableField(PILOT_MODE, row, field)
}

function commitTableField(path, row, field) {
  return commitPilotField(path, { field, dk: row.dk[field.key], raw: row.raw[field.key], index: row.index })
}

function addRow(path, fields) {
  const rows = fc.tomlTables(path)
  if (!rows.length) {
    ElMessage.warning(`原文里 ${path} 一段一行都没有，地面站不替你决定初值——请先核对 sysconfig.toml`)
    return
  }
  const last = rows[rows.length - 1]
  const src = last.fields || {}
  const copy = {}
  for (const f of fields) {
    const v = src[f.key]
    copy[f.key] = Array.isArray(v) ? v.slice() : v
  }
  ElMessageBox.confirm(
    `将按最后一行的键集合（${fields.map((f) => f.key).join(' / ')}）追加到 ${path} 段，值原样抄最后一行。
` + '追加后请把这一行的模式号 / 通道 / 区间改成你要的，再走右下角全局保存。',
    '确认追加一行',
    { type: 'warning', confirmButtonText: '追加', cancelButtonText: '取消' }
  )
    .then(() => {
      clearLocal() // 增删会移动表格行，旧草稿的 index 不能再往别的行上落
      fc.appendTomlTable(path, copy, '地面站新增（请核对数值）')
      ElMessage.success('已追加到本地原文，记得改完再全局保存')
    })
    .catch(() => {})
}

function removeRow(path, index, count) {
  ElMessageBox.confirm(
    `删除 ${path} 段的第 ${index + 1} 行（共 ${count} 行）。` +
      '这一行如果带行尾注释会一起消失；右下角全局保存才会写回飞控。',
    '确认删除这一行',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  )
    .then(() => {
      clearLocal()
      fc.removeTomlTable(path, index)
      ElMessage.success('已从本地原文删除这一行')
    })
    .catch(() => {})
}

/** 区间判定：拿当前遥测与本行 range 比，只作为显示参考 */
function rangeState(range, channel) {
  if (!Array.isArray(range) || range.length !== 2) return { text: '原文不完整', type: 'info' }
  const v = valueOf(channel)
  if (v === null) return { text: '无遥测', type: 'info' }
  return v >= range[0] && v <= range[1]
    ? { text: '落在区间内', type: 'success' }
    : { text: '未落在区间内', type: 'info' }
}
</script>

<style scoped>
.rc-preview-inline {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--dsh-border);
}
.preview-title {
  font-size: 12px;
  color: var(--dsh-text-2);
  margin-bottom: 4px;
}
.rc-preview-inline :deep(.aircraft-3d) {
  height: 190px;
}
.rc-preview-inline .model-readout {
  display: flex;
  justify-content: space-between;
  color: var(--dsh-text-3);
  font: 12px monospace;
}

.model-body {
  position: absolute;
  left: 105px;
  top: 60px;
  width: 50px;
  height: 38px;
  display: grid;
  place-items: center;
  color: var(--dsh-accent);
  background: var(--dsh-surface);
  border: 2px solid var(--dsh-accent);
}
.model-prop {
  position: absolute;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  color: var(--dsh-success);
  font-size: 24px;
  transition: opacity 0.12s;
}
.model-prop--1 {
  left: 42px;
  top: 28px;
}
.model-prop--2 {
  right: 42px;
  top: 28px;
}
.model-prop--3 {
  left: 42px;
  bottom: 28px;
}
.model-prop--4 {
  right: 42px;
  bottom: 28px;
}
.model-readout {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font: 12px monospace;
  color: var(--dsh-text-2);
}
.rc-config-container {
  padding: 20px;
  background-color: var(--dsh-surface-2);
  min-height: 100%;
}

.config-tabs {
  background: transparent;
  border: none;
}

.config-tabs :deep(.el-tabs__content) {
  padding: 0;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pane-card {
  margin-bottom: 16px;
}

.pane-note {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--dsh-text-3);
  line-height: 1.6;
}

.foot-note {
  font-size: 12px;
  color: var(--dsh-text-3);
  line-height: 1.7;
}

.mono {
  font-family: var(--dsh-font-mono);
  font-size: 12px;
}

.raw-hint {
  font-size: 11px;
  color: var(--dsh-text-3);
  line-height: 1.5;
  margin-top: 2px;
}

.draft-hit {
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsh-danger-vivid);
  margin-top: 2px;
}

.draft-hit.ok {
  color: var(--dsh-warning);
}

.tab-badge {
  margin-left: 6px;
}

.ml-2 {
  margin-left: 8px;
}

.mr-2 {
  margin-right: 8px;
}

.mb-3 {
  margin-bottom: 12px;
}

.sticks-layout {
  display: flex;
  justify-content: space-around;
  padding: 20px 0;
}

.stick-box {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stick-title {
  font-size: 12px;
  color: var(--dsh-text-2);
  margin-bottom: 8px;
}

.stick-base {
  width: 120px;
  height: 120px;
  background: var(--dsh-border);
  border-radius: 50%;
  position: relative;
  border: 4px solid var(--dsh-border-strong);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.1);
}

.stick-knob {
  width: 40px;
  height: 40px;
  background: var(--dsh-accent);
  border-radius: 50%;
  position: absolute;
  top: 50%;
  left: 50%;
  margin-top: -20px;
  margin-left: -20px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
  transition: transform 0.1s linear;
}

.stick-labels {
  margin-top: 10px;
  font-size: 12px;
  color: var(--dsh-text-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: center;
}

.mini-info {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  justify-content: space-between;
  font-size: 12px;
  color: var(--dsh-text-3);
  padding: 0 8px;
}

.channel-item {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}

.ch-label {
  width: 44px;
  font-size: 12px;
  color: var(--dsh-text-3);
}

.ch-axis {
  width: 78px;
  font-size: 11px;
  color: var(--dsh-text-3);
  white-space: nowrap;
}

.ch-bar {
  flex: 1;
  position: relative;
}

.ch-bar :deep(.el-progress-bar__outer),
.ch-bar :deep(.el-progress-bar__inner) {
  border-radius: 8px;
}

.ch-range {
  position: absolute;
  right: 0;
  top: -14px;
  font-size: 10px;
  color: var(--dsh-placeholder);
}

.ch-value {
  width: 50px;
  text-align: right;
  font-size: var(--dsh-font);
  font-weight: 600;
  color: var(--dsh-text-1);
}

.calib-footer {
  margin-top: 8px;
}
</style>
