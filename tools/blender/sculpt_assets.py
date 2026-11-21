"""
Sculpted character assets for Skyline Runner, built with Blender's Python module (bpy).

    pip install bpy     (Blender 5.x as a module)
    python3 tools/blender/sculpt_assets.py

Writes public/assets/models/{hand,sleeve_upper,sleeve_fore,shoe}.glb.

Coordinates: everything is authored in the game's frame (three.js: +Y up) and converted to
Blender's Z-up on the way in, so the exporter's Y-up conversion lands it back unchanged.
Hand frame: wrist at origin, fingers +Y, back of hand +Z, palm -Z, thumb on -X (right hand).
"""
import math, os
import bpy, bmesh
from mathutils import Vector

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'models')
os.makedirs(OUT, exist_ok=True)

def B(x, y, z):  # game (three) -> Blender
    return Vector((x, -z, y))

def G(v):  # Blender -> game
    return (v.x, v.z, -v.y)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, rgb, rough=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    return m

def select_only(*obs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]

def apply_mods(ob):
    select_only(ob)
    for m in list(ob.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)

def export(path, obs):
    select_only(*obs)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=False, export_skins=True, export_animations=False, export_normals=True)
    print('wrote', path, os.path.getsize(path))

def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)

# ---------------------------------------------------------------------------------------------
# HAND
# ---------------------------------------------------------------------------------------------
FX = [-0.029, -0.0097, 0.0096, 0.0289]          # index .. little
KN = [0.089, 0.091, 0.086, 0.081]                # knuckle heights
LENS = [[0.041, 0.025, 0.02], [0.045, 0.028, 0.021], [0.043, 0.027, 0.02], [0.033, 0.02, 0.018]]
RAD = [0.0093, 0.0096, 0.009, 0.0079]
T_BASE = (-0.03, 0.016, -0.008)
T_LEN = [0.034, 0.03, 0.026]

def thumb_dir():
    # same pose as the game's procedural thumb: +Y rotated about Z by 0.75, then about X by -0.35
    a, b = 0.75, -0.35
    x, y, z = -math.sin(a), math.cos(a), 0.0
    y, z = y * math.cos(b) - z * math.sin(b), y * math.sin(b) + z * math.cos(b)
    n = math.sqrt(x * x + y * y + z * z)
    return (x / n, y / n, z / n)

def finger_chain(f):
    pts = [(FX[f], KN[f] - 0.014, 0.0)]  # root starts inside the palm so the remesh fuses them
    y = KN[f]
    for L in LENS[f]:
        y += L
        pts.append((FX[f], y, 0.0))
    return pts

def thumb_chain():
    d = thumb_dir()
    p = [T_BASE[i] - d[i] * 0.012 for i in range(3)]  # root inside the palm
    pts = [tuple(p)]
    p = list(T_BASE)
    for L in T_LEN:
        p = [p[i] + d[i] * L for i in range(3)]
        pts.append(tuple(p))
    return pts

