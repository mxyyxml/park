"""Download CC0 assets from Poly Haven (https://polyhaven.com, CC0) into public/assets."""
import json, os, urllib.request
TEX = ['concrete_wall_001', 'concrete_wall_006', 'concrete_wall_008', 'bicolour_gravel', 'asphalt_02']
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'asset-fetch/1.0'}), timeout=60).read()
for t in TEX:
    files = json.loads(get(f'https://api.polyhaven.com/files/{t}'))
    for kind, key in [('Diffuse', 'diff'), ('nor_gl', 'nor'), ('arm', 'arm')]:
        url = files[kind]['1k']['jpg']['url']
        out = f'public/assets/tex/{t}_{key}.jpg'
        if not os.path.exists(out): open(out, 'wb').write(get(url))
        print(out, os.path.getsize(out))
# aircon: keep the gltf, its buffer and only the variant-01 textures
m = json.loads(get('https://api.polyhaven.com/files/exterior_aircon_unit'))['gltf']['1k']['gltf']
base = 'public/assets/models/aircon'
os.makedirs(base + '/textures', exist_ok=True)
open(base + '/aircon.gltf', 'wb').write(get(m['url']))
for path, f in m['include'].items():
    if 'rusted' in path: continue
    open(f'{base}/{path}', 'wb').write(get(f['url']))
    print(path, f['size'])

# keep only the clean unit: one node at the origin
g = json.load(open(base + '/aircon.gltf'))
g['scenes'][0]['nodes'] = [0]
g['nodes'][0].pop('translation', None)
json.dump(g, open(base + '/aircon.gltf', 'w'))
