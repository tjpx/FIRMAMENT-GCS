<template>
  <el-tooltip placement="top-start" effect="light" :show-after="220" :hide-after="0" popper-class="page-help-popper">
    <template #content><div class="page-help-content">{{ text }}</div></template>
    <el-icon class="page-help-icon" :size="15" aria-label="查看页面教学"><QuestionFilled /></el-icon>
  </el-tooltip>
</template>
<script setup>
import { QuestionFilled } from '@element-plus/icons-vue'
defineProps({ text: { type: String, required: true } })
</script>
<style scoped>
.page-help-icon{color:var(--dsh-accent);cursor:help;vertical-align:middle;flex:none}.page-help-icon:hover{color:var(--dsh-accent-ink)}
</style>
<style>
.page-help-popper{max-width:380px}.page-help-content{white-space:pre-line;line-height:1.65;font-size:12px;color:var(--dsh-text-1)}
</style>