def build_hand():
    reset()
    # fingers + thumb as skin-modifier tubes on a vertex skeleton
    me = bpy.data.meshes.new('fingers')
    bm = bmesh.new()
    radii = []
    for f in range(4):
        chain = finger_chain(f)
        vs = [bm.verts.new(B(*p)) for p in chain]
        for i in range(len(vs) - 1): bm.edges.new((vs[i], vs[i + 1]))
        r = RAD[f]
        radii += [r * 1.05, r, r * 0.92, r * 0.8]
    tch = thumb_chain()
    vs = [bm.verts.new(B(*p)) for p in tch]
    for i in range(len(vs) - 1): bm.edges.new((vs[i], vs[i + 1]))
    radii += [0.0135, 0.0118, 0.0105, 0.0092]
    bm.to_mesh(me); bm.free()
    fingers = bpy.data.objects.new('fingers', me)
    bpy.context.collection.objects.link(fingers)
    sk = fingers.modifiers.new('skin', 'SKIN')
    for i, (v, r) in enumerate(zip(me.skin_vertices[0].data, radii)):
        v.radius = (r, r * 0.85)
        v.use_root = i % 4 == 0  # each finger/thumb chain is its own island and needs a root
    sub = fingers.modifiers.new('sub', 'SUBSURF'); sub.levels = 2
    apply_mods(fingers)

    # palm: subdivided box sculpted like the game's palmGeo (taper, arched back, fleshy heel)
    bpy.ops.mesh.primitive_cube_add(size=1)
    palm = bpy.context.active_object
    palm.scale = (0.08, 0.028, 0.094)
    bpy.ops.object.transform_apply(scale=True)
    palm.location = B(0, 0.045, 0)
    bpy.ops.object.transform_apply(location=True)
    bv = palm.modifiers.new('bv', 'BEVEL'); bv.width = 0.011; bv.segments = 5
    s = palm.modifiers.new('sub', 'SUBSURF'); s.levels = 3; s.subdivision_type = 'SIMPLE'
    apply_mods(palm)
    for v in palm.data.vertices:
        x, y, z = G(v.co)
        t = max(0.0, min(1.0, (y + 0.002) / 0.094))
        x *= 0.84 + 0.16 * t
        across = x / 0.042
        if z > 0: z += 0.0035 * (1 - across * across) * (0.4 + 0.6 * t)
        else:
            thenar = max(0.0, -across) * math.sin(math.pi * min(1.0, t * 1.4))
            z -= 0.006 * thenar + 0.003 * math.sin(math.pi * t)
        y -= 0.007 * max(0.0, across) * t
        v.co = B(x, y, z)

    # wrist stub so the hand blends into the forearm
    bpy.ops.mesh.primitive_cylinder_add(radius=0.026, depth=0.03, location=B(0, -0.006, 0))
    wrist = bpy.context.active_object
    wrist.rotation_euler = (math.pi / 2, 0, 0)
    wrist.scale = (1.15, 0.72, 1)
    bpy.ops.object.transform_apply(rotation=True, scale=True)

    # fuse everything into one surface: voxel remesh + smoothing = blended webbing and joints
    select_only(palm, fingers, wrist)
    bpy.ops.object.join()
    hand = bpy.context.active_object
    rm = hand.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = 0.0011
    sm = hand.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.6; sm.iterations = 8
    apply_mods(hand)

    # sculpt pass: knuckle bumps on the back, creases on the palm side at the joints, tendons
    joints = []
    for f in range(4):
        y = KN[f]
        joints.append((FX[f], y))
        for L in LENS[f][:-1]:
            y += L
            joints.append((FX[f], y))
    for v in hand.data.vertices:
        x, y, z = G(v.co)
        d_out = 0.0  # + pushes out along the normal (knuckles, tendons), - presses in (creases)
        for (jx, jy) in joints:
            d = math.hypot((x - jx) / 0.012, (y - jy) / 0.004)
            if d < 1.0:
                if z > 0.002: d_out += 0.0011 * (1 - d) ** 2
                elif z < -0.002: d_out -= 0.0012 * (1 - d) ** 2
        if z > 0.004 and 0.02 < y < 0.08:
            for jx in FX:
                d = abs(x - jx * 0.85) / 0.003
                if d < 1: d_out += 0.0005 * (1 - d) * math.sin(math.pi * (y - 0.02) / 0.06)
        if d_out: v.co += v.normal * d_out
    dec = hand.modifiers.new("dec", "DECIMATE"); dec.ratio = 0.16
    apply_mods(hand)
    bpy.ops.object.shade_smooth()

    # skin everywhere; the fingerless glove is built from separate pieces shrink-wrapped onto
    # the hand surface (clean edges instead of voxel-stepped material borders)
    skin, glove, pad, nail = mat('skin', (0.79, 0.56, 0.45), 0.5), mat('glove', (0.11, 0.115, 0.125), 0.75), mat('pad', (0.23, 0.235, 0.255), 0.9), mat('nail', (0.91, 0.71, 0.64), 0.25)
    hand.data.materials.append(skin)

    def conform(ob, material, thick):
        sw = ob.modifiers.new('sw', 'SHRINKWRAP'); sw.target = hand; sw.wrap_method = 'NEAREST_SURFACEPOINT'; sw.offset = 0.0006
        so = ob.modifiers.new('so', 'SOLIDIFY'); so.thickness = thick; so.offset = 1
        sm2 = ob.modifiers.new('sm', 'SMOOTH'); sm2.factor = 0.4; sm2.iterations = 2
        apply_mods(ob)
        ob.data.materials.append(material)
        select_only(ob); bpy.ops.object.shade_smooth()
        return ob

    def panel(x0, x1, y0, y1, zside, corner, material, thick):
        bpy.ops.mesh.primitive_grid_add(x_subdivisions=18, y_subdivisions=18, size=1)
        ob = bpy.context.active_object
        bm = bmesh.new(); bm.from_mesh(ob.data)
        for v in bm.verts:
            u, w = v.co.x + 0.5, v.co.y + 0.5
            v.co = B(x0 + (x1 - x0) * u, y0 + (y1 - y0) * w, zside)
        # round the corners of the panel outline
        cut = []
        for v in bm.verts:
            x, y, _ = G(v.co)
            cx = min(max(x, x0 + corner), x1 - corner); cy = min(max(y, y0 + corner), y1 - corner)
            if math.hypot(x - cx, y - cy) > corner: cut.append(v)
        bmesh.ops.delete(bm, geom=cut, context='VERTS')
        bm.to_mesh(ob.data); bm.free()
        return conform(ob, material, thick)

    pieces = [
        panel(-0.04, 0.038, 0.006, 0.084, -0.04, 0.012, glove, 0.0016),   # palm grip
        panel(-0.034, 0.036, 0.074, 0.088, 0.04, 0.006, pad, 0.0022),     # knuckle guard
        panel(-0.034, 0.034, 0.004, 0.04, 0.04, 0.008, glove, 0.0014),     # lower back panel
    ]
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.04, depth=0.02, end_fill_type='NOTHING', location=B(0, 0.008, 0))
    strap = bpy.context.active_object
    strap.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    sub2 = strap.modifiers.new('sub', 'SUBSURF'); sub2.levels = 2; sub2.subdivision_type = 'SIMPLE'
    apply_mods(strap)
    pieces.append(conform(strap, glove, 0.0022))
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(0.012, 0.008, 0.024))
    tab = bpy.context.active_object; tab.scale = (0.03, 0.016, 0.004)
    tbv = tab.modifiers.new('bv', 'BEVEL'); tbv.width = 0.0015; tbv.segments = 2
    apply_mods(tab); tab.data.materials.append(mat('accent', (0.78, 0.09, 0.12), 0.55))
    pieces.append(tab)
    select_only(hand, *pieces)
    bpy.ops.object.join()
    hand = bpy.context.active_object

    # nails as crisp separate shells (rest pose fingers are straight)
    nails = []
    for f in range(4):
        tip = KN[f] + sum(LENS[f])
        L3 = LENS[f][2]
        r1 = RAD[f] * 0.8
        bpy.ops.mesh.primitive_cube_add(size=1, location=B(FX[f], tip - L3 * 0.42, r1 * 0.82))
        n = bpy.context.active_object
        n.scale = (r1 * 1.35, 0.0014, L3 * 0.55)
        nails.append(n)
    tch = thumb_chain(); d = thumb_dir()
    tp = [tch[3][i] - d[i] * 0.011 for i in range(3)]
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(tp[0] + 0.004, tp[1], tp[2] + 0.008))
    n = bpy.context.active_object; n.scale = (0.012, 0.0014, 0.013); nails.append(n)
    for n in nails:
        bv = n.modifiers.new('bv', 'BEVEL'); bv.width = 0.0006; bv.segments = 2
        apply_mods(n)
        n.data.materials.append(nail)
    select_only(hand, *nails)
    bpy.ops.object.join()
    hand = bpy.context.active_object
    hand.name = 'hand'

    # armature: wrist + 3 bones per finger + 3 thumb bones, rolled so local X is the curl axis
    bpy.ops.object.armature_add(location=(0, 0, 0))
    arm = bpy.context.active_object
    arm.name = 'hand_rig'
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    root = eb[0]; root.name = 'hand'
    root.head = B(0, -0.01, 0); root.tail = B(0, 0.06, 0); root.roll = 0
    for f in range(4):
        chain = finger_chain(f)
        chain[0] = (FX[f], KN[f], 0.0)
        parent = root
        for k in range(3):
            b = eb.new(f'f{f}_{k}')
            b.head = B(*chain[k]); b.tail = B(*chain[k + 1]); b.roll = 0
            b.parent = parent; b.use_connect = k > 0
            parent = b
    tch = thumb_chain(); parent = root
    for k in range(3):
        b = eb.new(f't_{k}')
        b.head = B(*tch[k]); b.tail = B(*tch[k + 1])
        b.align_roll(B(0, 0, -1))  # bone Z toward the palm so local X is the flex axis
        b.parent = parent; b.use_connect = k > 0
        parent = b
    bpy.ops.object.mode_set(mode='OBJECT')
    # skin weights from distance to each bone segment (heat weighting fails on the separate
    # nail/glove shells); nearest 3 bones, inverse-distance^4 falloff, normalised
    segs = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in arm.data.bones}
    groups = {n: hand.vertex_groups.new(name=n) for n in segs}
    # glove pieces ride rigidly on the palm so they don't shear at the knuckles
    rigid = set()
    for poly in hand.data.polygons:
        if hand.data.materials[poly.material_index].name.split('.')[0] in ('glove', 'pad', 'accent'): rigid.update(poly.vertices)
    for v in hand.data.vertices:
        if v.index in rigid:
            groups['hand'].add([v.index], 1.0, 'REPLACE'); continue
        ws = []
        for n, (h, t) in segs.items():
            ab = t - h
            k = max(0.0, min(1.0, (v.co - h).dot(ab) / ab.length_squared))
            d = (v.co - (h + ab * k)).length
            if n == 'hand': d *= 1.15  # let finger bones win at the knuckles
            ws.append((1.0 / (d ** 4 + 1e-12), n))
        ws.sort(reverse=True)
        top = ws[:3]
        tot = sum(w for w, _ in top)
        for w, n in top: groups[n].add([v.index], w / tot, 'REPLACE')
    hand.parent = arm
    mod = hand.modifiers.new('armature', 'ARMATURE'); mod.object = arm
    print('hand tris', sum(len(p.vertices) - 2 for p in hand.data.polygons), 'groups', len(hand.vertex_groups))
    export(os.path.join(OUT, 'hand.glb'), [arm, hand])

