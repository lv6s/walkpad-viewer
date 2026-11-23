import type {AnkleStream} from './squat-core';

type LocalConfig = {endpoint: string; publicKey: string; token?: string};
type CalibrationResult = {
  schema: string;
  version?: string;
  status: 'accepted' | 'rejected';
  pose_backend?: string;
  offset_seconds?: number;
  reason?: string;
  diagnostics?: {best_candidate_seconds?: number; alternative_seconds?: number};
};
const LAN_CONFIG: LocalConfig = {
  endpoint: 'http://192.168.100.29:18872/v1/calibrate',
  publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1HnDG53oAVbwHf7dFu5asNTUgT6VMa/+wT5uBLf/EgqCyZu7bCQaUEaiaFFTDDuiXtqGHuOBF+n4H1rUQgw32Gklrq9eIO5agPw8qdyAxkKy1PNmZGpuN9zC/vAjs8mTAGviFT02p/p8qSyeH8ZcqDLU0kV34HCQsv/VF+NGq+GW7Dis1RSOXjabZuH35zuh4JU64ajFCTzPpg2U+h9dSlan1Aqrna8+t3SWMCtzlnOjdHjR4Bp9MmHbZlTU5PaW0/8rdgWr5wN9xInUIbt0UZqL6Ge/PPKp1yAoaEWRElwtkoJ1aWv8zDG91FiQaP6FaKb8Gwgyy28KPUE1cxnyBQIDAQAB',
};
const scope = globalThis as typeof globalThis & {walkpadWorkstation?: LocalConfig};
const bytes = new TextEncoder();
const requestAAD = bytes.encode('walkpad.video-calibration.request.v1');
const responseAAD = bytes.encode('walkpad.video-calibration.response.v1');
const maxVideo = 96 * 1024**2;
let loading: Promise<LocalConfig>;

function config(): Promise<LocalConfig> {
  if (loading) return loading;
  return loading = new Promise<LocalConfig>((resolve,reject)=>{
    if (location.protocol !== 'file:') { reject(new Error('请直接打开本地查看器 index.html，再使用工作站自动校准')); return; }
    const script = document.createElement('script');
    script.src = new URL('workstation.local.js',document.baseURI).href;
    script.onload = () => {
      script.remove();
      const value = scope.walkpadWorkstation;
      delete scope.walkpadWorkstation;
      if (!value || !/^http:\/\/192\.168\.100\.(?:[1-9]\d{0,2}):\d{1,5}\/v1\/calibrate$/.test(value.endpoint)
          || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.publicKey !== 'string') {
        reject(new Error('工作站连接配置无效')); return;
      }
      resolve(value);
    };
    script.onerror = () => { script.remove(); resolve(LAN_CONFIG); };
    document.head.append(script);
  }).catch(error=>{ loading=undefined; throw error; });
}

export async function workstationCalibration(video: Blob, origin: number, streams: [AnkleStream, AnkleStream], signal: AbortSignal): Promise<CalibrationResult> {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持加密连接，请使用新版 Edge 或 Chrome');
  if (!video.size || video.size > maxVideo) throw new Error('工作站校准的视频不能超过 96 MiB');
  if (streams.some(s=>s.t.length>36000)) throw new Error('工作站校准的双踝数据过长');
  const settings = await config();
  signal.throwIfAborted();
  const crypto = globalThis.crypto, subtle = crypto.subtle;
  const publicKey = await subtle.importKey('spki',Uint8Array.from(atob(settings.publicKey),c=>c.charCodeAt(0)),
    {name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const aes = await subtle.importKey('raw',secret,'AES-GCM',false,['encrypt','decrypt']);
  const wrapped = await subtle.encrypt('RSA-OAEP',publicKey,secret);
  secret.fill(0);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ankles = streams.map(s=>Array.from(s.t,(t,i)=>[t,s.receive[i],s.elapsed[i],Array.from(s.values.subarray(i*6+3,i*6+6))]));
  const meta = bytes.encode(JSON.stringify({time:Math.floor(Date.now()/1000),token:settings.token,origin,ankles}));
  const data = new Uint8Array(4+meta.length+video.size);
  new DataView(data.buffer).setUint32(0,meta.length,true);
  data.set(meta,4);
  data.set(new Uint8Array(await video.arrayBuffer()),4+meta.length);
  signal.throwIfAborted();
  const encrypted = await subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:requestAAD},aes,data);
  const body = new Blob([wrapped,nonce,encrypted],{type:'application/octet-stream'});
  let response: Response;
  try {
    response = await fetch(settings.endpoint,{method:'POST',body,signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
  } catch (error) {
    signal.throwIfAborted();
    throw new Error('无法连接工作站 GPU，请确认在公司局域网，并允许浏览器访问本地网络',{cause:error});
  }
  if (response.status === 429) throw new Error('工作站校准请求过于频繁，请稍后重试');
  if (!response.ok) throw new Error(response.status===403 ? '工作站拒绝请求，请检查局域网与两台电脑的时钟' : `工作站连接失败（${response.status}）`);
  const answer = new Uint8Array(await response.arrayBuffer());
  if (answer.length < 29 || answer.length > 8192) throw new Error('工作站返回了无效响应');
  const plain = await subtle.decrypt({name:'AES-GCM',iv:answer.subarray(0,12),additionalData:responseAAD},aes,answer.subarray(12));
  const result = JSON.parse(new TextDecoder().decode(plain)) as CalibrationResult;
  if (result?.schema !== 'walkpad.video-calibration.lan.v1' || !['accepted','rejected'].includes(result.status)
      || (result.status==='accepted' && (result.pose_backend!=='gpu' || !Number.isFinite(result.offset_seconds) || Math.abs(result.offset_seconds)>12))) {
    throw new Error('工作站未返回有效的 GPU 校准结果');
  }
  return result;
}
