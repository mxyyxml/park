"""
Download CC0 models from Poly Haven and make them game-ready (run with Blender's Python module):
decimate each mesh to a triangle budget, shrink textures to 512 px and export a GLB into
public/assets/models/<name>.glb. Then run tools/embed_gltf.py to produce the .json the game loads.

    python3 tools/blender/optimize_models.py [name ...]   # all models, or only the named ones
"""
import json, os, sys, urllib.request, tempfile
import bpy

# name -> (poly haven id, triangle budget)
MODELS = {
    'barrier': ('concrete_road_barrier', 1800),
    'hydrant': ('fire_hydrant', 1600),
    'trashcan': ('metal_trash_can', 1600),
    'barrel': ('Barrel_01', 1400),
    'streetlamp': ('street_lamp_02', 2000),
    'seating': ('modular_street_seating', 2500),
    'plant': ('potted_plant_02', 3500),
    'aircon': ('exterior_aircon_unit', 1600),  # placed ~250 times: keep it cheap
}
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'models')
TMP = os.path.join(tempfile.gettempdir(), 'ph_models')

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'asset-fetch/1.0'}), timeout=120).read()

def download(ph_id):
    d = os.path.join(TMP, ph_id)
    os.makedirs(d, exist_ok=True)
    g = json.loads(get(f'https://api.polyhaven.com/files/{ph_id}'))['gltf']['1k']['gltf']
    main = os.path.join(d, os.path.basename(g['url']))
    if not os.path.exists(main):
        open(main, 'wb').write(get(g['url']))
        for path, f in g['include'].items():
            p = os.path.join(d, path)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'wb').write(get(f['url']))
    return main

def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)

for name, (ph_id, budget) in MODELS.items():
    if sys.argv[1:] and name not in sys.argv[1:]:
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    src = download(ph_id)
    bpy.ops.import_scene.gltf(filepath=src)
    if name == 'aircon':  # only the clean unit, centred (the rusted variant sits beside it)
        for o in [o for o in bpy.context.scene.objects if 'rusted' in o.name]:
            bpy.data.objects.remove(o)
        for o in bpy.context.scene.objects:
            o.location = (0, 0, 0)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    total = sum(tris(o) for o in meshes)
    ratio = min(1.0, budget / max(total, 1))
    for o in meshes:
        if ratio < 1:
            m = o.modifiers.new('dec', 'DECIMATE'); m.ratio = ratio; m.use_collapse_triangulate = True
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier='dec')
    for img in bpy.data.images:
        if img.size[0] > 512:
            img.scale(512, max(1, int(512 * img.size[1] / img.size[0])))
    after = sum(tris(o) for o in meshes)
    out = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_image_format='JPEG', export_jpeg_quality=82,
                              export_apply=True, export_animations=False)
    print(f'{name}: {ph_id} {total} -> {after} tris, {os.path.getsize(out) // 1024} KB')
