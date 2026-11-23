import {state} from './core/state';
import {baseName} from './core/util';
import {SQUAT_VERSION, type SquatResult} from './squat-core';
import {FEATURE_DEFS, type RepFeatures} from './squat-score-features';
import {FEATURE_SCHEMA, parseScoreModel, predictGrade, fitPersonalBias, type Grade, type ScoreModel} from './squat-score-model';
import builtIn from './squat-score-pilot.json';

const PROFILE_SCHEMA='walkpad-squat-personal-v1';
const EXPORT_SCHEMA='walkpad-squat-review-v1';
const labels: Record<Grade,string>={bad:'不好',fair:'一般',good:'好'};
const allowed=new Set(FEATURE_DEFS.map(f=>f.key).filter(k=>!(/^(wrist_|coverage_|sagittal_axis_confidence_|return_gyro_bias_delta_)/.test(k))));
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById('squatScore'+id) as T;
type Capture={recordId: string|null; wrist?: {placement:string; family:string; gyro:string}};
let capture: Capture, result: SquatResult, features: RepFeatures[]=[], selected=-1;
const deviation: Record<Grade,string>={bad:'偏差明显',fair:'有偏差',good:'偏差较小'};
const defaultModel = parseScoreModel(builtIn,allowed);
const resultLabel=(grade:Grade)=>model===defaultModel ? deviation[grade] : labels[grade];
let model: ScoreModel=defaultModel, personal: {bias:number;count:number}, issue='', notice='', generation=0;
let reviews=new Map<string,Grade>();

const repKey=(r: number[])=>r.map(x=>x.toFixed(4)).join('/');
const reviewed=(i:number)=>reviews.get(repKey(result.reps[i])) ?? null;
const rateable=(row: RepFeatures)=>row?.values.coverage_bilateral===1;
const prediction=(i:number, bias=0)=>rateable(features[i]) && model ? predictGrade(model,features[i].values,bias) : null;

function save(value:unknown,name:string) {
  const href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a=document.createElement('a'); a.href=href; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(href),5000);
}

export function resetSquatScore(newCapture=false) {
  if(newCapture) {reviews=new Map();personal=null;capture=null;notice='';generation++;}
  result=null;features=[];selected=-1;issue='';
}

export function setSquatScore(r: SquatResult, rows: RepFeatures[], meta: Capture, warning: string) {
  result=r;features=rows ?? [];capture=meta;issue=warning;
  selected=r?.reps.length ? 0 : -1;
}

export function squatScoreLabel(i:number) {
  const grade=reviewed(i), auto=prediction(i,personal?.bias);
  return grade ? `人工：${labels[grade]}` : auto ? (model===defaultModel ? resultLabel(auto.grade) : `模型：${resultLabel(auto.grade)}`) : '无法评分';
}

export function selectSquatScore(i:number) {
  if(!result?.reps[i]) return;
  selected=i;renderDetails();
}

function renderDetails() {
  const row=features[selected], picker=$<HTMLSelectElement>('Rep'), review=$<HTMLSelectElement>('Review');
  picker.value=selected>=0 ? String(selected) : '';
  review.disabled=!result?.reps[selected];
  const grade=review.disabled ? null : reviewed(selected), base=prediction(selected), auto=prediction(selected,personal?.bias);
  review.value=grade ?? '';
  $('Result').textContent=auto ? (model===defaultModel ? '双踝提示：' : '基础判定：')+resultLabel(base.grade)+(personal ? ` · 个人判定：${resultLabel(auto.grade)}` : '')
    : selected<0 ? '' : model===defaultModel ? '双踝覆盖或设备角度不足，无法给出偏差提示。' : '当前动作缺少模型所需指标，无法评分。';
  $('Details').hidden=!row;
  $('Issues').textContent=row?.issues.join(' · ') ?? '';
  const metrics=$('Metrics'); metrics.replaceChildren();
  if(!row) return;
  for(const def of FEATURE_DEFS) {
    const tr=document.createElement('tr'), key=document.createElement('th'), value=document.createElement('td');
    key.scope='row';key.textContent=def.label;
    const v=row.values[def.key];
    value.textContent=Number.isFinite(v) ? `${v.toFixed(def.digits ?? 2)}${def.unit && def.unit!=='1' ? ' '+def.unit : ''}` : '—';
    tr.append(key,value);metrics.append(tr);
  }
}