# ---------------------------------------------------------------------------------------------
# SLEEVES: tapered tubes with sculpted fabric folds and a ribbed cuff, cylindrical UVs
# ---------------------------------------------------------------------------------------------
def sleeve(name, L, r0, r1, bulge, folds):
    reset()
    seg, rings = 40, 72
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    grid = []
    for i in range(rings + 1):
        t = i / rings
        row = []
        for j in range(seg):
            a = j / seg * math.pi * 2
            r = r0 + (r1 - r0) * t + bulge * math.sin(math.pi * t ** 0.8)
            r += folds(t, a)
            # rounded closing at both ends
            end = min(t, 1 - t)
            if end < 0.04: r *= math.sqrt(max(0.0, 1 - ((0.04 - end) / 0.04) ** 2)) * 0.45 + 0.55
            x, z = math.cos(a) * r, math.sin(a) * r * 0.9
            row.append(bm.verts.new(B(x, t * L, z)))
        grid.append(row)
    for i in range(rings):
        for j in range(seg):
            q = (grid[i][j], grid[i][(j + 1) % seg], grid[i + 1][(j + 1) % seg], grid[i + 1][j])
            face = bm.faces.new(q)
            for k, l in enumerate(face.loops):
                jj = j + (1 if k in (1, 2) else 0)
                ii = i + (1 if k in (2, 3) else 0)
                l[uv].uv = (jj / seg * 2, ii / rings * L * 8)
    for end in (grid[0], grid[-1]):
        bm.faces.new(end if end is grid[-1] else list(reversed(end)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat('jacket', (0.91, 0.91, 0.9), 0.85))
    select_only(ob)
    bpy.ops.object.shade_smooth()
    export(os.path.join(OUT, f'{name}.glb'), [ob])

def upper_folds(t, a):
    # compression folds bunching toward the elbow, softer drape near the shoulder
    elbow = smoothstep(0.55, 0.95, t)
    d = 0.0022 * elbow * math.sin(2 * math.pi * (5.5 * t + 0.9 * a / (2 * math.pi))) * (0.6 + 0.4 * math.sin(a * 2 + 1))
    d += 0.0012 * (1 - smoothstep(0.0, 0.3, t)) * math.sin(a * 3)
    return d

def fore_folds(t, a):
    bunch = smoothstep(0.45, 0.85, t) * (1 - smoothstep(0.86, 0.9, t))
    d = 0.0024 * bunch * math.sin(2 * math.pi * (7 * t - 0.7 * a / (2 * math.pi)))
    cuff = smoothstep(0.88, 0.9, t)
    d += cuff * (0.002 + 0.0007 * math.sin(a * 36))     # ribbed cuff
    return d

# ---------------------------------------------------------------------------------------------
# SHOE: lofted upper, midsole, outsole with cut tread, laces + eyelets
# ---------------------------------------------------------------------------------------------
def build_shoe():
    reset()
    # outline along the foot (game frame: +Z toe, origin at the ankle)
    Z0, Z1 = -0.09, 0.2
    def half_width(t):  # t 0 heel .. 1 toe
        return 0.036 + 0.014 * math.sin(math.pi * min(1, t * 1.15)) - 0.012 * smoothstep(0.85, 1, t) ** 2
    def top(t):          # height of the upper above the sole top
        return 0.075 - 0.045 * smoothstep(0.35, 0.95, t) + 0.01 * (1 - smoothstep(0.0, 0.15, t))
    SOLE_TOP = -0.062
    white, red, dark, mid = mat('shoe_white', (0.95, 0.95, 0.94), 0.5), mat('shoe_red', (0.78, 0.09, 0.12), 0.55), mat('shoe_dark', (0.13, 0.135, 0.14), 0.75), mat('shoe_mid', (0.97, 0.97, 0.96), 0.7)

    def loft(name, sections, cap=True):
        me = bpy.data.meshes.new(name); bm = bmesh.new()
        rows = [[bm.verts.new(B(*p)) for p in sec] for sec in sections]
        n = len(rows[0])
        for i in range(len(rows) - 1):
            for j in range(n - 1):
                bm.faces.new((rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]))
        if cap:
            for r in (rows[0], rows[-1]):
                if len(set(r)) > 2: bm.faces.new(r)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
        return ob

    N = 48
    # upper: half-superellipse sections, opening at the collar
    secs = []
    for i in range(N + 1):
        t = i / N
        z = Z0 + (Z1 - Z0) * t
        w, h = half_width(t) * 0.97, top(t)
        sec = []
        for j in range(25):
            a = math.pi * j / 24
            cx, cy = math.cos(a), math.sin(a)
            px = w * math.copysign(abs(cx) ** 0.7, cx)
            py = h * abs(cy) ** 0.55
            toe = smoothstep(0.82, 1.0, t)
            py *= 1 - 0.55 * toe ** 1.5
            sec.append((px, SOLE_TOP + py, z))
        secs.append(sec)
    upper = loft('upper', secs, cap=False)
    sol = upper.modifiers.new('sol', 'SOLIDIFY'); sol.thickness = 0.003
    sub = upper.modifiers.new('sub', 'SUBSURF'); sub.levels = 1
    apply_mods(upper)
    # remove the collar opening: delete faces near the top behind the tongue
    bm = bmesh.new(); bm.from_mesh(upper.data)
    kill = [f for f in bm.faces if (lambda c: c[1] > SOLE_TOP + 0.05 and c[2] < 0.035 and abs(c[0]) < 0.026)(G(f.calc_center_median()))]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(upper.data); bm.free()
    upper.data.materials.append(white)
    # heel counter + collar padding
    bpy.ops.mesh.primitive_torus_add(major_radius=0.033, minor_radius=0.008, location=B(0, SOLE_TOP + 0.072, -0.03))
    collar = bpy.context.active_object
    collar.scale = (1.0, 1.45, 1.0); collar.rotation_euler = (0, 0, 0)
    bpy.ops.object.transform_apply(scale=True, rotation=True)
    collar.data.materials.append(dark)
    # midsole and outsole: outline extrusions
    def outline(scale, y0, y1, nm):
        pts = []
        M = 64
        for k in range(M):
            a = k / M * math.pi * 2
            t = 0.5 - 0.5 * math.cos(a)
            side = 1 if a < math.pi else -1
            pts.append((side * half_width(t) * scale, 0, Z0 + (Z1 - Z0) * t))
        me = bpy.data.meshes.new(nm); bm = bmesh.new()
        lo = [bm.verts.new(B(p[0], y0, p[2])) for p in pts]
        hi = [bm.verts.new(B(p[0], y1, p[2])) for p in pts]
        for k in range(M):
            k2 = (k + 1) % M
            bm.faces.new((lo[k], lo[k2], hi[k2], hi[k]))
        bm.faces.new(list(reversed(lo))); bm.faces.new(hi)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(nm, me); bpy.context.collection.objects.link(ob)
        bv = ob.modifiers.new('bv', 'BEVEL'); bv.width = 0.004; bv.segments = 3
        apply_mods(ob)
        return ob
    midsole = outline(1.06, -0.076, SOLE_TOP + 0.004, 'midsole'); midsole.data.materials.append(mid)
    outsole = outline(1.07, -0.086, -0.074, 'outsole'); outsole.data.materials.append(red)
    # tread: cut grooves across the outsole with a boolean of thin bars
    bars = []
    for k in range(13):
        z = Z0 + 0.015 + k * 0.021
        bpy.ops.mesh.primitive_cube_add(size=1, location=B(0, -0.087, z))
        b = bpy.context.active_object; b.scale = (0.13, 0.007, 0.0045); b.rotation_euler = (0, 0, 0.35 if k % 2 else -0.35)
        bars.append(b)
    select_only(*bars); bpy.ops.object.join(); cutter = bpy.context.active_object
    bo = outsole.modifiers.new('tread', 'BOOLEAN'); bo.object = cutter; bo.operation = 'DIFFERENCE'
    apply_mods(outsole)
    bpy.data.objects.remove(cutter)
    # laces & eyelets over the instep
    parts = [upper, collar, midsole, outsole]
    for k in range(5):
        t = 0.42 + k * 0.075
        z = Z0 + (Z1 - Z0) * t
        y = SOLE_TOP + top(t) * (1 - 0.55 * smoothstep(0.82, 1.0, t) ** 1.5) + 0.002
        bpy.ops.mesh.primitive_cylinder_add(radius=0.0028, depth=0.05, location=B(0, y, z))
        lace = bpy.context.active_object; lace.rotation_euler = (0, math.pi / 2, 0.28 if k % 2 else -0.28)
        lace.data.materials.append(dark); parts.append(lace)
        for sx in (-1, 1):
            bpy.ops.mesh.primitive_torus_add(major_radius=0.0035, minor_radius=0.001, location=B(sx * 0.022, y - 0.002, z))
            e = bpy.context.active_object; e.data.materials.append(dark); parts.append(e)
    select_only(*parts)
    bpy.ops.object.join()
    shoe = bpy.context.active_object; shoe.name = 'shoe'
    dec = shoe.modifiers.new('dec', 'DECIMATE'); dec.ratio = 0.3
    apply_mods(shoe)
    bpy.ops.object.shade_smooth()
    print('shoe tris', sum(len(p.vertices) - 2 for p in shoe.data.polygons))
    export(os.path.join(OUT, 'shoe.glb'), [shoe])

