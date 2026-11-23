/* 逐次深蹲指标展示与导出。只读特征表；不评分、不导入模型、不留人工评级。
   缺失值一律显示「—」，分组只为阅读顺序，不改变指标计算。 */
import {state} from './core/state';
import {baseName} from './core/util';
import {SQUAT_VERSION, type SquatResult} from './squat-core';
import {FEATURE_DEFS, type RepFeatures} from './squat-score-features';

const EXPORT_SCHEMA='walkpad-squat-metrics-v1';
const FEATURE_SCHEMA='walkpad-squat-features-v1';
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById('squatMetrics'+id) as T;
type Capture={recordId: string|null; wrist?: {placement:string; family:string; gyro:string}};
let capture: Capture, result: SquatResult, features: RepFeatures[]=[], selected=-1, issue='';

const PRIORITY = [
  'wrist_tilt_peak_deg', 'wrist_tilt_peak_phase', 'wrist_tilt_bottom_phase', 'wrist_tilt_peak_to_bottom_s',
  'wrist_tilt_bottom_deg', 'wrist_tilt_bottom_retention', 'wrist_to_ankle_range_ratio',
  'sagittal_range_deg_left', 'sagittal_range_deg_right', 'sagittal_range_lr_abs_deg',
  'ascent_peak_delay_right_minus_left_s',
  'lateral_range_deg_left', 'lateral_range_deg_right', 'device_pitch_bottom_deg_left', 'device_pitch_bottom_deg_right',
  'descent_end_speed_dps_left', 'descent_end_speed_dps_right',
  'bottom_transition_acc_dev_peak_g_left', 'bottom_transition_acc_dev_peak_g_right',
  'bottom_speed_rms_dps_left', 'bottom_speed_rms_dps_right',
  'squat_descent_yaw_deg_left', 'squat_descent_yaw_deg_right',
  'squat_descent_lateral_deg_left', 'squat_descent_lateral_deg_right',
];
const rank = new Map(PRIORITY.map((key, i) => [key, i]));
const ORDER = ['动作时序', '双踝 · 矢状', '双踝 · 侧向', '蹲底与转换', '本次相对转向',
  '左右差与对称', '设备角度与回站', '腕部', '数据可用性', '其他指标'];
const TIMES = new Set(['rep_duration_s', 'descent_s', 'bottom_s', 'ascent_s', 'descent_ascent_ratio', 'movement_duration_s']);
const isDevice = (k: string) => k.startsWith('device_') || k.startsWith('return_');
const isSymmetry = (k: string) => /symmetry|balance|_lr_abs_deg$|_lr_deg$|_lr_ratio$/.test(k) || k === 'ascent_peak_delay_right_minus_left_s';
const isWrist = (k: string) => k.startsWith('wrist_') || k === 'wrist_to_ankle_range_ratio';
function groupOf(key: string) {
  if (TIMES.has(key)) return '动作时序';
  if (isDevice(key)) return '设备角度与回站';
  if (isSymmetry(key)) return '左右差与对称';
  if (isWrist(key)) return '腕部';
  if (key.startsWith('coverage_')) return '数据可用性';
  if (key.startsWith('sagittal_')) return '双踝 · 矢状';
  if (key.startsWith('lateral_')) return '双踝 · 侧向';
  if (key.startsWith('bottom_') || key.startsWith('descent_end_speed') || key.startsWith('acc_dynamic_')
    || key.startsWith('acc_magnitude_jerk_')) return '蹲底与转换';
  if (key.startsWith('squat_descent_')) return '本次相对转向';
  return '其他指标';
}

function save(value: unknown, name: string) {
  const href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a=document.createElement('a'); a.href=href; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(href),5000);
}

export function resetSquatMetrics(newCapture=false) {
  if(newCapture) capture=null;
  result=null; features=[]; selected=-1; issue='';
}

export function setSquatMetrics(r: SquatResult, rows: RepFeatures[], meta: Capture, warning: string) {
  result=r; features=rows ?? []; capture=meta; issue=warning;
  selected=r?.reps.length ? 0 : -1;
}

export function selectSquatMetrics(i: number) {
  if(!result?.reps[i]) return;
  selected=i; renderDetails();
}

function renderDetails() {
  const row=features[selected], picker=$<HTMLSelectElement>('Rep');
  if(picker.value!==String(selected)) picker.value=selected>=0 ? String(selected) : '';
  $('Issues').textContent=row?.issues.join(' · ') ?? '';
  const body=$('Body'); body.replaceChildren();
  if(!result?.reps.length) return;
  if(!row) {
    const tr=document.createElement('tr'), cell=document.createElement('td');
    cell.colSpan=2; cell.textContent='该次指标不可用'; tr.append(cell); body.append(tr);
    return;
  }
  const defs=[...FEATURE_DEFS].sort((a,b)=>
    (rank.get(a.key) ?? 1e6)-(rank.get(b.key) ?? 1e6) || FEATURE_DEFS.indexOf(a)-FEATURE_DEFS.indexOf(b));
  const groups=new Map<string, typeof defs>();
  for(const def of defs) {
    const name=groupOf(def.key);
    (groups.get(name) ?? groups.set(name, []).get(name)!).push(def);
  }
  for(const name of [...ORDER, ...[...groups.keys()].filter(k=>!ORDER.includes(k))]) {
    const list=groups.get(name);
    if(!list?.length) continue;
    const head=document.createElement('tr'), cell=document.createElement('th');
    cell.scope='colgroup'; cell.colSpan=2; cell.textContent=name; head.append(cell); body.append(head);
    for(const def of list) {
      const tr=document.createElement('tr'), key=document.createElement('th'), value=document.createElement('td');
      key.scope='row'; key.textContent=def.label;
      const v=row.values[def.key];
      value.textContent=Number.isFinite(v) ? `${v.toFixed(def.digits ?? 2)}${def.unit && def.unit!=='1' ? ' '+def.unit : ''}` : '—';
      tr.append(key,value); body.append(tr);
    }
  }
}

export function renderSquatMetrics() {
  const n=result?.reps.length ?? 0;
  $('Status').textContent=[n ? `${n} 次完整深蹲 · 逐次指标` : '', issue].filter(Boolean).join(' · ');
  const picker=$<HTMLSelectElement>('Rep');
  if(picker.options.length!==n) picker.replaceChildren(...Array.from({length:n},(_,i)=>new Option(`第 ${i+1} 次`,String(i))));
  picker.disabled=!n; $<HTMLButtonElement>('Export').disabled=!n;
  renderDetails();
}

export function initSquatMetrics() {
  $<HTMLSelectElement>('Rep').onchange=e=>selectSquatMetrics(Number((e.target as HTMLSelectElement).value));
  $('Export').onclick=()=>{
    if(!result?.reps.length) return;
    save({schema:EXPORT_SCHEMA,featureSchema:FEATURE_SCHEMA,segmentationVersion:SQUAT_VERSION,
      source:{name:state.name,recordId:capture?.recordId ?? null,wrist:capture?.wrist ?? null},
      issues:issue || null, featureDefinitions:FEATURE_DEFS,
      reps:result.reps.map((r,i)=>({number:i+1,timesS:r,features:features[i]?.values ?? null,issues:features[i]?.issues ?? []}))},
      `${baseName()}_深蹲指标.json`);
  };
}
