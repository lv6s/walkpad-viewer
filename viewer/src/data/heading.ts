// relativeHeadingDeg 是按 [-180,180] 回绕输出的：跨越 ±180 时原始值会跳 360°，
// 直接画成曲线是一个假尖峰，跨蹲比较也会差出整整一圈。这里按「相邻差最小」展开成连续角。
// 只在同一 referenceId 内展开；参考一变说明设备重建了姿态基准，之前的角度不可比，重新起算。
const NO_REF = Symbol('no-ref');

export function headingCursor() {
  let ref: unknown = NO_REF, prevWrapped = NaN, acc = NaN;
  return (v: number, refId?: string | null): number => {
    if (!Number.isFinite(v)) return NaN;
    if (refId !== ref || !Number.isFinite(acc)) {
      ref = refId; prevWrapped = v; acc = v;
      return acc;
    }
    let d = v - prevWrapped;
    if (d > 180) d -= 360; else if (d < -180) d += 360;
    acc += d; prevWrapped = v;
    return acc;
  };
}