# ---------------------------------------------------------------------------------------------
# BODY: lofted pieces in the game's frame, sculpted by displacement, fused where needed
# ---------------------------------------------------------------------------------------------
def loft_rings(name, rings, closed_ends=True):
    """rings: list of lists of game-frame points (same count per ring, closed loops)."""
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    rows = [[bm.verts.new(B(*p)) for p in r] for r in rings]
    n = len(rows[0])
    for i in range(len(rows) - 1):
        for j in range(n):
            f = bm.faces.new((rows[i][j], rows[i][(j + 1) % n], rows[i + 1][(j + 1) % n], rows[i + 1][j]))
            for k, l in enumerate(f.loops):
                l[uv].uv = ((j + (1 if k in (1, 2) else 0)) / n * 2, (i + (1 if k in (2, 3) else 0)) / len(rows) * 4)
    if closed_ends:
        for r in (rows[0], rows[-1]): bm.faces.new(r)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    return ob

def ring(y, rx, rz, n, fn=None, e=2.6):
    """superellipse cross-section at height y; fn(angle) -> radial offset (sculpt detail).
    Angle 0 = +X, pi/2 = +Z (back), 3pi/2 = -Z (front)."""
    pts = []
    for j in range(n):
        a = j / n * math.pi * 2
        c, s_ = math.cos(a), math.sin(a)
        px = rx * math.copysign(abs(c) ** (2 / e), c)
        pz = rz * math.copysign(abs(s_) ** (2 / e), s_)
        d = fn(a) if fn else 0.0
        L = math.hypot(px, pz) or 1
        pts.append((px + px / L * d, y, pz + pz / L * d))
    return pts

