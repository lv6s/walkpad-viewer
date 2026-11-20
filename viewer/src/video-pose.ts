import PoseWorker from './video-pose-worker?worker&inline';
import {APP_VER} from './core/constants';

export type ShinFrame = [number, number, number];
const MOTION_LIMIT = 120;
const runtimeUrl = new URL(`dist/pose-runtime.js?v=${APP_VER}`, document.baseURI).href;
let loading: Promise<Blob[]>;

function loadPoseAssets(): Promise<Blob[]> {
  if (loading) return loading;
  return loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = runtimeUrl;
    script.onload = () => {script.remove(); resolve();};
    script.onerror = () => {script.remove(); reject(new Error('离线姿态组件未找到。'));};
    document.head.append(script);
  }).then(async () => {
    const scope = globalThis as typeof globalThis & {walkpadPoseAssets?: string[]};
    const assets = scope.walkpadPoseAssets;
    delete scope.walkpadPoseAssets;
    if (assets?.length !== 3) throw new Error('离线姿态组件不完整。');
    return Promise.all(assets.map(async (asset,i)=>{
      const bytes = Uint8Array.from(atob(asset), c=>c.charCodeAt(0));
      const type = ['text/javascript','application/wasm','application/octet-stream'][i];
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), {headers:{'Content-Type':type}}).blob();
    }));
  }).catch(e => {loading=undefined; throw e;});
}

export async function readShinMotion(video: Blob, duration: number, signal: AbortSignal, progress: (p:number)=>void): Promise<ShinFrame[]> {
  if (duration<5 || duration>MOTION_LIMIT) throw new Error(`动作校准支持 5–${MOTION_LIMIT} 秒的单段视频。`);
  if (!globalThis.VideoDecoder || !globalThis.OffscreenCanvas || !globalThis.DecompressionStream) {
    throw new Error('浏览器不支持离线动作校准，请用新版 Edge 或 Chrome。');
  }
  const assets = await loadPoseAssets();
  signal.throwIfAborted();
  const worker = new PoseWorker();
  let abort: () => void, timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise<ShinFrame[]>((resolve,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      const arm=()=>{
        clearTimeout(timer);
        timer=setTimeout(()=>reject(new Error('离线视频识别无进展，请重试。')),20000);
      };
      arm();
      worker.onerror=e=>{e.preventDefault(); reject(new Error('后台视频识别无法运行。'));};
      worker.onmessage=({data})=>{
        if (data.error) reject(new Error(data.error));
        else if (data.motion) resolve(data.motion);
        else if (Number.isFinite(data.progress)) {arm(); progress(data.progress);}
      };
      worker.postMessage({assets,video,duration});
    });
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort',abort); worker.terminate();
  }
}
