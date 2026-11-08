"""Measures public/assets/mayor.glb so the kit can match its style without shipping any of its data.
  blender -b --factory-startup --python scripts/blender/measure_mayor.py -- [--image OUT.png]
Writes scripts/blender/mayor-measure.json: a radial shape table of the body, a colour table of its painted
markings on the same grid, landmark boxes (ears, arms, paws, feet, tail, face features) and material values."""
import bpy, bmesh, json, math, os, sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'public', 'assets', 'mayor.glb'))
dg = bpy.context.evaluated_depsgraph_get()
objs = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
body = next(o for n, o in objs.items() if n.startswith('Mayor • continuous rounded body'))

def world_mesh(o):
    bm = bmesh.new(); bm.from_object(o, dg); bm.transform(o.matrix_world); return bm
bm = world_mesh(body); bm.faces.ensure_lookup_table(); bvh = BVHTree.FromBMesh(bm)
uv = bm.loops.layers.uv.active
img = next(i for i in bpy.data.images if i.size[0] > 0); W, H = img.size; px = list(img.pixels)
def sample(face, p):
    """Bilinear texture colour (linear RGB) at a surface point, via barycentric UVs."""
    a, b, c = (l.vert.co for l in face.loops[:3]); la, lb, lc = (l[uv].uv for l in face.loops[:3])
    v0, v1, v2 = b - a, c - a, p - a; d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
    den = d00 * d11 - d01 * d01 or 1e-12; v = (d11 * d20 - d01 * d21) / den; w = (d00 * d21 - d01 * d20) / den; u = 1 - v - w
    t = la * u + lb * v + lc * w; x = (t.x % 1) * (W - 1); y = (t.y % 1) * (H - 1); i = (int(y) * W + int(x)) * 4
    return [round(px[i + k], 3) for k in range(3)]
# Radial table from a centre inside the body: R(theta, phi) and the painted colour there.
C = Vector((0, 0, 0.9)); NT, NP = 160, 80; R, COL = [], []
for j in range(NP + 1):
    phi = math.pi * j / NP; row, crow = [], []          # phi: 0 = straight up, pi = straight down
    for i in range(NT):
        th = 2 * math.pi * i / NT                       # theta: 0 = front (-Y), +pi/2 = character left (+X)
        d = Vector((math.sin(phi) * math.sin(th), -math.sin(phi) * math.cos(th), math.cos(phi)))
        hit, n, fi, dist = bvh.ray_cast(C + d * 3.0, -d)   # from outside inward: the outer skin
        row.append(round((hit - C).length, 4)); crow.append(sample(bm.faces[fi], hit))
    R.append(row); COL.append(crow)
def box(o):
    b = world_mesh(o); vs = [v.co for v in b.verts]; b.free()
    lo = [min(v[k] for v in vs) for k in range(3)]; hi = [max(v[k] for v in vs) for k in range(3)]
    return {'min': [round(x, 4) for x in lo], 'max': [round(x, 4) for x in hi]}
def islands(o):
    b = world_mesh(o); b.verts.ensure_lookup_table(); seen = set(); out = []
    for v in b.verts:
        if v.index in seen: continue
        stack = [v]; group = []
        while stack:
            x = stack.pop()
            if x.index in seen: continue
            seen.add(x.index); group.append(x.co.copy()); stack += [e.other_vert(x) for e in x.link_edges]
        lo = [min(p[k] for p in group) for k in range(3)]; hi = [max(p[k] for p in group) for k in range(3)]
        out.append({'min': [round(x, 4) for x in lo], 'max': [round(x, 4) for x in hi], 'verts': len(group)})
    b.free(); return out
def principled(m):
    if not m or not m.use_nodes: return None
    n = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not n: return None
    g = lambda k: (list(n.inputs[k].default_value)[:3] if hasattr(n.inputs[k].default_value, '__len__') else n.inputs[k].default_value) if k in n.inputs else None
    return {'base': g('Base Color'), 'roughness': g('Roughness'), 'metallic': g('Metallic'), 'specular': g('Specular IOR Level'),
            'sheen': g('Sheen Weight'), 'coat': g('Coat Weight'), 'textured': n.inputs['Base Color'].is_linked}
out = {'centre': list(C), 'theta_steps': NT, 'phi_steps': NP, 'radius': R, 'colour': COL,
       'boxes': {n: box(o) for n, o in objs.items() if not n.startswith('Icosphere')},
       'face_islands': {n: islands(o) for n, o in objs.items() if n.startswith(('Sphere.025', 'Tiny nose', 'Whisker', 'Paw crease', 'Toe crease', 'Rounded whisker'))},
       'materials': {m.name: principled(m) for m in bpy.data.materials},
       'bones': {b.name: {'head': [round(x, 4) for x in b.head_local], 'tail': [round(x, 4) for x in b.tail_local]} for b in bpy.data.objects['Mayor.Rig'].data.bones},
       'shape_keys': [k.name for k in objs['Sphere.025'].data.shape_keys.key_blocks]}
json.dump(out, open(os.path.join(HERE, 'mayor-measure.json'), 'w'), separators=(',', ':'))
if '--image' in ARGV:
    img.filepath_raw = ARGV[ARGV.index('--image') + 1]; img.file_format = 'PNG'; img.save()
print('MEASURED', body.name, 'radius range', min(min(r) for r in R), max(max(r) for r in R))
