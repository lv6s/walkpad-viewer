<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { buffers, number } from '../store'
const props = defineProps<{ deviceId: string; foot: string | null; format: number | null }>()
const emit = defineEmits<{ select: [channel: number] }>()
const canvas = ref<HTMLCanvasElement>()
const hover = ref('点击传感器查看该位置波形')
const selected = ref(0)

const W = 209, H = 671
const rows: [number, number[]][] = [[45.4,[95.5,143.8]],[91.8,[69,95.5,131.5,163.5]],[145.1,[43.2,69.6,96.4,130,164.8]],[195.5,[34.6,59.6,88.9,118.4,159.9]],[232.5,[34.6,59.4,87.5,118.4,155.5]],[268.3,[33.8,60.5,89.6,118.3,151.4]],[306.1,[33.8,60.4,90,118.5]],[340.6,[38.3,67.1,100.4,128.5]],[378.4,[38.2,67.9,100.4,129.6]],[416.5,[39.5,66.6,101.2,129.4]],[454.3,[38.7,68,100.4,128.9]],[500.1,[39.3,67.9,100,127.8]],[548.7,[38.4,67.9,100.1,127.8]],[591.3,[38.5,67.1]]]
const points = rows.flatMap(([y, xs]) => [...xs].reverse().map(x => ({ x: x / W, y: y / H })))
const edge: [number, number, number][] = [[0.0045,0.5885,0.6459],[0.0164,0.4641,0.7368],[0.0283,0.4067,0.7799],[0.0402,0.3636,0.8086],[0.0522,0.3301,0.8325],[0.0641,0.3014,0.8565],[0.076,0.2775,0.8708],[0.0879,0.2536,0.8852],[0.0999,0.2344,0.8995],[0.1326,0.1866,0.9187],[0.1654,0.1483,0.933],[0.1982,0.1196,0.933],[0.231,0.0957,0.9282],[0.2638,0.0766,0.9234],[0.2966,0.067,0.9091],[0.3294,0.0622,0.89],[0.3621,0.0574,0.8612],[0.3949,0.0622,0.8325],[0.4277,0.0622,0.8038],[0.4605,0.0718,0.7751],[0.4933,0.0766,0.7512],[0.5261,0.0766,0.7368],[0.5589,0.0813,0.7273],[0.5917,0.0813,0.7225],[0.6244,0.0813,0.7177],[0.6572,0.0813,0.7177],[0.69,0.0766,0.7129],[0.7228,0.0766,0.7081],[0.7556,0.0718,0.7033],[0.7884,0.067,0.6986],[0.8212,0.067,0.689],[0.8539,0.0718,0.6794],[0.8867,0.0861,0.6603],[0.8987,0.0957,0.6555],[0.9106,0.11,0.6459],[0.9225,0.1244,0.6316],[0.9344,0.1435,0.6172],[0.9463,0.1627,0.5981],[0.9583,0.1914,0.5742],[0.9702,0.2297,0.5407],[0.9762,0.2632,0.512]]

// 色阶走 sqrt：重量档满量程下正常踩踏集中在低端，线性会分不出深浅
const stops: [number, number, number, number][] = [[0,255,255,255],[0.04,226,232,240],[0.32,255,209,153],[0.62,246,134,46],[1,190,30,30]]
const units = ['ADC','V','V','Ω','g']

function span() { return props.format === 4 ? 2200 : 4096 }
function base() { return props.format === 4 ? 100 : 0 }
function unit() { return props.format == null ? '原始值（格式未确认）' : units[props.format] ?? '原始值' }

function color(value: number) {
  const t = Math.sqrt(Math.max(0, Math.min(1, (value - base()) / span())))
  let i = 1
  while (i < stops.length - 1 && t > stops[i]![0]) i++
  const a = stops[i - 1]!, b = stops[i]!
  const k = (t - a[0]) / (b[0] - a[0] || 1)
  const c = (j: number) => Math.round(a[j]! + (b[j]! - a[j]!) * k)
  return `rgb(${c(1)},${c(2)},${c(3)})`
}
function label(value: number) {
  if (value >= 9995) return '10k'
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
  return String(Math.round(value))
}

let timer: ReturnType<typeof setInterval>
let hits: { x: number; y: number; r: number; index: number; value: number }[] = []
let radiusKey = '', radiusValue = 10

