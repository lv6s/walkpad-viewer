import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';

// Usage: node tests/squat-angle-chart-browser.mjs <capture-with-video.zip> [entry.html] [rep-count] [screenshot.png]
const [capture,entry,expected,screenshot]=process.argv.slice(2);
assert.ok(capture,'Pass a local dual-ankle capture with video.');
const url=entry ? pathToFileURL(entry) : new URL('../index.html',import.meta.url);
const browser=await chromium.launch({channel:process.env.VIEWER_BROWSER || 'chrome',headless:true,
  args:['--disable-background-networking','--disable-component-update','--disable-sync']});
try {
  const context=await browser.newContext({offline:true,viewport:{width:1280,height:1000},colorScheme:'light'});
  await context.route(/^(?:https?|wss?):\/\//,route=>route.abort());
  const page=await context.newPage(), errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message',({data})=>{
          if(data.result?.phase instanceof Int8Array) window.squatPacket=data;
        });
      }
    };
  });
  await page.goto(url.href);
  await page.locator('#file').setInputFiles(capture);
  await page.waitForFunction(()=>!document.querySelector('#bar').hidden && document.querySelector('#busy').hidden);
  assert.equal(await page.locator('#err').textContent(),'');
  await page.getByRole('tab',{name:'深蹲专项'}).click();
  const chart=page.locator('#squatAngleChart'), values=page.locator('#squatAngleValues');
  assert.equal(await chart.isVisible(),true);
  assert.equal(await values.isVisible(),false);
  await page.locator('#squatRun').click();
  await page.waitForFunction(()=>/^预测完成|^预测失败/.test(document.querySelector('#squatStatus').textContent));
  assert.match(await page.locator('#squatStatus').textContent(),/^预测完成/);
  await page.waitForFunction(()=>Number.isFinite(document.querySelector('#vid').duration));
  const {reps,counts,offset,duration}=await page.evaluate(()=>{
    const data=window.squatPacket;
    return {reps:data.result.reps,counts:data.repAngles.map(s=>s.traces.map(r=>r.linked.reduce((n,x)=>n+x))),
      offset:+document.querySelector('#vidOff').value,duration:document.querySelector('#vid').duration};
  });
  assert.ok(reps.length>0);
  if(expected) assert.equal(reps.length,Number(expected));
  assert.equal(await page.locator('#squatAngleRows tr').count(),reps.length);
  assert.deepEqual(counts.map(s=>s.length),[reps.length,reps.length]);
  assert.ok(counts.every(s=>s.every(n=>n>8)),'Both ankles should provide measured angle samples.');

  const layout=()=>page.evaluate(()=>{
    const time=document.querySelector('#squatTimeline'), angle=document.querySelector('#squatAngleChart'), events=document.querySelector('#squatRows');
    const top=time.getBoundingClientRect(), below=angle.getBoundingClientRect(), table=events.getBoundingClientRect();
    return {ordered:top.bottom<below.top && below.bottom<table.top, aligned:top.x===below.x && time.clientWidth===angle.clientWidth};
  });
  assert.deepEqual(await layout(),{ordered:true,aligned:true});
  async function curvePixels() {
    return chart.evaluate(cv=>{
      const g=cv.getContext('2d'), pixels=g.getImageData(0,0,cv.width,cv.height).data, css=getComputedStyle(cv);
      return ['--squat-angle-left','--squat-angle-right'].map(name=>{
        const hex=css.getPropertyValue(name).trim().slice(1), rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16));
        let n=0;
        for(let i=0;i<pixels.length;i+=4) if(rgb.every((v,k)=>Math.abs(v-pixels[i+k])<9)) n++;
        return n;
      });
    });
  }
  assert.ok((await curvePixels()).every(n=>n>30),'The canvas should contain both ankle curves.');

  const index=reps.findIndex(([a,b])=>offset<a && b<offset+duration);
  assert.ok(index>=0,'Video must cover a complete descent for the seek check.');
  const time=(reps[index][0]+reps[index][1])/2;
  async function point(canvas,t) {
    return canvas.evaluate((cv,time)=>{
      const box=cv.getBoundingClientRect(), a=+document.querySelector('#tA').value, b=+document.querySelector('#tB').value;
      return {clientX:box.x+cv.clientLeft+46+(cv.clientWidth-16-46)*(time-a)/(b-a),clientY:box.top+24};
    },t);
  }
  async function alignedCursors(a,b) {
    const [x,y]=await page.evaluate(ids=>ids.map(id=>{
      const el=document.getElementById(id);
      return el.hidden ? null : parseFloat(el.style.left);
    }),[a,b]);
    assert.ok(x!==null && y!==null && Math.abs(x-y)<.5,'Stage and angle cursors are not aligned.');
    return x;
  }
  const before=await point(chart,time);
  await chart.dispatchEvent('pointermove',before);
  assert.match(await values.textContent(),/前后倾 左 [+-−]\d/);
  assert.match(await values.textContent(),/右 [+-−]\d.*左右倾.*绕竖直/);
  await alignedCursors('squatTimelineHoverCursor','squatAngleHoverCursor');
  await chart.dispatchEvent('click',before);
  await chart.dispatchEvent('pointerleave');
  await page.waitForFunction(t=>Math.abs(document.querySelector('#vid').currentTime-t)<.08,time-offset);
  const seekX=await alignedCursors('squatVideoCursor','squatAngleVideoCursor');
  await page.evaluate(()=>document.querySelector('#vid').play());
  await page.waitForFunction(t=>document.querySelector('#vid').currentTime>t+.10,time-offset);
  await page.evaluate(()=>document.querySelector('#vid').pause());
  assert.ok(await alignedCursors('squatVideoCursor','squatAngleVideoCursor')>seekX,'Angle cursor must move as video plays.');

  await page.locator('#squatRows tr').nth(index).locator('td').first().dispatchEvent('click');
  await page.waitForFunction(a=>Math.abs(+document.querySelector('#tA').value-Math.max(0,a-.2))<.03,reps[index][0]);
  const after=await point(chart,time);
  assert.ok(Math.abs(after.clientX-before.clientX)>5,'Zoom did not change the time projection.');
  await chart.dispatchEvent('pointermove',after);
  assert.match(await values.textContent(),/前后倾 左 [+-−]\d/);
  await alignedCursors('squatTimelineHoverCursor','squatAngleHoverCursor');

  if(screenshot) {
    // Show only the analysis UI in the diagnostic screenshot, never the subject's video.
    await page.addStyleTag({content:'#vidPanel{visibility:hidden !important}'});
    await page.locator('#viewSquat .activity-card').screenshot({path:screenshot,scale:'css'});
  }
  await page.emulateMedia({colorScheme:'dark'});
  await page.setViewportSize({width:680,height:950});
  await page.waitForFunction(()=>{
    const c=document.querySelector('#squatAngleChart'); return c.width===Math.round(c.clientWidth*window.devicePixelRatio);
  });
  assert.deepEqual(await layout(),{ordered:true,aligned:true});
  assert.ok((await curvePixels()).every(n=>n>15),'The curves should remain visible at a narrower width in dark mode.');
  assert.deepEqual(errors,[]);
  console.log(`Offline angle chart: ${reps.length} reps, two curves, synchronized windows and cursors, video seek/playback, dark/narrow layout OK`);
} finally {await browser.close();}
