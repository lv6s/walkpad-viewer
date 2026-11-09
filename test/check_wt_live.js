/* Real page parser -> scheduler -> HTTP -> ONNX; virtual receipt clock only. */
const assert = require('assert');
const fs = require('fs');
const cdp = require('./cdp');
(async () => {
  const c = await cdp.connect('wt901ble');
  try {
    await c.reload(1000);
    const fixtures = JSON.parse(fs.readFileSync(process.env.WT_FIXTURE, 'utf8'));
    const expression = `(async () => {
      const d = __wtDebug;
      for (let i=1;i<10000;i++) clearInterval(i);
      let clock = 10000;
      Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
      document.querySelector('#actSource').value='wt';
      await document.querySelector('#actSource').onchange();
      const left=d.makeDevice({key:'test-left',name:'WT Left'});
      const right=d.makeDevice({key:'test-right',name:'WT Right'});
      left.connected=right.connected=true;
      d.actWtChoices();
      document.querySelector('#actWtL').value=left.key;
      document.querySelector('#actWtR').value=left.key;
      await d.actStart();
      const duplicateRejected=!d.act.on;
      document.querySelector('#actWtR').value=right.key;
      const results={};
      for (const [name, packets] of Object.entries(${JSON.stringify(fixtures)})) {
        if(d.act.on)d.actStop();
        clock=10000;
        await d.actStart();
        if(!d.act.on)throw new Error(d.act.err);
        let index=0;const outcomes=[];
        for(let end=10000;end<=10000+packets[packets.length-1].receipt_ms-150;end+=200){
          clock=end+150;
          while(index<packets.length && packets[index].receipt_ms<=clock-10000){
            const p=packets[index++], bytes=[];
            for(const v of p.values){
              bytes.push(0x55,0x61);
              for(let j=0;j<9;j++){
                const scale=j<3?16/32768:(j<6?2000/32768:180/32768);
                let n=Math.round((v[j]||0)/scale);n=Math.max(-32768,Math.min(32767,n));
                bytes.push(n&255,(n>>8)&255);
              }
            }
            const packet=new Uint8Array(bytes);
            const saved=clock;clock=10000+p.receipt_ms;
            d.onPacket(p.foot==='l'?left:right,new DataView(packet.buffer));clock=saved;
          }
          await d.actTick();
          outcomes.push(d.act.last);
        }
        const valid=outcomes.filter(v=>v&&v.valid);
        const labels={};valid.forEach(v=>labels[v.label]=(labels[v.label]||0)+1);
        clock+=1000;await d.actTick();
        results[name]={decisions:outcomes.length,valid:valid.length,labels,silenceInvalid:!d.act.last.valid,
          text:document.querySelector('#actWhy').textContent,model:d.act.info.onnx_sha256};
        d.actStop();
      }
      return {duplicateRejected,results,axis:document.querySelector('#actAxis').textContent};
    })()`;
    const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.result.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails));
    const result=r.result.result.value;
    assert(result.duplicateRejected);
    assert(result.axis.includes('无硬件时间戳'));
    for(const v of Object.values(result.results)){
      assert(v.valid>80,JSON.stringify(v));assert(v.silenceInvalid);
      assert(v.labels.walk>60,JSON.stringify(v));assert(!v.labels.run,JSON.stringify(v));
    }
    assert.equal(c.errors().length,0);
    console.log('WT_LIVE_PASS',JSON.stringify(result));
  } finally {c.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