def build_torso():
    reset()
    N, R = 48, 44
    rings = []
    for i in range(R + 1):
        t = i / R
        y = -0.02 + 0.585 * t
        # jacket silhouette: hips, waist, chest, shoulders sloping into the neck
        rx = 0.15 + 0.018 * math.sin(math.pi * min(1, t * 1.4)) + 0.045 * smoothstep(0.45, 0.78, t) - 0.13 * smoothstep(0.86, 1.0, t) ** 1.3
        rz = 0.095 + 0.018 * smoothstep(0.4, 0.72, t) - 0.05 * smoothstep(0.88, 1.0, t)
        def detail(a, t=t):
            d = 0.0
            front = -math.sin(a)  # 1 at the front (-Z)
            back = math.sin(a)
            d += 0.004 * math.exp(-((a - 3 * math.pi / 2) / 0.05) ** 2)  # zipper ridge
            d += 0.006 * smoothstep(0.5, 0.7, t) * (1 - smoothstep(0.75, 0.85, t)) * max(0, front) ** 3  # chest
            d += 0.005 * smoothstep(0.55, 0.8, t) * max(0, back) ** 2 * abs(math.cos(a)) * 1.5  # shoulder blades
            d += 0.0025 * smoothstep(0.15, 0.5, t) * (1 - smoothstep(0.5, 0.6, t)) * math.sin(a * 6 + t * 9)  # waist folds
            if t < 0.07: d += 0.004 + 0.0012 * math.sin(a * 40)  # ribbed hem
            return d
        rings.append(ring(y, rx, rz, N, detail))
    ob = loft_rings('torso', rings)
    sub = ob.modifiers.new('sub', 'SUBSURF'); sub.levels = 1
    apply_mods(ob)
    jacket, accent, dark = mat('jacket', (0.91, 0.91, 0.9), 0.85), mat('accent', (0.78, 0.09, 0.12), 0.55), mat('dark', (0.13, 0.135, 0.14), 0.75)
    for m in (jacket, accent): ob.data.materials.append(m)
    for poly in ob.data.polygons:  # red stripe panel down the left side
        x, y, z = G(poly.center)
        if 0.02 < y < 0.52 and abs(math.atan2(z, x) - math.radians(200)) < 0.12: poly.material_index = 1
    # collar and hood folded at the back of the neck
    bpy.ops.mesh.primitive_torus_add(major_radius=0.07, minor_radius=0.024, location=B(0, 0.565, 0.005))
    collar = bpy.context.active_object; collar.scale = (1.15, 1, 1.0)
    bpy.ops.object.transform_apply(scale=True)
    collar.data.materials.append(jacket)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1, location=B(0, 0.53, 0.085))
    hood = bpy.context.active_object; hood.scale = (1.15, 0.55, 0.45)
    bpy.ops.object.transform_apply(scale=True)
    hood.data.materials.append(jacket)
    # zipper pull
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(0, 0.5, -0.112))
    zp = bpy.context.active_object; zp.scale = (0.01, 0.025, 0.004); zp.data.materials.append(dark)
    select_only(ob, collar, hood, zp); bpy.ops.object.join()
    ob = bpy.context.active_object; ob.name = 'torso'
    bpy.ops.object.shade_smooth()
    export(os.path.join(OUT, 'torso.glb'), [ob])

