"""Convert models to self-contained glTF JSON (buffers as data URIs) saved as .json, a type the
artifact host serves. Images stay external files next to the model."""
import base64, json, struct, glob, os
def from_glb(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    rest = b[20 + n:]
    blen = struct.unpack('<I', rest[0:4])[0]
    j['buffers'][0]['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(rest[8:8 + blen]).decode()
    return j
for p in glob.glob('public/assets/models/*.glb'):
    json.dump(from_glb(p), open(p[:-4] + '.json', 'w'))
    os.remove(p)
g = 'public/assets/models/aircon/aircon.gltf'
if os.path.exists(g):
    j = json.load(open(g))
    for buf in j['buffers']:
        if not buf['uri'].startswith('data:'):
            src = os.path.join(os.path.dirname(g), buf['uri'])
            buf['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(open(src, 'rb').read()).decode()
            os.remove(src)
    json.dump(j, open('public/assets/models/aircon/aircon.json', 'w'))
    os.remove(g)
print('ok')
