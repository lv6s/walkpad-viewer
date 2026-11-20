import SquatWorker from './squat-worker?worker&inline';
import type {SquatResult} from './squat-core';
import {version as modelVersion} from './squat-v03-model.json';
import {state} from './core/state';
import {squatInput, squatPackage} from './parse';
import {applyWin, winOf} from './timewin';
import {seekVideoSession} from './video';

const HZ=50, colors=['#74849a','#526cdb','#b87616','#178477'];
const labels=['非深蹲','下降','蹲底','上升'];
const events=['开始下降','进入蹲底','开始上升','结束上升'];
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
let source: typeof state.sides, worker: Worker, result: SquatResult, token=0, selected=-1, busy=false, clips: [number,number,number][]=[];
let message='';

function reset() {
  token++; worker?.terminate(); worker=null; busy=false; result=null; selected=-1; clips=[]; message='';
}

async function run() {
  const files=squatPackage(state.sides);
  if (!files || busy) return;
  const range=$<HTMLSelectElement>('squatScope').value==='window' ? winOf() : null;
  reset(); const mine=token; const alive=()=>mine===token && source===state.sides;
  busy=true; message='正在读取双踝数据…'; renderSquat();
  try {
    const inputs=[await squatInput(files[0],alive),await squatInput(files[1],alive)];
    if (!alive()) return;
    worker=new SquatWorker(); message='正在本地预测深蹲…'; renderSquat();
    const finish=(value?:SquatResult,error?:string)=>{
      if (!alive()) return;
      worker?.terminate(); worker=null; busy=false;
      result=value ?? null;
      if (!result) message='预测失败：'+error;
      else {
        const {phase,start,valid}=result;
        for (let i=0,j;i<phase.length;i=j) {
          for (j=i+1;j<phase.length && phase[j]===phase[i];j++);
          clips.push([start+i/HZ,start+j/HZ,phase[i]]);
        }
        message=`预测完成 · ${result.reps.length} 次完整深蹲 · 实际范围 ${start.toFixed(3)}–${(start+(phase.length-1)/HZ).toFixed(3)} s · 可判断 ${(valid/HZ).toFixed(2)} / ${(phase.length/HZ).toFixed(2)} s`;
      }
      renderSquat();
    };
    worker.onmessage=ev=>finish(ev.data.result,ev.data.error);
    worker.onerror=ev=>{ev.preventDefault();finish(undefined,ev.message || '后台计算不可用。');};
    worker.postMessage({inputs,origin:source[0].t0,range},inputs.flatMap(s=>[s.t.buffer,s.receive.buffer,s.elapsed.buffer,s.values.buffer]));
  } catch(e) {
    if (!alive()) return;
    reset(); message='预测失败：'+(e instanceof Error ? e.message : e); renderSquat();
  }
}

function focus(i:number) {
  selected=i; const r=result?.reps[i]; if (!r) return;
  applyWin(r[0]-.20,r[3]+.20); drawSquat();
  $('squatRows').querySelectorAll('tr').forEach((row,j)=>row.classList.toggle('selected',i===j));
}

function geometry(cv:HTMLCanvasElement) {
  const w=cv.clientWidth, h=cv.clientHeight;
  return {w,h,l:46,r:Math.max(47,w-16),...winOf()};
}

export function paintSquatCursor() {
  if (state.tab!=='squat') return;
  const cv=$<HTMLCanvasElement>('squatTimeline'), cursor=$('squatVideoCursor'), readout=$('squatVideoTime');
  if (!cv || !cursor || !readout) return;
  const t=state.videoT;
  cursor.hidden=readout.hidden=t==null || !state.sides.length || cv.clientWidth<100;
  if (cursor.hidden) return;
  const {a,b,l,r}=geometry(cv);
  const edge=t<a ? 'left' : t>b ? 'right' : '';
  if (edge) cursor.dataset.edge=edge;
  else cursor.removeAttribute('data-edge');
  cursor.style.left=`${cv.clientLeft+l+(r-l)*Math.min(1,Math.max(0,(t-a)/(b-a)))}px`;
  const j=result ? Math.floor((t-result.start)*HZ+1e-8) : -1;
  const phase=j>=0 ? result.phase[j] : undefined;
  const text=`视频游标 · 会话 ${t.toFixed(2)} s`+(edge ? ' · 超出当前时间窗' : phase==null ? '' : ` · ${labels[phase] ?? '无法判断'}`);
  if (readout.textContent!==text) readout.textContent=text;
}

