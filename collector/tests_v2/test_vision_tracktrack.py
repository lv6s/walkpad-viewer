from types import SimpleNamespace

import numpy as np
import pytest

from backend.vision_tracktrack import CROP_SIZE, GPUReID, TrackTrackReID
from backend.vision_worker import GPU_ID_MODE, identity_mode


def test_gpu_mode_is_explicit(monkeypatch):
    monkeypatch.setenv('WALKPAD_VISION_ID_MODEL', GPU_ID_MODE)
    assert identity_mode() == 'tracktrack-reid'


def test_gpu_encoder_batches_clear_boxes_and_keeps_indices():
    calls = []
    encoder = GPUReID.__new__(GPUReID)
    encoder.cv2 = SimpleNamespace(resize=lambda crop, size: np.broadcast_to(crop[0, 0], (size[1], size[0], 3)))

    def infer(batch):
        calls.append(batch)
        return np.eye(2, 512, dtype=np.float32)

    encoder._infer = infer
    image = np.zeros((400, 600, 3), dtype=np.uint8)
    image[50:250, 40:160] = (0, 0, 255)
    image[50:250, 400:520] = (255, 0, 0)
    boxes = SimpleNamespace(xyxy=np.array([[40, 50, 160, 250], [0, 70, 15, 90], [400, 50, 520, 250]]))
    features = encoder.embed(image, boxes)
    assert len(calls) == 1 and calls[0].shape == (2, 3, CROP_SIZE, CROP_SIZE)
    assert calls[0][0, :, 0, 0].tolist() == [1., 0., 0.]
    assert calls[0][1, :, 0, 0].tolist() == [0., 0., 1.]
    assert features[1] is None and features[0][0] == features[2][1] == 1.


def test_tracker_reuses_batch_and_maps_by_original_detection_row():
    torch = pytest.importorskip('torch')
    infer = TrackTrackReID.__new__(TrackTrackReID)
    features = np.array([None, 'b', 'c'], dtype=object)
    infer.encoder = SimpleNamespace(embed=lambda image, boxes: features)
    rows = np.asarray([[10, 20, 30, 40, 7, .9, 0, 2], [50, 60, 70, 80, 9, .8, 0, 1]], dtype=np.float32)

    def update(boxes, image, feats):
        assert feats is features
        return rows

    infer.tracker = SimpleNamespace(update=update)

    class Result:
        orig_img = object()
        boxes = SimpleNamespace(cpu=lambda: SimpleNamespace(numpy=lambda: object()), data=torch.empty(0))

        def __getitem__(self, indices):
            assert indices.tolist() == [2, 1]
            return self

        def update(self, boxes):
            assert boxes[:, 4].tolist() == [7., 9.]

    assert infer.update(Result())[1] == {7: 'c', 9: 'b'}
