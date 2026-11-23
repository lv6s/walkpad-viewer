import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';

const [output, labelZip, ...captures]=process.argv.slice(2);
assert.ok(output && labelZip && captures.length, 'Pass output.json, label ZIP, and key=path captures.');
const csv=execFileSync('tar',['-xOf',labelZip,'--include','*逐次评分.csv'],{encoding:'utf8'}).replace(/^\uFEFF/,'');
function parseLine(line) {
  return (line.match(/(?:^|,)(?:"(?:[^"]|"")*"|[^,]*)/g) ?? []).map((field,i)=>{
    const v=i ? field.slice(1) : field;
    return v.startsWith('"') ? v.slice(1,-1).replaceAll('""','"') : v;
  });
}
const [header,...lines]=csv.trimEnd().split(/\r?\n/).map(parseLine);
const columns=['来源文件','次数','视频蹲底秒','视频复核档'].map(k=>header.indexOf(k));
assert.ok(columns.every(i=>i>=0),'Missing label columns.');
const labels=lines.map(line=>{
  assert.equal(line.length,header.length,'Unsupported label row.');
  const [file,index,bottom,grade]=columns.map(i=>line[i]);
  return {file,index:Number(index),bottom:Number(bottom),grade};
});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage();
  await page.addInitScript(()=>{
    const Native=window.Worker;
    window.Worker=class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener('message',e=>{
          if(e.data.result?.phase instanceof Int8Array) window.squatCapture=e.data;
        });
      }
    };
  });
  await page.goto(new URL('../index.html',import.meta.url).href);
  const packets={};
  for(const arg of captures) {
    const i=arg.indexOf('=');assert.ok(i>0,'Use key=path.');
    const key=arg.slice(0,i);assert.ok(!Object.hasOwn(packets,key),'Duplicate capture.');
    await page.evaluate(()=>{window.squatCapture=null;});
    const input=page.locator('#file');
    await input.setInputFiles([]);
    await input.setInputFiles(arg.slice(i+1));
    await page.locator('#busy').waitFor({state:'hidden'});
    assert.equal(await page.locator('#err').textContent(),'');
    await page.getByRole('tab',{name:'深蹲专项'}).click();
    await page.locator('#squatScope').selectOption('all');
    await page.locator('#squatRun').click();
    await page.waitForFunction(()=>/^预测完成|^预测失败/.test(document.querySelector('#squatStatus').textContent));
    assert.match(await page.locator('#squatStatus').textContent(),/^预测完成/);
    packets[key]=await page.evaluate(()=>{
      const {result:{reps},features,scoreIssue}=window.squatCapture;
      if(scoreIssue || features.length!==reps.length) throw new Error(scoreIssue || 'Feature count mismatch.');
      return reps.map((times,i)=>({times,features:features[i].values}));
    });
    console.log(key,packets[key].length);
  }
  writeFileSync(output,JSON.stringify({labels,packets}));
} finally {await browser.close();}
