<template><div ref="el" class="aircraft-3d" :class="{ compact }"></div></template>
<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as THREE from 'three'
const props = defineProps({
  roll: { type: Number, default: 0 },
  pitch: { type: Number, default: 0 },
  yaw: { type: Number, default: 0 },
  throttle: { type: Number, default: 0 },
  compact: Boolean,
})
const el = ref(null)
let scene,
  camera,
  renderer,
  drone,
  props3 = [],
  raf
// 机头为 +Z（摄像头侧），机体左为 +X；从机体上方俯视，绕 +Y 的负角为顺时针。
const rotorDirections = [-1, 1, 1, -1] // 左前顺、右前逆、左后逆、右后顺，对应 build 的四臂顺序。
function build() {
  const bodyMat = new THREE.MeshPhongMaterial({ color: 0x2c3e50 }),
    armMat = new THREE.MeshPhongMaterial({ color: 0x34495e }),
    motorMat = new THREE.MeshPhongMaterial({ color: 0x1a1a2e }),
    propMat = new THREE.MeshPhongMaterial({ color: 0xbdc3c7, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    camMat = new THREE.MeshPhongMaterial({ color: 0xe74c3c })
  drone = new THREE.Group()
  drone.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 1), bodyMat))
  ;[
    { x: 1, z: 1, r: (Math.PI * 3) / 4 },
    { x: -1, z: 1, r: (-Math.PI * 3) / 4 },
    { x: 1, z: -1, r: (-Math.PI * 3) / 4 },
    { x: -1, z: -1, r: (Math.PI * 3) / 4 },
  ].forEach((c) => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 0.4), armMat)
    a.position.set(c.x, 0, c.z)
    a.rotation.y = c.r
    drone.add(a)
    const x = c.x + (c.x > 0 ? 1 : -1),
      z = c.z + (c.z > 0 ? 1 : -1)
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.6, 16), motorMat)
    m.position.set(x, 0, z)
    drone.add(m)
    const pg = new THREE.Group()
    pg.add(new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.06, 0.5), propMat))
    pg.position.set(x, 0.7, z)
    drone.add(pg)
    props3.push(pg)
  })
  const cam = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.25, 1, 12), camMat)
  cam.position.set(0, 0, 1)
  cam.rotation.x = Math.PI / 2
  drone.add(cam)
  return drone
}
function resize() {
  if (!el.value || !camera) return
  const w = el.value.clientWidth,
    h = el.value.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}
function init() {
  const w = el.value.clientWidth,
    h = el.value.clientHeight
  scene = new THREE.Scene()
  scene.background = null
  camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200)
  camera.position.set(0, 5.5, 11.5)
  camera.lookAt(0, 0, 0)
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  el.value.appendChild(renderer.domElement)
  scene.add(new THREE.AmbientLight(0xffffff, 0.7))
  const light = new THREE.DirectionalLight(0xffffff, 1.2)
  light.position.set(8, 12, 6)
  scene.add(light)
  drone = build()
  drone.scale.setScalar(props.compact ? 1.35 : 1.6)
  scene.add(drone)
  const loop = () => {
    raf = requestAnimationFrame(loop)
    drone.rotation.set(
      THREE.MathUtils.degToRad(-props.pitch),
      THREE.MathUtils.degToRad(-props.yaw),
      THREE.MathUtils.degToRad(props.roll)
    )
    props3.forEach((p, i) => (p.rotation.y += (0.04 + (props.throttle / 100) * 0.25) * rotorDirections[i]))
    renderer.render(scene, camera)
  }
  loop()
  window.addEventListener('resize', resize)
}
onMounted(init)
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>
<style scoped>
.aircraft-3d {
  width: 100%;
  height: 100%;
  min-height: 180px;
  overflow: hidden;
  background: var(--dsh-console-bg);
  border: 1px solid var(--dsh-border);
  border-radius: var(--dsh-radius);
}
.aircraft-3d.compact {
  min-height: 150px;
}
</style>
