<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { buffers, number } from '../store'
const props = defineProps<{ deviceId: string; foot: string | null; format: number | null }>()
const emit = defineEmits<{ select: [channel: number] }>()
const canvas = ref<HTMLCanvasElement>()
const hover = ref('点击传感器查看该位置波形')
const selected = ref(0)
const rows: [number, number[]][] = [[45.4,[95.5,143.8]],[91.8,[69,95.5,131.5,163.5]],[145.1,[43.2,69.6,96.4,130,164.8]],[195.5,[34.6,59.6,88.9,118.4,159.9]],[232.5,[34.6,59.4,87.5,118.4,155.5]],[268.3,[33.8,60.5,89.6,118.3,151.4]],[306.1,[33.8,60.4,90,118.5]],[340.6,[38.3,67.1,100.4,128.5]],[378.4,[38.2,67.9,100.4,129.6]],[416.5,[39.5,66.6,101.2,129.4]],[454.3,[38.7,68,100.4,128.9]],[500.1,[39.3,67.9,100,127.8]],[548.7,[38.4,67.9,100.1,127.8]],[591.3,[38.5,67.1]]]
const positions = rows.flatMap(([y, xs]) => [...xs].reverse().map(x => ({ x: x / 209, y: y / 671 })))
let timer: ReturnType<typeof setInterval>
let hits: { x: number; y: number; r: number; index: number; value: number }[] = []
function draw() {
  const cv = canvas.value
  if (!cv) return
  const ratio = devicePixelRatio || 1
  const width = cv.clientWidth, height = cv.clientHeight
  if (cv.width !== width * ratio || cv.height !== height * ratio) { cv.width = width * ratio; cv.height = height * ratio }
  const ctx = cv.getContext('2d')!
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const scale = Math.min(width / 230, height / 650)
  const w = 209 * scale, h = 620 * scale, left = (width - w) / 2, top = 10
  ctx.fillStyle = '#f2f7fb'; ctx.strokeStyle = '#cbd8e5'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.ellipse(width / 2, height / 2, w * .47, h * .49, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
  const frame = buffers.get(props.deviceId)?.at(-1)
  hits = positions.map((position, index) => {
    const x = left + (props.foot === 'r' ? 1 - position.x : position.x) * w
    const y = top + position.y * h
    const value = frame?.pressure?.[index] || 0
    const intensity = Math.max(0, Math.min(1, value / (props.format === 4 ? 3000 : 4096)))
    const r = Math.max(6, 8 * scale)
    ctx.fillStyle = `hsl(${210 - intensity * 205} 78% ${94 - intensity * 42}%)`
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
    if (index === selected.value) { ctx.strokeStyle = '#172f48'; ctx.lineWidth = 2; ctx.stroke() }
    ctx.fillStyle = '#233b53'; ctx.font = `${Math.max(7, 7.5 * scale)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(index + 1), x, y)
    return { x, y, r, index, value }
  })
}
function pointer(event: MouseEvent, choose = false) {
  const rect = canvas.value!.getBoundingClientRect()
  const hit = hits.find(hit => Math.hypot(event.clientX - rect.left - hit.x, event.clientY - rect.top - hit.y) < hit.r + 3)
  if (!hit) return
  const unit = props.format === 4 ? 'g' : props.format === 0 ? 'ADC' : props.format == null ? '原始值（格式未确认）' : ['ADC', 'V', 'V', 'Ω', 'g'][props.format]
  hover.value = `P${hit.index + 1} · ${number(hit.value, 0)} ${unit}`
  if (choose) { selected.value = hit.index; emit('select', hit.index) }
}
onMounted(() => { draw(); timer = setInterval(draw, 100) })
onUnmounted(() => clearInterval(timer))
</script>
<template><div class="pressure-map"><canvas ref="canvas" @mousemove="pointer($event)" @click="pointer($event, true)"></canvas><p class="muted">{{ hover }}</p><p class="micro">当前帧稀疏快照；未上报位置显示0，不以历史保持值冒充当前压力。</p></div></template>
