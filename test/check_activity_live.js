/* Real page + HTTP + ONNX smoke test. CDP_PORT selects an isolated headless browser. */
const cdp = require('./cdp');
const assert = require('assert');

(async () => {
  const c = await cdp.connect('wt901ble');
  const evaluate = async expression => {
    const response = await c.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
    return response.result.result.value;
  };
  try {
    await c.reload(1500);
    const result = await evaluate(`(async () => {
      const d = __wtDebug;
      await d.actInfo();
      await d.actStart();
      if (!d.act.on) throw new Error(d.act.err);
      const start = performance.now();
      for (const foot of ['l','r']) {
        const st = d.irStates[foot];
        st.dev = { fake: true }; st.capI = foot === 'l' ? 1000 : 1001;
        st.bias.ready = true; st.bias.g = [0,0,0]; st.rate = 51;
      }
      let index=0;
      while (performance.now()-start < 3600) {
        const elapsed = performance.now()-start;
        while (index/51.2*1000 <= elapsed) {
          const t = index/51.2, w = t*Math.PI*3.6;
          if (!(index>=80 && index<=82)) for (const foot of ['l','r']) {
            d.actFeed(d.irStates[foot], { clk: { epoch: 1000000+Math.round(t*1000) }, seq: index,
              receiptPerf: performance.now(), perf: -9999,
              ax: Math.sin(w)*.3, ay: 0, az: 1+Math.cos(w)*.2,
              gx: 0, gy: Math.sin(w)*100, gz: 0,
              raw6: [index,0,2048,index,2,3] });
          }
          index++;
        }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      if (d.act.inflight) await new Promise(resolve=>setTimeout(resolve,100));
      await d.actTick();
      const good = d.act.last;
      const text = document.querySelector('#actWhy').textContent;
      const label = document.querySelector('#actLabel').textContent;
      await new Promise(resolve=>setTimeout(resolve,600));
      if (d.act.inflight) await new Promise(resolve=>setTimeout(resolve,100));
      await d.actTick();
      const silent = d.act.last;
      d.actStop();
      return { good, silent, text, label, axis: document.querySelector('#actAxis').textContent };
    })()`);
    assert(result.good.valid, JSON.stringify(result));
    assert.equal(result.good.quality_level, 'degraded');
    assert(Math.abs(result.good.probabilities.reduce((a,b)=>a+b,0)-1)<1e-5);
    assert(result.good.result_age_ms>=150 && result.good.result_age_ms<350);
    assert(result.axis.includes('80 ms'));
    assert(result.text.includes('降级有效'));
    assert(!result.silent.valid && result.silent.label === null);
    assert(['步行','跑步','其他'].includes(result.label));
    assert.equal(c.errors().length, 0);
    console.log('ACTIVITY_LIVE_PASS', JSON.stringify(result));
  } finally { c.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
