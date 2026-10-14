<template>
  <!-- title 里带原始输入值和最近更新时间：出问题时鼠标停一下就知道是"数据没上来"还是"画法不对" -->
  <div class="att-instrument" :class="{ 'att-instrument--invalid': !valid }" :title="probeText">
    <svg viewBox="0 0 240 196" role="img" :aria-label="ariaLabel">
      <defs>
        <clipPath :id="clipId"><circle :cx="CX" :cy="CY" :r="R" /></clipPath>
        <linearGradient :id="skyId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2f7fd0" />
          <stop offset="100%" stop-color="#8fc4ea" />
        </linearGradient>
        <linearGradient :id="groundId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#8a5a2b" />
          <stop offset="100%" stop-color="#4a3016" />
        </linearGradient>
      </defs>

      <!-- 镜像画法（航空地平仪）：刻度环钉在外壳上不动，指针跟着飞机转。
           - 固定层：滚转刻度环（**不写数字**，业主明确要求盘上不放刻度值）
           - 旋转层：顶部三角指针 + 地平线 + 俯仰梯尺（一起按 -roll 转，俯仰再平移地平线本体） -->
      <g class="roll-scale">
        <g v-for="m in ROLL_SCALE_MARKS" :key="`r-${m.deg}`" :transform="`rotate(${m.deg} ${CX} ${CY})`">
          <line
            :x1="CX"
            :y1="CY - R + 1"
            :x2="CX"
            :y2="CY - R + (m.major ? 13 : 7)"
            class="roll-tick"
            :class="{ 'is-major': m.major }"
          />
        </g>
      </g>

      <g :clip-path="`url(#${clipId})`">
        <g :transform="`rotate(${-safeRoll} ${CX} ${CY})`">
          <!-- 指针在天空/地面上都会经过，所以用白描边保证两边都看得见 -->
          <path
            :d="`M${CX} ${CY - R + 2} L${CX - 8} ${CY - R + 17} L${CX + 8} ${CY - R + 17} Z`"
            class="roll-pointer"
          />
          <!-- 地平线本体：在旋转层里再按俯仰上下平移 -->
          <g :transform="`translate(0 ${horizonY})`">
            <rect :x="CX - 200" :y="CY - 400" width="400" height="400" :fill="`url(#${skyId})`" />
            <rect :x="CX - 200" :y="CY" width="400" height="400" :fill="`url(#${groundId})`" />
            <line :x1="CX - 200" :y1="CY" :x2="CX + 200" :y2="CY" class="horizon-line" />
            <g v-for="l in ladder" :key="`l-${l.deg}`" :transform="`translate(0 ${l.y})`">
              <line
                :x1="CX - l.width / 2"
                y1="0"
                :x2="CX + l.width / 2"
                y2="0"
                class="ladder-line"
                :class="{ 'is-pitch': l.isPitch }"
              />
            </g>
            <!-- 平飞附近地平线就在中心，补一对小记号，免得看着像"少了一条线" -->
            <g v-if="showHorizonMark">
              <line :x1="CX - 16" y1="0" :x2="CX - 6" y2="0" class="ladder-line is-pitch" />
              <line :x1="CX + 6" y1="0" :x2="CX + 16" y2="0" class="ladder-line is-pitch" />
            </g>
          </g>
        </g>
      </g>

      <!-- 固定外壳：表圈和中心机体符号。盘上不再放数字读数——数值看右侧卡片，
           仪表只负责"看姿态"，黑字压在盘中央会挡住地平线。 -->
      <g class="case">
        <circle :cx="CX" :cy="CY" :r="R" class="bezel" />
        <line :x1="CX - 40" :y1="CY" :x2="CX - 14" :y2="CY" class="aircraft-symbol" />
        <line :x1="CX + 14" :y1="CY" :x2="CX + 40" :y2="CY" class="aircraft-symbol" />
        <circle :cx="CX" :cy="CY" r="3" class="aircraft-symbol" />
      </g>
    </svg>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { PX_PER_DEG, ROLL_SCALE_MARKS, horizonOffsetY, pitchLadder } from '../utils/attitude-instrument.js'

const props = defineProps({
  /** 滚转角（度，右滚为正） */
  roll: { type: Number, default: 0 },
  /** 俯仰角（度，抬头为正） */
  pitch: { type: Number, default: 0 },
  /** 姿态是否可信；false 时读数只显示占位符，地平线仍按最后已知角度画 */
  valid: { type: Boolean, default: true },
})

