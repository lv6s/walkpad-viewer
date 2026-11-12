<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, error, number, type Device } from '../store'
import WaveChart from './WaveChart.vue'
const props = defineProps<{ device: Device; online: boolean; window: number }>()
const busy = ref(false)
const chartMode = ref<'speed' | 'velocity'>('speed')
const texts: Record<string, string> = {
  idle: '未初始化', calibrating: '保持相对地面静止，正在初始化', estimating: '连续惯性估算中',
  time_gap: '采样时间重复、倒退或断流，请重新初始化',
  sequence_gap: '帧序号不连续，请重新初始化', connection_changed: '连接或时间域变化，请重新初始化',
  disconnected: '设备已断开', stale: '六轴数据已过期', invalid_sample: '六轴或时间无效',
  saturated: '输入超量程', calibration_timeout: '未取得合格静止窗或零偏未就绪，请静止后重试',
  bias_unavailable: '在线零偏不可用，请等待恢复后重新初始化',
  device_clock_unusable: '设备逐帧时间不可用，请恢复后重新初始化',
  bias_boundary: '零偏重置或发生不连续，请重新初始化',
  unsupported_frames: '当前 WT 为分包输出，请使用 0x61 同帧六轴模式',
}
const valid = computed(() => props.online && props.device.connected && props.device.velocity?.valid)
async function control(start: boolean) {
  if (start && !window.confirm('请确认设备相对地面静止，并继续保持约 5 秒（窗口不合格会延长）。不能在行驶车辆、传送带或匀速运动中将速度置零。初始化后延续本次地面静止约束，检测到运动即退出；之后不自动判零速，需再次确认静止才能恢复。小于检测阈值的缓慢运动仍可能误判，不能用于车辆或传送带。是否开始？')) return
  busy.value = true
  try { await api(start ? 'velocity_start' : 'velocity_stop', { device_id: props.device.id }) }
  catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="velocity-panel">
    <div class="velocity-heading"><h3>连续速度估算 <small>实验性 · 传感器速度，非人体步速</small></h3><div><button :disabled="busy || !online || !device.connected" @click="control(true)">确认静止并初始化</button><button :disabled="busy || !online" @click="control(false)">停止估算</button></div></div>
    <div class="velocity-readout"><strong>{{ valid ? number(device.velocity.speed_mps, 3) : '—' }} <small>m/s</small></strong><span>{{ valid ? number((device.velocity.speed_mps ?? 0) * 3.6, 2) + ' km/h' : '无有效估算' }}</span><span>{{ online ? texts[device.velocity?.status] || '等待数据' : '后台未连接' }}</span></div>
    <div class="velocity-axes"><span v-for="(axis, i) in ['水平 Vx', '水平 Vy', '垂直 Vz（向上为正）']" :key="axis">{{ axis }} {{ valid ? number(device.velocity.velocity_mps?.[i], 3) : '—' }} m/s</span><span v-if="valid">距零速初始化 {{ number(device.velocity.elapsed_s, 1) }} s</span><span v-if="device.velocity?.status === 'calibrating'">静止窗 {{ number(device.velocity.calibration_progress * 100, 0) }}%{{ device.profile === 'insole' && !device.velocity.bias_ready ? ' · 等待在线零偏就绪' : '' }}</span></div>
    <label class="micro">曲线 <select v-model="chartMode"><option value="speed">合速度</option><option value="velocity">三个方向分量</option></select></label>
    <WaveChart :device-id="device.id" :metric="chartMode" :window="window"/>
    <p v-if="valid" class="micro"><strong>{{ device.velocity.constraint === 'confirmed_ground_rest' ? '地面静止约束中（基于本次人工确认）' : '运动积分：无零速约束，误差会累积' }}</strong> · 约束更新 {{ device.velocity.constraint_updates ?? 0 }} 次</p>
    <p class="micro">每台独立：在线扣偏角速度 → 姿态传播 → 扣重力 → 积分；人工确认的静止段用误差状态滤波联合修正速度、倾斜和加速度残差。残差并非六面校准结果，单姿态无法分离全部误差。Z 向上；XY 为固定初始水平轴，不是人体前后左右。</p>
    <p class="micro">{{ device.profile === 'wt' ? 'WT 使用本次初始化陀螺偏置，仅支持 0x61 同帧六轴；接收抖动影响精度。' : '鞋垫逐帧复用在线零偏，仅扣一次；正常偏置更新不重置速度。' }} 静止约束检测到运动即退出，不因随后六轴稳定而恢复；缓慢运动仍可能漏检，需要再次人工确认零速。未启用脚载支撑期自动 ZUPT，未验证运动测速精度。断流或不连续时暂停，原始记录与导出不变。</p>
  </section>
</template>
<style scoped>
.velocity-panel{margin:16px 0;padding:14px;border:1px solid #d4e0eb;background:#f8fbfd;border-radius:9px}.velocity-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.velocity-heading h3{font-size:14px;margin:0}.velocity-heading small{color:#7c6c49;font-weight:400}.velocity-heading button{margin-left:6px;font-size:12px}.velocity-readout{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:12px 0 6px}.velocity-readout strong{font-size:26px;color:#226da9}.velocity-readout small{font-size:13px}.velocity-readout span,.velocity-axes{font-size:12px;color:#60748b}.velocity-axes{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px}.micro{margin-top:8px}
</style>
