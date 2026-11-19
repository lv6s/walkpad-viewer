/* 脚背 IMU 离线 IC/TO 候选：instep-imu-ic-to-offline-v4-cycle-20261109 的移植。
   cycle_structure.py = 同正波瓣合峰 + 支撑窗选方向；legacy_core.py = 内部搜索；
   boundary_v2.py = 首尾 TO/IC；frozen_core.py = 弱起步恢复。公式、切分条件、拒绝原因照抄，
   只把 numpy 换成标量循环。改算法必须另起版本号，否则对拍闸门（tests/icto-reference.mjs）会失效。 */

import type {IctoInput} from '../types';

const AXES = ['ax_g', 'ay_g', 'az_g', 'gx_dps', 'gy_dps', 'gz_dps'];
const VERSION = 'instep-imu-ic-to-offline-v4-cycle-20261109';

// 正角速度的两类间方差最大切分；与 numpy 同序累加，别改成 Kahan 或先排序后求和
function otsuPositive(x: ArrayLike<number>) {
  const z: number[] = [];
  for (let i = 0; i < x.length; i++) if (x[i] > 0) z.push(x[i]);
  z.sort((a, b) => a - b);
  const n = z.length;
  if (n < 2) return NaN;
  const s = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += z[i]; s[i] = acc; }
  let best = -Infinity, k = 0;
  for (let i = 1; i < n; i++) {
    let v = (s[i - 1] / i - (s[n - 1] - s[i - 1]) / (n - i)) ** 2 * i * (n - i);
    if (z[i - 1] === z[i]) v = -Infinity;
    if (v > best) { best = v; k = i - 1; }
  }
  return (z[k] + z[k + 1]) / 2;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
// 并列时都取最先出现的那个，与 np.argmin / np.argmax 一致
const argMax = (a: ArrayLike<number>, i: number, j: number) => {
  let b = i;
  for (let k = i + 1; k <= j; k++) if (a[k] > a[b]) b = k;
  return b;
};
const argMin = (a: ArrayLike<number>, i: number, j: number) => {
  let b = i;
  for (let k = i + 1; k <= j; k++) if (a[k] < a[b]) b = k;
  return b;
};
function medianOf(xs: number[]) {
  const s = Float64Array.from(xs).sort();
  const n = s.length;
  return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// 时间映射缺失、包序号倒退或跳号、时间倒退都要切开：缺口两侧不能被同一个摆动峰连起来
function segmentsOf(n: number, ok: Uint8Array, seq: Float64Array, t: Float64Array) {
  const cuts: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = seq[i] - seq[i - 1];
    if (!ok[i - 1] || !ok[i] || d < 0 || d > 1 || t[i] - t[i - 1] < 0) cuts.push(i);
  }
  const segs: [number, number][] = [];
  let s0 = 0;
  for (const b of cuts) { if (b > s0) segs.push([s0, b]); s0 = b; }
  if (s0 < n) segs.push([s0, n]);
  // 只留整段都有效的区间：夹杂无效行的段一律不作为分析对象
  return segs.filter(([p, q]) => {
    for (let i = p; i < q; i++) if (!ok[i]) return false;
    return true;
  });
}

// 摆动锚：p>cut 的连续区间取峰（贴着段首尾的截断区间不算），同波瓣多峰合并，再按峰高做 200ms 抑制
function anchors(p: Float64Array, t: Float64Array, start: number, stop: number, cut: number, diag?: any) {
  const raw: number[] = [];
  let i = start;
  while (i <= stop) {
    if (!(p[i] > cut)) { i++; continue; }
    let j = i;
    while (j < stop && p[j + 1] > cut) j++;
    if (i !== start && j !== stop) raw.push(argMax(p, i, j));
    i = j + 1;
  }
  // 两峰之间始终 p>0 ⇒ 属于同一个连续正波瓣，只是一次摆动被门限劈成了两半
  const groups: number[][] = [];
  for (const j of raw) {
    const last = groups.length ? groups[groups.length - 1] : null;
    let split = true;
    if (last) {
      split = false;
      for (let k = last[last.length - 1]; k <= j; k++) if (p[k] <= 0) { split = true; break; }
    }
    if (split) groups.push([j]); else last.push(j);
  }
  const merged = groups.map(g => {
    let b = g[0];
    for (const k of g) if (p[k] > p[b]) b = k;
    return b;
  });
  const byPitch = merged.slice().sort((a, b) => (p[b] - p[a]) || (a - b));
  const keep: number[] = [];
  for (const j of byPitch) {
    let okGap = true;
    for (const h of keep) if (Math.abs(t[j] - t[h]) < .2 - 1e-9) { okGap = false; break; }
    if (okGap) keep.push(j);
  }
  keep.sort((a, b) => a - b);
  if (diag) {
    diag.raw_threshold_peaks = raw;
    diag.same_positive_lobe_groups = groups;
    diag.merged_lobe_peaks = merged;
    diag.retained_anchors = keep;
  }
  return keep;
}