// 地平线盘比罗盘大一圈：R=92（罗盘 78），viewBox 240×196——左右各留 28 给滚转刻度数字，
// 上下各留 6 放表圈。
const CX = 120
const CY = 98
const R = 92

// 自增 id：同页可能出现多个仪表（现在只有一处），SVG 的 defs id 必须互不冲突
let instanceSeq = 0
const uid = ++instanceSeq
const clipId = `att-clip-${uid}`
const skyId = `att-sky-${uid}`
const groundId = `att-ground-${uid}`

const safeRoll = computed(() => (Number.isFinite(Number(props.roll)) ? Number(props.roll) : 0))
const safePitch = computed(() => (Number.isFinite(Number(props.pitch)) ? Number(props.pitch) : 0))
const horizonY = computed(() => horizonOffsetY(safePitch.value, PX_PER_DEG))
const ladder = computed(() => pitchLadder(safePitch.value, { pxPerDeg: PX_PER_DEG }))
/** 平飞附近（±2°）地平线就在中心，给它补一对小刻度当 0 记号 */
const showHorizonMark = computed(() => Math.abs(safePitch.value) <= 2)
/**
 * 中心线（离表盘圆心最近的那条梯尺线）：抬头时它就是"当前俯仰"那条刻度。
 * 暴露出来是为了自测能直接验证"中心刻度跟着俯仰走"，也是诊断用的一行文案。
 */
/**
 * 压在表盘中心的那条线（= 当前俯仰线，不写数字，只作指示）。
 * 暴露出来是为了自测能直接验证"中心那条线跟着俯仰走"，也是诊断用的一行文案。
 */
const centerLine = computed(() => ladder.value.filter((l) => l.isPitch)[0] || null)
const probeText = computed(() => {
  const c = centerLine.value
  return (
    `滚转 ${safeRoll.value.toFixed(1)}° / 俯仰 ${safePitch.value.toFixed(1)}°` +
    ` · 中心线 = ${c ? `${c.deg}°` : '地平线'}` +
    ` · 地平线偏移 ${horizonY.value.toFixed(0)}px` +
    (props.valid ? '' : ' · 尚未收到可信姿态')
  )
})
// 盘上不画数字，但读屏/无障碍仍要能报出姿态
const ariaLabel = computed(() =>
  props.valid
    ? `姿态仪表：滚转 ${safeRoll.value.toFixed(0)} 度、俯仰 ${safePitch.value.toFixed(0)} 度`
    : '姿态仪表：尚未收到姿态数据'
)
</script>
<style scoped>
.att-instrument {
  width: 100%;
  height: 100%;
}
.att-instrument svg {
  width: 100%;
  height: 100%;
  display: block;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35));
}
.att-instrument--invalid svg {
  opacity: 0.55;
}
.bezel {
  fill: none;
  stroke: var(--dsh-border-strong, var(--dsh-border));
  stroke-width: 2;
}
.horizon-line {
  stroke: #ffffff;
  stroke-width: 1.6;
  stroke-opacity: 0.9;
}
.ladder-line {
  stroke: #ffffff;
  stroke-width: 1.2;
  stroke-opacity: 0.85;
}
/* 当前俯仰那条线加粗，它就是盘上唯一的读数指示（不写字） */
.ladder-line.is-pitch {
  stroke-width: 2.2;
  stroke-opacity: 1;
}
/* 刻度线会压在地平线（蓝/棕两种底色）上，统一白色 + 深色描边保证两边都读得清 */
.roll-tick {
  stroke: #ffffff;
  stroke-width: 1.4;
  paint-order: stroke;
}
.roll-tick.is-major {
  stroke: #ffffff;
  stroke-width: 2.4;
}
/* 指针会转到天空和地面上，白描边保证两边都清楚 */
.roll-pointer {
  fill: var(--dsh-warning-fill);
  stroke: #ffffff;
  stroke-width: 1.2;
  paint-order: stroke;
}
.aircraft-symbol {
  stroke: var(--dsh-warning-fill);
  stroke-width: 3;
  stroke-linecap: round;
  fill: var(--dsh-warning-fill);
}
</style>
