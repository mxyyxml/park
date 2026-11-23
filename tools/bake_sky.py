"""Bake a Poly Haven HDRI (CC0) into the game's sky assets (run with Blender's Python module):
  - public/assets/sky/sky.jpg  4096x2048 tonemapped background (the renderer tonemaps again, so
    this keeps highlights soft and exposure matched to the scene)
  - public/assets/sky/sky.json sun direction (three.js equirect convention) + horizon colour for fog
"""
import json, math, sys
import bpy, numpy as np
from PIL import Image
src = sys.argv[1]
img = bpy.data.images.load(src)
W, H = img.size
px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[::-1, :, :3]  # top row first
# sun: brightest region (blurred luminance peak)
lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
py_, px_ = np.unravel_index(np.argmax(lum), lum.shape)
u = (px_ + 0.5) / W; v = 1 - (py_ + 0.5) / H
el = (v - 0.5) * math.pi; az = (u - 0.5) * 2 * math.pi
sun = [math.cos(az) * math.cos(el), math.sin(el), math.sin(az) * math.cos(el)]
# horizon colour: average of a band just above the horizon, tonemapped like the background
band = px[int(H * 0.44):int(H * 0.49)].reshape(-1, 3)
exposure = 0.9
def tonemap(c):
    c = c * exposure
    c = c / (1 + c * 0.35)  # gentle shoulder, the game's ACES pass does the rest
    return np.clip(c, 0, None) ** (1 / 2.2)
hor = tonemap(np.median(band, axis=0))
json.dump({'sun': sun, 'elevationDeg': math.degrees(el), 'horizon': [float(x) for x in np.clip(hor, 0, 1)], 'source': 'Poly Haven kloofendal_48d_partly_cloudy_puresky (CC0)'},
          open('public/assets/sky/sky.json', 'w'), indent=1)
ldr = (np.clip(tonemap(px), 0, 1) * 255 + 0.5).astype(np.uint8)
Image.fromarray(ldr).save('public/assets/sky/sky.jpg', quality=88, optimize=True)
print('sun', [round(s, 3) for s in sun], 'elev', round(math.degrees(el), 1), 'horizon', hor)