// 正负方向用「相邻锚点之间的低角速度支撑窗」比一致性：两个方向各算 30%–45% 窗内最小 |ω| 的中位数，
// 小的那边才是脚掌俯仰正方向。三阶矩只在证据不足或分数相同时决定。
function choosePolarity(gAxis: Float64Array, gn: Float64Array, t: Float64Array, n: number,
                        ok: Uint8Array, segs: [number, number][]) {
  let count = 0, sum = 0;
  for (let i = 0; i < n; i++) if (ok[i]) { count++; sum += gAxis[i]; }
  const mean = count ? sum / count : 0;
  let sk = 0;
  for (let i = 0; i < n; i++) if (ok[i]) { const d = gAxis[i] - mean; sk += d * d * d; }
  const legacySign = count && sk / count >= 0 ? 1 : -1;

  const options: any[] = [];
  for (const sign of [1, -1]) {
    const p = new Float64Array(n);
    const uniq = new Set<number>();
    for (let i = 0; i < n; i++) {
      p[i] = sign * gAxis[i];
      if (ok[i] && p[i] > 0) uniq.add(p[i]);
    }
    const opt: any = {sign, threshold_dps: null, median_support_G_dps: null, support_samples: [], segments: []};
    options.push(opt);
    if (uniq.size < 2) { opt.status = 'insufficient_positive_variation'; continue; }
    const vals: number[] = [];
    for (let i = 0; i < n; i++) if (ok[i]) vals.push(p[i]);
    const cut = otsuPositive(vals);
    opt.threshold_dps = cut;
    const support: number[] = [];
    for (const [s, e] of segs) {
      const start = s, stop = e - 1;
      const detail: any = {start, stop};
      const kept = anchors(p, t, start, stop, cut, detail);
      opt.segments.push(detail);
      for (let w = 0; w + 1 < kept.length; w++) {
        const a = kept[w], b = kept[w + 1], span = t[b] - t[a];
        const lo = t[a] + .30 * span, hi = t[a] + .45 * span;
        let m = -1;
        for (let k = a; k <= b; k++) if (t[k] >= lo && t[k] <= hi) { if (m < 0 || gn[k] < gn[m]) m = k; }
        if (m < 0) continue;
        support.push(gn[m]);
        opt.support_samples.push({start: a, stop: b, support: m, start_s: t[a], stop_s: t[b],
          support_s: t[m], support_G_dps: gn[m]});
      }
    }
    if (support.length) { opt.median_support_G_dps = medianOf(support); opt.status = 'scored'; }
    else opt.status = 'no_observed_support_window';
  }

  const scored = options.filter(o => o.median_support_G_dps !== null);
  let sign: number, status: string;
  if (scored.length) {
    let best = scored[0];
    for (let i = 1; i < scored.length; i++) {
      const c = scored[i];
      if (c.median_support_G_dps < best.median_support_G_dps
        || (c.median_support_G_dps === best.median_support_G_dps
          && c.sign === legacySign && best.sign !== legacySign)) best = c;
    }
    sign = best.sign;
    status = 'support_consistency_selected';
    if (scored.length === 1) status = 'only_one_direction_has_support_evidence';
    else if (scored[0].median_support_G_dps === scored[1].median_support_G_dps) status = 'equal_support_scores_legacy_tiebreak';
  } else {
    const usable = options.filter(o => o.threshold_dps !== null);
    if (!usable.length) throw new Error('两方向都没有两个以上不同取值的正角速度，定不出门限');
    sign = usable.some(o => o.sign === legacySign) ? legacySign : usable[0].sign;
    status = 'insufficient_support_evidence_legacy_fallback';
  }
  return {sign, diag: {method: 'median_min_G_in_inherited_support_windows', status,
    legacy_skew_sign: legacySign, selected_sign: sign, options}};
}

