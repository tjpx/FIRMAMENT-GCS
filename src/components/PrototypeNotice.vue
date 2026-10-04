<!--
  src/components/PrototypeNotice.vue
  ================================================================
  原型页统一横幅：明说"这块还没接通协议、页面上的数字是从哪来的、不会写飞控"。

  立场：只要页面里有地面站自己造出来的数字或按钮，就必须挂这个横幅。
  成熟地面站（Betaflight Configurator 等）的做法是"未连接就整页变灰并给出原因"，
  我们暂时保留布局，但结论性的文案（成功/已保存）一律不许出现在未接通的通道上。
-->
<template>
  <el-alert
      type="warning"
      show-icon
      :closable="false"
      class="prototype-notice"
      :title="title"
  >
    <ul v-if="items.length" class="pn-list">
      <li v-for="(it, i) in items" :key="i">{{ it }}</li>
    </ul>
  </el-alert>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  items: { type: Array, default: () => [] },
})
</script>

<style scoped>
.prototype-notice {
  margin-bottom: 16px;
}

.pn-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}
</style>