export function renderSquatScore() {
  $('Status').textContent=[model===defaultModel ? '内置双踝偏差提示（试用）：不等同于姿势好坏。' : `基础模型：${model.modelId}`,
    personal ? `个人偏置 ${personal.bias.toFixed(3)}（${personal.count} 条可用复核）` : '',issue,notice].filter(Boolean).join(' · ');
  const picker=$<HTMLSelectElement>('Rep'), n=result?.reps.length ?? 0;
  if(picker.options.length!==n) picker.replaceChildren(...Array.from({length:n},(_,i)=>new Option(`第 ${i+1} 次`,String(i))));
  picker.disabled=!n; $<HTMLButtonElement>('Export').disabled=!n;
  $<HTMLButtonElement>('Fit').disabled=model===defaultModel || !features.length || !n;
  $<HTMLButtonElement>('BuiltIn').disabled=model===defaultModel;
  $<HTMLButtonElement>('Reset').disabled=!personal; $<HTMLButtonElement>('Profile').disabled=!personal;
  renderDetails();
}

export function initSquatScore(refresh:()=>void) {
  const file=$<HTMLInputElement>('File');
  $('Import').onclick=()=>file.click();
  $('BuiltIn').onclick=()=>{generation++;model=defaultModel;personal=null;notice='';refresh();};
  file.onchange=async()=>{
    const f=file.files[0];file.value='';if(!f) return;
    const current=++generation;
    try {
      if(f.size>128*1024) throw new Error('评分模型文件过大。');
      const data=JSON.parse(await f.text());
      if(current!==generation) return;
      const isProfile=data?.schema===PROFILE_SCHEMA;
      const next=parseScoreModel(isProfile ? data.model : data,allowed);
      if(next.modelId===defaultModel.modelId) throw new Error('内置双踝提示无需导入，请点击「使用内置提示」。');
      if(isProfile && (!Number.isFinite(data.bias) || Math.abs(data.bias)>next.personalization.maxBias ||
          !Number.isSafeInteger(data.count) || data.count<next.personalization.minExamples))
        throw new Error('个人档偏置或复核数量无效。');
      model=next;personal=isProfile ? {bias:data.bias,count:data.count} : null;
      notice=isProfile ? '已启用导入的个人档；请确认采集对象相同。' : '已加载模型，结果仅供实验。';
    } catch(e) {
      if(current!==generation) return;
      notice='导入失败：'+(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };
  $<HTMLSelectElement>('Rep').onchange=e=>selectSquatScore(Number((e.target as HTMLSelectElement).value));
  $<HTMLSelectElement>('Review').onchange=e=>{
    if(!result?.reps[selected]) return;
    const key=repKey(result.reps[selected]), value=(e.target as HTMLSelectElement).value;
    if(Object.hasOwn(labels,value)) reviews.set(key,value as Grade); else reviews.delete(key);
    if(personal) notice='复核有改动，可重新调整个人偏置。';
    refresh();
  };
  $('Fit').onclick=()=>{
    if(model===defaultModel || !result) return;
    const examples=features.flatMap((row,i)=>{
      const grade=reviewed(i);return grade && rateable(row) ? [{values:row.values,grade}] : [];
    });
    const next=fitPersonalBias(model,examples);
    if(next) {personal=next;notice='已调整个人偏置，基础权重不变。';}
    else {
      const {minExamples,minPerGrade}=model.personalization;
      notice=`可用复核不足：至少 ${minExamples} 次可评分样本，且三档各至少 ${minPerGrade} 次。`;
    }
    refresh();
  };
  $('Reset').onclick=()=>{personal=null;notice='已恢复基础评分。';refresh();};
  $('Profile').onclick=()=>{
    if(model && personal) save({schema:PROFILE_SCHEMA,model,...personal},`${model.modelId}_个人评分.json`);
  };
  $('Export').onclick=()=>{
    if(!result?.reps.length) return;
    save({schema:EXPORT_SCHEMA,featureSchema:FEATURE_SCHEMA,segmentationVersion:SQUAT_VERSION,
      source:{name:state.name,recordId:capture?.recordId ?? null,wrist:capture?.wrist ?? null}, modelId:model.modelId,
      predictionKind:model===defaultModel ? 'bilateral-deviation' : 'quality-model',
      personalBias:personal?.bias ?? null, issues:issue || null,
      featureDefinitions:FEATURE_DEFS.map(f=>({...f,scoreInput:allowed.has(f.key)})),
      reps:result.reps.map((r,i)=>({number:i+1,timesS:r,features:features[i]?.values ?? null,issues:features[i]?.issues ?? [],
        basePrediction:prediction(i),personalPrediction:personal ? prediction(i,personal.bias) : null,review:reviewed(i)}))},`${baseName()}_深蹲质量.json`);
  };
}
