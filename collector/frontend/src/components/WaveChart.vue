<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import uPlot from 'uplot'
import { buffers } from '../store'

const props = withDefaults(defineProps<{ deviceId: string; metric: 'acc' | 'gyro' | 'attitude' | 'pressure'; window: number; channel?: number; corrected?: boolean; axisLabels?: string[] }>(), { channel: 0, corrected: false })
const box = ref<HTMLDivElement>()
let chart: uPlot | undefined
let observer: ResizeObserver | undefined
let timer: ReturnType<typeof setInterval> | undefined
const colors = ['#dd493e', '#279a6b', '#2875c7']
function draw() {
  if (!chart || !box.value?.getClientRects().length) return
  const frames = buffers.get(props.deviceId) || []
  const last = frames.at(-1)
  const end = (last?.receipt_ms ?? 0) / 1000
  const attitude = props.metric === 'attitude'
  const visible = frames.filter(frame => frame.receipt_ms / 1000 >= end - props.window &&
    (attitude ? frame.attitude !== undefined : frame.values != null))
  const xs: number[] = []
  const ys: (number | null)[][] = props.metric === 'pressure' ? [[]] : [[], [], []]
  const maximum = Math.max(500, box.value.clientWidth * 2)
  const stride = attitude ? 1 : Math.max(1, Math.ceil(visible.length / maximum))
  for (let i = 0; i < visible.length; i += stride) {
    const frame = visible[i]!
    const x = frame.receipt_ms / 1000 - end
    const previous = attitude ? visible[i - 1] : undefined
    if (previous && frame.attitude && previous.attitude) {
      const boundary = frame.attitude.reference_id !== previous.attitude.reference_id || frame.receipt_ms - previous.receipt_ms > 500
      const wrap = frame.attitude.degrees.map((value, axis) => {
        const before = previous.attitude?.degrees[axis]
        return value != null && before != null && Math.abs(value - before) > 180
      })
      if (boundary || wrap.some(Boolean)) {
        xs.push((xs[xs.length - 1]! + x) / 2)
        for (let axis = 0; axis < ys.length; axis++) {
          const a = previous.attitude.degrees[axis], b = frame.attitude.degrees[axis]
          ys[axis]!.push(boundary || wrap[axis] || a == null || b == null ? null : (a + b) / 2)
        }
      }
    }
    xs.push(x)
    for (let axis = 0; axis < ys.length; axis++) {
      let value: number | null | undefined
      if (props.metric === 'attitude') value = frame.attitude?.degrees[axis]
      else if (props.metric === 'pressure') value = frame.pressure?.[props.channel]
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
  const single = props.metric === 'pressure'
  chart = new uPlot({
    width: box.value.clientWidth || 600, height: 185,
    padding: [12, 12, 0, 0],
    scales: { x: { time: false, auto: false, range: [-props.window, 0] } },
    series: [{}, ...(single ? [{ label: `P${props.channel + 1}`, stroke: colors[0], width: 1.4, spanGaps: false }] : colors.map((color, axis) => ({ label: props.axisLabels?.[axis] ?? 'XYZ'[axis], stroke: color, width: 1.2, spanGaps: false })))],
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
watch(() => [props.metric, props.axisLabels], create)
onUnmounted(() => { clearInterval(timer); observer?.disconnect(); chart?.destroy() })
</script>
<template><div ref="box" class="wave-chart"></div></template>
