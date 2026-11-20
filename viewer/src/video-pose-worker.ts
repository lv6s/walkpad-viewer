import {PoseLandmarker} from '@mediapipe/tasks-vision';
import {BlobSource, CanvasSink, Input, MP4, QTFF, WEBM} from 'mediabunny';
import type {ShinFrame} from './video-pose';

self.onmessage = async ({data}: MessageEvent<{assets: Blob[]; video: Blob; duration: number}>) => {
  const [loader, wasm, model] = data.assets;
  const wasmLoaderPath = URL.createObjectURL(loader), wasmBinaryPath = URL.createObjectURL(wasm);
  const input = new Input({source:new BlobSource(data.video), formats:[MP4,QTFF,WEBM]});
  let detector: PoseLandmarker;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('浏览器无法解码这段视频，请使用 Edge 或 Chrome 打开支持的 MP4。');
    const [w,h] = await Promise.all([track.getDisplayWidth(),track.getDisplayHeight()]);
    const scale = Math.min(1,448/Math.max(w,h));
    const width = Math.round(w*scale), height = Math.round(h*scale);
    const sink = new CanvasSink(track,{width,height,fit:'contain',poolSize:1});
    const modelAssetBuffer = new Uint8Array(await model.arrayBuffer());
    detector = await PoseLandmarker.createFromOptions({wasmLoaderPath, wasmBinaryPath}, {
      baseOptions:{modelAssetBuffer,delegate:'CPU'}, runningMode:'VIDEO', numPoses:2,
      minPoseDetectionConfidence:.4, minPosePresenceConfidence:.45, minTrackingConfidence:.5,
    });
    const samples: ShinFrame[] = [];
    let next=0;
    for await (const frame of sink.canvases(0,data.duration)) {
      const time=frame.timestamp;
      if (time<next-.013) continue;
      next+=1/15;
      if (next<time) next=time+1/15;
      const result=detector.detectForVideo(frame.canvas,Math.round(time*1000));
      const p=result.landmarks.length===1 ? result.landmarks[0] : null;
      const angles: [number,number] = [NaN,NaN];
      for(const [j,[k,a]] of [[25,27],[26,28]].entries()) {
        if (!p || p[k].visibility<.43 || p[a].visibility<.43) continue;
        const x=(p[k].x-p[a].x)*width, y=(p[a].y-p[k].y)*height;
        if (y>0 && Math.hypot(x,y)>=height*.025) angles[j]=Math.atan2(x,y);
      }
      samples.push([time,...angles]);
      if(samples.length%8===0) self.postMessage({progress:Math.min(99,Math.floor(100*time/data.duration))});
    }
    self.postMessage({motion:samples});
  } catch (e) { self.postMessage({error:e instanceof Error ? e.message : String(e)}); }
  finally {
    detector?.close(); input.dispose();
    URL.revokeObjectURL(wasmLoaderPath); URL.revokeObjectURL(wasmBinaryPath);
  }
};
