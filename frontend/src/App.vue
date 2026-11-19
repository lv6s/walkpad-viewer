<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, clearBuffers, connect, disconnect, dropBuffers, error, idleExit, number, online, places, where, status, type Device } from './store'
import WaveChart from './components/WaveChart.vue'
import PressureMap from './components/PressureMap.vue'
import CameraPanel from './components/CameraPanel.vue'
import DeviceMetrics from './components/DeviceMetrics.vue'
import VelocityPanel from './components/VelocityPanel.vue'

const busy = ref(false)
const windowSeconds = ref(10)
const panel = ref('devices')
const protocol = ref<'insole' | 'wt'>('insole')
const source = ref('direct')
const found = ref<{ address: string; name: string; rssi: number; profile: string; kind: string | null; foot: string | null }[]>([])
const address = ref('')
const placement = ref('leftInstep')
const customLabel = ref('')
const channels = ref<Record<string, number>>({})
const commandLink = ref('v2')
const showPressure = ref(true)
const compensate = ref(true)
const sessions = ref<Record<string, any>[]>([])
const phoneConfig = ref<Record<string, any> | null>(null)
const camera = ref<InstanceType<typeof CameraPanel>>()
const showCamera = ref(false)
const selectedSession = ref('')
const message = ref('')
const closed = ref(false)
const devices = computed(() => status.value?.devices.filter(device => device.source === status.value?.source || device.connected) || [])
const recording = computed(() => status.value?.recorder.recording)
const result = computed(() => status.value?.algorithm.result || {})
const label = computed(() => ({ walk: '步行', run: '跑步', other: '其他' }[result.value.label as string] || '—'))
const sourceText: Record<string, string> = { direct: '电脑蓝牙直连', phone: '手机局域网采集', demo: '模拟数据', replay: '离线回放' }
const reasonText: Record<string, string> = { not_started: '未开始推断', warming_up: '等待窗口', bias_not_ready: '等待双脚零偏就绪', missing_foot: '等待双脚数据', stale_result: '结果已过期', device_boundary: '连接变化，重新积累窗口', network_gap: '数据中断，重新积累窗口', device_clock_unusable: '设备时间不可用', algorithm_error: '算法异常', algorithm_queue_overflow: '算法队列溢出', stale_input: '输入过期' }
async function run(action: string, args: Record<string, any> = {}) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { return await api(action, args) }
  catch (exception) { error.value = String(exception); return undefined }
  finally { busy.value = false }
}
async function changeSource() {
  const result = await run('source', { source: source.value })
  if (!result) source.value = status.value?.source || 'direct'
  if (source.value === 'phone') phoneConfig.value = await run('phone_config')
}
async function scan() { const result = await run('scan'); if (result) found.value = result.devices }
// 协议与位置互不限制：任何协议都能接任意多台设备，位置只决定是否进左右脚算法
const canConnect = computed(() => !!address.value && (placement.value !== 'custom' || !!customLabel.value.trim()))
// 按钮置灰必须给出可见原因，否则选完位置就只剩一个按不动的按钮
const connectHint = computed(() => !address.value ? '先扫描并选择设备' : placement.value === 'custom' && !customLabel.value.trim() ? '自定义位置需要填名称' : '')
async function add() {
  const hit = found.value.find(item => item.address === address.value)
  const result = await run('connect', { address: address.value, profile: protocol.value, kind: hit?.kind ?? undefined, placement: placement.value, placement_label: placement.value === 'custom' ? customLabel.value.trim() : undefined })
  if (result) message.value = '已连接 ' + result.name
}
async function forget(device: Device) {
  if (!window.confirm(`从列表移除 ${device.name}？只删除设备缓存，已保存的记录不受影响，重新扫描可以再连。`)) return
  if (await run('forget', { device_id: device.id })) {
    dropBuffers(device.id)
    message.value = '已移除 ' + device.name
  }
}
async function record() {
  if (recording.value) {
    try { await camera.value?.stop() }
    catch (exception) { error.value = String(exception) }
    await run('record_stop')
    await loadSessions()
  } else await run('record_start')
}
async function loadSessions() {
  try { sessions.value = await (await fetch('/api/sessions')).json(); if (!selectedSession.value && sessions.value.length) selectedSession.value = sessions.value[0]!.session_id }
  catch (e) { error.value = String(e) }
}
async function algorithm() { await run('algorithm', { profile: protocol.value, enabled: !status.value?.algorithm.enabled }) }
async function bias(device: Device, action: string) { await run('bias', { bias_key: device.bias_key, bias_action: action }) }
async function shutdownServer() {
  if (!window.confirm('会先停止并保存记录，再断开所有设备、结束后台进程与算法子进程。之后需要重新运行启动入口才能继续采集。确定关闭？')) return
  const result = await run('shutdown')
  if (result) { closed.value = true; message.value = '后台服务正在关闭' }
}
function download(format: string, session = selectedSession.value) { if (session) window.location.href = `/api/sessions/${encodeURIComponent(session)}/export?format=${format}` }
function biasFor(device: Device) { return status.value?.algorithm.profile === device.profile && device.profile === 'insole' ? status.value.algorithm.bias[device.bias_key] : undefined }
function kindText(kind: string | null | undefined) { return kind === 'imu' ? '自研独立IMU' : kind === 'insole' ? '自研鞋垫' : kind === 'wt' ? 'WT901' : '协议按名称推断' }
function biasText(device: Device) {
  const b = biasFor(device)
  if (!b) return '等待后台处理'
  const values = b.ready && Array.isArray(b.gyro_bias_dps) ? `(${(b.gyro_bias_dps as number[]).map(v => v.toFixed(2)).join(', ')}) °/s · ` : ''
  return values + (b.status || '')
}
function correctionOn(device: Device) { return compensate.value && !!biasFor(device)?.ready }
function formatChanged(event: Event, device: Device) { run('set_format', { device_id: device.id, value: +(event.target as HTMLSelectElement).value, link: commandLink.value }) }
function topology(event: Event, device: Device) { run('topology', { device_id: device.id, topology: (event.target as HTMLSelectElement).value }) }
watch(address, value => {
  // 广播已登记产品类型时按设备定协议：独立 IMU 与鞋垫同协议，WT 走维特协议
  const hit = found.value.find(item => item.address === value)
  if (!hit) return
  if (hit.kind === 'wt') protocol.value = 'wt'
  else if (hit.kind === 'insole' || hit.kind === 'imu') protocol.value = 'insole'
  if (hit.kind === 'insole' && hit.foot === 'l') placement.value = 'leftInstep'
  if (hit.kind === 'insole' && hit.foot === 'r') placement.value = 'rightInstep'
})
watch(() => status.value?.source, value => { if (value === 'direct' || value === 'phone') source.value = value })
onMounted(() => { connect(); loadSessions() })
onUnmounted(disconnect)
</script>