// 谷值两侧都必须有观测到的高点：量化平底允许，但不会被当成「没有回归」
function closedMinimum(p: Float64Array, j: number, start: number, stop: number) {
  let left = j, right = j;
  while (left > start && p[left - 1] === p[j]) left--;
  while (right < stop && p[right + 1] === p[j]) right++;
  return left > start && right < stop && p[left - 1] > p[j] && p[right + 1] > p[j];
}

// inp 按列存（n 行）：tUs 整数微秒、seq 原始包序号、ok=1 表示该行时间映射有效、
// ax 是 n×6 展开的 ax..gz（列序同 AXES）。sfo 是源帧序号，用于输出与溯源，须严格递增。
function detect(key: string, side: string, inp: IctoInput) {
  const n = inp.n, ax = inp.ax, seq = inp.seq, ok = inp.ok, tUs = inp.tUs;
  const t = new Float64Array(n), gn = new Float64Array(n), an = new Float64Array(n);
  const gc = new Float64Array(n * 3);
  let m = 0;
  for (let i = 0; i < n; i++) {
    t[i] = tUs[i] / 1e6;
    const o = i * 6;
    const g0 = ax[o + 3], g1 = ax[o + 4], g2 = ax[o + 5];
    const a0 = ax[o], a1 = ax[o + 1], a2 = ax[o + 2];
    gc[i * 3] = g0; gc[i * 3 + 1] = g1; gc[i * 3 + 2] = g2;
    gn[i] = Math.sqrt(g0 * g0 + g1 * g1 + g2 * g2);
    an[i] = Math.sqrt(a0 * a0 + a1 * a1 + a2 * a2);
    if (ok[i]) m++;
  }
  const sfo = inp.sfo;
  const ordOf = (i: number) => (sfo && Number.isFinite(sfo[i])) ? sfo[i] : i;

  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) if (ok[i]) for (let j = 0; j < 3; j++) sum[j] += gc[i * 3 + j];
  const mean = m ? [sum[0] / m, sum[1] / m, sum[2] / m] : [0, 0, 0];
  const ss = [0, 0, 0];
  for (let i = 0; i < n; i++) if (ok[i]) for (let j = 0; j < 3; j++) {
    const d = gc[i * 3 + j] - mean[j];
    ss[j] += d * d;
  }
  const varG = [ss[0] / (m || 1), ss[1] / (m || 1), ss[2] / (m || 1)];
  let axis = 0;
  for (let j = 1; j < 3; j++) if (varG[j] > varG[axis]) axis = j;
  const varSum = varG[0] + varG[1] + varG[2];
  const gAxis = new Float64Array(n);
  for (let i = 0; i < n; i++) gAxis[i] = gc[i * 3 + axis];

  const segs = segmentsOf(n, ok, seq, t);
  const pol = choosePolarity(gAxis, gn, t, n, ok, segs);
  const sign = pol.sign;
  const pitch = new Float64Array(n);
  for (let i = 0; i < n; i++) pitch[i] = sign * gAxis[i];
  const pv: number[] = [];
  for (let i = 0; i < n; i++) if (ok[i]) pv.push(pitch[i]);
  const cut = otsuPositive(pv);

  const base = (j: number) => ({
    imu_packet_time_s: t[j], tUs: tUs[j], row: inp.row ? inp.row[j] : j, rowIdx: j,
    source_frame_ordinal: ordOf(j), pitch_proxy_dps: r4(pitch[j]), acc_norm_g: r4(an[j]),
    pitchRaw: pitch[j], accRaw: an[j]
  });

  // ---- 内部：相邻锚点之间找一对 IC / TO -------------------------------------
  const events: any[] = [];
  const cycles: any[] = [];
  const segDiag: any[] = [];
  let count = 0;
  const lastT: number[] = [];   // 已接受事件的时刻，末两个即上一周期的 IC / TO
  for (const [s, e] of segs) {
    const start = s, stop = e - 1;
    const keep = anchors(pitch, t, start, stop, cut);
    segDiag.push({start, stop, anchors: keep.length});
    for (let w = 0; w + 1 < keep.length; w++) {
      const a = keep[w], b = keep[w + 1];
      count++;
      const span = t[b] - t[a];
      const lo = t[a] + .30 * span, hi = t[a] + .45 * span;
      let reason = '', ic = -1, to = -1, mIdx = -1;
      for (let k = a; k <= b; k++) if (t[k] >= lo && t[k] <= hi) { if (mIdx < 0 || gn[k] < gn[mIdx]) mIdx = k; }
      if (mIdx < 0) reason = 'no_midstance_sample';
      else {
        // 中间支撑后第一次正→非正（脚落地），下一次中间支撑前最后一次非正→正（脚离地）
        let z1 = -1, z2 = -1;
        for (let k = a + 1; k < mIdx; k++) if (pitch[k] <= 0 && pitch[k - 1] > 0) { z1 = k; break; }
        for (let k = b - 1; k > mIdx; k--) if (pitch[k] <= 0 && pitch[k + 1] > 0) { z2 = k; break; }
        if (z1 < 0 || z2 < 0) reason = 'missing_zero_crossing';
        else {
          ic = argMin(pitch, z1, mIdx - 1);
          to = argMin(pitch, mIdx + 1, z2);
          if (!(a < ic && ic < mIdx && mIdx < to && to < b && t[ic] < t[to] && pitch[ic] < 0 && pitch[to] < 0))
            reason = 'unresolved_order_or_lobes';
          // 同一类事件的最小间隔：连着两个周期贴太近说明是一个事件被切成了两个
          if (!reason && lastT.length >= 2
            && (t[ic] - lastT[lastT.length - 2] < .2 - 1e-9 || t[to] - lastT[lastT.length - 1] < .2 - 1e-9))
            reason = 'same_event_spacing_lt_200ms';
        }
      }
      cycles.push({activity: key, side, cycle: count, swing_start_s: t[a], swing_end_s: t[b],
        status: reason || 'candidate_pair'});
      if (reason) continue;
      for (const typ of ['IC', 'TO']) {
        const j = typ === 'IC' ? ic : to;
        events.push({
          ...base(j),
          id: key + '-' + side + '-' + String(count).padStart(3, '0') + '-' + typ,
          activity: key, side, event: typ, cycle: count, detection_path: 'interior',
          swing_start_s: t[a], swing_end_s: t[b], status: 'candidate_unverified', review_note: '',
          reference_stride_s: null, support_window: null, startup: null
        });
        lastT.push(t[j]);
      }
    }
  }
  // 邻接周期没分成段的，事件本身仍可能有效，但要优先人工核验
  const rejected = new Set(cycles.filter(c => c.status !== 'candidate_pair').map(c => c.cycle));
  for (const e of events) {
    if (rejected.has(e.cycle - 1) || rejected.has(e.cycle + 1)) e.review_note = '优先核验：邻接未能分段的周期';
  }
  const interior = events.slice();

  // ---- 首尾：只补记录最外侧有效片段的首 TO 与末 IC --------------------------
  let firstValid = -1, lastValid = -1;
  for (let i = 0; i < n; i++) if (ok[i]) { if (firstValid < 0) firstValid = i; lastValid = i; }
  const bndDiag: any[] = [];
  const bndEvents: any[] = [];
  const edges: [string, string, [number, number]][] = segs.length
    ? [['TO', 'record_start', segs[0]], ['IC', 'record_end', segs[segs.length - 1]]] : [];
  for (const [kind, path, seg] of edges) {
    const start = seg[0], stop = seg[1] - 1;
    const diag: any = {event: kind, detection_path: path, segment_start: start, segment_stop: stop};
    bndDiag.push(diag);
    if ((kind === 'TO' && start !== firstValid) || (kind === 'IC' && stop !== lastValid)) {
      diag.status = 'not_record_outer_valid_edge';
      continue;
    }
    const kept = anchors(pitch, t, start, stop, cut);
    diag.anchors_in_segment = kept.length;
    if (kept.length < 2) { diag.status = 'insufficient_reference_anchors'; continue; }
    const anchor = kind === 'TO' ? kept[0] : kept[kept.length - 1];
    // 门限把一次摆动劈成两半时，那两个峰不能给出整步时长；要找一个真经过 p≤0 的邻居当参考
    const others: number[] = [];
    if (kind === 'TO') { for (let i = 1; i < kept.length; i++) others.push(kept[i]); }
    else { for (let i = kept.length - 2; i >= 0; i--) others.push(kept[i]); }
    let reference = -1;
    for (const j of others) {
      const lo = Math.min(j, anchor), hi = Math.max(j, anchor);
      for (let k = lo; k <= hi; k++) if (pitch[k] <= 0) { reference = j; break; }
      if (reference >= 0) break;
    }
    if (reference < 0) { diag.status = 'no_distinct_swing_for_stride_reference'; continue; }
    const stride = Math.abs(t[anchor] - t[reference]);
    diag.anchor_index = anchor; diag.anchor_time_s = t[anchor];
    diag.reference_anchor_index = reference; diag.reference_anchor_time_s = t[reference];
    diag.reference_stride_s = stride;
    if (stride <= 0) { diag.status = 'nonpositive_reference_stride'; continue; }
    // 与内部同一套 30%–45% 支撑位置规则；参考周期只用来摆搜索窗，不虚构样本值
    const lo = kind === 'TO' ? t[anchor] - .70 * stride : t[anchor] + .30 * stride;
    const hi = kind === 'TO' ? t[anchor] - .55 * stride : t[anchor] + .45 * stride;
    diag.support_window_start_s = lo; diag.support_window_end_s = hi;
    if (t[start] > lo || t[stop] < hi) { diag.status = 'support_window_not_fully_observed'; continue; }
    let mid = -1;
    for (let k = start; k <= stop; k++) if (t[k] >= lo && t[k] <= hi) { if (mid < 0 || gn[k] < gn[mid]) mid = k; }
    if (mid < 0) { diag.status = 'no_midstance_sample'; continue; }
    diag.support_index = mid; diag.support_time_s = t[mid];
    let j = -1, ordered = false;
    if (kind === 'TO') {
      let cross = -1;
      for (let k = mid + 1; k < anchor; k++) if (pitch[k] <= 0 && pitch[k + 1] > 0) cross = k;
      if (cross < 0) { diag.status = 'missing_pre_swing_upcrossing'; continue; }
      j = argMin(pitch, mid + 1, cross);
      ordered = mid < j && j < anchor && t[mid] < t[j] && t[j] < t[anchor];
    } else {
      let cross = -1;
      for (let k = anchor + 1; k < mid; k++) if (pitch[k] <= 0 && pitch[k - 1] > 0) { cross = k; break; }
      if (cross < 0) { diag.status = 'missing_post_swing_downcrossing'; continue; }
      j = argMin(pitch, cross, mid - 1);
      ordered = anchor < j && j < mid && t[anchor] < t[j] && t[j] < t[mid];
    }
    diag.candidate_index = j; diag.candidate_time_s = t[j];
    if (!ordered || pitch[j] >= 0) { diag.status = 'unresolved_order_or_negative_lobe'; continue; }
    if (!closedMinimum(pitch, j, start, stop)) { diag.status = 'minimum_not_bracketed_by_observed_samples'; continue; }
    if (events.length) {
      let minT = Infinity, maxT = -Infinity;
      for (const e of events) {
        if (e.imu_packet_time_s < minT) minT = e.imu_packet_time_s;
        if (e.imu_packet_time_s > maxT) maxT = e.imu_packet_time_s;
      }
      if ((kind === 'TO' && t[j] >= minT) || (kind === 'IC' && t[j] <= maxT)) {
        diag.status = 'not_outside_interior_event_range';
        continue;
      }
    }
    let near = false;
    for (const e of events.concat(bndEvents)) {
      if (e.event === kind && Math.abs(t[j] - e.imu_packet_time_s) < .2 - 1e-9) { near = true; break; }
    }
    if (near) { diag.status = 'same_event_spacing_lt_200ms'; continue; }
    const maxCycle = cycles.reduce((acc, c) => Math.max(acc, c.cycle), 0);
    bndEvents.push({
      ...base(j),
      id: key + '-' + side + '-' + path + '-' + kind,
      activity: key, side, event: kind, cycle: kind === 'TO' ? 0 : maxCycle + 1,
      detection_path: path,
      swing_start_s: kind === 'TO' ? null : t[anchor],
      swing_end_s: kind === 'TO' ? t[anchor] : null,
      status: 'candidate_unverified',
      review_note: '首尾独立候选，需视频确认；参考周期只用于定位搜索窗',
      reference_stride_s: stride,
      support_window: [lo, hi],
      startup: null
    });
    diag.status = 'candidate_event';
  }

  // ---- 弱起步：首强摆动之前若还有一次够幅度、且能配出完整一对的弱摆动，补一对 ----
  const startupDiag: any = {status: 'not_evaluated', candidates: []};
  const startupEvents: any[] = [];
  const allBefore = events.concat(bndEvents);

  // 弱起步候选的逐条判定：任何一步不成立就只留下原因，不产出事件
  function weakStartCandidate(d: any, w: number, first: number, start: number, stop: number,
                              oldIndex: number, cp: number, cg: number) {
    if (pitch[w] > cut) return 'already_strong_lobe';
    if (!(pitch[w] > cp && gn[w] > cg)) return 'below_joint_prefix_activity_thresholds';
    const stride = t[first] - t[w];
    if (stride <= 0) return 'nonpositive_stride';
    const postlo = t[w] + .30 * stride, posthi = t[w] + .45 * stride;
    let mid = -1;
    for (let k = w; k <= first; k++) if (t[k] >= postlo && t[k] <= posthi) { if (mid < 0 || gn[k] < gn[mid]) mid = k; }
    if (mid < 0) return 'no_post_swing_support_sample';
    let down = -1;
    for (let k = w + 1; k < mid; k++) if (pitch[k] <= 0 && pitch[k - 1] > 0) { down = k; break; }
    let up = -1;
    for (let k = first - 1; k > mid; k--) if (pitch[k] <= 0 && pitch[k + 1] > 0) { up = k; break; }
    if (down < 0 || up < 0) return 'missing_cycle_zero_crossings';
    const ic = argMin(pitch, down, mid - 1);
    const nextTo = argMin(pitch, mid + 1, up);
    d.post_support_index = mid; d.IC_index = ic; d.next_TO_index = nextTo;
    d.reference_stride_s = stride; d.post_support_window = [postlo, posthi];
    if (!(w < ic && ic < mid && mid < nextTo && nextTo < first
      && t[w] < t[ic] && t[ic] < t[nextTo] && t[nextTo] < t[first] && pitch[ic] < 0 && pitch[nextTo] < 0))
      return 'inconsistent_cycle_order';
    if (nextTo !== oldIndex) return 'does_not_reproduce_existing_start_TO';
    const lo = t[w] - .70 * stride, hi = t[w] - .55 * stride;
    d.pre_support_window = [lo, hi];
    if (lo < t[start] || hi > t[stop]) return 'pre_support_window_not_fully_observed';
    let m0 = -1, background = -Infinity;
    for (let k = start; k <= stop; k++) {
      if (t[k] < lo || t[k] > hi) continue;
      if (m0 < 0 || gn[k] < gn[m0]) m0 = k;
      if (gn[k] > background) background = gn[k];
    }
    if (m0 < 0) return 'no_pre_support_sample';
    let cross = -1;
    for (let k = m0 + 1; k < w; k++) if (pitch[k] <= 0 && pitch[k + 1] > 0) cross = k;
    if (cross < 0) return 'missing_start_TO_upcrossing';
    const to = argMin(pitch, m0 + 1, cross);
    d.TO_index = to; d.pre_support_index = m0; d.observed_support_max_dps = background;
    d.TO_time_s = t[to]; d.IC_time_s = t[ic];
    if (!(m0 < to && to < w && w < ic && ic < nextTo
      && t[m0] < t[to] && t[to] < t[w] && t[w] < t[ic] && t[ic] < t[nextTo] && pitch[to] < 0))
      return 'inconsistent_startup_order';
    for (const j of [to, ic]) if (!closedMinimum(pitch, j, start, stop)) return 'unbracketed_event_minimum';
    for (const j of [to, w, ic]) if (!(gn[j] > background)) return 'not_above_observed_pre_support_motion';
    let minT = Infinity;
    for (const e of allBefore) if (e.imu_packet_time_s < minT) minT = e.imu_packet_time_s;
    if (t[ic] >= minT) return 'overlaps_existing_event_range';
    for (const [kind, j] of [['TO', to], ['IC', ic]] as [string, number][]) {
      for (const e of allBefore) {
        if (e.event === kind && Math.abs(t[j] - e.imu_packet_time_s) < .2 - 1e-9) return 'same_event_spacing_lt_200ms';
      }
    }
    return 'accepted_candidate_pair';
  }

  if (!segDiag.length) startupDiag.status = 'no_valid_segment';
  else {
    const start = segDiag[0].start, stop = segDiag[0].stop;
    const segKept = anchors(pitch, t, start, stop, cut);
    const oldTo = allBefore.find(e => e.detection_path === 'record_start' && e.event === 'TO');
    if (start !== firstValid) startupDiag.status = 'not_record_outer_valid_edge';
    else if (segKept.length < 2) startupDiag.status = 'insufficient_reference_anchors';
    else if (!oldTo) startupDiag.status = 'no_existing_start_TO_for_consistency';
    else {
      const first = segKept[0];
      const oldIndex = oldTo.rowIdx;
      let end = first;
      while (end > start && pitch[end - 1] > 0) end--;
      startupDiag.segment_start = start; startupDiag.segment_stop = stop;
      startupDiag.first_strong_anchor_index = first;
      startupDiag.first_strong_anchor_s = t[first];
      startupDiag.prefix_stop_exclusive = end;
      startupDiag.existing_start_TO_index = oldIndex;
      if (end - start < 2) startupDiag.status = 'insufficient_prefix';
      else {
        // 前缀自己的两个 Otsu 门限：p 与 |ω| 必须同时超过，避免把噪声当弱步
        const pPre: number[] = [], gPre: number[] = [];
        for (let i = start; i < end; i++) { pPre.push(pitch[i]); gPre.push(gn[i]); }
        const cp = otsuPositive(pPre), cg = otsuPositive(gPre);
        startupDiag.local_pitch_threshold_dps = cp;
        startupDiag.local_norm_threshold_dps = cg;
        if (!isFinite(cp) || !isFinite(cg)) startupDiag.status = 'insufficient_prefix_variation';
        else {
          const accepted: any[] = [];
          let i = start;
          while (i < end) {
            if (!(pitch[i] > 0)) { i++; continue; }
            let j = i;
            while (j + 1 < end && pitch[j + 1] > 0) j++;
            if (i !== start && j !== end - 1) {
              const w = argMax(pitch, i, j);
              const d: any = {anchor_index: w, anchor_time_s: t[w], peak_pitch_dps: pitch[w], peak_norm_dps: gn[w]};
              startupDiag.candidates.push(d);
              d.status = weakStartCandidate(d, w, first, start, stop, oldIndex, cp, cg);
              if (d.status === 'accepted_candidate_pair') accepted.push(d);
            }
            i = j + 1;
          }
          if (accepted.length !== 1) {
            startupDiag.status = accepted.length ? 'ambiguous_multiple_weak_starts' : 'no_supported_weak_start';
          } else {
            const d = accepted[0];
            startupDiag.status = 'accepted_candidate_pair';
            for (const kind of ['TO', 'IC']) {
              const j = kind === 'TO' ? d.TO_index : d.IC_index;
              startupEvents.push({
                ...base(j),
                id: key + '-' + side + '-weak_start-' + kind,
                activity: key, side, event: kind, cycle: -1, detection_path: 'startup_recovery',
                swing_start_s: kind === 'TO' ? null : t[d.anchor_index],
                swing_end_s: kind === 'TO' ? t[d.anchor_index] : t[first],
                status: 'candidate_unverified', review_note: '弱起步恢复候选，需视频确认',
                reference_stride_s: d.reference_stride_s,
                support_window: kind === 'TO' ? d.pre_support_window : d.post_support_window,
                startup: {anchor_s: t[d.anchor_index], pitch_threshold_dps: cp, norm_threshold_dps: cg,
                  observed_support_max_dps: d.observed_support_max_dps}
              });
            }
          }
        }
      }
    }
  }

  const all = events.concat(bndEvents, startupEvents)
    .sort((a, b) => (a.imu_packet_time_s - b.imu_packet_time_s) || (a.source_frame_ordinal - b.source_frame_ordinal));

  const cnt = (arr: string[]) => {
    const o: Record<string, number> = {};
    for (const v of arr) o[v] = (o[v] || 0) + 1;
    return o;
  };
  return {
    events: all, cycles,
    diagnostics: {
      version: VERSION,
      samples: n, mapped_rows: m, excluded_rows: n - m,
      gyro_axis: 'xyz'[axis], sign,
      dominant_axis_variance_share: varSum > 0 ? r4(varG[axis] / varSum) : 0,
      swing_lobe_threshold_dps: cut,
      polarity_selection: pol.diag,
      segments: segDiag,
      cycles: cnt(cycles.map(c => c.status)),
      events: cnt(all.map(e => e.event)),
      interior_events: cnt(interior.map(e => e.event)),
      boundary_events: cnt(bndEvents.map(e => e.event)),
      startup_events: cnt(startupEvents.map(e => e.event)),
      boundary_diagnostics: bndDiag,
      startup_diagnostics: startupDiag,
      clock: 'mapped packet receive time; no inferred within-packet offset'
    }
  };
}

