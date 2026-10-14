<template>
  <div class="home-workspace">
    <aside class="workspace-sidebar" aria-label="欢迎与工具工作区">
      <div class="workspace-heading"><h2>欢迎与工具</h2></div>
      <nav class="workspace-navigation" aria-label="欢迎与工具导航">
        <router-link
          v-for="item in navigation"
          :key="item.path"
          :to="item.path"
          class="workspace-link"
          exact-active-class="is-active"
          ><component :is="item.icon" class="workspace-icon" aria-hidden="true" /><span>{{
            item.label
          }}</span></router-link
        >
      </nav>
    </aside>
    <div class="workspace-content">
      <router-view
        @open-connect="emit('open-connect', $event)"
        @motor-test-state="emit('motor-test-state', $event)"
        @open-config-review="emit('open-config-review', $event)"
      />
    </div>
  </div>
</template>
<script setup>
import { House, PartlyCloudy, Document, Upload, Setting } from '@element-plus/icons-vue'
const emit = defineEmits(['open-connect', 'motor-test-state', 'open-config-review'])
const navigation = [
  { path: '/', label: '欢迎', icon: House },
  { path: '/environment', label: '飞前环境', icon: PartlyCloudy },
  { path: '/log', label: '日志分析', icon: Document },
  { path: '/firmware', label: '固件烧写准备', icon: Upload },
  { path: '/setting', label: '设置', icon: Setting },
]
</script>
<style scoped>
.home-workspace {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  min-height: 100%;
  background: var(--dsh-canvas);
  color: var(--dsh-text-1);
}
.workspace-sidebar {
  display: flex;
  flex-direction: column;
  gap: 22px;
  min-width: 0;
  padding: 24px 14px;
  border-right: 1px solid var(--dsh-border);
  background: var(--dsh-surface);
}
.workspace-heading {
  padding: 0 10px;
}
.workspace-eyebrow {
  color: var(--dsh-accent);
  font-size: 10px;
  letter-spacing: 0.1em;
}
.workspace-heading h2 {
  margin: 10px 0 8px;
  font-size: 19px;
}
.workspace-heading p {
  margin: 0;
  color: var(--dsh-text-3);
  font-size: 12px;
  line-height: 1.6;
}
.workspace-navigation {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.workspace-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--dsh-text-2);
  text-decoration: none;
  font-size: 14px;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}
.workspace-link:hover {
  background: var(--dsh-canvas);
  color: var(--dsh-text-1);
}
.workspace-link.is-active {
  border-color: var(--dsh-border);
  background: var(--dsh-canvas);
  color: var(--dsh-accent);
  font-weight: 600;
}
.workspace-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.workspace-link:focus-visible {
  outline: 2px solid var(--dsh-accent);
  outline-offset: 3px;
}
.workspace-content {
  min-width: 0;
}
@media (max-width: 900px) {
  .home-workspace {
    grid-template-columns: 180px minmax(0, 1fr);
  }
  .workspace-sidebar {
    padding: 20px 10px;
  }
}
@media (max-width: 640px) {
  .home-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .workspace-sidebar {
    gap: 14px;
    padding: 16px;
    border-right: 0;
    border-bottom: 1px solid var(--dsh-border);
  }
  .workspace-heading {
    padding: 0;
  }
  .workspace-heading h2 {
    margin: 6px 0;
  }
  .workspace-navigation {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .workspace-link {
    padding: 10px;
    font-size: 13px;
  }
}
</style>
