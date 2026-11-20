import type {AnkleStream} from './squat-core';
import type {ShinFrame} from './video-pose';

const STEP = .01;
const cutoff = (x:number, limit:number) => Math.max(-limit, Math.min(limit,x));

function dominantGyro(s: AnkleStream): Float64Array {
  const n=s.t.length, mag=s.t.map((_,i)=>Math.hypot(s.values[6*i+3],s.values[6*i+4],s.values[6*i+5]));
  const cap=Math.max(15,mag.slice().sort()[Math.floor((n-1)*.95)]);
  const m=new Float64Array(9);
  for(let i=0;i<n;i++) {
    const w=Math.min(1,cap/Math.max(.01,mag[i]));
    for(let a=0;a<3;a++) for(let b=0;b<3;b++) m[3*a+b]+=s.values[6*i+3+a]*s.values[6*i+3+b]*w*w;
  }
  const axis=[0,1,2].reduce((a,b)=>m[4*b]>m[4*a] ? b : a);
  let v=[0,1,2].map(i=>i===axis ? 1 : .11*(i+1));
  for(let it=0;it<24;it++) {
    v=v.map((_,a)=>m[a*3]*v[0]+m[a*3+1]*v[1]+m[a*3+2]*v[2]);
    const norm=Math.hypot(...v);
    if (!(norm>0)) return new Float64Array(n);
    v=v.map(x=>x/norm);
  }
  return s.t.map((_,i)=>cutoff(v.reduce((u,x,j)=>u+x*s.values[6*i+3+j],0),160));
}

function videoRates(frames: ShinFrame[], column: 1|2) {
  const weights=[-2,3,6,7,6,3,-2];
  const smoothed=frames.map((f,i)=>{
    if(i<3 || i+3>=frames.length || frames[i+3][0]-frames[i-3][0]>.55) return NaN;
    return weights.reduce((s,w,j)=>s+w*frames[i+j-3][column],0)/21;
  });
  return frames.map((f,i)=>{
    const dt=i>0 && i+1<frames.length ? frames[i+1][0]-frames[i-1][0] : NaN;
    return dt>.048 && dt<.21 ? cutoff((smoothed[i+1]-smoothed[i-1])/dt,4) : NaN;
  });
}

function correlation(t:number[], x:number[], imut:Float64Array, imux:Float64Array, shift:number): number {
  let n=0, a=0, b=0, aa=0, bb=0, ab=0;
  for (let i=0,j=1;i<t.length;i++) {
    const u=t[i]+shift;
    while(j<imut.length-1 && imut[j]<u) j++;
    const h=imut[j]-imut[j-1];
    if(u<imut[j-1] || u>imut[j] || h>.12) continue;
    const y=imux[j-1]+(imux[j]-imux[j-1])*(u-imut[j-1])/h, z=x[i];
    n++; a+=z; b+=y; aa+=z*z; bb+=y*y; ab+=z*y;
  }
  if(n<Math.max(34,.85*t.length)) return NaN;
  const va=aa-a*a/n, vb=bb-b*b/n;
  return va/n>=.014 && vb/n>=30 ? (ab-a*b/n)/Math.sqrt(va*vb) : NaN;
}

export type MotionOffset = {offset:number; score:number; margin:number; supporting:number; alternative:number|null; accepted:boolean};
export function motionOffset(frames: ShinFrame[], streams: [AnkleStream,AnkleStream], shifts:number[], offset:number): MotionOffset {
  const end=frames.at(-1)?.[0] ?? 0;
  const times=streams.map((s,j)=>s.t.map(v=>v/1e6+shifts[j]+offset));
  const gyro=streams.map(dominantGyro);
  const rates=([1,2] as const).map(j=>videoRates(frames,j));
  const blocks=[[.38,end-.38], ...[0,1,2].map(i=>[i*end/3+.20,(i+1)*end/3-.20])];
  if(end<4.5 || blocks[0].some(v=>!Number.isFinite(v))) throw new Error('有效视频片段太短，未修改偏移。');
  const traces=blocks.map(([lo,hi])=>rates.map(rate=>{
    const t:number[]=[], x:number[]=[];
    for(let i=0;i<frames.length;i++) if(frames[i][0]>=lo && frames[i][0]<=hi && Number.isFinite(rate[i])) {
      t.push(frames[i][0]); x.push(rate[i]);
    }
    return {t,x};
  }));
  if(traces[0].some(s=>s.t.length<Math.max(65,.50*frames.length))) throw new Error('画面中未能持续找到同一人的双侧膝踝，未修改偏移。');
  const calculate=(lag:number, swapped:number, block:number) => traces[block].map(({t,x},j)=>{
    const k=j^swapped;
    return correlation(t,x,times[k],gyro[k],lag);
  });
  const rows:{lag:number; swap:number; signs:number[]; score:number}[]=[];
  const a=Math.max(-12,Math.ceil((Math.max(times[0][0],times[1][0])-end*.15)*100)*STEP);
  const b=Math.min(12,Math.floor((Math.min(times[0].at(-1),times[1].at(-1))-end*.85)*100)*STEP);
  for(let i=Math.ceil(a/STEP);i<=Math.floor(b/STEP);i++) {
    const lag=i*STEP;
    for(let swap=0;swap<2;swap++) {
      const cs=calculate(lag,swap,0), score=(Math.abs(cs[0])+Math.abs(cs[1]))/2;
      if (Number.isFinite(score)) rows.push({lag,swap,signs:cs.map(Math.sign),score});
    }
  }
  rows.sort((a,b)=>b.score-a.score);
  const best=rows[0];
  if (!best || best.score<.56) throw new Error('视频和双踝的共同运动不够明显，未修改偏移。');
  const runner=rows.find(r=>Math.abs(r.lag-best.lag)>=.27);
  const margin=best.score-(runner?.score ?? 0);
  const local=(r:typeof best, block:number)=>{
    let quality=-Infinity, lag=r.lag;
    for(let i=-10;i<=10;i++) {
      const v=r.lag+i*STEP;
      const cs=calculate(v,r.swap,block).map((q,j)=>q*r.signs[j]);
      const score=(cs[0]+cs[1])/2;
      if(score>quality) {quality=score; lag=v;}
    }
    return {quality,lag};
  };
  let supporting=0, decisive=0;
  const supportedLags:number[]=[];
  for(let i=1;i<4;i++) {
    const p=local(best,i);
    if(p.quality>=.49) {
      supporting++;
      supportedLags.push(p.lag);
      if(!runner || p.quality-local(runner,i).quality>=.025) decisive++;
    }
  }
  // 匀速重复会产生错半个/整周期的强匹配；不是取最高峰就能自动校准。
  const stable=supporting>=2 && Math.max(...supportedLags)-Math.min(...supportedLags)<=.16;
  const accepted=stable && (margin>=.052 || (margin>=.024 && decisive>=2));
  return {offset:best.lag,score:best.score,margin,supporting,alternative:runner?.lag ?? null,accepted};
}
