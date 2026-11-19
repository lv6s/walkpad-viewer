'use strict';
const path = require('node:path');
const readline = require('node:readline');
const { createBiasTracker } = require(path.resolve(__dirname, 'reference/insole_bias.cjs'));
const configuredGate = process.env.WALKPAD_BIAS_GATE || 'confirmed';
const gate = configuredGate === 'bounded' ? 'confirmed' : configuredGate;
if (gate !== 'legacy' && gate !== 'confirmed') throw new Error('unknown WALKPAD_BIAS_GATE');
let feet;
function reset() {
  feet = new Map();
}
// 零偏按设备键记账：脚背设备键为 l/r，其余位置为 d:<设备id>，位置不影响零偏本身
function track(key) {
  let f = feet.get(key);
  if (!f) {
    f = { tracker: createBiasTracker({ recovery: gate === 'confirmed' }), connection: null, retired: new Set(), generation: 0, previous: null, clock: null };
    feet.set(key, f);
  }
  return f;
}
reset();
function prepare(records) {
  const events = [], states = [], trace = [];
  for (const r of records) {
    const key = r.key ?? r.foot;
    if (!key || !Number.isFinite(r.processing_ms)) throw new Error('invalid record');
    const f = track(key);
    if (r.action) {
      f.tracker.advance(r.processing_ms);
      if (r.action === 'reset_bias') { f.tracker.reset(); f.previous = null; f.generation++; }
      else if (r.action === 'manual') f.tracker.setMode('manual');
      else if (r.action === 'dynamic') f.tracker.setMode('dynamic');
      else if (r.action === 'start_calibration') f.tracker.startCalibration();
      else if (r.action === 'cancel_calibration') f.tracker.cancelCalibration();
      else throw new Error('unknown action');
      states.push({ key, foot: r.foot ?? null, processing_ms: r.processing_ms, action: r.action, ...f.tracker.snapshot(), generation: f.generation, discontinuity: r.action === 'reset_bias' });
      continue;
    }
    if (f.retired.has(r.connection)) continue;
    let discontinuity = false;
    if (f.connection !== r.connection) {
      if (f.connection !== null) { f.retired.add(f.connection); discontinuity = true; }
      f.connection = r.connection; f.tracker.reset(); f.previous = null; f.clock = null; f.generation++;
    }
    const raw = r.raw6;
    if (!Array.isArray(raw) || raw.length !== 6 || !raw.every(x => Number.isInteger(x) && x >= -32768 && x <= 32767)) throw new Error('bad raw six axis');
    const v = [raw[1]/2048, -raw[0]/2048, raw[2]/2048, raw[4]*.07, -raw[3]*.07, raw[5]*.07];
    const b = f.tracker.push({seq:r.seq, ax:v[0], ay:v[1], az:v[2], gx0:v[3], gy0:v[4], gz0:v[5], raw6:raw, clk:{epoch:r.device_ms}}, r.processing_ms);
    if (b.ready) {
      if (f.previous && Math.hypot(...b.gyro_bias_dps.map((x,i)=>x-f.previous[i]))>3) { f.generation++; discontinuity=true; }
      if (f.clock && (r.device_ms-f.clock.device_ms)-(r.receipt_ms-f.clock.receipt_ms)>2000) { f.generation++; discontinuity=true; }
      f.previous=[...b.gyro_bias_dps]; f.clock={device_ms:r.device_ms,receipt_ms:r.receipt_ms};
      events.push({key,foot:r.foot ?? null,device_ms:r.device_ms,receipt_ms:r.receipt_ms,available_ms:r.processing_ms,seq:r.seq,segment:r.connection+':'+f.generation,values:v.map((x,i)=>i<3?x:x-b.gyro_bias_dps[i-3]),raw:[...raw]});
    } else if (f.previous) { f.previous=null;f.generation++;discontinuity=true; }
    states.push({key,foot:r.foot ?? null,processing_ms:r.processing_ms,...b,generation:f.generation,discontinuity});
    trace.push({key,foot:r.foot ?? null,processing_ms:r.processing_ms,own_before_bias:v,...b,emitted:b.ready,discontinuity});
  }
  return {events,states,trace};
}
readline.createInterface({input:process.stdin}).on('line', line => {
  try {
    const input=JSON.parse(line);
    if(input.reset)reset();
    process.stdout.write(JSON.stringify({ok:true,...prepare(input.records||[])})+'\n');
  } catch(e) {process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');}
});
