"""Builds public/assets/house-roofs.glb: scalloped shingle rows for the house roofs (an original model, made here).
  blender -b --factory-startup --python scripts/blender/build_house_roofs.py
Every piece is in unit space and public/house-art.js scales it onto a roof, so one kit fits every tower:
  cap_large / cap_small  rows round the cap() lathe profile (radius 1, height 1), more scallops on the big roofs
  gable                  rows on one slope of a gable roof: x up the slope 0..1, y out of the roof (metres), z along the ridge -.5..+.5
  dome                   rows round a unit sphere (the merchant's onion dome)
Each piece is two meshes: <name>_face (the shingles) and <name>_lip (the dark edge under each scallop row). The COLOR
attribute is the shade the runtime multiplies the roof colour by (face 1.0, lip LIP_SHADE). No textures, no materials.
Coordinates are written Y-up (three.js) and swapped to Blender's Z-up on the way in, so the exporter's +Y up lands back."""
import bpy, bmesh, math, os
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'house-roofs.glb')
LIP_SHADE = 0.74
SAMPLES = 6  # corners per scallop along the row

# cap() in world-art.js: [r,y] at radius 1, height 1 (its tip is 0.035 m absolute; any small radius here is hidden).
CAP = [(1.08, 0), (1.0, .12), (.77, .3), (.48, .57), (.22, .8), (.02, 1)]

def cap_at(s):
    """Point on the cap profile at parameter s (0 eave .. 1 tip), plus the outward normal in the (r,y) plane."""
    s = min(max(s, 0), 1) * (len(CAP) - 1); i = min(int(s), len(CAP) - 2); f = s - i
    (r0, y0), (r1, y1) = CAP[i], CAP[i + 1]
    r, y = r0 + (r1 - r0) * f, y0 + (y1 - y0) * f
    dr, dy = r1 - r0, y1 - y0; n = math.hypot(dr, dy)
    return r, y, dy / n, -dr / n  # normal (nr, ny) points out and up

def sphere_at(s):
    """Unit sphere meridian at s (0 at latitude LAT0 .. 1 at the top)."""
    lat = DOME_LAT0 + (math.pi / 2 - DOME_LAT0) * s
    return math.cos(lat), math.sin(lat), math.cos(lat), math.sin(lat)

DOME_LAT0 = -0.3  # the dome's band (world-art.js merchant) covers below this

def scallop_ring(rows, profile, out, lift):
    """Rows of fish-scale shingles round a lathe profile. rows: [(s_bottom, s_top, scallops)]. out(s): offset of a row's
    tongue (its tucked top edge sits at lift). Returns (face_tris, lip_tris) as lists of three (x,y,z) points."""
    face, lip = [], []
    for s0, s1, n in rows:
        seg = n * SAMPLES; depth = (s1 - s0) * .38
        def at(s, a, off):
            r, y, nr, ny = profile(s)
            return ((r + nr * off) * math.sin(a), y + ny * off, (r + nr * off) * math.cos(a))
        for k in range(seg):
            a0, a1 = k / seg * 2 * math.pi, (k + 1) / seg * 2 * math.pi
            # The bottom edge rises between scallops: a round tongue under every scallop.
            b0 = s0 + depth * (1 - math.sin(math.pi * (k % SAMPLES) / SAMPLES))
            b1 = s0 + depth * (1 - math.sin(math.pi * ((k % SAMPLES) + 1) / SAMPLES))
            top0, top1 = at(s1, a0, lift), at(s1, a1, lift)
            bot0, bot1 = at(b0, a0, out), at(b1, a1, out)
            in0, in1 = at(b0, a0, lift * .3), at(b1, a1, lift * .3)
            face += [(bot0, bot1, top1), (bot0, top1, top0)]
            lip += [(in0, in1, bot1), (in0, bot1, bot0)]
    return face, lip

def gable_rows(rows, scallops, thick):
    """Rows on one gable slope: x up the slope (0 eave .. 1 ridge), y out of the roof (metres), z along the ridge."""
    face, lip = [], []; seg = scallops * SAMPLES; h = 1 / rows
    for r in range(rows):
        s0, s1 = r * h, min(1, (r + 1) * h + h * .35); depth = h * .38
        for k in range(seg):
            z0, z1 = k / seg - .5, (k + 1) / seg - .5
            b0 = s0 + depth * (1 - math.sin(math.pi * (k % SAMPLES) / SAMPLES))
            b1 = s0 + depth * (1 - math.sin(math.pi * ((k % SAMPLES) + 1) / SAMPLES))
            top0, top1 = (s1, .004, z0), (s1, .004, z1)
            bot0, bot1 = (b0, thick, z0), (b1, thick, z1)
            in0, in1 = (b0, .002, z0), (b1, .002, z1)
            face += [(bot0, bot1, top1), (bot0, top1, top0)]
            lip += [(in0, in1, bot1), (in0, bot1, bot0)]
    return face, lip

def add_mesh(name, tris, shade, smooth):
    bm = bmesh.new(); col = bm.loops.layers.color.new('Color')
    for t in tris:
        # three.js (x,y,z) -> Blender (x,-z,y); the glTF exporter's Y-up conversion maps it back.
        vs = [bm.verts.new((p[0], -p[2], p[1])) for p in t]
        f = bm.faces.new(vs); f.smooth = smooth
        for l in f.loops: l[col] = (shade, shade, shade, 1)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    me.color_attributes.active_color = me.color_attributes['Color']
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    return len(me.polygons)

def rows_between(s_from, s_to, counts):
    """len(counts) overlapping rows from s_from to s_to; each row's top tucks a third of a row under the next."""
    h = (s_to - s_from) / len(counts)
    return [(s_from + i * h, min(s_to, s_from + (i + 1.35) * h), n) for i, n in enumerate(counts)]

bpy.ops.wm.read_factory_settings(use_empty=True)
total = {}
pieces = {
    'cap_large': scallop_ring(rows_between(0, .86, [18, 15, 12, 9, 6]), cap_at, .04, .012),
    'cap_small': scallop_ring(rows_between(0, .84, [10, 8, 7, 5]), cap_at, .05, .014),
    'dome': scallop_ring(rows_between(0, .9, [16, 14, 12, 9, 6]), sphere_at, .03, .01),
    'gable': gable_rows(4, 7, .045),
}
for name, (face, lip) in pieces.items():
    total[name] = add_mesh(name + '_face', face, 1.0, True) + add_mesh(name + '_lip', lip, LIP_SHADE, False)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_materials='NONE',
                          export_vertex_color='ACTIVE', export_normals=True, export_texcoords=False, export_animations=False)
print('house-roofs:', ', '.join(f'{k} {v} tris' for k, v in total.items()), OUT)
