<template>
  <div class="compass" :class="{ 'compass--invalid': !valid }">
    <svg viewBox="0 0 164 164" role="img" :aria-label="ariaLabel">
      <defs>
        <radialGradient :id="plateId" cx="50%" cy="42%" r="70%">
          <stop offset="0%" stop-color="#1b2432" />
          <stop offset="100%" stop-color="#0d1117" />
        </radialGradient>
      </defs>

      <!-- 底盘：半径与表盘一致（外沿就是表盘外沿），不透明保证叠在 3D 模型上也读得清 -->
      <circle :cx="C" :cy="C" :r="plateR" :fill="`url(#${plateId})`" class="plate" />
      <circle :cx="C" :cy="C" :r="R" class="bezel" />

      <!-- 盘面：整体按 -heading 旋转，当前航向朝上 -->
      <g :transform="`rotate(${-headingValue} ${C} ${C})`">
        <g v-for="t in rose" :key="`t-${t.deg}`" :transform="`rotate(${t.rot} ${C} ${C})`">
          <line
            :x1="C"
            :y1="C - R"
            :x2="C"
            :y2="C - R + (t.kind === 'cardinal' ? 18 : t.major ? 12 : 6)"
            class="tick"
            :class="{
              'tick--cardinal': t.kind === 'cardinal',
              'tick--major': t.major && t.kind !== 'cardinal',
              'tick--minor': t.minor,
            }"
          />
          <!-- 文字再反向转回来，保证任何航向下都是正的 -->
          <g v-if="t.label" :transform="`rotate(${-t.rot} ${C} ${C - R + (t.kind ? 28 : 24)})`">
            <text
              :x="C"
              :y="C - R + (t.kind ? 32 : 27)"
              text-anchor="middle"
              class="mark"
              :class="t.kind === 'cardinal' ? 'mark--cardinal' : t.kind === 'ordinal' ? 'mark--ordinal' : 'mark--num'"
            >
              {{ t.label }}
            </text>
          </g>
        </g>
        <path :d="`M${C} ${C + 14} L${C - 6} ${C + 25} L${C + 6} ${C + 25} Z`" class="rose-index" />
      </g>

      <!-- 固定外壳：顶部红色航向指标（压在盘沿内侧，不越出画布）+ 中心大字读数 -->
      <path :d="`M${C - 9} ${C - R + 6} L${C + 9} ${C - R + 6} L${C} ${C - R + 20} Z`" class="course-index" />
      <line :x1="C - 30" :y1="C" :x2="C - 10" :y2="C" class="center-lines" />
      <line :x1="C + 10" :y1="C" :x2="C + 30" :y2="C" class="center-lines" />
      <text :x="C" :y="C - 1" text-anchor="middle" class="center-heading">{{ headingText }}</text>
      <text :x="C" :y="C + 16" text-anchor="middle" class="center-label">{{ headingLabel }}</text>
    </svg>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { formatHeading, headingRose, normalizeHeading } from '../utils/attitude-instrument.js'

const props = defineProps({
  /** 航向（度，0 = 北） */
  heading: { type: Number, default: 0 },
  /** 航向是否可信；false 时读数给占位符，盘面仍按最后已知航向转 */
  valid: { type: Boolean, default: true },
})

// 与姿态盘同半径：R=78、viewBox 164 ⇒ 半径占画布 0.476，两块叠在一起时圆一样大
const C = 82
const R = 78
const plateR = R

const headingValue = computed(() => normalizeHeading(Number.isFinite(Number(props.heading)) ? props.heading : 0))
const rose = computed(() => headingRose(headingValue.value, { stepDeg: 5, labelStepDeg: 30 }))
const heading = computed(() => formatHeading(headingValue.value, props.valid))
const headingText = computed(() => (props.valid ? `${heading.value.text}°` : '--'))
const headingLabel = computed(() => heading.value.label)
const ariaLabel = computed(() =>
  props.valid ? `磁罗盘：航向 ${heading.value.text} 度，${heading.value.label}` : '磁罗盘：尚未收到航向'
)

// 同页多个罗盘时 defs id 要互不冲突
let seq = 0
const plateId = `compass-plate-${++seq}`
</script>
<style scoped>
.compass {
  width: 100%;
  height: 100%;
}
.compass svg {
  width: 100%;
  height: 100%;
  display: block;
  filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.45));
}
.compass--invalid svg {
  opacity: 0.6;
}
.plate {
  stroke: none;
}
.bezel {
  fill: none;
  stroke: var(--dsh-border-strong, var(--dsh-border));
  stroke-width: 2;
}
/* 配色按"一眼能读"来定：主方位红/橙、数字刻度纯白、短线灰蓝、指标红 */
.tick {
  stroke: #8fa3bf;
  stroke-width: 1;
}
.tick--major {
  stroke: #ffffff;
  stroke-width: 2;
}
.tick--cardinal {
  stroke: #ff5a3c;
  stroke-width: 3.5;
}
.mark {
  font-family: var(--dsh-font-mono, monospace);
  font-weight: 700;
}
.mark--cardinal {
  fill: #ff5a3c;
  font-size: 15px;
}
.mark--ordinal {
  fill: #ffab2e;
  font-size: 11px;
}
.mark--num {
  fill: #ffffff;
  font-size: 9px;
  font-weight: 600;
}
.rose-index {
  fill: #ffab2e;
}
.course-index {
  fill: #ff5a3c;
  stroke: #ffffff;
  stroke-width: 0.8;
}
.center-lines {
  stroke: #ffab2e;
  stroke-width: 3;
  stroke-linecap: round;
}
.center-heading {
  fill: #ffffff;
  font: 700 22px var(--dsh-font-mono, monospace);
}
.center-label {
  fill: #ffab2e;
  font: 700 12px var(--dsh-font-mono, monospace);
}
</style>
