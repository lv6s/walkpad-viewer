import { ref, shallowRef } from 'vue'
import { openVisionSocket, type ActionRules, type IdModel, type VisionTarget } from './store'

interface Person {
  id: number; box: [number, number, number, number]; action: string
  status: 'confirmed' | 'candidate' | 'unknown'; count: number
}

interface TrackReview {
  track_id: number; start_s: number; last_seen_s: number
  person_id: number | null; suggested_id: number | null
  status: 'confirmed_tracklet' | 'live_reconnected' | 'needs_review'
}

export function cameraVision(video: () => HTMLVideoElement | undefined, draw: (canvas: HTMLCanvasElement) => void) {
  const enabled = ref(false)
  const message = ref('')
  const people = shallowRef<Person[]>([])
  const review = shallowRef<{ tracks: TrackReview[]; overflow: boolean }>()
  let socket: WebSocket | undefined
  let videoCallback: number | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let waitReview: ReturnType<typeof setTimeout> | undefined
  let readyForReview = false
  let finishing = false

  function finish() {
    if (finishing) return
    if (!readyForReview || socket?.readyState !== WebSocket.OPEN) { stop(); return }
    finishing = true
    if (videoCallback !== undefined) video()?.cancelVideoFrameCallback(videoCallback)
    videoCallback = undefined
    clearTimeout(expiry)
    people.value = []
    message.value = '正在复核复入轨迹…'
    socket.send(new Uint8Array(4))
    waitReview = setTimeout(() => { message.value = '身份复核超时，未生成结果'; stop() }, 15000)
  }

  function stop() {
    enabled.value = false
    if (videoCallback !== undefined) video()?.cancelVideoFrameCallback(videoCallback)
    videoCallback = undefined
    clearTimeout(expiry)
    clearTimeout(waitReview)
    readyForReview = false
    finishing = false
    people.value = []
    const old = socket
    socket = undefined
    old?.close()
  }

  function start(target: VisionTarget, idModel: IdModel, actionRules: ActionRules) {
    stop()
    review.value = undefined
    const v = video()
    if (!v?.requestVideoFrameCallback) { message.value = '当前浏览器不支持实时取帧'; return }
    let current: WebSocket
    try { current = openVisionSocket(target, idModel, actionRules) }
    catch (error) { message.value = String(error); return }
    socket = current
    enabled.value = true
    message.value = target === 'workstation' ? '正在连接工作站识别…' : '正在启动本机识别…'
    const input = document.createElement('canvas')
    let encoding = false, outstanding = 0, seq = 0, newest = 0, lastSent = -Infinity, lastMedia = -1
    const maxAgeMs = 1000
    let source = ''

    const frame: VideoFrameRequestCallback = (now, { mediaTime }) => {
      if (socket !== current) return
      videoCallback = v.requestVideoFrameCallback(frame)
      if (encoding || outstanding >= 1 || current.bufferedAmount || mediaTime <= lastMedia || now - lastSent < 65) return
      encoding = true
      draw(input)
      input.toBlob(blob => {
        encoding = false
        if (!blob || finishing || socket !== current || current.readyState !== WebSocket.OPEN) return
        const header = new DataView(new ArrayBuffer(12))
        header.setUint32(0, ++seq)
        header.setFloat64(4, mediaTime)
        lastSent = now
        lastMedia = mediaTime
        outstanding++
        current.send(new Blob([header.buffer, blob]))
      }, 'image/jpeg', .82)
    }
    current.onmessage = ({ data }) => {
      if (socket !== current) return
      const event = JSON.parse(data)
      if (event.type === 'ready') {
        const identity = event.identity || idModel
        readyForReview = identity === 'collection-reid'
        const mode = readyForReview ? '采集 ReID GPU' : identity === 'tracktrack-reid'
          ? ['TrackTrack/ReID', event.reid_device].filter(Boolean).join(' ')
          : identity === 'reid' ? 'ReID' : ''
        const rules = event.rules || actionRules
        source = [event.device, mode, rules !== 'v1' ? `规则 ${rules}` : '',
          event.server_version ? `服务 v${event.server_version}` : ''].filter(Boolean).join(' · ')
        message.value = `${source} · 等待画面`
        videoCallback = v.requestVideoFrameCallback(frame)
      } else if (event.type === 'result') {
        outstanding = Math.max(0, outstanding-1)
        if (finishing || event.seq <= newest) return
        newest = event.seq
        const remaining = maxAgeMs - Math.max(0, (v.currentTime-event.t)*1000)
        clearTimeout(expiry)
        people.value = remaining > 0 ? event.people : []
        const pending = event.pending_count > 0 ? `待确认身份 ${event.pending_count}` : ''
        const state = event.people.length ? `跟踪 ${event.people.length} 人` : '未跟踪到人体'
        message.value = remaining <= 0 ? `${source} · 识别结果已过期`
          : [source, state, pending].filter(Boolean).join(' · ')
        if (remaining > 0) expiry = setTimeout(() => { people.value = []; message.value = `${source} · 等待新结果` }, remaining)
      } else if (event.type === 'review' && finishing) {
        review.value = { tracks: event.tracks, overflow: event.overflow }
        message.value = '身份复核候选已生成；候选未计入正式动作'
        stop()
      } else if (event.type === 'error') {
        message.value = event.message
        stop()
      }
    }
    current.onclose = () => {
      if (socket !== current) return
      message.value = '实时识别已断开；可重新开启'
      stop()
    }
  }

  return { enabled, message, people, review, start, stop, finish }
}
