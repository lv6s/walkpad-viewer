<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { number, type Device } from '../store'

const props = defineProps<{ device: Device; online: boolean }>()
const now = ref(Date.now())
const receivedAt = ref(0)
watch([() => props.device.last?.cursor, () => props.device.connected, () => props.online], () => {
  receivedAt.value = Date.now()
}, { immediate: true })
const timer = setInterval(() => { now.value = Date.now() }, 500)
onUnmounted(() => clearInterval(timer))
const fresh = computed(() => props.online && props.device.connected && !!props.device.last && now.value - receivedAt.value < 2000)
const magnitude = computed(() => {
  const axes = props.device.last?.values?.slice(0, 3)
  return fresh.value && axes?.length === 3 && axes.every(v => typeof v === 'number' && Number.isFinite(v))
    ? Math.hypot(...axes as number[]) : undefined
})
const temperature = computed(() => fresh.value ? props.device.last?.temperature : undefined)
</script>

<template>
  <div class="device-metrics">
    <div class="metric-card" data-metric="acceleration-magnitude" title="当前帧 √(Ax² + Ay² + Az²)，包含重力，不做归一化或去重力">
      <span>加速度模长 <small>g</small></span>
      <strong>{{ number(magnitude, 4) }}</strong>
      <small>含重力 · 当前帧</small>
    </div>
    <div class="metric-card" data-metric="temperature" title="设备回传温度，不代表环境温度或体温">
      <span>设备温度 <small>°C</small></span>
      <strong>{{ number(temperature, 2) }}</strong>
      <small>设备回传 · 非环境温度</small>
    </div>
  </div>
</template>

<style scoped>
.device-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:-8px 0 20px}
.metric-card{display:flex;flex-direction:column;gap:3px;border:1px solid #dce7ef;border-radius:7px;padding:10px 12px;background:#f5f9fc}
.metric-card>span{font-size:12px;color:#60748b}
.metric-card strong{font-family:Consolas,monospace;font-size:21px;font-weight:500;color:#38536f;font-variant-numeric:tabular-nums}
.metric-card small{font-size:11px;color:#718499}
</style>
