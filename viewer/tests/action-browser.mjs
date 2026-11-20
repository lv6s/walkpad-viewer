import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {APP_VER} from '../src/core/constants.ts';
import {motionOffset} from '../src/video-align.ts';

const [reference, root, unsupported, missingComp, badClock] = process.argv.slice(2);
const mixed = process.env.WALKPAD_MIXED_CAPTURE;
const motionCapture = process.env.WALKPAD_MOTION_CAPTURE;
assert.ok(reference && root, 'Pass the v0.3.0 reference JSON and capture directory.');
const cases = JSON.parse(readFileSync(reference, 'utf8'));
const span = 24, lag = -.72;
const sample = (rate,n,fn) => Array.from({length:n},(_,i)=>fn(i/rate));
function alignmentFixture(angle, rate) {
  const frames=sample(15,15*span,t=>[t,angle(t),-.8*angle(t)]);
  const streams=[1,-1].map(sign=>{
    const t=Float64Array.from(sample(50,(span+4)*50,s=>(s-2)*1e6)), values=new Float64Array(t.length*6);
    t.forEach((s,i)=>{const u=s/1e6; values[i*6+3]=sign*48*rate(u-lag);});
    return {t,values,receive:new Float64Array(t.length),elapsed:new Float64Array(t.length)};
  });
  return ()=>motionOffset(frames,streams,[0,0],0);
}
const phase=t=>4.5*t+1.5*Math.sin(1.16*t)+.028*t*t;
const varying=t=>.36*Math.sin(phase(t));
const velocity=t=>.36*Math.cos(phase(t))*(4.5+1.74*Math.cos(1.16*t)+.056*t);
const identifiable=alignmentFixture(varying,velocity)();
assert.ok(identifiable.accepted && Math.abs(identifiable.offset-lag)<.035,JSON.stringify(identifiable));
assert.equal(alignmentFixture(t=>.36*Math.sin(4.5*t),t=>1.62*Math.cos(4.5*t))().accepted,false);
assert.throws(alignmentFixture(()=>0,()=>0),/共同运动/);
const browser = await chromium.launch({channel:'msedge', headless:true});
const page = await browser.newPage({viewport:{width:1280,height:900}});
page.setDefaultTimeout(20000);
const errors=[], network=[];
const isCalibration = r=>r.method()==='POST' && /^http:\/\/192\.168\.100\.\d+:\d+\/v1\/calibrate$/.test(r.url());
page.on('pageerror', e=>errors.push(e.message));
page.on('request', r=>{if(/^https?:/.test(r.url()) && !isCalibration(r)) network.push(r.url());});
await page.addInitScript(()=>{
  const Native=window.Worker;
  window.Worker=class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message',e=>{
        if(e.data.result?.phase instanceof Int8Array) window.squatTest=e.data.result;
        if(e.data.motion) throw new Error('Automatic calibration must not use a local worker');
      });
    }
    postMessage(data,...args) {
      if (data.inputs?.[0]?.elapsed && 'range' in data) window.squatInputCounts=data.inputs.map(s=>s.t.length);
      return super.postMessage(data,...args);
    }
  };
});
async function importFile(file) {
  const input=page.locator('#file');
  await input.setInputFiles([]);
  await input.setInputFiles(file);
  await page.locator('#busy').waitFor({state:'hidden'});
  assert.equal(await page.locator('#err').textContent(),'');
  await page.getByRole('tab',{name:'深蹲专项'}).click();
  assert.equal(await page.locator('#squatRows tr').count(),0);
}
async function run(expected) {
  const state=page.locator('#squatStatus');
  await page.locator('#squatRun').click();
  await page.waitForFunction(()=>/^预测完成|^预测失败/.test(document.querySelector('#squatStatus').textContent));
  assert.match(await state.textContent(),new RegExp(`预测完成 · ${expected.reps.length} 次`));
  const out=await page.evaluate(()=>({...window.squatTest,phase:Array.from(window.squatTest.phase)}));
  assert.ok(Math.abs(out.start-expected.start)<1e-4,`${out.start} != ${expected.start}`);
  assert.equal(out.phase.length,expected.phase.length);
  assert.equal(out.phase.filter((v,i)=>v!==expected.phase[i]).length,0);
  const rows=await page.locator('#squatRows tr').evaluateAll(rs=>rs.map(r=>[...r.cells].map(c=>Number(c.textContent))));
  assert.equal(rows.length,expected.reps.length);
  for(const [i,row] of rows.entries()) {
    const rep=expected.reps[i];
    assert.equal(row[0],i+1);
    row.slice(1).forEach((v,j)=>assert.ok(Math.abs(v-[...rep,rep[3]-rep[0]][j])<.001));
  }
}
const calibration = {
  SG: {offset:5.358, bottom:2.31},
  SW: {offset:.011, bottom:11.40},
};
const seekFrame = async t=>{
  await page.locator('#vid').evaluate((v,t)=>{v.currentTime=t;},t);
  await page.waitForFunction(t=>{const v=document.querySelector('#vid');return !v.seeking && v.readyState>=2 && Math.abs(v.currentTime-t)<.014;},t);
};
async function firstBottomCalibration(rep) {
  const vid=page.locator('#vid'), offset=page.locator('#vidOff'), button=page.getByRole('button',{name:'首次蹲底对时'});
  const status=page.locator('#vidSeekStatus'), note=page.locator('#vidNote');
  const midpoint=(rep[1]+rep[2])/2, duration=await vid.evaluate(v=>v.duration);
  const frame=Math.min(duration-.5,midpoint+.5);
  const scope=page.locator('#squatScope');
  await scope.selectOption('window');
  const before=await offset.inputValue(), rows=await page.locator('#squatRows').textContent();

  await seekFrame(frame);
  await vid.evaluate(v=>{v.muted=true;return v.play();});
  await button.click();
  assert.match(await status.textContent(),/请暂停在第一次/);
  assert.equal(await offset.inputValue(),before);
  await vid.evaluate(v=>v.pause());

  await seekFrame(frame);
  await button.evaluate(b=>{ b.click(); document.querySelector('#vid').currentTime+=.1; });
  await page.waitForFunction(()=>!document.querySelector('#vidFirstBottom').disabled);
  assert.equal(await offset.inputValue(),before);
  assert.match(await status.textContent(),/视频位置已变化/);

  await seekFrame(frame);
  await button.click();
  await page.waitForFunction(()=>!document.querySelector('#vidFirstBottom').disabled);
  const measured=Number(await offset.inputValue());
  assert.ok(Math.abs(measured-(midpoint-frame))<=.00051,`${measured} vs ${midpoint-frame}`);
  assert.match(await note.textContent(),/首次蹲底手动对时/);
  assert.match(await status.textContent(),/双踝第 1 次蹲底中点/);
  assert.equal(await page.locator('#squatRows').textContent(),rows);
  assert.equal(await scope.inputValue(),'window');
  assert.ok(Math.abs(await vid.evaluate(v=>v.currentTime)-frame)<.014);
  console.log('PASS first-bottom offset',measured,'video',frame,'IMU midpoint',midpoint);
}
async function videoCalibration(c) {
  const ref=calibration[c.name];
  if (!ref) return;
  await page.waitForFunction(()=>Number.isFinite(document.querySelector('#vid').duration));
  const offset=page.locator('#vidOff'), auto=page.locator('#vidAuto');
  assert.equal(Number(await offset.inputValue()),ref.offset);
  assert.match(await page.locator('#vidNote').textContent(),/已应用此采集包/);
  await seekFrame(ref.bottom);
  assert.match(await page.locator('#squatVideoTime').textContent(),/蹲底/);
  await offset.fill('1');
  await auto.click();
  assert.equal(Number(await offset.inputValue()),ref.offset);

  const archive=readFileSync(join(root,c.input));
  assert.equal(archive.readUInt32LE(0),0x04034b50);
  archive[10]^=1;
  await importFile({name:c.input,mimeType:'application/zip',buffer:archive});
  await page.waitForFunction(()=>document.querySelector('#busy').hidden && Number.isFinite(document.querySelector('#vid').duration) && document.querySelector('#vidNote').textContent.startsWith('未校准'));
  await firstBottomCalibration(c.full.reps[0]);
}
async function motionCalibration(expected) {
  const offset=page.locator('#vidOff');
  const before=await offset.inputValue();
  const start=performance.now();
  const request=page.waitForRequest(isCalibration);
  await page.locator('#vidAuto').click();
  await page.waitForFunction(()=>!document.querySelector('#vidAuto').disabled,{}, {timeout:120000});
  const status=await page.locator('#vidSeekStatus').textContent();
  assert.match(status,/工作站 GPU/,status);
  const response=await (await request).response();
  assert.equal(response?.status(),200,status);
  if(expected===null) {
    assert.equal(await offset.inputValue(),before);
    assert.match(status,/节奏重复.*未覆盖原值/);
  } else {
    assert.ok(Math.abs(Number(await offset.inputValue())-expected)<.03,status);
    assert.match(await page.locator('#vidNote').textContent(),/工作站 GPU/);
  }
  console.log('PASS workstation automatic calibration',((performance.now()-start)/1e3).toFixed(2),'s',status);
}
async function videoLink(rep) {
  const panel=page.locator('#vidPanel'), vid=page.locator('#vid'), offset=page.locator('#vidOff');
  const cursor=page.locator('#squatVideoCursor'), time=page.locator('#squatVideoTime');
  await page.waitForFunction(()=>Number.isFinite(document.querySelector('#vid').duration));
  await cursor.waitFor({state:'visible'});
  const seeked=async t=>page.waitForFunction(t=>{
    const v=document.querySelector('#vid');
    return !v.seeking && Math.abs(v.currentTime-t)<.04;
  },t);
  const first=page.locator('#squatRows tr').first();
  const start=rep[0], bottom=rep[1], middle=(rep[1]+rep[2])/2, off=middle-1;
  await offset.fill(String(off));
  await first.locator('button').nth(1).press('Enter');
  await seeked(bottom-off);
  assert.ok(await first.evaluate(r=>r.classList.contains('selected')));
  await vid.evaluate(v=>{v.currentTime=1;});
  await seeked(1);
  assert.match(await time.textContent(),/蹲底/);
  const x=await cursor.evaluate(e=>e.offsetLeft);
  await vid.evaluate(v=>{v.muted=true;return v.play();});
  await page.waitForFunction(x=>document.querySelector('#squatVideoCursor').offsetLeft>x+3,x);
  await vid.evaluate(v=>v.pause());
  const pausedAt=await vid.evaluate(v=>v.currentTime);
  await page.waitForFunction(t=>document.querySelector('#squatVideoTime').textContent.includes(`会话 ${t.toFixed(2)} s`),pausedAt+off);
  await vid.evaluate(v=>{v.currentTime=v.duration;});
  await page.waitForFunction(()=>document.querySelector('#squatVideoCursor').dataset.edge==='right');
  await page.locator('#vidClose').click();
  await cursor.waitFor({state:'hidden'});
  const canvas=page.locator('#squatTimeline');
  const xy=await canvas.evaluate((c,t)=>{
    const a=Number(document.querySelector('#tA').value), b=Number(document.querySelector('#tB').value);
    const r=c.getBoundingClientRect();
    return {x:r.left+c.clientLeft+46+(c.clientWidth-62)*(t-a)/(b-a),y:r.top+44};
  },middle);
  await page.mouse.click(xy.x,xy.y);
  await panel.waitFor({state:'visible'});
  await seeked(1);
  const before=await vid.evaluate(v=>v.currentTime);
  await offset.fill(String(start+1));
  await first.locator('button').first().evaluate(b=>b.click());
  assert.match(await page.locator('#vidSeekStatus').textContent(),/视频只覆盖会话/);
  await seeked(before);
  await vid.evaluate(v=>v.play());
  await page.locator('#vidClose').click();
  await cursor.waitFor({state:'hidden'});
  await page.waitForFunction(t=>document.querySelector('#vid').currentTime>t+.3,before);
  assert.ok(await cursor.isHidden());
  await vid.evaluate(v=>v.pause());
}
try {
  await page.goto(new URL('../index.html',import.meta.url).href);
  assert.ok((await page.locator('#ver').textContent()).includes(APP_VER));
  assert.equal(await page.getByRole('tab',{name:'动作速度'}).count(),0);
  for(const c of cases) {
    await importFile(join(root,c.input));
    await page.locator('#squatScope').selectOption('all');
    await run(c.full);
    await page.locator('#squatRows tr').first().press('Enter');
    assert.ok(Math.abs(Number(await page.locator('#tA').inputValue())-(c.full.reps[0][0]-.20))<.01);
    await page.getByRole('tab',{name:'状态与步态'}).click();
    await page.locator('#activityRun').waitFor({state:'visible'});
    await page.getByRole('tab',{name:'深蹲专项'}).click();
    assert.equal(await page.locator('#squatRows tr').count(),c.full.reps.length);
    await videoLink(c.full.reps[0]);
    await page.locator('#squatScope').selectOption('window');
    for(const span of c.clips) {
      await page.locator('#tA').fill(String(span.a)); await page.locator('#tB').fill(String(span.b));
      await page.locator('#tGo').click();
      await run(span.result);
    }
    await importFile(join(root,c.input));
    await page.locator('#squatScope').selectOption('all');
    await run(c.full);
    await videoCalibration(c);
    console.log('PASS',c.name,'full',c.full.reps.length,'clips',c.clips.map(x=>x.result.reps.length),'calibration');
  }
  if (mixed) {
    await importFile(mixed);
    await page.getByRole('tab',{name:'波形',exact:true}).click();
    assert.deepEqual(await page.locator('#panels h2').allTextContents(),
      ['左脚 56 个传感器原始压力波形','右脚 56 个传感器原始压力波形']);
    await page.getByRole('tab',{name:'IMU',exact:true}).click();
    assert.deepEqual((await page.locator('#imuPanels h2').allTextContents()).sort(),
      ['左脚','左踝','右脚','右踝'].map(s=>s+' IMU 六轴').sort());
    await page.waitForFunction(()=>Number.isFinite(document.querySelector('#vid').duration));
    assert.match(await page.locator('#vidNote').textContent(),/未校准/);
    await page.getByRole('tab',{name:'深蹲专项'}).click();
    await page.locator('#squatScope').selectOption('all');
    await page.locator('#squatRun').click();
    await page.waitForFunction(()=>/^预测完成|^预测失败/.test(document.querySelector('#squatStatus').textContent));
    assert.match(await page.locator('#squatStatus').textContent(),/预测完成 · 15 次完整深蹲/);
    assert.equal(await page.locator('#squatRows tr').count(),15);
    assert.deepEqual(await page.evaluate(()=>window.squatInputCounts),[1564,1566]);
    if (motionCapture) {
      const prediction=await page.evaluate(()=>window.squatTest.reps);
      await motionCalibration(null);
      assert.deepEqual(await page.evaluate(()=>window.squatTest.reps),prediction);
    }
    await firstBottomCalibration(await page.evaluate(()=>window.squatTest.reps[0]));
    assert.equal(await page.locator('#squatRows tr').count(),15);
    console.log('PASS mixed D56 insoles and ankle IMUs, 15 predicted cycles');
  }
  if (motionCapture) {
    await importFile(motionCapture);
    await page.waitForFunction(()=>Number.isFinite(document.querySelector('#vid').duration));
    const t=await page.locator('#vid').evaluate(v=>v.currentTime);
    await motionCalibration(1.06);
    assert.equal(await page.locator('#vid').evaluate(v=>v.currentTime),t);
    const endpoint = /^http:\/\/192\.168\.100\.\d+:\d+\/v1\/calibrate$/;
    await page.route(endpoint,route=>route.abort('connectionrefused'));
    const last=await page.locator('#vidOff').inputValue();
    await page.locator('#vidAuto').click();
    await page.waitForFunction(()=>!document.querySelector('#vidAuto').disabled);
    assert.equal(await page.locator('#vidOff').inputValue(),last);
    assert.match(await page.locator('#vidSeekStatus').textContent(),/无法连接工作站.*原偏移保留/);
    await page.unroute(endpoint);
    await page.locator('#vidOff').fill('1.8');
    await page.locator('#vidAuto').click();
    await page.locator('#vidOff').fill('1.625');
    await page.waitForFunction(()=>!document.querySelector('#vidAuto').disabled);
    assert.equal(Number(await page.locator('#vidOff').inputValue()),1.625);
    assert.match(await page.locator('#vidNote').textContent(),/手动/);
  }
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
  if(unsupported) {
    await importFile(unsupported);
    assert.ok(await page.locator('#squatRun').isDisabled());
    assert.match(await page.locator('#squatStatus').textContent(),/左踝、右踝/);
  }
  for(const [file,re] of [[missingComp,/缺少补偿角速度/],[badClock,/时间轴差异过大|时间轴波动较大/]]) {
    if(!file) continue;
    await importFile(file);
    await page.locator('#squatRun').click();
    await page.waitForFunction(()=>/^预测失败/.test(document.querySelector('#squatStatus').textContent));
    assert.match(await page.locator('#squatStatus').textContent(),re);
  }
  assert.deepEqual(errors,[]); assert.deepEqual(network,[]);
  console.log('PASS model parity, video cursor and seeking, file changes, responsive layout and offline mode');
} finally { await browser.close(); }
