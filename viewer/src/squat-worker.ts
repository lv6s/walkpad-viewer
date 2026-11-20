import {predictSquats, type AnkleStream} from './squat-core';

type Streams = {inputs: [AnkleStream, AnkleStream]; origin: number};
export type CalibrationInput = Streams & {firstBottom: true};
type Input = CalibrationInput | (Streams & {range: {a:number;b:number}|null});
self.onmessage = ({data}: MessageEvent<Input>) => {
  try {
    if ('firstBottom' in data) {
      const [rep] = predictSquats(data.inputs, data.origin, null).reps;
      if (!rep) throw new Error('整段双踝数据没有识别到完整深蹲。');
      self.postMessage({firstBottom: (rep[1]+rep[2])/2});
      return;
    }
    const result = predictSquats(data.inputs, data.origin, data.range);
    self.postMessage({result}, {transfer:[result.phase.buffer]});
  } catch (e) { self.postMessage({error:e instanceof Error ? e.message : String(e)}); }
};
