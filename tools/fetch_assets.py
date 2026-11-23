"""Download CC0 assets from Poly Haven (https://polyhaven.com, CC0) into public/assets."""
import json, os, urllib.request
TEX = ['concrete_wall_001', 'concrete_wall_006', 'concrete_wall_008', 'bicolour_gravel', 'asphalt_02',
       'metal_plate', 'concrete_pavement', 'wood_planks_grey', 'leafy_grass', 'terrazzo_tiles', 'factory_brick']
TERRAIN = ['aerial_grass_rock', 'aerial_rocks_02', 'aerial_beach_01']  # colour only: seen from a distance
from PIL import Image
def shrink(path, size, q=82):
    im = Image.open(path).convert('RGB')
    if im.size[0] > size: im = im.resize((size, size), Image.LANCZOS)
    im.save(path, quality=q, optimize=True)
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'asset-fetch/1.0'}), timeout=60).read()
for t in TEX:
    files = json.loads(get(f'https://api.polyhaven.com/files/{t}'))
    for kind, key in [('Diffuse', 'diff'), ('nor_gl', 'nor'), ('arm', 'arm')]:
        url = files[kind]['1k']['jpg']['url']
        out = f'public/assets/tex/{t}_{key}.jpg'
        if not os.path.exists(out):
            open(out, 'wb').write(get(url))
            shrink(out, 512 if key == 'arm' else 1024)
        print(out, os.path.getsize(out))
for t in TERRAIN:
    out = f'public/assets/tex/{t}_diff.jpg'
    if not os.path.exists(out):
        files = json.loads(get(f'https://api.polyhaven.com/files/{t}'))
        open(out, 'wb').write(get(files['Diffuse']['1k']['jpg']['url']))
        shrink(out, 1024, 80)
    print(out, os.path.getsize(out))
# models (aircon, street props) are fetched and decimated by tools/blender/optimize_models.py