def build_pelvis():
    reset()
    N, R = 40, 12
    rings = [ring(-0.08 + 0.16 * i / R, 0.15 - 0.01 * abs(i / R - 0.5), 0.1, N, None, 3.2) for i in range(R + 1)]
    ob = loft_rings('pelvis', rings)
    sub = ob.modifiers.new('sub', 'SUBSURF'); sub.levels = 1
    apply_mods(ob)
    pants, dark, metal = mat('pants', (0.17, 0.18, 0.2), 0.9), mat('dark', (0.13, 0.135, 0.14), 0.75), mat('metal', (0.6, 0.6, 0.62), 0.3)
    ob.data.materials.append(pants)
    belt = loft_rings('belt', [ring(0.05, 0.155, 0.104, N, None, 3.2), ring(0.082, 0.157, 0.106, N, None, 3.2)])
    belt.data.materials.append(dark)
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(0, 0.066, -0.108))
    buckle = bpy.context.active_object; buckle.scale = (0.04, 0.03, 0.006); buckle.data.materials.append(metal)
    select_only(ob, belt, buckle); bpy.ops.object.join()
    ob = bpy.context.active_object; ob.name = 'pelvis'
    bpy.ops.object.shade_smooth()
    export(os.path.join(OUT, 'pelvis.glb'), [ob])

