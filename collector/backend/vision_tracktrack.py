import hashlib
import sys

import numpy as np

from .vision_identity import clear


MODEL = 'yolo26n-reid.onnx'
MODEL_HASH = '8529c383197ae4c468eda535d1b165f8b4162cf17bf5fbcff49c7cb6455bc0bb'
CUDA = 'CUDAExecutionProvider'
FEATURE_DIM = 512
CROP_SIZE = 224


class GPUReID:
    def __init__(self, cv2, root, device):
        weight = root / MODEL
        if not weight.is_file():
            raise ValueError(f'工作站缺少 ReID 权重 {MODEL}')
        with weight.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != MODEL_HASH:
                raise ValueError('工作站 ReID 权重校验失败')
        deps = root / 'reid-cu128-deps'
        if deps.is_dir():
            sys.path.insert(0, str(deps))
        try:
            import onnxruntime as ort

            ort.preload_dlls()
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            cuda_options = {'device_id': device, 'cudnn_conv_algo_search': 'HEURISTIC'}
            self.session = ort.InferenceSession(str(weight), sess_options=opts, providers=[(CUDA, cuda_options)])
        except Exception as exc:
            raise ValueError(f'工作站 ReID CUDA 运行时无法加载：{exc}') from exc
        if CUDA not in self.session.get_providers()[:1]:
            raise ValueError('工作站 ReID 未使用 CUDA，未启用该模式')
        self.session.disable_fallback()
        self.input = self.session.get_inputs()[0].name
        self.cv2 = cv2
        probe = self._infer(np.zeros((2, 3, CROP_SIZE, CROP_SIZE), dtype=np.float32))
        if np.any(np.linalg.norm(probe, axis=1) < .99):
            raise ValueError('工作站 ReID 模型预热返回无效特征')

    def _infer(self, batch):
        vectors = self.session.run(None, {self.input: batch})[0]
        if vectors.shape != (len(batch), FEATURE_DIM) or not np.isfinite(vectors).all():
            raise ValueError('工作站 ReID 模型返回无效特征')
        return vectors

    def embed(self, image, boxes):
        h, w = image.shape[:2]
        xyxy = boxes.xyxy
        norm_boxes = xyxy / np.array([w, h, w, h], dtype=np.float32)
        crops, indices = [], []
        for i, box in enumerate(norm_boxes):
            if not clear(h, w, box, np.delete(norm_boxes, i, axis=0)):
                continue
            x0, y0, x1, y1 = xyxy[i].round().astype(int)
            crop = image[y0:y1, x0:x1]
            if not crop.size:
                continue
            crop = self.cv2.resize(crop, (CROP_SIZE, CROP_SIZE))
            crops.append(crop[..., ::-1].transpose(2, 0, 1))
            indices.append(i)
        features = np.full(len(norm_boxes), None, dtype=object)
        if crops:
            batch = np.asarray(crops, dtype=np.float32) / 255.
            for i, vector in zip(indices, self._infer(batch)):
                if np.linalg.norm(vector) > 0:
                    features[i] = vector
        return features


class TrackTrackReID:
    def __init__(self, cv2, root, device):
        from ultralytics.trackers.track_tracker import TRACKTRACK
        from ultralytics.utils import IterableSimpleNamespace

        self.encoder = GPUReID(cv2, root, device)
        self.tracker = TRACKTRACK(IterableSimpleNamespace(
            track_high_thresh=.35, track_low_thresh=.10, new_track_thresh=.45,
            track_buffer=30, match_thresh=.70, min_track_len=3,
            with_reid=True, model='auto', gmc_method='sparseOptFlow',
        ))

    def update(self, result):
        boxes = result.boxes.cpu().numpy()
        features = self.encoder.embed(result.orig_img, boxes)
        # Both layers use the same embeddings, indexed by the original detection row.
        tracks = self.tracker.update(boxes, result.orig_img, feats=features)
        if not len(tracks):
            return result[:0], {}
        import torch

        indices = tracks[:, -1].astype(int)
        tracked = result[indices]
        tracked.update(boxes=torch.as_tensor(tracks[:, :-1], device=result.boxes.data.device))
        return tracked, {int(row[4]): features[i] for row, i in zip(tracks, indices)}