export function drawSquat() {
  const cv=$<HTMLCanvasElement>('squatTimeline');
  if (!cv || cv.clientWidth<100 || !state.sides.length) return;
  const {w,h,l,r,a,b}=geometry(cv); if (!(b>a)) return;
  const g=cv.getContext('2d'), k=window.devicePixelRatio||1, css=getComputedStyle(cv);
  const ink=css.getPropertyValue('--ink'),line=css.getPropertyValue('--line'), bg=css.getPropertyValue('--bg');
  cv.width=Math.round(w*k); cv.height=Math.round(h*k); g.setTransform(k,0,0,k,0,0);
  const x=(t:number)=>l+(r-l)*(t-a)/(b-a);
  g.fillStyle=bg; g.fillRect(0,0,w,h);
  g.strokeStyle=line; g.fillStyle=ink; g.font='12px system-ui'; g.textAlign='center';
  const count=Math.min(8,Math.max(2,Math.floor((r-l)/85)));
  for (let i=0;i<=count;i++) {
    const t=a+(b-a)*i/count, u=x(t);
    g.beginPath();g.moveTo(u,18);g.lineTo(u,78);g.stroke();g.fillText(t.toFixed(b-a<12 ? 2 : 1),u,96);
  }
  g.textAlign='left';g.fillText('s',Math.min(w-8,r+4),96);
  for (const [s,e,p] of clips) {
    if(e<=a || s>=b) continue;
    const x0=x(Math.max(a,s)),x1=x(Math.min(b,e));
    g.fillStyle=p<0 ? '#a0a6b0' : colors[p];g.fillRect(x0,30,Math.max(.5,x1-x0),30);
    if(p<0) {
      g.save();g.beginPath();g.rect(x0,30,x1-x0,30);g.clip();g.strokeStyle=bg;
      for(let j=x0-30;j<x1;j+=7) {g.beginPath();g.moveTo(j,60);g.lineTo(j+30,30);g.stroke();}
      g.restore();
    }
  }
  result?.reps.forEach((rep,i)=>{
    if(rep[3]<a || rep[0]>b) return;
    const s=x(Math.max(a,rep[0])), e=x(Math.min(b,rep[3]));
    if(i===selected) {g.strokeStyle=ink;g.lineWidth=2;g.strokeRect(s,27,e-s,36);g.lineWidth=1;}
    if(e-s>22) {g.fillStyle=ink;g.textAlign='center';g.fillText(String(i+1),(s+e)/2,23);}
  });
  if (!result) {g.fillStyle=ink;g.textAlign='center';g.fillText('点击「预测」后显示状态时间轴', (l+r)/2,51);}
  else if (!clips.some(([s,e])=>e>a && s<b)) {g.fillStyle=ink;g.textAlign='center';g.fillText('当前时间窗不在上次预测范围内', (l+r)/2,51);}
  paintSquatCursor();
}

export function renderSquat() {
  if (!$('viewSquat')) return;
  if(source!==state.sides) {reset();source=state.sides;}
  const enabled=!!squatPackage(source);
  $<HTMLButtonElement>('squatRun').disabled=!enabled || busy;
  $<HTMLSelectElement>('squatScope').disabled=busy;
  $<HTMLButtonElement>('squatCancel').hidden=!busy;
  $('squatStatus').textContent=message || (enabled ? '准备就绪。选择范围并点击「预测」。' : '需要同一个 Walkpad ZIP，且设备位置明确标为左踝、右踝。');
  const rows=$('squatRows'); rows.replaceChildren();
  result?.reps.forEach((rep,i)=>{
    const tr=document.createElement('tr'); tr.tabIndex=0; tr.classList.toggle('selected',i===selected);
    const go=(t:number)=>{focus(i);seekVideoSession(t,true);};
    tr.onclick=()=>go(rep[0]);
    tr.onkeydown=e=>{if(e.target===tr && (e.key==='Enter'||e.key===' ')) {e.preventDefault();go(rep[0]);}};
    for(const [j,val] of [String(i+1),...rep.map(v=>v.toFixed(3)),(rep[3]-rep[0]).toFixed(3)].entries()) {
      const cell=document.createElement('td');
      if(j>=1 && j<=4) {
        const button=document.createElement('button');
        button.type='button'; button.className='lnk'; button.textContent=val;
        button.setAttribute('aria-label',`第 ${i+1} 次 · ${events[j-1]} · ${val} s`);
        button.title='定位事件；如有视频则跳到该时刻';
        button.onclick=e=>{e.stopPropagation();go(rep[j-1]);};
        cell.append(button);
      } else cell.textContent=val;
      tr.append(cell);
    }
    rows.append(tr);
  });
  $('squatEmpty').textContent=!result ? '暂无预测结果' : result.reps.length ? '' : '该范围未识别到完整深蹲。';
  drawSquat();
}

export function initSquat() {
  const cv=$<HTMLCanvasElement>('squatTimeline'); if (!cv) return;
  $('squatVersion').textContent=`模型 v${modelVersion} · ${HZ} Hz`;
  $('squatRun').onclick=()=>void run();
  $('squatCancel').onclick=()=>{reset();message='预测已取消。';renderSquat();};
  new ResizeObserver(drawSquat).observe(cv);
  const hit=(event:MouseEvent)=>{
    const {l,r,a,b}=geometry(cv), dx=event.clientX-cv.getBoundingClientRect().left-cv.clientLeft;
    return dx>=l && dx<=r ? a+(b-a)*(dx-l)/(r-l) : NaN;
  };
  cv.onclick=e=>{
    const t=hit(e); if(!Number.isFinite(t)) return;
    const i=result?.reps.findIndex(r=>r[0]<=t && t<r[3]);
    if(i>=0) focus(i);
    seekVideoSession(t,true);
  };
  cv.onmousemove=e=>{
    const t=hit(e), s=clips.find(c=>c[0]<=t && t<c[1]);
    cv.title=s ? `${t.toFixed(3)} s · ${labels[s[2]] ?? '无法判断'}` : '';
  };
}