def build_leg(name, L, r0, r1, bulge, detail_fn, extras=None):
    """Limb along +Y (0..L). Game segment frame: local -X = front of the leg, +Z = outside (right leg)."""
    reset()
    N, R = 36, 56
    rings = []
    for i in range(R + 1):
        t = i / R
        r = r0 + (r1 - r0) * t + bulge * math.sin(math.pi * t ** 0.8)
        end = min(t, 1 - t)
        if end < 0.035: r *= math.sqrt(max(0.0, 1 - ((0.035 - end) / 0.035) ** 2)) * 0.4 + 0.6
        rings.append(ring(t * L, r, r * 0.92, N, lambda a, t=t: detail_fn(t, a), 2.0))
    ob = loft_rings(name, rings)
    pants = mat('pants', (0.17, 0.18, 0.2), 0.9)
    ob.data.materials.append(pants)
    parts = [ob]
    if extras: parts += extras(pants)
    select_only(*parts); bpy.ops.object.join()
    ob = bpy.context.active_object; ob.name = name
    bpy.ops.object.shade_smooth()
    export(os.path.join(OUT, f'{name}.glb'), [ob])

def thigh_detail(t, a):
    front = -math.cos(a)  # local -X
    d = 0.003 * smoothstep(0.75, 0.95, t) * max(0, front) * math.sin(a * 5 + t * 30)   # knee wrinkles
    d += 0.0018 * smoothstep(0.0, 0.25, t) * (1 - smoothstep(0.25, 0.4, t)) * math.sin(a * 4)  # hip drape
    d += 0.0035 * math.exp(-((a - math.pi / 2) / 0.06) ** 2) * (0.2 < t < 0.9)            # outer seam
    return d

def thigh_pocket(pants):
    # cargo pocket with flap on the outer side (+Z), mid thigh
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(0.0, 0.22, 0.082))
    pk = bpy.context.active_object; pk.scale = (0.1, 0.022, 0.12)  # Blender axes: x, depth, up
    bv = pk.modifiers.new('bv', 'BEVEL'); bv.width = 0.008; bv.segments = 3
    apply_mods(pk)
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(0.0, 0.165, 0.094))
    fl = bpy.context.active_object; fl.scale = (0.108, 0.012, 0.035)
    bv = fl.modifiers.new('bv', 'BEVEL'); bv.width = 0.004; bv.segments = 2
    apply_mods(fl)
    for o in (pk, fl): o.data.materials.append(pants)
    return [pk, fl]

def shin_detail(t, a):
    d = 0.0035 * smoothstep(0.55, 0.85, t) * (1 - smoothstep(0.86, 0.9, t)) * math.sin(2 * math.pi * (6 * t + 0.6 * a / (2 * math.pi)))
    d += 0.0035 * math.exp(-((a - math.pi / 2) / 0.06) ** 2) * (t < 0.85)
    if t > 0.9: d += 0.004 + 0.001 * math.sin(a * 30)  # ribbed ankle cuff
    return d

