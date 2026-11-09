"""Receive-clock WT input: packet order is known, hardware sample times are not."""
import numpy as np
from online_preprocess import DeviceStream, OnlineInput, POLICY

WT_POLICY = dict(POLICY, version='activity-wt-receipt-v1',
    timing='bounded receive-clock cadence tracker, 20ms nominal lag; not hardware synchronized',
    cadence_correction_ms=2., cadence_residual_limit_ms=80., cadence_reset_gap_ms=120.,
    sequence='local parsed-sample counter; hardware loss count unknown', max_missing=None,
    max_packet_samples=10)


class ReceiptStream(DeviceStream):
    def __init__(self, fs):
        super().__init__(fs)
        self.counter = 0
        self.previous_receipt = None

    def packet(self, rx, segment, values):
        if segment != self.segment:
            if segment in self.retired:
                self.late += len(values)
                return
            if self.segment is not None:
                self.retired.append(self.segment)
            self._new_segment(segment)
            self.previous_receipt = None
            self.counter = 0
        if self.previous_receipt is not None and rx <= self.previous_receipt:
            self.late += len(values)
            return
        n = len(values)
        period = 1000/self.fs
        desired_end = rx-period
        if self.events and self.previous_receipt is not None and rx-self.previous_receipt <= 120:
            predicted_end = self.events[-1][5]+n*period
            residual = desired_end-predicted_end
            if abs(residual) <= 80:
                end = min(rx, predicted_end+float(np.clip(residual, -2., 2.)))
            else:
                end = desired_end
        else:
            end = desired_end
        if self.events and end <= self.events[-1][5]:
            self.late += n
            return
        start = end-n*period
        if self.events:
            start = max(start, self.events[-1][5])
        times = start+(end-start)*np.arange(1,n+1)/n
        for t, value in zip(times, values):
            if t <= self.finalized_host:
                self.late += 1
                continue
            self.counter += 1
            self.events.append((float(t),rx,self.counter,value,None,float(t)))
        self.offset = 0.
        self.anchor_d = 0.
        self.previous_receipt = rx
        self.last_rx = rx
        cut = rx-POLICY['retention_ms']
        while len(self.events)>2 and self.events[1][0]<cut:
            self.events.pop(0)

    def window(self, last_index):
        values, q, reason = super().window(last_index)
        q.update(synchronization='receive-clock estimate; inter-foot latency unknown',
                 hardware_loss_count=None, hardware_sample_time=False)
        return values,q,reason


class WTInput(OnlineInput):
    def __init__(self, fs_left=50., fs_right=50.):
        self.streams={'l':ReceiptStream(fs_left),'r':ReceiptStream(fs_right)}
        self.grid_origin=None
        self.next_index=0
        self.last_end=self.last_now=None

    def push(self, events, now):
        batch=[]
        if not isinstance(events,list) or len(events)>1000:
            raise ValueError('WT packets must be a bounded list')
        for p in events:
            if not isinstance(p,dict) or p.get('foot') not in ('l','r'):
                raise ValueError('WT packet requires foot')
            rx=float(p['receipt_ms']);segment=p['segment'];v=np.asarray(p['values'],float)
            if (not np.isfinite(rx) or rx>now+1e-6 or not isinstance(segment,str)
                or not 0<len(segment)<=128 or v.ndim!=2 or v.shape[1]!=6
                or not 1<=len(v)<=WT_POLICY['max_packet_samples'] or not np.isfinite(v).all()):
                raise ValueError('invalid WT packet')
            batch.append((p['foot'],rx,segment,v))
        for foot,rx,segment,v in batch:
            self.streams[foot].packet(rx,segment,v)
        return sum(len(v) for _,_,_,v in batch)
