/* 全局状态与各视图的缓存。视图条目的形状由各自的绘图模块决定，这里只标注键。 */

import type {DetailRef, ImuY, Overview, RefData, Side, SideId, SrcInfo, TabName, VideoInfo, Win} from '../types';

export interface State {
  name: string;
  sides: Side[];
  ymax: number | null;
  auto: boolean;
  detail: DetailRef | null;
  gmax: number;
  /** 这份文件自己声明的东西：schema_version 与列数（维特 TXT 没有则为 null） */
  src: SrcInfo | null;
  /** 'pressure' = 鞋垫 parquet / 测量包；'imu' = 维特 TXT（时间轴是写盘批次重建的） */
  mode: 'pressure' | 'imu';
  /** 有没有压力通道。纯 IMU 的 parquet 也是 mode='pressure' 但压力页没东西可画 */
  hasP: boolean;
  /** true = 时间戳是上位机写盘时刻（维特 TXT），逐帧间隔不能当丢包 */
  rebuilt: boolean;
  /** true = 长录制按窗口懒加载：压力与 IMU 只有窗口块 */
  lazy: boolean;
  tab: string;
  copT: number;
  copSpan: number;
  playing: boolean;
  copLp: boolean;
  copZero: boolean;
  copRate: number;
  zeroOnlyBad: boolean;
  win: Win;
  hoverT: number | null;
  /** 显示采样率（Hz）：只在跨度大到屏幕装不下时才生效，null = 完全按屏宽 */
  drawHz: number | null;
  imuAxes: Set<string>;
  imuKinds: Set<string>;
  /** 'phys' = imu_physical_values（g / °/s），'raw' = imu_raw_values（LSB） */
  imuSrc: string;
  imuY: ImuY;
  /** true = 纵轴按当前时间窗取，false = 按全段取 */
  imuFit: boolean;
  imuDraw: string;
  imuGap: boolean;
  imuGapMs: number;
  /** true = IMU 波形背后铺状态分段底色 */
  imuSeg: boolean;
  /** 整段状态分段的唯一结果：分段页表格与 IMU 底色共用；null = 还没分析 */
  seg: {busy: boolean; status: string; modelId: string; list: any[]} | null;
  axisRange: string;
  axisSens: string;
  ref: RefData | null;
  /** 包里带的现场视频；null = 这份文件没有视频 */
  video: VideoInfo | null;
  /** 视频当前时刻对应的会话时间（秒），null = 没有视频或已收起；IMU 页据此画游标 */
  videoT: number | null;
  /** IMU 页的窄带开关：温度、设备俯仰/侧倾角 */
  imuTemp: boolean;
  imuAng: boolean;
  gaitFocus: {side: SideId; ic: number; to: number; nextIc: number; peak?: number; algorithm: string;
    icUncertain?: boolean; nextIcUncertain?: boolean; note?: string} | null;
  icto: Map<SideId, any> | null;
  ictoOn: boolean;
  ictoListOn: boolean;
  /** COP 播放/段定位用：当前块的起止（懒加载时按块算） */
  copA?: number;
  /** 波形详情的几何，绘图模块写、悬停读 */
  dGeo?: any;
  /** 详情图的离屏画布与几何，由 detail.ts 写 */
  dOff?: any;
  [k: string]: any;
}

export const state: State = {
  name: '', sides: [], ymax: null, auto: true, detail: null, gmax: 0, src: null,
  mode: 'pressure', hasP: true, rebuilt: false, lazy: false,
  tab: 'wave', copT: 0, copSpan: 0, playing: false, copLp: false, copZero: false, copRate: 1,
  zeroOnlyBad: false, win: null, hoverT: null, drawHz: null,
  imuAxes: new Set(['X', 'Y', 'Z']), imuKinds: new Set(['acc', 'gyro']),
  imuSrc: 'phys',
  // 手动纵轴（±值）按数据源分开存：raw 的数是 g 的 2048/4096 倍，共用一份必然错
  imuY: {phys: {acc: null, gyro: null}, raw: {acc: null, gyro: null}},
  imuFit: false, imuDraw: 'line', imuGap: true, imuGapMs: 40, imuSeg: true, seg: null,
  axisRange: 'all', axisSens: 'auto',
  // 同一次录制的另一份 IMU：坐标系不同、轴向结论不能搬，但落地冲击时刻能搬，用来对齐和切段
  ref: null, video: null, videoT: null, imuTemp: true, imuAng: true,
  gaitFocus: null, icto: null, ictoOn: false, ictoListOn: false
};

/* 视图条目各模块自己填，键一律是侧别 */
export const view = new Map<SideId, any>();
export const meanView = new Map<SideId, any>();
export const seekView = new Map<SideId, any>();
export const zeroView = new Map<SideId, any>();
export const gapView = new Map<SideId, any>();
export const imuView = new Map<SideId, any>();
export const axisView = new Map<SideId, any>();

/** 全程缩略条数据按侧挂在这里，不放进 state（它只是渲染缓存） */
export type OvMap = Map<SideId, Overview>;
