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
print('ok')
