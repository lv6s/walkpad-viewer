<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api, status, upload } from '../store'
const video = ref<HTMLVideoElement>()
const devices = ref<MediaDeviceInfo[]>([])
const selected = ref('')
const resolution = ref('1280x720')
const fps = ref(30)
const linked = ref(true)
const active = ref(false)
const recording = ref(false)
const message = ref('录像按块写入本次记录目录；无需在内存累积整段视频。')
let stream: MediaStream | undefined
let recorder: MediaRecorder | undefined
let chain: Promise<void> = Promise.resolve()
let pending = 0
let bytes = 0
let failed = false
let starting = false
let session = ''
let stopPromise: Promise<void> | undefined
let resolveStop: (() => void) | undefined
async function enumerate() {
  devices.value = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput')
}
async function open() {
  try {
    const [width, height] = resolution.value.split('x').map(Number)
    stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: selected.value ? { exact: selected.value } : undefined, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps.value } }, audio: false })
    video.value!.srcObject = stream
    active.value = true
    await enumerate()
    const settings = stream.getVideoTracks()[0]!.getSettings()
    message.value = `已开启 ${settings.width}×${settings.height} · ${settings.frameRate?.toFixed(1)} fps（实际协商值）`
  } catch (error) { message.value = String(error) }
}
async function start() {
  if (!stream || recording.value || starting) return
  starting = true
  try {
    if (!status.value?.recorder.recording) await api('record_start')
    const current = await (await fetch('/api/status')).json()
    session = current.recorder.session_id
    const mime = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || ''
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined)
    const id = crypto.randomUUID().replaceAll('-', '')
    let index = 0
    pending = 0; bytes = 0; failed = false; chain = Promise.resolve()
    stopPromise = new Promise(resolve => { resolveStop = resolve })
    recorder.ondataavailable = event => {
      if (!event.data.size || failed) return
      pending += event.data.size
      if (pending > 48 * 1024 * 1024) {
        failed = true
        message.value = '录像写盘跟不上，已停止录像；此前已写盘部分保留，IMU继续记录。'
        if (recorder?.state === 'recording') recorder.stop()
        return
      }
      const part = index++
      chain = chain.then(async () => {
        if (failed) return
        await upload(`/api/sessions/${encodeURIComponent(session)}/video/${id}/${part}`, event.data)
        bytes += event.data.size
        message.value = `录像已写盘 ${(bytes / 1048576).toFixed(1)} MB · 待写 ${(pending / 1048576).toFixed(1)} MB`
      }).catch(error => {
        failed = true; message.value = `录像写盘失败：${error}；已写盘部分保留`
        if (recorder?.state === 'recording') recorder.stop()
      }).finally(() => { pending -= event.data.size })
    }
    recorder.onstop = async () => {
      await chain
      recording.value = false
      if (!failed) message.value = `录像已保存 ${(bytes / 1048576).toFixed(1)} MB · 随本次记录ZIP导出`
      resolveStop?.()
    }
    recorder.onerror = event => { message.value = '录像编码错误：' + String(event); failed = true }
    recorder.start(1000)
    recording.value = true
  } catch (error) { message.value = String(error) }
  finally { starting = false }
}
async function stop() {
  if (recorder?.state === 'recording') recorder.stop()
  if (stopPromise) await stopPromise
}
async function close() { await stop(); stream?.getTracks().forEach(track => track.stop()); stream = undefined; active.value = false }
async function pip() {
  try { await video.value?.requestPictureInPicture() } catch (error) { message.value = String(error) }
}
async function shot() {
  if (!video.value || !active.value) { message.value = '先开启摄像头再拍照'; return }
  const canvas = document.createElement('canvas')
  canvas.width = video.value.videoWidth; canvas.height = video.value.videoHeight
  canvas.getContext('2d')!.drawImage(video.value, 0, 0)
  canvas.toBlob(async blob => {
    if (!blob) return
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `camera_${new Date().toISOString().replaceAll(':', '-')}.png`; anchor.click(); URL.revokeObjectURL(anchor.href)
  })
}
watch(() => status.value?.recorder.recording, async (value, old) => {
  if (value && !old && linked.value && active.value && !recording.value) await start()
  if (!value && old && recording.value) await stop()
})
function unload(event: BeforeUnloadEvent) { if (recording.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => { enumerate().catch(() => {}); window.addEventListener('beforeunload', unload) })
onUnmounted(() => { close(); window.removeEventListener('beforeunload', unload) })
defineExpose({ stop, recording })
</script>
<template><section class="panel camera-panel"><div class="panel-head"><h2>摄像头</h2><span class="badge" :class="{ live: recording }">{{ recording ? '录像写盘中' : active ? '预览中' : '未开启' }}</span></div><div class="toolbar"><select v-model="selected" :disabled="active"><option value="">默认摄像头</option><option v-for="device in devices" :key="device.deviceId" :value="device.deviceId">{{ device.label || device.deviceId }}</option></select><select v-model="resolution" :disabled="active"><option>640x480</option><option>1280x720</option><option>1920x1080</option><option>3840x2160</option></select><select v-model="fps" :disabled="active"><option :value="15">15 fps</option><option :value="30">30 fps</option><option :value="60">60 fps</option></select><button v-if="!active" @click="open">开启摄像头</button><button v-else @click="close">关闭</button><button :disabled="!active" @click="pip">画中画</button><button :disabled="!active" @click="shot">拍照</button></div><video ref="video" autoplay playsinline muted></video><div class="toolbar"><label><input v-model="linked" type="checkbox"> 随传感器记录启停</label><button :disabled="!active || recording" @click="start">开始录像</button><button :disabled="!recording" @click="stop">停止录像</button></div><p class="muted">{{ message }}</p><p class="micro">传感器记录不依赖页面；摄像头仍由浏览器持有，刷新前请先停止录像。同步点击启停不代表帧级时间同步。</p></section></template>
