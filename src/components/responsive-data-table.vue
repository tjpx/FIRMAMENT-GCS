<template>
  <div class="responsive-table">
    <div class="desktop-table"><slot name="table" /></div>
    <div class="mobile-cards"><slot name="cards" /></div>
  </div>
</template>
<script setup></script>
<style scoped>
.responsive-table {
  min-width: 0;
}
/* EP 的 max-height/height 负责滚动表体与同步横向表头，不能给整张表套第二层滚动。 */
.desktop-table {
  min-width: 0;
  border-radius: var(--dsh-radius-sm);
}
.mobile-cards {
  display: none;
}
.mobile-cards :deep(> *) {
  padding: var(--dsh-gap);
  border: 1px solid var(--dsh-border);
  border-radius: var(--dsh-radius);
  background: var(--dsh-surface);
}
@media (max-width: 700px) {
  .desktop-table {
    display: none;
  }
  .mobile-cards {
    display: grid;
    gap: var(--dsh-gap-sm);
  }
}
</style>
