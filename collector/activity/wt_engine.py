"""Instep candidate and receive-time preprocessing, separate from the insole model."""
from pathlib import Path
from act_engine import ActEngine
from wt_preprocess import WTInput, WT_POLICY

HERE=Path(__file__).resolve().parent


class WTEngine(ActEngine):
    def __init__(self, threads=1):
        super().__init__(HERE/'act_instep.onnx',HERE/'act_instep.json',threads)

    def reset(self, fs_left=50., fs_right=50., mode='online-v2'):
        out=super().reset(fs_left,fs_right,mode='online-v2')
        self.online=WTInput(fs_left,fs_right)
        out['policy']=WT_POLICY
        return out

    def info(self):
        out=super().info()
        out.update(online_policy=WT_POLICY,axis_label='WT脚背原始xyz；完整三维姿态增强候选',
                   gyro_label='WT设备输出角速度；不套用自研鞋垫零偏估计',
                   gyro_source='WT device output',source='wt',
                   limitations='未验证真实跑步/其他及重新佩戴准确率；非硬件同步')
        return out

    def step(self, events, t_end, now_ms=None):
        out=super().step(events,t_end,now_ms)
        out['preprocess']=WT_POLICY['version']
        if out.get('valid'):
            out['quality_level']='degraded'
        return out