def build_head():
    reset()
    # skull + face built as one surface: deformed sphere + nose + ears, fused by remesh
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=40, radius=0.1)
    sk = bpy.context.active_object
    for v in sk.data.vertices:
        x, y, z = G(v.co)
        nx, ny, nz = x / 0.1, y / 0.1, z / 0.1
        front = max(0.0, -nz)
        x *= 0.9; y *= 1.12
        if y < 0:  # jaw narrows, chin forward
            k = -y / 0.112
            x *= 1 - 0.25 * k
            z *= 1 - 0.1 * k
            if z < 0: z -= 0.014 * k * front
        # brow ridge, eye sockets, cheekbones
        z -= 0.006 * front * math.exp(-((y - 0.03) / 0.012) ** 2) * (1 - abs(nx))
        for sx in (-1, 1):
            de = math.hypot((x - sx * 0.033) / 0.016, (y - 0.012) / 0.011)
            if de < 1 and z < 0: z += 0.006 * (1 - de) ** 2
            dc = math.hypot((x - sx * 0.05) / 0.025, (y + 0.02) / 0.02)
            if dc < 1 and z < 0: z -= 0.004 * (1 - dc) ** 2
        v.co = B(x, y, z)
    bpy.ops.mesh.primitive_cone_add(radius1=0.016, radius2=0.004, depth=0.036, location=B(0, -0.008, -0.098))
    nose = bpy.context.active_object; nose.rotation_euler = (math.radians(-100), 0, 0)
    ears = []
    for sx in (-1, 1):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.024, location=B(sx * 0.088, 0.0, 0.01))
        e = bpy.context.active_object; e.scale = (0.35, 1.0, 0.7); ears.append(e)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.046, depth=0.12, location=B(0, -0.15, 0.01))
    neck = bpy.context.active_object  # cylinder axis is already vertical
    select_only(sk, nose, neck, *ears); bpy.ops.object.join()
    head = bpy.context.active_object
    rm = head.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = 0.0018
    sm = head.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.5; sm.iterations = 6
    dec = head.modifiers.new('dec', 'DECIMATE'); dec.ratio = 0.18
    apply_mods(head)
    skin, hair, dark, accent = mat('skin', (0.79, 0.56, 0.45), 0.5), mat('hair', (0.1, 0.08, 0.07), 0.55), mat('dark', (0.13, 0.135, 0.14), 0.75), mat('accent', (0.78, 0.09, 0.12), 0.55)
    head.data.materials.append(skin)
    # lips: a slightly darker band pressed onto the face
    # hair cap with strand grooves swept back
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, radius=0.106)
    hc = bpy.context.active_object
    bm = bmesh.new(); bm.from_mesh(hc.data)
    kill = []
    for v in bm.verts:
        x, y, z = G(v.co)
        # hairline: forehead at the front, above the ears at the sides, nape at the back
        line = 0.04 if z < 0 else (-0.04 + 0.03 * (1 - abs(x) / 0.106))
        if y < line - 0.03 * max(0, -z / 0.106) ** 2: kill.append(v)
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    for v in bm.verts:
        x, y, z = G(v.co)
        a = math.atan2(x, z)
        r = 1 + 0.03 * math.sin(a * 46) * 0.25
        v.co = B(x * 0.92 * r, y * 1.13 + 0.004, z * 1.02 * r)
    bm.to_mesh(hc.data); bm.free()
    smh = hc.modifiers.new('sm', 'SMOOTH'); smh.factor = 0.8; smh.iterations = 4  # soften the cut hairline
    so = hc.modifiers.new('so', 'SOLIDIFY'); so.thickness = 0.004
    apply_mods(hc)
    hc.data.materials.append(hair)
    eyes = []
    for sx in (-1, 1):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.0085, location=B(sx * 0.033, 0.012, -0.085))
        ey = bpy.context.active_object; ey.data.materials.append(dark); eyes.append(ey)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.016, minor_radius=0.006, location=B(0, 0.04, 0.1))
    tie = bpy.context.active_object; tie.rotation_euler = (0.6, 0, 0); tie.data.materials.append(accent)
    select_only(head, hc, tie, *eyes); bpy.ops.object.join()
    head = bpy.context.active_object; head.name = 'head'
    bpy.ops.object.shade_smooth()
    export(os.path.join(OUT, 'head.glb'), [head])

if __name__ == '__main__':
    build_hand()
    sleeve('sleeve_upper', 0.29, 0.05, 0.042, 0.008, upper_folds)
    sleeve('sleeve_fore', 0.27 * 0.72, 0.043, 0.036, 0.004, fore_folds)
    build_shoe()
    build_torso()
    build_pelvis()
    build_leg('thigh', 0.44, 0.088, 0.062, 0.01, thigh_detail, thigh_pocket)
    build_leg('shin', 0.43, 0.06, 0.042, 0.012, shin_detail)
    build_head()
