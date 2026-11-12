<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, error, number, type Device } from '../store'
import WaveChart from './WaveChart.vue'
const props = defineProps<{ device: Device; online: boolean; window: number }>()
const busy = ref(false)
const texts: Record<string, string> = {
  idle: '未初始化', calibrating: '保持相对地面静止，正在初始化', estimating: '短时积分估算中',
  expired: '已满 5 秒，请静止后重新初始化', time_gap: '采样时间重复、倒退或断流，请重新初始化',
  sequence_gap: '帧序号不连续，请重新初始化', connection_changed: '连接或时间域变化，请重新初始化',
  disconnected: '设备已断开', stale: '六轴数据已过期', invalid_sample: '六轴或时间无效',
  saturated: '输入超量程', calibration_timeout: '未取得稳定窗口，请静止后重试',
  unsupported_frames: '当前 WT 为分包输出，请使用 0x61 同帧六轴模式',
}
const valid = computed(() => props.online && props.device.connected && props.device.velocity?.valid)
async function control(start: boolean) {
  if (start && !window.confirm('请确认设备此刻相对地面静止，并继续保持约 2 秒。不能在行驶车辆、传送带或匀速运动中将速度置零。之后估算 5 秒内的传感器运动速度，是否开始？')) return
  busy.value = true
  try { await api(start ? 'velocity_start' : 'velocity_stop', { device_id: props.device.id }) }
  catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="velocity-panel">
    <div class="velocity-heading"><h3>短时速度估算 <small>实验性 · 非步行速度</small></h3><div><button :disabled="busy || !online || !device.connected" @click="control(true)">确认静止并初始化</button><button :disabled="busy || !online" @click="control(false)">停止估算</button></div></div>
    <div class="velocity-readout"><strong>{{ valid ? number(device.velocity.speed_mps, 3) : '—' }} <small>m/s</small></strong><span>{{ valid ? number((device.velocity.speed_mps ?? 0) * 3.6, 2) + ' km/h' : '无有效估算' }}</span><span>{{ online ? texts[device.velocity?.status] || '等待数据' : '后台未连接' }}</span></div>
    <div class="velocity-axes"><span v-for="(axis, i) in ['Vx', 'Vy', 'Vz']" :key="axis">{{ axis }} {{ valid ? number(device.velocity.velocity_mps?.[i], 3) : '—' }} m/s</span><span v-if="valid">剩余 {{ number(device.velocity.remaining_s, 1) }} s</span><span v-if="device.velocity?.status === 'calibrating'">初始化 {{ number(device.velocity.calibration_progress * 100, 0) }}%</span></div>
    <WaveChart :device-id="device.id" metric="speed" :window="window"/>
    <p class="micro">每台独立：静止初始化姿态与陀螺残余偏置 → 旋转到初始水平坐标系 → 扣重力 → 积分。Z 向上；XY 无地理航向，不用于设备间方向对齐。仅估算传感器本身运动，不等于人体行走速度；不自动零速修正、不输出距离。</p>
    <p class="micro">{{ device.profile === 'wt' ? 'WT 使用蓝牙接收间隔近似采样间隔，抖动与批量通知会降低精度；仅支持 0x61 同帧六轴。' : '鞋垫使用设备逐帧时间与序号；本模块单独估计陀螺残余偏置，不修改现有自动零偏与推断。' }} 5 秒是显示保护上限，不代表精度保证；超时或断流留空。原始记录与导出不变，速度暂不写入导出。</p>
  </section>
</template>
<style scoped>
.velocity-panel{margin:16px 0;padding:14px;border:1px solid #d4e0eb;background:#f8fbfd;border-radius:9px}.velocity-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.velocity-heading h3{font-size:14px;margin:0}.velocity-heading small{color:#7c6c49;font-weight:400}.velocity-heading button{margin-left:6px;font-size:12px}.velocity-readout{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:12px 0 6px}.velocity-readout strong{font-size:26px;color:#226da9}.velocity-readout small{font-size:13px}.velocity-readout span,.velocity-axes{font-size:12px;color:#60748b}.velocity-axes{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px}.micro{margin-top:8px}
</style>
