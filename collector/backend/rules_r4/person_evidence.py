import numpy as np


def pose_evidence(box, pose, image_height, conf):
    box = np.asarray(box, float)
    pose = np.asarray(pose, float)
    size = box[:, 2:] - box[:, :2]
    unit = np.maximum(size[:, 0], size[:, 1])
    unit = np.where(np.isfinite(unit) & (size > 0).all(axis=1), unit, np.nan)
    xy = pose[:, :, :2]
    margin = .10 * unit[:, None, None]
    valid = (np.isfinite(pose).all(axis=2) & (pose[:, :, 2] >= conf)
             & (xy >= box[:, None, :2] - margin).all(axis=2)
             & (xy <= box[:, None, 2:] + margin).all(axis=2))
    count = valid.sum(axis=1)

    def link(a, b, lower=.040, upper=.81):
        d = np.linalg.norm(xy[:, a] - xy[:, b], axis=1)
        return valid[:, a] & valid[:, b] & (d >= lower*unit) & (d <= upper*unit)

    trunk = link(5, 11, .09, .82) | link(6, 12, .09, .82)
    arms = link(5, 7) | link(6, 8)
    thighs = link(11, 13) | link(12, 14)
    shins = link(13, 15) | link(14, 16)
    head = np.any([link(h, shoulder, .04, .58) for h in (0, 1, 2, 3, 4) for shoulder in (5, 6)], axis=0)
    shoulders = link(5, 6, .055, .72)
    upper_body = shoulders & head & arms & (count >= 5)
    body = (trunk & (arms | thighs | (head & shoulders)) & (count >= 5)) | upper_body
    edge = ((size[:, 1] >= .44*image_height) & (box[:, 1] <= .18*image_height)
            & (valid[:, :7].sum(axis=1) <= 1))
    two_legs = (link(13, 14, .042, .79) | (shins & (valid[:, 13:17].sum(axis=1) >= 3)))
    lower = edge & two_legs
    weak = (count >= 3) & (trunk | arms | thighs | shins | head | two_legs)
    return body, lower, weak | body | lower
