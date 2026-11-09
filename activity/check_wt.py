"""WT receive-time contract checks and deployed-engine package replay."""
import argparse
import copy
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from wt_engine import WTEngine
from wt_preprocess import WTInput, ReceiptStream


def replay(packets, engine):
    packets=sorted(copy.deepcopy(packets),key=lambda p:p['receipt_ms'])
    decisions=[];index=0
    for end in np.arange(0,packets[-1]['receipt_ms']-149,200):
        now=float(end+150);batch=[]
        while index<len(packets) and packets[index]['receipt_ms']<=now:
            batch.append(packets[index]);index+=1
        result=engine.step(batch,float(end),now)
        decisions.append(result)
    return decisions


def synthetic(seconds=7,fs=50):
    result=[]
    for i in range(int(seconds*fs/2)):
        rx=40.*(i+1)
        for f in 'lr':
            values=[[.1*np.sin(t/100),0,1,0,30*np.sin(t/100),0] for t in [rx-20,rx]]
            result.append(dict(foot=f,receipt_ms=rx,segment=f+'0',values=values))
    return result


def checks():
    s=ReceiptStream(50)
    a=np.array([[0,0,1,0,0,0],[.1,0,1,0,1,0]])
    s.packet(40,'a',a)
    assert len(s.events)==2 and [v[5] for v in s.events]==[0,20]
    s.packet(80,'a',a)
    assert [v[5] for v in s.events]==[0,20,40,60]
    s.packet(80,'a',a)
    assert len(s.events)==4 and s.late==2
    s.packet(120,'b',a)
    assert len(s.events)==2 and s.resets==1
    s.packet(160,'a',a)
    assert s.segment=='b' and len(s.events)==2
    inp=WTInput()
    for packet in [dict(foot='l',receipt_ms=40,segment='l',values=[[0]*6]*11),
                   dict(foot='l',receipt_ms=41,segment='l',values=[[0]*6]),
                   dict(foot='l',receipt_ms=40,segment='l',values=[[float('nan')]*6])]:
        try: inp.push([packet],40)
        except ValueError: pass
        else: raise AssertionError('bad packet accepted')
    assert not inp.streams['l'].events
    eng=WTEngine();base=synthetic();out=replay(base,eng)
    assert sum(v['valid'] for v in out)>15
    assert all(v['quality_level']=='degraded' for v in out if v['valid'])
    assert not eng.step([],7200,7350)['valid']
    assert eng.step([],7400,7550)['label'] is None
    eng.reset();only_left=replay([p for p in base if p['foot']=='l'],eng)
    assert not any(v['valid'] for v in only_left)
    eng.reset();sparse=replay([p for i,p in enumerate(base) if int(p['receipt_ms']/40)%2==0],eng)
    assert not any(v['valid'] for v in sparse[15:])
    eng.reset();gap=replay([p for p in base if not 3000<=p['receipt_ms']<=3300],eng)
    assert any(not v['valid'] for v in gap if 3400<=v['t_end']<=5000)
    assert gap[-1]['valid']
    return dict(packet_spreading=True,duplicate_packet=True,reconnect=True,retired_segment=True,
                atomic_validation=True,valid_online=True,receipt_always_degraded=True,
                silence_invalid=True,missing_foot=True,half_rate_rejected=True,gap_recovery=True)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--repo')
    ap.add_argument('--out',required=True)
    ap.add_argument('--packages',nargs='*',default=[])
    args=ap.parse_args()
    result=dict(selfcheck=checks(),packages={},limitations='Prediction fractions are not accuracy; no interval labels or real-run/other instep validation.')
    if args.packages:
        sys.path.insert(0,str(Path(args.repo)/'scripts'))
        from evaluate_instep_packages import packets
        for path in args.packages:
            pp=packets(path);out=replay(pp,WTEngine())
            valid=[v for v in out if v['valid']]
            counts=Counter(v['label'] for v in valid)
            middle=[v for v in valid if 5000<=v['t_end']<=max(p['receipt_ms'] for p in pp)-2000]
            active=[v for v in valid if 4000<=v['t_end']<=16000]
            tail=[v for v in valid if v['t_end']>=21000]
            result['packages'][Path(path).name]=dict(decisions=len(out),valid=len(valid),
                predicted_counts=dict(counts),invalid_counts=dict(Counter(v['reason'] for v in out if not v['valid'])),
                signal_active_4_16s=dict(windows=len(active),predicted_counts=dict(Counter(v['label'] for v in active))),
                signal_tail_21s=dict(windows=len(tail),predicted_counts=dict(Counter(v['label'] for v in tail))),
                interior_windows=len(middle),interior_walk_fraction=float(np.mean([v['label']=='walk' for v in middle])) if middle else None,
                outcomes=[{k:v[k] for k in ['t_end','valid','label','probabilities']} for v in out])
    Path(args.out).write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({k:v if k!='packages' else {n:{a:b for a,b in d.items() if a!='outcomes'} for n,d in v.items()} for k,v in result.items()},ensure_ascii=False))

if __name__=='__main__':main()