// 包装层：与 ic_to.detect_rows 同样的空输入判据，避免把「样本不够」当成「没有落步」
function detectRows(inp: IctoInput, side: string, key: string) {
  const n = inp.n;
  let mapped = 0;
  for (let i = 0; i < n; i++) if (inp.ok[i]) mapped++;
  const empty = (status: string) => ({
    events: [] as any[], cycles: [] as any[],
    diagnostics: {version: VERSION, status, samples: n, mapped_rows: mapped,
      excluded_rows: n - mapped, events: {}, cycles: {}} as any
  });
  if (mapped < 2) return empty('insufficient_valid_samples');
  // 与 ic_to.detect_rows 同一判据：先选轴，再看某个方向的正角速度有没有两个不同取值
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) if (inp.ok[i]) for (let j = 0; j < 3; j++) sum[j] += inp.ax[i * 6 + 3 + j];
  const mean = sum.map(v => v / mapped);
  const ssq = [0, 0, 0];
  for (let i = 0; i < n; i++) if (inp.ok[i]) for (let j = 0; j < 3; j++) {
    const d = inp.ax[i * 6 + 3 + j] - mean[j];
    ssq[j] += d * d;
  }
  let a = 0;
  for (let j = 1; j < 3; j++) if (ssq[j] / mapped > ssq[a] / mapped) a = j;
  let usable = false;
  for (const sg of [1, -1]) {
    const uniq = new Set<number>();
    for (let i = 0; i < n; i++) if (inp.ok[i] && sg * inp.ax[i * 6 + 3 + a] > 0) uniq.add(sg * inp.ax[i * 6 + 3 + a]);
    if (uniq.size >= 2) { usable = true; break; }
  }
  if (!usable) return empty('insufficient_distinct_positive_gyro_values');
  return detect(key, side, inp);
}

export {AXES as ICTO_AXES, VERSION as ICTO_VERSION, detect as ictoDetect, detectRows as ictoDetectRows};
