<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import uPlot from 'uplot'
import { buffers } from '../store'

const props = withDefaults(defineProps<{ deviceId: string; metric: 'acc' | 'gyro' | 'angles' | 'pressure' | 'speed'; window: number; channel?: number; corrected?: boolean }>(), { channel: 0, corrected: false })
const box = ref<HTMLDivElement>()
let chart: uPlot | undefined
let observer: ResizeObserver | undefined
let timer: ReturnType<typeof setInterval> | undefined
const colors = ['#dd493e', '#279a6b', '#2875c7']
function draw() {
  if (!chart || !box.value?.getClientRects().length) return
  const frames = buffers.get(props.deviceId) || []
  const last = frames.at(-1)
  if (!last) return
  const end = last.receipt_ms / 1000
  const visible = frames.filter(frame => frame.receipt_ms / 1000 >= end - props.window)
  const xs: number[] = []
  const ys: (number | null)[][] = props.metric === 'pressure' || props.metric === 'speed' ? [[]] : [[], [], []]
  const maximum = Math.max(500, box.value.clientWidth * 2)
  const stride = Math.max(1, Math.ceil(visible.length / maximum))
  for (let i = 0; i < visible.length; i += stride) {
    const frame = visible[i]!
    xs.push(frame.receipt_ms / 1000 - end)
    for (let axis = 0; axis < ys.length; axis++) {
      let value: number | null | undefined
      if (props.metric === 'speed') value = frame.velocity?.valid ? frame.velocity.speed_mps : null
      else if (props.metric === 'pressure') value = frame.pressure?.[props.channel]
      else if (props.metric === 'angles') value = frame.angles?.[axis]
      else {
        value = frame.values?.[axis + (props.metric === 'gyro' ? 3 : 0)]
        if (props.metric === 'gyro' && props.corrected) value = value == null || !frame.bias_used ? null : value - (frame.bias_used[axis] ?? 0)
      }
      ys[axis]!.push(value ?? null)
    }
  }
  chart.setData([xs, ...ys] as uPlot.AlignedData)
  chart.setScale('x', { min: -props.window, max: 0 })
}
function create() {
  chart?.destroy()
  if (!box.value) return
  const single = props.metric === 'pressure' || props.metric === 'speed'
  chart = new uPlot({
    width: box.value.clientWidth || 600, height: 185,
    padding: [12, 12, 0, 0],
    scales: { x: { time: false, auto: false, range: [-props.window, 0] } },
    series: [{}, ...(single ? [{ label: props.metric === 'speed' ? '合速度 m/s' : `P${props.channel + 1}`, stroke: colors[0], width: 1.4, spanGaps: false }] : colors.map((color, axis) => ({ label: 'XYZ'[axis], stroke: color, width: 1.2, spanGaps: false })))],
    axes: [{ stroke: '#7e8b9c', grid: { stroke: '#edf1f5' }, values: (_u, ticks) => ticks.map(value => `${value.toFixed(0)}s`) }, { stroke: '#7e8b9c', grid: { stroke: '#edf1f5' }, size: 54 }],
    legend: { show: true },
    cursor: { drag: { x: true, y: false } },
  }, (single ? [[], []] : [[], [], [], []]) as uPlot.AlignedData, box.value)
  draw()
}
onMounted(() => {
  create()
  observer = new ResizeObserver(() => { if (box.value && chart) chart.setSize({ width: box.value.clientWidth || 600, height: 185 }) })
  observer.observe(box.value!)
  timer = setInterval(draw, 50)
})
watch(() => props.metric, create)
onUnmounted(() => { clearInterval(timer); observer?.disconnect(); chart?.destroy() })
</script>
<template><div ref="box" class="wave-chart"></div></template>
