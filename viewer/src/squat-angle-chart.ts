import type {SquatAngleTrace} from './squat-axis';

export type SquatPlot = {w: number; h: number; l: number; r: number; a: number; b: number};
type Clip = readonly [start: number, end: number, phase: number];
type VisibleTrace = {trace: SquatAngleTrace; first: number; last: number};
export const squatAngleLabels=['前后倾','左右倾','绕竖直'] as const;

export const squatX = ({a,b,l,r}: SquatPlot,t: number) => l+(r-l)*(t-a)/(b-a);
export function squatTicks(p: SquatPlot) {
  const {a,b,l,r}=p, n=Math.min(8,Math.max(1,Math.floor((r-l)/85)));
  return Array.from({length:n+1},(_,i)=>{
    const t=a+(b-a)*i/n;
    return {x:squatX(p,t),label:t.toFixed(b-a<12 ? 2 : 1)};
  });
}

export function drawSquatTimeLabels(g: CanvasRenderingContext2D,ticks: ReturnType<typeof squatTicks>,y: number,ink: string) {
  g.font='12px system-ui'; g.fillStyle=ink;
  for(const [i,tick] of ticks.entries()) {
    const last=i===ticks.length-1;
    g.textAlign=last ? 'right' : 'center';
    g.fillText(last ? `${tick.label} s` : tick.label,tick.x+(last ? 6 : 0),y);
  }
}

function lowerBound(times: Float64Array, t: number) {
  let lo=0, hi=times.length;
  while(lo<hi) {const mid=(lo+hi)>>>1; if(times[mid]<t) lo=mid+1; else hi=mid;}
  return lo;
}

/** Sample only inside one repetition and never interpolate over missing data. */
export function squatTraceAt(traces: readonly SquatAngleTrace[], time: number): [number,number,number] | null {
  let lo=0, hi=traces.length;
  while(lo<hi) {
    const mid=(lo+hi)>>>1, t=traces[mid].t;
    if(t[t.length-1]<time) lo=mid+1; else hi=mid;
  }
  const trace=traces[lo];
  if(!trace || !Number.isFinite(time) || time<trace.t[0]) return null;
  const {t,deg,linked}=trace, i=lowerBound(t,time), j=i*3;
  if(t[i]===time) return Number.isFinite(deg[j]) ? [deg[j],deg[j+1],deg[j+2]] : null;
  if(!linked[i]) return null;
  const f=(time-t[i-1])/(t[i]-t[i-1]);
  const lerp=(k:number)=>deg[k-3]+(deg[k]-deg[k-3])*f;
  return [lerp(j),lerp(j+1),lerp(j+2)];
}

function visible(traces: readonly SquatAngleTrace[], a: number, b: number): VisibleTrace[] {
  const out: VisibleTrace[]=[];
  for(const trace of traces) {
    const {t,linked}=trace;
    if(t[0]>=b) break;
    if(t[t.length-1]<=a || t.length<2) continue;
    const first=Math.max(1,lowerBound(t,a)), last=Math.min(t.length-1,lowerBound(t,b));
    for(let i=first;i<=last;i++) if(linked[i]) {out.push({trace,first,last}); break;}
  }
  return out;
}

function rangeOf(runs: VisibleTrace[], channel: number) {
  let lo=0, hi=0;
  for(const {trace:{deg,linked},first,last} of runs) for(let i=first;i<=last;i++) if(linked[i]) {
    const a=deg[(i-1)*3+channel], b=deg[i*3+channel];
    lo=Math.min(lo,a,b); hi=Math.max(hi,a,b);
  }
  // Both ankles use the same scale; retain a legible range when the motion is close to zero.
  if(hi-lo<4) {const mid=(lo+hi)/2; lo=mid-2; hi=mid+2;}
  const rough=(hi-lo)/3, mag=10**Math.floor(Math.log10(rough));
  const step=[1,2,2.5,5,10].find(n=>n*mag>=rough)*mag;
  return {lo:Math.floor(lo/step)*step, hi:Math.ceil(hi/step)*step, step};
}

export function drawSquatAngleChart(cv: HTMLCanvasElement, p: SquatPlot, traces: readonly (readonly SquatAngleTrace[])[],
    clips: readonly Clip[], phaseColors: readonly string[], empty: string) {
  const {w,h,l,r,a,b}=p, g=cv.getContext('2d'), dpr=window.devicePixelRatio||1, css=getComputedStyle(cv);
  const color=(name:string)=>css.getPropertyValue(name).trim();
  const ink=color('--ink'), muted=color('--muted'), line=color('--line'), faint=color('--faint');
  const strokes=[color('--squat-angle-left'),color('--squat-angle-right')];
  if(!g || w<100 || !(b>a)) return;
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr); g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle=color('--bg'); g.fillRect(0,0,w,h);
  const top=6, bottom=h-25, lane=(bottom-top)/3, ticks=squatTicks(p), x=(t:number)=>squatX(p,t);
  drawSquatTimeLabels(g,ticks,h-8,ink);

  const sides=traces.map(side=>visible(side,a,b)), runs=sides.flat();
  if(!runs.length) {
    g.textAlign='center'; g.fillStyle=muted;
    g.fillText(empty,(l+r)/2,(top+bottom)/2,Math.max(10,r-l-8));
    return;
  }
  for(const [channel,label] of squatAngleLabels.entries()) {
    const start=top+channel*lane, upper=start+16, lower=start+lane-5;
    const {lo,hi,step}=rangeOf(runs,channel), y=(v:number)=>lower-(lower-upper)*(v-lo)/(hi-lo);
    g.fillStyle=ink; g.font='600 12px system-ui'; g.textAlign='left'; g.fillText(label,l+4,start+11);
    g.fillStyle=color('--card'); g.fillRect(l,upper,r-l,lower-upper);
    g.globalAlpha=.11;
    for(const [s,e,phase] of clips) if(phase>0 && e>a && s<b) {
      const x0=x(Math.max(a,s));
      g.fillStyle=phaseColors[phase]; g.fillRect(x0,upper,x(Math.min(b,e))-x0,lower-upper);
    }
    g.globalAlpha=1;
    g.strokeStyle=line; g.beginPath();
    for(const tick of ticks) {g.moveTo(tick.x,upper); g.lineTo(tick.x,lower);}
    g.stroke();
    g.font='11px system-ui'; g.textAlign='right'; g.textBaseline='middle';
    for(let i=Math.round(lo/step); i<=Math.round(hi/step); i++) {
      const v=i*step, at=y(v);
      g.strokeStyle=v===0 ? faint : line;
      g.beginPath(); g.moveTo(l,at); g.lineTo(r,at); g.stroke();
      g.fillStyle=v===0 ? ink : muted; g.fillText(`${v}°`,l-5,at);
    }
    g.textBaseline='alphabetic';
    g.save(); g.beginPath(); g.rect(l,upper-1,r-l,lower-upper+2); g.clip();
    g.lineWidth=1.8; g.lineJoin='round';
    for(const [side,segments] of sides.entries()) {
      g.strokeStyle=strokes[side]; g.setLineDash(side ? [5,3] : []); g.beginPath();
      for(const {trace:{t,deg,linked},first,last} of segments) {
        let pen=false;
        for(let i=first;i<=last;i++) {
          if(!linked[i]) {pen=false; continue;}
          if(!pen) g.moveTo(x(t[i-1]),y(deg[(i-1)*3+channel]));
          g.lineTo(x(t[i]),y(deg[i*3+channel])); pen=true;
        }
      }
      g.stroke();
    }
    g.restore();
  }
}