<template>
  <div class="workbench">
    <header class="app-header"><div class="brand"><div class="brand-mark">W</div><div><h1>Walkpad <span>采集工作台</span></h1><p>传感器实时采集 · 本地持久化 · 在线算法</p></div></div><div class="header-right"><span class="connection"><i :class="{ connected: online }"></i>{{ online ? '后台已连接' : '连接后台中' }}</span><span class="version">v2.0</span><button :class="recording ? 'danger' : 'primary'" :disabled="busy || !online" @click="record">{{ recording ? '停止并保存' : '开始记录' }}</button><button :disabled="busy || !online" title="立即停止记录、断开全部设备并结束后台进程（含算法子进程）；直接关闭页面时后台也会在宽限期后自动退出" @click="shutdownServer">关闭后台</button></div></header>
    <div v-if="closed" class="alert warning">后台服务已关闭：记录、蓝牙连接与算法进程都已退出。继续采集请重新运行启动入口。</div>
    <div v-if="error || status?.error || status?.recorder.error" class="alert error" role="alert">{{ error || status?.recorder.error || status?.error }}<button @click="error = ''">关闭提示</button></div>
    <div v-if="status?.source === 'demo'" class="alert warning">当前为模拟数据，仅用于验证软件链路，不是设备实测。</div>
    <div v-if="status?.recorder.recovered.length" class="alert warning">检测到 {{ status.recorder.recovered.length }} 个异常中断记录。已写出的原始日志与Parquet分段仍在记录目录，可在历史记录导出。</div>

    <section class="summary-grid"><div class="summary"><span>采集来源</span><strong>{{ sourceText[status?.source || 'direct'] }}</strong><small>{{ idleExit ? `关闭页面 ${idleExit} 秒后自动退出后台（记录进行期间不退出）` : '页面可重新连接，后台独立运行' }}</small></div><div class="summary"><span>在线设备</span><strong>{{ status?.devices.filter(device => device.connected).length || 0 }} <em>台</em></strong><small>每个连接独立协议缓冲与记录标识</small></div><div class="summary"><span>{{ recording ? '记录中 · 后台记录帧数' : '最近记录 · 后台记录帧数' }}</span><strong>{{ (status?.recorder.frames || 0).toLocaleString() }} <em>帧</em></strong><small>{{ status?.recorder.chunks || 0 }} 个Parquet分段 · 待写 {{ status?.recorder.queued || 0 }} 条</small></div><div class="summary"><span>状态推断</span><strong>{{ status?.algorithm.enabled && result.valid && online ? label : '—' }}</strong><small>{{ status?.algorithm.enabled ? (result.valid ? '有效结果 · ' + number(result.latency_ms, 1) + ' ms推断' : reasonText[result.reason] || result.reason || '等待数据') : '尚未启用' }}</small></div></section>

    <section class="panel acquisition"><div class="panel-head"><h2>采集与连接</h2><p class="muted">手机与电脑来源互斥；切换前停止记录并断开设备</p></div><div class="toolbar"><label>来源<select v-model="source" :disabled="busy || recording" @change="changeSource"><option value="direct">电脑蓝牙直连</option><option value="phone">手机采集（局域网）</option></select></label><label>自研命令合同<select v-model="commandLink"><option value="v2">144 B（现行）</option><option value="v1">80 B（旧固件）</option></select></label><label>设备协议<select v-model="protocol" :disabled="status?.algorithm.enabled"><option value="insole">自研鞋垫 / 独立IMU（同一协议）</option><option value="wt">WT901 IMU</option></select></label><template v-if="(status?.source || 'direct') === 'direct'"><button :disabled="busy" @click="scan">{{ busy ? '处理中…' : '扫描蓝牙设备' }}</button><select v-model="address"><option value="">选择设备</option><option v-for="device in found" :key="device.address" :value="device.address">{{ device.name }} · {{ kindText(device.kind) }} · {{ device.rssi }} dBm</option></select><select v-model="placement"><option v-for="(text, key) in places" :key="key" :value="key">{{ text }}</option><option value="custom">自定义位置…</option></select><input v-if="placement === 'custom'" v-model="customLabel" class="position-input" maxlength="20" placeholder="如 腰部"><button :disabled="busy || !canConnect" title="左右脚背进左右脚算法，其余位置只采集" @click="add">连接</button><span v-if="connectHint" class="micro">{{ connectHint }}</span><button :disabled="busy" @click="run('reconnect')">全部重连</button></template><button :disabled="busy" @click="run('disconnect_all')">全部断开</button><button v-if="status?.demo_allowed" :disabled="busy || recording" @click="run('demo', { profile: protocol })">模拟双脚数据</button></div><div v-if="status?.source === 'phone'" class="phone-info"><p>手机地址：<b v-for="ip in phoneConfig?.addresses" :key="ip">http://{{ ip }}:{{ phoneConfig?.port }}　</b>配对码：<code>{{ phoneConfig?.token || '点击刷新获取' }}</code><button @click="async () => phoneConfig = await run('phone_config')">刷新配对信息</button><button :disabled="recording" @click="run('phone_release')">释放手机会话</button></p><p class="muted">手机队列等待 {{ number(status.phone.phone_queue_latest_ms, 1) }} ms · 相对最低路径额外滞后 {{ number(status.phone.network_excess_ms, 1) }} ms · 真实单程延迟未知。手机接入自动建立后台原始记录；仅在可信局域网使用。</p></div><p v-if="message" class="muted">{{ message }}</p></section>

    <nav class="view-nav"><button :class="{ selected: panel === 'devices' }" @click="panel = 'devices'">实时设备</button><button :class="{ selected: panel === 'algorithm' }" @click="panel = 'algorithm'">状态推断</button><button :class="{ selected: panel === 'records' }" @click="panel = 'records'; loadSessions()">历史记录与回放</button><span class="spacer"></span><label>时间窗<select v-model="windowSeconds"><option :value="5">5 秒</option><option :value="10">10 秒</option><option :value="30">30 秒</option></select></label><label><input v-model="showPressure" type="checkbox"> 压力图</label><label><input v-model="showCamera" type="checkbox"> 摄像头</label><button @click="clearBuffers(); run('clear_display')">清空显示</button></nav>

    <main v-if="panel === 'devices'" class="device-grid"><section v-if="!devices.length" class="panel empty"><h2>准备开始采集</h2><p>电脑直连：扫描设备，指定协议与位置后连接。</p><p>随身采集：选择手机来源，用手机App填写电脑地址和配对码。</p><p class="muted">传感器原始通知和记录由后台管理，刷新页面不会主动断开蓝牙。</p></section><section v-for="device in devices" :key="device.id" class="panel device-panel"><div class="panel-head"><div><h2>{{ where(device) }} <span class="device-side">{{ device.name }}</span><span v-if="device.foot == null" class="badge">{{ device.kind === 'imu' ? '独立IMU·仅采集' : device.profile === 'insole' ? '不进推断' : '仅采集' }}</span></h2><p class="micro">{{ kindText(device.kind) }} · {{ device.address || device.source }} · {{ device.rate }} Hz · {{ device.frames.toLocaleString() }} 帧 · 坏帧 {{ device.bad }}</p></div><span class="badge" :class="{ live: device.connected }">{{ device.connected ? '已连接' : device.reconnecting ? '重连中' : '已断开' }}</span><button v-if="device.source === 'direct'" @click="run('disconnect', { device_id: device.id })">断开</button><button v-if="device.source === 'direct'" :disabled="device.connected || device.reconnecting" title="从列表移除该设备缓存，需要先断开" @click="forget(device)">移除</button></div><div class="readouts"><div v-for="(axis, i) in ['Ax', 'Ay', 'Az', 'Gx', 'Gy', 'Gz']" :key="axis"><span>{{ axis }} <small>{{ i < 3 ? 'g' : '°/s' }}</small></span><b>{{ number(device.last?.values?.[i]) }}</b></div></div><DeviceMetrics :device="device" :online="online"/><VelocityPanel :device="device" :online="online" :window="windowSeconds"/><div class="chart-label">加速度 <span>g · XYZ</span></div><WaveChart :device-id="device.id" metric="acc" :window="windowSeconds"/><div class="chart-label">角速度 <span>°/s · {{ correctionOn(device) ? '后台当时零偏补偿后（就绪前留空）' : '设备输出值' }}</span></div><WaveChart :device-id="device.id" metric="gyro" :window="windowSeconds" :corrected="correctionOn(device)"/><template v-if="device.profile === 'insole'"><div class="bias-toolbar"><span>零偏：{{ biasText(device) }}</span><label><input v-model="compensate" type="checkbox"> 显示补偿后角速度</label><button @click="bias(device, 'dynamic')">自动</button><button @click="bias(device, 'manual')">手动锁定</button><button @click="bias(device, 'start_calibration')">静止校准</button><button @click="bias(device, 'reset_bias')">重置</button></div><p v-if="!device.foot" class="micro">未标脚背位置：零偏照常补偿，但不进入步态推断。</p><div v-if="showPressure && device.has_pressure" class="pressure-grid"><PressureMap :device-id="device.id" :foot="device.foot" :format="device.format" @select="channels[device.id] = $event"/><div><div class="chart-label">压力位置 P{{ (channels[device.id] || 0) + 1 }} <span>{{ device.format === 4 ? 'g' : '格式未确认时仅原始值' }}</span></div><WaveChart :device-id="device.id" metric="pressure" :window="windowSeconds" :channel="channels[device.id] || 0"/><p class="micro">温度 {{ number(device.last?.temperature) }} ℃ · 设备序号 {{ device.last?.seq ?? '—' }}</p><label>拓扑<select :value="device.topology" :disabled="recording" @change="topology($event, device)"><option value="v2">现行 row-mirrored v2</option><option value="v1">legacy v1</option></select></label><div v-if="device.source === 'direct'" class="toolbar"><button @click="run('read_state', { device_id: device.id, link: commandLink })">回读状态</button><select :value="device.format ?? ''" @change="formatChanged($event, device)"><option value="" disabled>选择并写入输出格式</option><option :value="0">原始 ADC</option><option :value="1">采样电压</option><option :value="2">可变电压</option><option :value="3">可变阻值</option><option :value="4">重量 g</option></select></div><p class="micro">{{ device.format_status }} · {{ device.command_status }}</p></div></div><p class="micro warning-text">六轴信号无法保证区分静止零偏与稳定匀速转动。设备RTC与电脑时钟未经校时，不能据此宣称跨脚同步或真实单程延迟。</p></template><template v-else><div class="chart-label">角度 <span>° · 设备输出</span></div><WaveChart :device-id="device.id" metric="angles" :window="windowSeconds"/><button v-if="device.source === 'direct'" @click="run('info', { device_id: device.id })">读取设备信息</button></template></section></main>

    <section v-if="panel === 'algorithm'" class="panel algorithm-panel"><div class="panel-head"><h2>在线状态推断</h2><span class="badge">{{ status?.algorithm.profile === 'wt' ? 'WT脚背 R1' : '自研鞋垫' }}</span><button class="primary" :disabled="busy" @click="algorithm">{{ status?.algorithm.enabled ? '停止推断' : '开始推断' }}</button></div><div class="classification"><strong>{{ result.valid && online ? label : '—' }}</strong><div><p>{{ result.valid ? '当前结果有效' : reasonText[result.reason] || result.reason || '等待开始' }}</p><p class="muted">推断 {{ number(result.latency_ms, 1) }} ms · 算法丢弃 {{ status?.algorithm.dropped || 0 }} · {{ status?.algorithm.error || '无算法异常' }}</p></div></div><div v-for="(text, index) in ['步行', '跑步', '其他']" :key="text" class="probability"><span>{{ text }}</span><div><i :style="{ width: (result.valid && online ? (result.probabilities?.[index] || 0) * 100 : 0) + '%' }"></i></div><b>{{ result.valid && online ? number((result.probabilities?.[index] || 0) * 100, 1) + '%' : '—' }}</b></div><p class="muted">{{ status?.algorithm.model?.axis_label || '模型仅在启用推断时加载，采集不依赖推断成功。' }}</p><p class="micro">自研先在后台估计零偏，再进入原有ONNX处理契约；WT不套用自研补偿。断流和过期结果不沿用旧类别。模型迁移一致性不代表现场分类准确率。</p></section>

    <section v-if="panel === 'records'" class="panel"><div class="panel-head"><h2>记录与回放</h2><button @click="loadSessions">刷新列表</button></div><p class="muted">{{ status?.recorder.path || '记录默认保存到工具目录 records。' }}</p><div class="toolbar"><select v-model="selectedSession"><option value="">选择记录</option><option v-for="session in sessions" :key="session.session_id" :value="session.session_id">{{ session.session_id }} · {{ session.status }} · {{ session.frames || 0 }}帧{{ session.interrupted ? ' · 异常中断' : '' }}</option></select><button :disabled="!selectedSession || recording" @click="download('zip')">导出全部 ZIP</button><button :disabled="!selectedSession || recording" @click="download('parquet')">自研标准 Parquet</button><button :disabled="!selectedSession || recording" @click="download('txt')">WT官方列 TXT</button><button :disabled="!selectedSession || recording" @click="run('replay', { session_id: selectedSession }); panel = 'devices'">按原始通知回放</button></div><p class="micro">ZIP包含原始通知JSONL、Parquet分段、算法决策与录像。标准Parquet保留既有列名，但没有独立时钟同步依据时有效对齐时间留空，不把接收时刻伪装成采样时间。异常中断记录可导出已保存部分。</p><div class="record-list"><div v-for="session in sessions.slice(0, 12)" :key="session.session_id"><code>{{ session.session_id }}</code><span>{{ session.source }} · {{ session.status }} · {{ session.frames || 0 }} 帧</span><button :disabled="recording" @click="download('zip', session.session_id)">导出</button></div></div></section>

    <CameraPanel v-if="showCamera" ref="camera"/>
    <section class="panel log-panel"><div class="panel-head"><h2>运行日志</h2><span class="micro">原始采集不依赖图表刷新</span></div><p v-if="!status?.logs.length" class="micro">后台就绪后可扫描设备或接入手机。</p><div v-for="(log, index) in status?.logs.slice(-8).reverse()" :key="index" class="log-line" :class="log.level"><time>{{ new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false }) }}</time><span>{{ log.text }}</span></div></section>
    <footer><span>LOCAL FIRST · {{ status?.warning }}</span><span>旧版回退：使用工具目录中的旧版启动入口；勿同时连接同一设备</span></footer>
  </div>
</template>
