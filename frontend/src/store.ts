import { shallowRef, ref } from 'vue'

export interface Frame {
  cursor: number
  device_id: string
  foot: string | null
  profile: 'wt' | 'insole'
  receipt_ms: number
  epoch_ms: number
  values: (number | null)[] | null
  angles?: number[]
  pressure?: number[]
  temperature?: number
  device_ms?: number | null
  seq?: number
}
export interface Device {
  id: string; name: string; profile: 'wt' | 'insole'; foot: string | null; source: string
  connected: boolean; reconnecting: boolean; frames: number; bad: number; rate: number
  last: Frame | null; topology: string; format: number | null; format_status: string; command_status: string
}
export interface Status {
  version: string; source: string; devices: Device[]; cursor: number; demo_allowed: boolean
  recorder: { recording: boolean; session_id: string | null; path: string; frames: number; chunks: number; events: number; queued: number; error: string | null; recovered: string[]; draining: boolean }
  algorithm: { enabled: boolean; profile: string; result: Record<string, any>; bias: Record<string, any>; error: string | null; dropped: number; model?: Record<string, any> }
  phone: Record<string, any>; error: string | null; warning: string
  logs: { time: number; text: string; level: string }[]
}
export const status = shallowRef<Status | null>(null)
export const online = ref(false)
export const error = ref('')
export const revision = ref(0)
export const buffers = new Map<string, Frame[]>()
let token = ''
let socket: WebSocket | null = null
let retry: ReturnType<typeof setTimeout> | undefined
let stopped = false
let previousServer = ''

export async function api<T = any>(action: string, args: Record<string, any> = {}): Promise<T> {
  const response = await fetch('/api/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Walkpad-Token': token },
    body: JSON.stringify({ action, ...args }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.detail || result.error || '请求失败')
  return result
}
export async function upload(path: string, blob: Blob) {
  const response = await fetch(path, { method: 'POST', headers: { 'X-Walkpad-Token': token, 'Content-Type': blob.type || 'video/webm' }, body: blob })
  const result = await response.json()
  if (!response.ok) throw new Error(result.detail || '录像写盘失败')
  return result
}
export async function connect() {
  stopped = false
  try {
    const config = await (await fetch('/api/config')).json()
    token = config.control_token
    if (previousServer && previousServer !== token) buffers.clear()
    previousServer = token
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(token)}`)
    socket.onopen = () => { online.value = true }
    socket.onmessage = (event) => {
      const update = JSON.parse(event.data)
      status.value = update.state
      if (update.gap) error.value = '显示缓存出现缺口；请以后台保存的原始记录为准'
      for (const frame of update.frames as Frame[]) {
        const array = buffers.get(frame.device_id) || []
        if (!array.length || frame.cursor > array[array.length - 1]!.cursor) array.push(frame)
        const cutoff = frame.receipt_ms - 35000
        let cut = 0
        while (cut < array.length && array[cut]!.receipt_ms < cutoff) cut++
        if (cut) array.splice(0, cut)
        if (array.length > 6000) array.splice(0, array.length - 6000)
        buffers.set(frame.device_id, array)
      }
      revision.value++
    }
    socket.onclose = () => {
      online.value = false
      if (!stopped) retry = setTimeout(connect, 1500)
    }
    socket.onerror = () => { online.value = false }
  } catch (e) {
    online.value = false
    error.value = String(e)
    if (!stopped) retry = setTimeout(connect, 1500)
  }
}
export function disconnect() {
  stopped = true
  clearTimeout(retry)
  socket?.close()
}
export function clearBuffers() { buffers.clear(); revision.value++ }
export const number = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits)
export const side = (value: string | null) => value === 'l' ? '左脚' : value === 'r' ? '右脚' : '未指定侧别'