function radius(bw: number, bh: number) {
  const key = bw.toFixed(1) + 'x' + bh.toFixed(1)
  if (key === radiusKey) return radiusValue
  let min = Infinity
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = (points[i]!.x - points[j]!.x) * bw
      const dy = (points[i]!.y - points[j]!.y) * bh
      const d = dx * dx + dy * dy
      if (d < min) min = d
    }
  }
  radiusKey = key
  radiusValue = Math.max(7, Math.sqrt(min) / 2 - 1.2)
  return radiusValue
}

function draw() {
  const cv = canvas.value
  if (!cv) return
  const ratio = devicePixelRatio || 1
  const width = cv.clientWidth, height = cv.clientHeight
  if (cv.width !== width * ratio || cv.height !== height * ratio) { cv.width = width * ratio; cv.height = height * ratio }
  const ctx = cv.getContext('2d')!
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  // 保持脚型长宽比，居中放，避免点被横向拉扁；长宽比固定，放大只能靠画布高度
  const asp = W / H
  let bw = width, bh = width / asp
  if (bh > height) { bh = height; bw = height * asp }
  const ox = (width - bw) / 2, oy = (height - bh) / 2
  // 右脚点位与轮廓一起镜像；只在 X 里翻一次
  const mirror = props.foot === 'r'
  const X = (nx: number) => ox + (mirror ? 1 - nx : nx) * bw
  const Y = (ny: number) => oy + ny * bh

  const path = edge.map(([y, xl]) => [xl, y] as [number, number])
    .concat([...edge].reverse().map(([y, , xr]) => [xr, y] as [number, number]))
  ctx.beginPath()
  path.forEach((p, i) => {
    if (!i) { ctx.moveTo(X(p[0]), Y(p[1])); return }
    const q = path[i - 1]!
    ctx.quadraticCurveTo(X(q[0]), Y(q[1]), X((q[0] + p[0]) / 2), Y((q[1] + p[1]) / 2))
  })
  ctx.closePath()
  ctx.fillStyle = '#fbfcfe'; ctx.fill()
  ctx.strokeStyle = '#dbe2ec'; ctx.lineWidth = 1.4; ctx.stroke()

  const frame = buffers.get(props.deviceId)?.at(-1)
  const pressure = frame?.pressure
  const r = radius(bw, bh)
  hits = points.map((position, index) => {
    const x = X(position.x), y = Y(position.y)
    const value = pressure?.[index] ?? 0
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = color(value); ctx.fill()
    // 0 值点也要描边，否则在白底上直接消失，鞋垫看着像空的
    ctx.strokeStyle = value > base() ? 'rgba(120,60,10,.55)' : '#d5dde7'
    ctx.lineWidth = value > base() ? 1.4 : 1.2
    ctx.stroke()
    if (value >= span() * 0.999) { ctx.strokeStyle = '#7a1616'; ctx.lineWidth = 2.2; ctx.stroke() }
    const text = label(value)
    ctx.fillStyle = (value - base()) / span() > 0.34 ? '#fff' : '#5b6a7d'
    const size = Math.min(r * 0.95, (2 * r * 0.88) / (0.62 * Math.max(1, text.length)))
    ctx.font = `700 ${Math.max(6, size).toFixed(1)}px ui-monospace,Consolas,monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(text, x, y + 0.5)
    if (index === selected.value) {
      ctx.beginPath(); ctx.arc(x, y, r + 4.5, 0, Math.PI * 2); ctx.strokeStyle = '#1971c2'; ctx.lineWidth = 2.4; ctx.stroke()
    }
    return { x, y, r, index, value }
  })
}

function pointer(event: MouseEvent, choose = false) {
  const rect = canvas.value!.getBoundingClientRect()
  const hit = hits.find(h => Math.hypot(event.clientX - rect.left - h.x, event.clientY - rect.top - h.y) < h.r + 3)
  if (!hit) return
  hover.value = `P${hit.index + 1} · ${number(hit.value, 0)} ${unit()}`
  if (choose) { selected.value = hit.index; emit('select', hit.index) }
}
onMounted(() => { draw(); timer = setInterval(draw, 100) })
onUnmounted(() => clearInterval(timer))
</script>
<template><div class="pressure-map"><canvas ref="canvas" @mousemove="pointer($event)" @click="pointer($event, true)"></canvas><p class="muted">{{ hover }}</p><p class="micro">点内为该位置本帧压力值（{{ unit() }}），颜色同一色阶。当前帧未上报的位置显示0，不以历史保持值冒充当前压力。</p></div></template>
