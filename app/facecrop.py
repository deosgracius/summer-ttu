"""Face-centered square cropping for headshots.

The kiosk directory shows every faculty/staff photo as a big square card, so a raw
department headshot (often a tall thumbnail with the face high or off-centre) needs to be
cropped to a consistent, centred square. This module does that once, at import time, so the
framing is baked into the stored photo and survives every data re-import.

Detection uses OpenCV's YuNet model (app/assets/yunet.onnx) when OpenCV is installed; if it
is not, we fall back to a PIL-only top-anchored centre crop (faces usually sit in the upper
half of a portrait). Everything is guarded so a missing dependency or an unreadable image
degrades gracefully to "store the original bytes" rather than raising.

Note: this handles FRAMING only. AI super-resolution of low-resolution source photos is a
separate, heavier one-off step (see scripts/enhance_photos.py) — not run on every import.
"""
import io
import os
from typing import Optional, Tuple

_SIZE = 600
_MODEL = os.path.join(os.path.dirname(__file__), "assets", "yunet.onnx")
_detector = None
_detector_tried = False


def _get_detector():
    """Lazily build the YuNet detector once; return None if OpenCV/model unavailable."""
    global _detector, _detector_tried
    if _detector_tried:
        return _detector
    _detector_tried = True
    try:
        import cv2  # noqa: F401
        if os.path.exists(_MODEL):
            _detector = cv2.FaceDetectorYN.create(_MODEL, "", (320, 320), 0.6, 0.3, 5000)
    except Exception:
        _detector = None
    return _detector


def _largest_face(pil) -> Optional[Tuple[float, float, float, float]]:
    det = _get_detector()
    if det is None:
        return None
    try:
        import cv2
        import numpy as np
        w, h = pil.size
        det.setInputSize((w, h))
        _r, faces = det.detect(cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR))
        if faces is None or len(faces) == 0:
            return None
        b = max(faces, key=lambda z: z[2] * z[3])
        return float(b[0]), float(b[1]), float(b[2]), float(b[3])
    except Exception:
        return None


def crop_square(data: bytes, size: int = _SIZE) -> Optional[bytes]:
    """Return JPEG bytes of a `size`x`size` face-centred crop of `data`.

    Returns None if Pillow is missing or the bytes aren't a decodable image, so callers can
    fall back to storing the original bytes unchanged.
    """
    try:
        from PIL import Image, ImageFilter
    except Exception:
        return None
    try:
        pil = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None

    w, h = pil.size
    box = _largest_face(pil)
    if box is not None:
        fx, fy, fw, fh = box
        # A head-and-shoulders square: ~3.2x the face height, never tighter than 72% of the
        # short side (avoids over-zooming an already-tight headshot) nor bigger than the image.
        side = int(min(max(fh * 3.2, min(w, h) * 0.72), w, h))
        left = int(round(fx + fw / 2 - side / 2))
        top = int(round((fy - 0.42 * fh) - 0.06 * side))  # anchor above the hairline so the whole head fits
    else:
        side = min(w, h)
        left = (w - side) // 2
        top = 0 if h >= w else (h - side) // 2  # portraits: keep the top (faces sit up top)

    left = max(0, min(left, w - side))
    top = max(0, min(top, h - side))
    square = pil.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)
    square = square.filter(ImageFilter.UnsharpMask(radius=2, percent=80, threshold=2))
    buf = io.BytesIO()
    square.save(buf, "JPEG", quality=90)
    return buf.getvalue()
