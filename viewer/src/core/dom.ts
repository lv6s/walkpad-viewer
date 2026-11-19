/* DOM 引用。axis.html 是独立页，大部分 id 取不到 —— 一律允许 null，用之前先判。 */

export const $ = (s: string): any => document.querySelector(s);

export const el: Record<string, any> = {
  drop: $('#drop'), file: $('#file'), pick: $('#pick'), err: $('#err'), bar: $('#bar'),
  fname: $('#fname'), chips: $('#chips'), ymax: $('#ymax'), panels: $('#panels'),
  tip: $('#tip'), detail: $('#detail'), dTitle: $('#dTitle'), dMeta: $('#dMeta'),
  dCanvas: $('#dCanvas'), dClose: $('#dClose'), again: $('#again'), cop: $('#copPanels'),
  tabs: $('#tabs'), viewWave: $('#viewWave'), viewCop: $('#viewCop'),
  zero: $('#zeroPanels'), viewZero: $('#viewZero'),
  gap: $('#gapPanels'), viewGap: $('#viewGap'),
  viewActivity: $('#viewActivity'),
  viewAction: $('#viewAction'),
  viewImu: $('#viewImu'), imu: $('#imuPanels'), imuNote: $('#imuNote'),
  imuYa: $('#imuYa'), imuYg: $('#imuYg'), imuYauto: $('#imuYauto'), imuYfit: $('#imuYfit'),
  imuUa: $('#imuUa'), imuUg: $('#imuUg'), imuKindLbl: $('#imuKindLbl'),
  imuGap: $('#imuGap'), imuGapMs: $('#imuGapMs'),
  imuRun: $('#imuRun'), imuSegOn: $('#imuSegOn'), imuSegNote: $('#imuSegNote'),
  winBar: $('#winBar'), winText: $('#winText'), winReset: $('#winReset'), winKeys: $('#winKeys'),
  rateSel: $('#rateSel'),
  tA: $('#tA'), tB: $('#tB'), tGo: $('#tGo'),
  scrub: $('#scrub'), scrubCv: $('#scrubCv'), scrubTip: $('#scrubTip'),
  imuOvBar: $('#imuOvBar'), imuOv: $('#imuOv'), imuOvLbl: $('#imuOvLbl'),
  viewAxis: $('#viewAxis'), axis: $('#axisPanels'), axisNote: $('#axisNote'), axisTools: $('#axisTools'),
  axisRef: $('#axisRef'), axisRefFile: $('#axisRefFile'), axisRefName: $('#axisRefName'),
  ictoOn: $('#ictoOn'), ictoList: $('#ictoList'), ictoRe: $('#ictoRe'), ictoNote: $('#ictoNote'),
  ictoBox: $('#ictoBox'), ictoCsvEv: $('#ictoCsvEv'), ictoCsvCy: $('#ictoCsvCy'),
  busy: $('#busy'), ver: $('#ver')
};
