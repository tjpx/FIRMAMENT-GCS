<template>
  <main class="welcome-page">
    <section class="welcome-hero">
      <h1>欢迎使用 FGC</h1>
      <p class="hero-copy">第一次使用？先准备连接，再了解飞控与工具。</p>
      <div class="hero-actions">
        <el-button v-if="!connected" type="primary" @click="$emit('open-connect')">连接飞控</el-button>
        <el-button v-else type="primary" @click="$router.push('/dashboard')">查看仪表盘</el-button>
        <a href="https://docs.sieon.net/product/#" target="_blank" rel="noopener noreferrer">官方产品文档 ↗</a>
      </div>
    </section>
    <div class="welcome-grid">
      <section class="welcome-panel prep-panel" aria-labelledby="prep-title">
        <div class="section-heading"><div><h2 id="prep-title">连接准备</h2></div><span class="subtle">拆桨后进行桌面操作</span></div>
        <ol class="prep-list">
          <li><strong>准备硬件</strong><p>飞控、支持数据传输的 USB 线和电脑；按设备说明供电。地面调试先拆桨，避免意外转动。</p></li>
          <li><strong>检查浏览器</strong><p>建议使用桌面 Chrome / Edge，通过安全连接访问地面站。</p><p v-if="!secureContext || !serialAvailable" class="browser-warning">当前浏览器无法连接串口。请使用桌面 Chrome / Edge，并通过 HTTPS 或本机地址打开地面站。</p></li>
          <li><strong>授权串口并连接</strong><p>点击“连接飞控”，选择正确串口与设备要求的波特率，并在浏览器弹窗中授权。关闭占用同一串口的其他软件。</p></li>
          <li><strong>等待心跳</strong><p>串口打开不等于飞控在线。收到有效心跳后才确认连接；在线后前往仪表盘查看真实数据。</p></li>
        </ol>
        <div class="doc-links"><a href="https://docs.sieon.net/product/#" target="_blank" rel="noopener noreferrer">硬件与产品说明 ↗</a><a href="https://docs.sieon.net/fmt/#/content_ch/" target="_blank" rel="noopener noreferrer">FMT 官方中文文档 ↗</a></div>
      </section>
      <section class="welcome-panel faq-panel" aria-labelledby="faq-title">
        <div class="section-heading"><div><h2 id="faq-title">常见问题</h2></div></div>
        <el-collapse>
          <el-collapse-item title="看不到串口，或提示串口被占用？" name="serial"><p>检查数据线、供电和 USB 驱动；关闭串口终端、其他地面站或已连接的浏览器标签页。重新插拔后再次授权正确的设备。</p></el-collapse-item>
          <el-collapse-item title="浏览器不支持，或连接后没有数据？" name="browser"><p>确认使用桌面 Chrome / Edge，并通过 HTTPS 或本机地址访问。按飞控端口配置选择波特率；连接后等待飞控心跳，不要将空白数据当作在线。</p></el-collapse-item>
          <el-collapse-item title="修改参数后，怎样保存到飞控？" name="save"><p>连接后通过右下角统一保存。运行参数保存后无需重启；系统配置保存并校验成功后会自动重启重连。请确认保存成功提示，失败时修改仍未保存。</p></el-collapse-item>
          <el-collapse-item title="勾完环境清单就可以起飞吗？" name="environment"><p>不可以。左侧“飞前环境”中的勾选只是人工备忘；天气参考来自 Open-Meteo 公开接口按坐标查询，不验证空域许可或设备状态。现场条件变化后必须重新检查，并依据当地法规、设备说明及实际飞前检查决定是否操作。</p></el-collapse-item>
        </el-collapse>
      </section>
    </div>
  </main>
</template>

<script setup>
import { computed, inject } from 'vue'
defineEmits(['open-connect'])
const mav = inject('mavlink')
const deviceState = mav.deviceState
const connected = computed(() => deviceState.phase === 'online')
const secureContext = typeof window !== 'undefined' && window.isSecureContext === true
const serialAvailable = typeof navigator !== 'undefined' && !!navigator.serial
</script>

<style scoped>
.welcome-page{min-height:100%;padding:clamp(18px,3vw,38px);background:var(--dsh-canvas);color:var(--dsh-text-1)}
.welcome-hero,.welcome-grid{max-width:1180px;margin:0 auto}.welcome-hero{margin-bottom:20px;padding-bottom:22px;border-bottom:1px solid var(--dsh-border)}
.eyebrow,.section-kicker{margin:0 0 7px;color:var(--dsh-accent);font-size:11px;letter-spacing:.1em}.welcome-hero h1{margin:0;font-size:clamp(28px,4vw,40px);letter-spacing:-.03em}.hero-copy{color:var(--dsh-text-2);font-size:14px;line-height:1.7;margin:12px 0}.hero-actions{display:flex;align-items:center;flex-wrap:wrap;gap:16px;margin-top:18px}a{color:var(--dsh-accent);text-underline-offset:3px}a:focus-visible{outline:2px solid var(--dsh-accent);outline-offset:4px}.hero-actions a,.doc-links a{font-size:13px}
.welcome-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}.welcome-panel{padding:20px;border:1px solid var(--dsh-border);border-radius:10px;background:var(--dsh-surface);min-width:0}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.section-heading h2{margin:0;font-size:19px}.subtle{font-size:12px;color:var(--dsh-text-3);line-height:1.6}.prep-list{padding-left:23px;margin:16px 0}.prep-list li{padding-left:6px;margin-bottom:17px;font-size:14px}.prep-list li::marker{color:var(--dsh-accent);font-weight:600}.prep-list p{margin:6px 0 0;font-size:13px;color:var(--dsh-text-2);line-height:1.7}.browser-facts{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}.browser-facts span{border:1px solid var(--dsh-border);border-radius:5px;padding:5px 8px;font-size:12px;color:var(--dsh-text-2)}.doc-links{display:flex;flex-wrap:wrap;gap:12px;padding-top:12px;border-top:1px solid var(--dsh-border)}.faq-panel p{margin:0;line-height:1.8;color:var(--dsh-text-2);font-size:13px}
@media(max-width:900px){.welcome-grid{grid-template-columns:1fr}}
@media(max-width:600px){.welcome-panel{padding:16px}.section-heading{flex-wrap:wrap}}
</style>
