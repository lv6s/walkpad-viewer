<script setup lang="ts">
import { computed } from 'vue'
import { number, type Device } from '../store'
import WaveChart from './WaveChart.vue'

const props = defineProps<{ device: Device; online: boolean; window: number }>()
const wt = computed(() => props.device.profile === 'wt')
const current = computed(() => props.online && props.device.connected ? props.device.attitude : null)
const labels = computed(() => wt.value ? ['X 角', 'Y 角', 'Z 角'] : ['俯仰', '侧倾', '相对航向'])
const hint = computed(() => !props.online ? '后台未连接' : !props.device.connected ? '设备已断开'
  : wt.value ? (current.value ? '维特设备上报，使用设备自身坐标' : '等待维特角度帧')
    : current.value?.degrees[2] != null ? '航向以当前设备和当前参考段为准，不是罗盘方向'
      : current.value ? '倾角已可用；保持静止约 2–3 秒，等待航向参考就绪' : '等待有效六轴与设备时间')
</script>

<template>
  <section class="attitude-panel">
    <div class="attitude-heading"><h3>实时姿态角</h3><span class="micro">{{ wt ? '维特设备输出' : 'Lab App 六轴算法' }}</span></div>
    <div class="attitude-readouts"><div v-for="(label, i) in labels" :key="label"><span>{{ label }}</span><strong>{{ number(current?.degrees[i], 1) }} <small>°</small></strong></div></div>
    <p class="micro">{{ hint }}</p>
    <WaveChart :device-id="device.id" metric="attitude" :window="window" :axis-labels="labels"/>
  </section>
</template>

<style scoped>
.attitude-panel{margin:16px 0;padding:14px;border:1px solid #d4e0eb;background:#f8fbfd;border-radius:9px}
.attitude-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.attitude-heading h3{font-size:14px;margin:0}
.attitude-readouts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0 6px}
.attitude-readouts span{display:block;font-size:12px;color:#60748b}
.attitude-readouts strong{font-size:22px;font-variant-numeric:tabular-nums;color:#226da9}
.attitude-readouts small{font-size:12px}
</style>
