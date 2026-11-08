"""Builds the modular Cat Town character kit (public/assets/cat-kit.glb) from code.

  blender -b --factory-startup --python scripts/blender/build_cat_kit.py -- [--out FILE] [--render DIR]

Blender space: Z up, the cat faces -Y (glTF: Y up, faces +Z), feet centre at the origin.
Everything is generated here; no GUI step, no imported source art.
"""
import bpy, bmesh, math, os, sys, json, struct, re
import numpy as np
from mathutils import Vector, Matrix, kdtree

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default=None):
    return ARGV[ARGV.index(name) + 1] if name in ARGV else default
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = arg('--out', os.path.join(ROOT, 'public', 'assets', 'cat-kit.glb'))
RENDER = arg('--render') and os.path.abspath(arg('--render'))
MAYOR = os.path.join(ROOT, 'public', 'assets', 'mayor.glb')

# ---------------------------------------------------------------- SDF toolkit (numpy, P is (N,3))
A = np.asarray
def ell(P, c, r, M=None):
    Q = P - A(c, float)
    if M is not None: Q = Q @ M
    r = A(r, float)
    k0 = np.linalg.norm(Q / r, axis=-1); k1 = np.linalg.norm(Q / (r * r), axis=-1)
    return k0 * (k0 - 1) / np.maximum(k1, 1e-9)
def sph(P, c, r): return np.linalg.norm(P - A(c, float), axis=-1) - r
def rcone(P, a, b, r1, r2):
    a, b = A(a, float), A(b, float); ba = b - a; l2 = ba @ ba; rr = r1 - r2; a2 = l2 - rr * rr; il2 = 1 / l2
    pa = P - a; y = pa @ ba; z = y - l2
    x2 = ((pa * l2 - np.outer(y, ba)) ** 2).sum(1); y2 = y * y * l2; z2 = z * z * l2
    k = np.sign(rr) * rr * rr * x2
    return np.where(np.sign(z) * a2 * z2 > k, np.sqrt(x2 + z2) * il2 - r2,
           np.where(np.sign(y) * a2 * y2 < k, np.sqrt(x2 + y2) * il2 - r1,
                    (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + y * rr) * il2 - r1))
def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1); return b * (1 - h) + a * h - k * h * (1 - h)
def smax(a, b, k): return -smin(-a, -b, k)
def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
def norm(v): v = A(v, float); return v / np.linalg.norm(v)
def grad(sdf, P, e=1e-4):
    g = np.empty_like(P)
    for i in range(3):
        d = np.zeros(3); d[i] = e; g[:, i] = (sdf(P + d) - sdf(P - d)) / (2 * e)
    return g
def normals(sdf, P):
    g = grad(sdf, P); return g / np.linalg.norm(g, axis=1)[:, None]
def project(sdf, P, it=5):
    for _ in range(it):
        d = sdf(P); g = grad(sdf, P); P = P - (d / np.maximum((g * g).sum(1), 1e-9))[:, None] * g
    return P
def raycast(sdf, O, D, tmax=2.5, steps=200):
    """First exit of rays O+tD (O inside) from the solid."""
    ts = np.linspace(0, tmax, steps)
    d = sdf((O[:, None, :] + ts[None, :, None] * D[:, None, :]).reshape(-1, 3)).reshape(len(D), steps)
    idx = np.argmax(d > 0, axis=1); lo = ts[np.maximum(idx - 1, 0)]; hi = ts[idx]
    for _ in range(30):
        mid = (lo + hi) / 2; ins = sdf(O + mid[:, None] * D) < 0
        lo = np.where(ins, mid, lo); hi = np.where(ins, hi, mid)
    return (lo + hi) / 2

# ---------------------------------------------------------------- mesh helpers
def cube_sphere(n):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=n - 1, use_grid_fill=True)
    bm.verts.index_update()
    V = A([v.co[:] for v in bm.verts]); F = [[v.index for v in f.verts] for f in bm.faces]
    E = A([[e.verts[0].index, e.verts[1].index] for e in bm.edges]); bm.free()
    return V / np.linalg.norm(V, axis=1)[:, None], F, E
def relax(sdf, V, E, iters, lam=0.5):
    deg = np.bincount(E.ravel(), minlength=len(V)).astype(float)
    for _ in range(iters):
        S = np.zeros_like(V); np.add.at(S, E[:, 0], V[E[:, 1]]); np.add.at(S, E[:, 1], V[E[:, 0]])
        L = S / deg[:, None] - V; n = normals(sdf, V); L -= (L * n).sum(1)[:, None] * n
        V = project(sdf, V + lam * L)
    return V
def sdf_island(sdf, center, n, iters=12, stretch=(1, 1, 1), focus=None):
    D, F, E = cube_sphere(n); D = D * A(stretch)
    if focus is not None: D = D / np.linalg.norm(D, axis=1)[:, None] + A(focus)
    D /= np.linalg.norm(D, axis=1)[:, None]
    O = np.tile(A(center, float), (len(D), 1)); V = O + raycast(sdf, O, D)[:, None] * D
    return relax(sdf, V, E, iters), F, E
def rings_mesh(R, cap0=None, cap1=None):
    """R: (rings, segs, 3) closed cross-sections -> V, F with optional cap points."""
    R = A(R, float); n, segs, _ = R.shape; V = list(R.reshape(-1, 3)); F = []
    for i in range(n - 1):
        for j in range(segs):
            j1 = (j + 1) % segs; F.append([i * segs + j, i * segs + j1, (i + 1) * segs + j1, (i + 1) * segs + j])
    if cap0 is not None:
        V.append(A(cap0, float)); c = len(V) - 1; F += [[(j + 1) % segs, j, c] for j in range(segs)]
    if cap1 is not None:
        V.append(A(cap1, float)); c = len(V) - 1; o = (n - 1) * segs; F += [[o + j, o + (j + 1) % segs, c] for j in range(segs)]
    return A(V), F
def ring_tube(path, radius, segs, frames_up=(0, 0, 1), cap0=True, cap1=True, xsec=None):
    """Sweep a cross-section along a polyline. frames_up: one vector, or one per path point."""
    P = A(path, float); n = len(P); T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1)[:, None]
    ups = A(frames_up, float); per_point = ups.ndim == 2; R = []; u_prev = None; S = []
    for i in range(n):
        ref = ups[i] if per_point else (ups if u_prev is None else u_prev)
        u = ref - (ref @ T[i]) * T[i]
        if np.linalg.norm(u) < 1e-6: u = np.cross(T[i], (1, 0, 0))
        u = u / np.linalg.norm(u); w = np.cross(T[i], u); u_prev = u; t = i / (n - 1)
        r = radius(t) if callable(radius) else radius; ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs; cx, cy = (math.cos(a), math.sin(a)) if xsec is None else xsec(a, t)
            ring.append(P[i] + r * (cx * u + cy * w))
        R.append(ring); S += [t] * segs
    V, F = rings_mesh(R, P[0] if cap0 else None, P[-1] if cap1 else None)
    S += [0.0] * cap0 + [1.0] * cap1
    return V, F, A(S)
def catmull(pts, count):
    P = A(pts, float); P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]]); out = []
    for k in range(count):
        t = k / (count - 1) * (len(P) - 3); i = min(int(t), len(P) - 4); u = t - i
        p0, p1, p2, p3 = P[i:i + 4]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3))
    return A(out)
def make_mesh(name, V, F, smooth=True, sharp_deg=None, mats=None, mat_idx=None, weld=False, recalc=False):
    """weld/recalc only where vertex order does not matter (parts); masks and weights are per input vertex."""
    me = bpy.data.meshes.new(name); me.from_pydata([tuple(v) for v in V], [], [list(f) for f in F]); me.update()
    if mat_idx is not None: me.polygons.foreach_set('material_index', [int(i) for i in mat_idx])
    bm = bmesh.new(); bm.from_mesh(me)
    if weld: bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    if recalc: bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces: f.smooth = smooth
    if sharp_deg is not None:
        for e in bm.edges:
            if e.is_manifold and e.calc_face_angle(0) > math.radians(sharp_deg): e.smooth = False
    bm.to_mesh(me); bm.free()
    for m in mats or []: me.materials.append(m)
    return me
def link(obj, coll=None):
    (coll or bpy.context.scene.collection).objects.link(obj); return obj
def merge(parts):
    """parts: list of (V, F, extra-dict). Concatenates with index offsets."""
    V, F, X, off = [], [], {}, 0
    for v, f, x in parts:
        V.append(v); F += [[i + off for i in face] for face in f]
        for k, val in x.items(): X.setdefault(k, []).append(val)
        off += len(v)
    return np.vstack(V), F, {k: np.concatenate(v) for k, v in X.items()}

# ---------------------------------------------------------------- materials
def mat(name, hex_color, rough=0.8, metal=0.0, double=False):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']; c = tuple(int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    b.inputs['Base Color'].default_value = (*[x ** 2.2 for x in c], 1); b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal; m.use_backface_culling = not double; m.diffuse_color = (*[x ** 2.2 for x in c], 1)
    return m
def srgb(h): return tuple((int(h[i:i + 2], 16) / 255) ** 2.2 for i in (1, 3, 5))

# ---------------------------------------------------------------- Mayor-matched bases
# Bean is the Mayor's body: a radial table measured from public/assets/mayor.glb by measure_mayor.py.
# Puff and Sprout are smooth warps of it, so every base shares the Mayor's face, proportions and markings.
MEASURE = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mayor-measure.json')))
MC = A(MEASURE['centre'], float); MR = A(MEASURE['radius'], float); MCOL = A(MEASURE['colour'], float)
NT, NP = MEASURE['theta_steps'], MEASURE['phi_steps']; MBONE = MEASURE['bones']; MBOX = MEASURE['boxes']
def mbox(prefix):
    b = next(v for k, v in MBOX.items() if k.startswith(prefix)); lo, hi = A(b['min']), A(b['max']); return (lo + hi) / 2, (hi - lo) / 2
def _cr(t):
    t2, t3 = t * t, t * t * t
    return np.stack([(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2], -1)
def sph_coords(P):
    v = P - MC; r = np.linalg.norm(v, axis=1)
    return r, np.arccos(np.clip(v[:, 2] / np.maximum(r, 1e-9), -1, 1)), np.arctan2(v[:, 0], -v[:, 1]) % (2 * math.pi)
def table(T, phi, th, cubic=True):
    """Periodic-in-theta lookup into a (NP+1, NT, ...) table; Catmull-Rom for the shape, bilinear for colour."""
    u = th / (2 * math.pi) * NT; w = phi / math.pi * NP; i0 = np.floor(u).astype(int); j0 = np.floor(w).astype(int)
    fu, fw = u - i0, w - j0
    if not cubic:
        out = 0
        for a, wa in ((0, 1 - fw), (1, fw)):
            for c, wc in ((0, 1 - fu), (1, fu)):
                out = out + (wa * wc).reshape(-1, *[1] * (T.ndim - 2)) * T[np.clip(j0 + a, 0, NP), (i0 + c) % NT]
        return out
    wu, ww = _cr(fu), _cr(fw); out = np.zeros(len(u))
    for a in range(4):
        for c in range(4): out += ww[:, a] * wu[:, c] * T[np.clip(j0 + a - 1, 0, NP), (i0 + c - 1) % NT]
    return out
def mayor_sdf(P):
    r, phi, th = sph_coords(P); return r - table(MR, phi, th)
def mayor_colour(P):
    _, phi, th = sph_coords(P); return table(MCOL, phi, th, cubic=False)

SPROUT_LIFT = 0.34
BASES = {'bean': dict(sx=1.0, sy=1.0, sprout=False, fluff=False),
         'puff': dict(sx=1.1, sy=1.06, sprout=False, fluff=True),
         'sprout': dict(sx=1.0, sy=1.0, sprout=True, fluff=False)}
for name, b in BASES.items(): b['name'] = name
def _lift(z): return z + SPROUT_LIFT * sstep(0.1, 1.0, z)
def _pear(zw): return 1.05 - 0.10 * sstep(0.2, 1.3, zw) + 0.05 * sstep(1.3, 1.75, zw)    # wider belly, slimmer under the head
def warp(b, P):
    """Mayor space -> base space."""
    P = A(P, float).reshape(-1, 3).copy()
    if b['sprout']: zw = _lift(P[:, 2]); k = _pear(zw); P[:, 0] *= k; P[:, 1] *= k; P[:, 2] = zw
    P[:, 0] *= b['sx']; P[:, 1] *= b['sy']; return P
def unwarp(b, P):
    P = A(P, float).reshape(-1, 3).copy(); P[:, 0] /= b['sx']; P[:, 1] /= b['sy']
    if b['sprout']:
        k = _pear(P[:, 2]); P[:, 0] /= k; P[:, 1] /= k; z = P[:, 2].copy(); zm = z.copy()
        for _ in range(8): zm = z - SPROUT_LIFT * sstep(0.1, 1.0, zm)
        P[:, 2] = zm
    return P
def wpt(b, p): return warp(b, p)[0]
def torso_sdf(b): return lambda P: mayor_sdf(unwarp(b, P))
def crown(b): return wpt(b, MC + A((0, 0, MR[0, 0])))

# Limbs and ears are the Mayor's own volumes (centres and radii from its meshes), placed per base.
ARM_C, ARM_R = mbox('Apricot arm 1'); PAW_C, PAW_R = mbox('Cream paw 1'); FOOT_C, FOOT_R = mbox('Small cream foot 1')
EAR_C, EAR_R = mbox('Soft ear 1'); TAILTIP_C, TAILTIP_R = mbox('Apricot rounded tail tip')
def mirror(p, s): p = A(p, float).copy(); p[0] *= s; return p
def ellipsoid_island(centre, radii, n, torso=None, margin=0.03):
    D, F, _ = cube_sphere(n); V = A(centre) + D * A(radii)
    if torso is None: return V, F
    V, F, _ = cull_inside(V, F, {'x': np.zeros(len(V))}, torso, margin); return V, F
def tail_path(b):
    pts = [MBONE['tail.1']['head']] + [MBONE[f'tail.{k}']['tail'] for k in range(1, 5)]
    pts = [A(MBONE['tail.1']['head']) - A((0.32, 0.0, -0.02))] + pts                  # root buried in the body
    return warp(b, catmull(pts, 20))
def ear_frame(b, s):
    base = wpt(b, mirror(EAR_C + A((0, 0, -EAR_R[2] - 0.05)), s)); up = norm(wpt(b, mirror(EAR_C + A((0.05, 0, EAR_R[2])), s)) - base)
    fw = norm(A((s * 0.1, -1, 0)) - up * (A((s * 0.1, -1, 0)) @ up)); sd = np.cross(fw, up)
    return base, up, fw, sd
def bean_pad(c, n, rx, ry, h, segs=7):
    """Small pink pad dome sitting on a surface point c with outward normal n."""
    n = norm(n); u = norm(np.cross(n, (0, 0, 1)) if abs(n[2]) < 0.9 else np.cross(n, (1, 0, 0))); v = np.cross(n, u)
    R = [[c - n * 0.006 + (u * rx * math.cos(a) + v * ry * math.sin(a)) * k + n * hh for a in np.linspace(0, 2 * math.pi, segs + 1)[:-1]]
         for k, hh in ((1.0, 0.0), (0.7, h * 0.8))]
    return rings_mesh(R, c - n * 0.006, c + n * h)
def ell_sdf(c, r): return lambda P: ell(P, c, r)
def fluff_lobes(b, torso):
    """Puff cheek fluff: soft overlapping lobes that scallop the lower cheeks."""
    out = []; D, F, _ = cube_sphere(3)
    for s in (-1, 1):
        for dz, ang in ((0.14, 12), (0.0, 30), (-0.13, 50)):
            d = norm((s * math.cos(math.radians(ang)), -0.18, -math.sin(math.radians(ang))))
            O = wpt(b, (0, -0.05, 1.12 + dz))[None, :]; Dr = norm(wpt(b, (s * 1.0, -0.42, 1.12 + dz)) - O[0])[None, :]
            root = (O + raycast(torso, O, Dr)[:, None] * Dr)[0]
            up = norm(np.cross(d, (0, 1, 0))); up = up if up[2] > 0 else -up; fw = np.cross(up, d)
            V = place(D * A((0.11, 0.088, 0.05)), root + d * 0.012, d, up, fw)
            V, Fc, _ = cull_inside(V, F, {'x': np.zeros(len(V))}, torso, 0.0); out.append((V, Fc))
    return out

# ---------------------------------------------------------------- markings (vertex masks)
def smooth_vals(vals, E, iters):
    deg = np.bincount(E.ravel(), minlength=len(vals)).astype(float); v = vals.copy()
    for _ in range(iters):
        s = np.zeros_like(v); np.add.at(s, E[:, 0], v[E[:, 1]]); np.add.at(s, E[:, 1], v[E[:, 0]])
        v = 0.5 * v + 0.5 * s / (deg[:, None] if v.ndim > 1 else deg)
    return v
def blob(V, c, r, soft=0.4): return sstep(r, r * (1 - soft), np.linalg.norm(V - A(c), axis=1))
FUR_RGB, CREAM_RGB, SPOT_RGB = A((0.95, 0.63, 0.31)), A((0.98, 0.87, 0.75)), A((0.87, 0.54, 0.25))   # measured clusters of the Mayor's paint
def mayor_marks(Pm):
    """Cream (muzzle, belly) and tabby (soft ovals, darker crown) weights read off the Mayor's painted texture."""
    c = mayor_colour(Pm); ax = CREAM_RGB - FUR_RGB
    cream = np.clip(((c - FUR_RGB) @ ax) / (ax @ ax), 0, 1)
    lum = lambda x: x @ A((0.3, 0.59, 0.11))
    stripe = np.clip((lum(FUR_RGB) - lum(c)) / (lum(FUR_RGB) - lum(SPOT_RGB)), 0, 1)
    return cream, stripe
def torso_masks(b, V, N, E):
    Pm = unwarp(b, V); x, y, z = Pm[:, 0], Pm[:, 1], Pm[:, 2]
    cream, stripe = mayor_marks(Pm)
    patch = np.clip(np.maximum(sstep(1.02, 1.12, z), sstep(-0.15, 0.25, y) * sstep(0.25, 0.45, z)), 0, 1)        # tuxedo cap + saddle
    spot_a = np.maximum(blob(Pm, (0.52, -0.42, 1.48), 0.40), blob(Pm, (-0.75, 0.15, 0.55), 0.45))                    # calico: patch colour
    spot_b = np.maximum.reduce([blob(Pm, (-0.55, -0.15, 1.58), 0.38), blob(Pm, (0.65, 0.45, 0.42), 0.42), blob(Pm, (0.1, 0.72, 1.15), 0.36)]) * (1 - spot_a)
    M = np.column_stack([smooth_vals(patch, E, 2), smooth_vals(stripe, E, 1), smooth_vals(cream, E, 2), np.zeros(len(V))]); S = np.column_stack([smooth_vals(spot_a, E, 2), smooth_vals(spot_b, E, 2)])
    keep = 1 - sstep(0.3, 0.7, M[:, 2]); M[:, 0] *= keep; M[:, 1] *= keep; S *= keep[:, None]
    return M, S

# ---------------------------------------------------------------- base body assembly
def cull_inside(V, F, X, inside, margin):
    """Drop faces buried deeper than margin inside the torso (never visible), then compact vertices."""
    d = inside(V); keep_f = [f for f in F if not all(d[i] < -margin for i in f)]
    used = np.unique(np.concatenate([A(f) for f in keep_f])); remap = -np.ones(len(V), int); remap[used] = np.arange(len(used))
    return V[used], [[int(remap[i]) for i in f] for f in keep_f], {k: v[used] for k, v in X.items()}
def head_weight(b, V): return sstep(0.92, 1.06, unwarp(b, V)[:, 2])
def build_body(b):
    islands = []; torso = torso_sdf(b)
    V, F, E = sdf_island(torso, wpt(b, MC), 15 if b['fluff'] else 16, iters=4)
    N = normals(torso, V); M, spot = torso_masks(b, V, N, E)
    zm = unwarp(b, V)[:, 2]; wh = sstep(0.92, 1.06, zm); wc = (1 - wh) * sstep(0.45, 0.7, zm)
    islands.append((V, F, dict(mask=M, spot=spot, w_head=wh, w_chest=wc, w_pelvis=1 - wh - wc)))
    z2 = lambda V: np.zeros((len(V), 2)); pink = lambda Vp: np.tile((0, 0, 0, 1.0), (len(Vp), 1))
    if b['fluff']:
        tree = kdtree.KDTree(len(V)); [tree.insert(v, i) for i, v in enumerate(V)]; tree.balance()
        for Vt, Ft in fluff_lobes(b, torso):
            near = A([tree.find(v)[1] for v in Vt]); islands.append((Vt, Ft, {'mask': M[near], 'spot': spot[near], 'w_head': np.ones(len(Vt))}))
    for s, sfx in ((1, 'L'), (-1, 'R')):
        # arm: the Mayor's apricot shoulder blob; paw: its cream mitt in front; both rigid on their bones
        # not culled: the shoulder pivot sits above this blob, so a raised arm swings its buried side into view
        Va, Fa = ellipsoid_island(wpt(b, mirror(ARM_C, s)), ARM_R * A((b['sx'], b['sy'], 1)) ** 0.5, 5)
        islands.append((Va, Fa, {'mask': np.tile((1.0, 0, 0, 0), (len(Va), 1)), 'spot': z2(Va), 'w_arm.' + sfx: np.ones(len(Va))}))
        pc = wpt(b, mirror(PAW_C, s)); Vp, Fp = ellipsoid_island(pc, PAW_R, 5)
        islands.append((Vp, Fp, {'mask': np.tile((0, 0, 1.0, 0), (len(Vp), 1)), 'spot': z2(Vp), 'w_paw.' + sfx: np.ones(len(Vp))}))
        psdf = ell_sdf(pc, PAW_R)
        for off, r in (((0, 0.03, -0.06), 0.034), ((-0.05, 0.0, -0.1), 0.017), ((0, -0.03, -0.112), 0.017), ((0.05, 0.0, -0.1), 0.017)):
            q = pc + A(off) * A((s, 1, 1)); q = project(psdf, q[None, :])[0]; Vb, Fb = bean_pad(q, normals(psdf, q[None, :])[0], r, r * 0.9, 0.012)
            islands.append((Vb, Fb, {'mask': pink(Vb), 'spot': z2(Vb), 'w_paw.' + sfx: np.ones(len(Vb))}))
        fc = wpt(b, mirror(FOOT_C, s)) + A((0, 0, 0.02)); fr = FOOT_R * A((b['sx'] ** 0.5, 1, 1)); Vf, Ff = ellipsoid_island(fc, fr, 6)
        Vf, Ff, Xf = cull_inside(Vf, Ff, {'mask': np.tile((0, 0, 1.0, 0), (len(Vf), 1)), 'spot': z2(Vf), 'w_foot.' + sfx: np.ones(len(Vf))}, torso, 0.04)
        islands.append((Vf, Ff, Xf)); fsdf = ell_sdf(fc, fr)
        for off, r in (((0, 0.03, -1), 0.06), ((-0.06, -0.11, -1), 0.026), ((0, -0.13, -1), 0.026), ((0.06, -0.11, -1), 0.026)):
            q = fc + A((off[0], off[1], -fr[2] * 0.9)); q = project(fsdf, q[None, :])[0]; Vb, Fb = bean_pad(q, normals(fsdf, q[None, :])[0], r, r * 0.9, 0.012)
            islands.append((Vb, Fb, {'mask': pink(Vb), 'spot': z2(Vb), 'w_foot.' + sfx: np.ones(len(Vb))}))
        base, up, fw, sd = ear_frame(b, s); rings, segs = 9, 12; R = []; prm = []; H = 2 * EAR_R[2] + 0.02
        for i in range(rings):
            t = i / (rings - 1); p = base + up * (H * t); w = EAR_R[0] * 1.02 * (1 - t ** 1.7) ** 0.75 + 0.05; dep = EAR_R[1] * (0.95 - 0.5 * t) + 0.02
            ring = []
            for j in range(segs):
                a = 2 * math.pi * j / segs; cx, cy = math.cos(a), math.sin(a)
                inset = cy > 0 and 0.2 < t < 0.85 and abs(cx) < 0.75
                if cy > 0: cy *= 0.45 + 0.55 * abs(cx) ** 1.6           # soft flush inset
                ring.append(p + sd * (w * cx) + fw * (dep * cy)); prm.append(float(inset))
            R.append(ring)
        V, F = rings_mesh(R, base, base + up * (H + 0.035)); inner = A(prm + [0.0, 0.0])
        V, F, X = cull_inside(V, F, {'mask': np.column_stack([1 - inner, np.zeros(len(V)), np.zeros(len(V)), inner]),
                                     'spot': np.column_stack([(1 - inner) * (s > 0), (1 - inner) * (s < 0)]), 'w_ear.' + sfx: np.ones(len(V))}, torso, 0.04)
        islands.append((V, F, X))
    P = tail_path(b); L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    tt = np.r_[np.linspace(0, 0.85, 14), 0.85 + 0.15 * np.sin(np.linspace(0, math.pi / 2, 6))[1:]]
    P = np.column_stack([np.interp(tt * L[-1], L, P[:, k]) for k in range(3)]); rt = TAILTIP_R.mean() * 0.95
    end = 0.85; rad = lambda t: (0.125 + (rt - 0.125) * t) * (math.sqrt(max(0.0, 1 - ((t - end) / (1 - end)) ** 2)) if t > end else 1.0)
    V, F, S = ring_tube(P[:-1], lambda u: rad(tt[int(round(u * (len(tt) - 2)))]), 10, frames_up=(0, 0, 1), cap0=True, cap1=True)
    V[-1] = P[-1]; S = np.r_[np.repeat(tt[:-1], 10), 0.0, 1.0]
    bands = np.max([np.clip(0.5 + (0.05 - abs(S - c)) / 0.05, 0, 1) for c in (0.42, 0.6, 0.76, 0.9)], axis=0)
    M = np.column_stack([np.ones(len(V)), bands, np.zeros(len(V)), np.zeros(len(V))]); sp = np.column_stack([sstep(0.6, 0.7, S), sstep(0.5, 0.4, S)])
    tw = [np.clip(1 - abs(S * 4 - (k + 0.5)) / 1.0, 0, 1) for k in range(4)]; tot = sum(tw); tw = [w / tot for w in tw]
    islands.append(cull_inside(V, F, {'mask': M, 'spot': sp, **{f'w_tail.{k + 1}': tw[k] for k in range(4)}}, torso, 0.03))
    keys = set(k for _, _, x in islands for k in x if k.startswith('w_'))
    islands = [(v, f, {**{k: x.get(k, np.zeros(len(v))) for k in keys}, 'mask': x['mask'], 'spot': x['spot']}) for v, f, x in islands]
    return merge(islands)

# ---------------------------------------------------------------- face features (decals with morphs), at the Mayor's positions
EYE_A, EYE_B, EYE_X, EYE_Z = 0.049, 0.055, 0.265, 1.35          # Mayor: eyes 0.096 x 0.108 at x +-0.265, z 1.35
def face_z(b, z): return wpt(b, (0, 0, z))[2]
def head_front(b, x, z, h, sdf=None, oy=0.05):
    """Project front-view (x,z) onto a surface (the head by default) and lift by h along the normal. oy: ray start, inside it."""
    sdf = sdf or torso_sdf(b); O = np.column_stack([x, np.full(len(x), oy), z]); D = np.tile((0, -1.0, 0), (len(x), 1))
    P = O + raycast(sdf, O, D, tmax=1.2, steps=160)[:, None] * D
    return P + normals(sdf, P) * A(h)[:, None]
def disc(a, b_, rings=3, segs=18):
    V = [(0.0, 0.0)]; F = []
    for r in range(1, rings + 1):
        for j in range(segs):
            t = 2 * math.pi * j / segs; V.append((a * r / rings * math.cos(t), b_ * r / rings * math.sin(t)))
    for j in range(segs): F.append([0, 1 + j, 1 + (j + 1) % segs])
    for r in range(1, rings):
        o0, o1 = 1 + (r - 1) * segs, 1 + r * segs
        for j in range(segs): F.append([o0 + j, o1 + j, o1 + (j + 1) % segs, o0 + (j + 1) % segs])
    return A(V), F
def ribbon(points, w, round_ends=True):
    """Strip along a 2D polyline; ends taper to read as a rounded stroke (the Mayor's lines end in small balls)."""
    P = A(points, float); T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1)[:, None]; Nn = np.column_stack([-T[:, 1], T[:, 0]])
    n = len(P); V = []
    for i in range(n):
        k = 1.0 if not round_ends else (0.55 if i in (0, n - 1) else 0.85 if i in (1, n - 2) else 1.0)
        V += [P[i] + Nn[i] * w / 2 * k, P[i] - Nn[i] * w / 2 * k]
    return A(V), [[2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2] for i in range(n - 1)]
FACE_MATS = ['eye', 'eye_highlight', 'mouth', 'pink', 'blush', 'line', 'nose']
MORPHS = ['Blink_L', 'Blink_R', 'MouthOpen', 'Happy', 'Curious', 'Sleepy']
def build_face(b):
    """Face features as thin decals. Each feature: 2D layout (u,v) + height, re-projected per morph. Also carries the
    paw and toe creases (line art), which are skinned to the paw and foot bones."""
    ez, mz = face_z(b, EYE_Z), face_z(b, 1.302); feats = []; k = EYE_B / 0.075
    def add(uv, F, m, anchor, h0, morph, sdf=None, bone='head', oy=0.05):     # morph(name, uv, h0) -> (uv, h) or None
        feats.append((A(uv, float), F, m, A(anchor, float), np.broadcast_to(A(h0, float), (len(uv),)).copy(), morph, sdf, bone, oy))
    for s, side in ((1, 'L'), (-1, 'R')):           # character's left eye sits at +X
        uv, F = disc(EYE_A, EYE_B, 3, 18); r2 = (uv[:, 0] / (EYE_A * 1.25)) ** 2 + (uv[:, 1] / (EYE_B * 1.25)) ** 2
        def eye_m(n, uv, h, side=side, s=s):
            u, v = uv[:, 0], uv[:, 1]; arc = 1 - (u / EYE_A) ** 2
            if n == 'Blink_' + side: return np.column_stack([u * 1.12, v * 0.15 - 0.016 * k * arc - 0.004]), h * 0.5
            if n == 'Happy': return np.column_stack([u * 1.22, v * 0.26 + 0.034 * k * arc - 0.008]), h * 0.5
            if n == 'Sleepy': return np.column_stack([u * 1.15, v * 0.17 - 0.022 * k - 0.014 * k * (u * s / EYE_A)]), h * 0.5
            if n == 'Curious': return np.column_stack([u * 1.25, v * 1.15 + 0.006]), h
        add(uv, F, 'eye', (s * EYE_X, ez), 0.004 + 0.02 * np.clip(1 - r2, 0, 1), eye_m)
        for hx, hy, hr in ((-0.014, 0.019, 0.012), (0.016, -0.02, 0.006)):
            uv, F = disc(hr, hr, 1, 10)
            def hl_m(n, uv, h, side=side):
                u, v = uv[:, 0], uv[:, 1]
                if n in ('Blink_' + side, 'Happy', 'Sleepy'): return np.column_stack([u * 0.5, v * 0.2]), h - 0.04   # sink out of sight
                if n == 'Curious': return np.column_stack([u * 1.25, v * 1.15 + 0.006]), h
            add(uv + A((hx, hy)), F, 'eye_highlight', (s * EYE_X, ez), 0.0255, hl_m)
        uv, F = disc(0.095, 0.07, 2, 16)
        add(uv, F, 'blush', (s * 0.385, face_z(b, 1.21)), 0.002, lambda n, uv, h: (uv * 1.12, h) if n == 'Happy' else None)
        for z0, z1 in ((1.32, 1.31), (1.235, 1.2)):                              # whiskers, as on the Mayor
            t = np.linspace(0, 1, 8); pts = np.column_stack([s * (0.55 + 0.115 * t), face_z(b, z0) + (face_z(b, z1) - face_z(b, z0)) * t])
            uv, F = ribbon(pts, 0.022); add(uv, F, 'line', (0, 0), 0.007, lambda n, uv, h: None)
    sw = np.linspace(-1, 1, 25); uv, F = ribbon(np.column_stack([0.095 * sw, -0.05 * np.sin(math.pi * abs(sw)) ** 0.85]), 0.018)
    add(uv, F, 'line', (0, mz), 0.007, lambda n, uv, h: (uv * 0.55 + A((0, 0.006)), h) if n == 'Curious' else (uv * 0.75, h) if n == 'Sleepy' else None)
    unit, F = disc(1.0, 1.0, 3, 18)                  # open mouth + tongue: collapsed out of sight in the basis
    def cavity(n, uv, h):
        u, v = unit[:, 0], unit[:, 1]
        if n == 'MouthOpen': return np.column_stack([u * 0.05, v * 0.055 - 0.06]), h * 0 + 0.004
        if n == 'Happy': return np.column_stack([u * 0.07 * (1 - 0.15 * np.clip(v, 0, 1)), np.where(v > 0, v * 0.008, v * 0.052) - 0.042]), h * 0 + 0.004
        if n == 'Curious': return np.column_stack([u * 0.022, v * 0.024 - 0.045]), h * 0 + 0.004
    add(unit * 0.01 + A((0, -0.045)), F, 'mouth', (0, mz), -0.014, cavity)
    unit2, F = disc(1.0, 1.0, 2, 14)
    def tongue(n, uv, h):
        u, v = unit2[:, 0], unit2[:, 1]
        if n == 'MouthOpen': return np.column_stack([u * 0.03, v * 0.018 - 0.093]), h * 0 + 0.0055
        if n == 'Happy': return np.column_stack([u * 0.038, v * 0.017 - 0.078]), h * 0 + 0.0055
    add(unit2 * 0.01 + A((0, -0.07)), F, 'pink', (0, mz), -0.014, tongue)
    uv, F = disc(0.025, 0.016, 2, 14); uv[:, 0] *= 1 + 0.4 * uv[:, 1] / 0.016
    add(uv, F, 'nose', (0, face_z(b, 1.316)), 0.004 + 0.008 * np.clip(1 - (uv[:, 0] / 0.03) ** 2 - (uv[:, 1] / 0.02) ** 2, 0, 1), lambda n, uv, h: None)
    for s, sfx in ((1, 'L'), (-1, 'R')):             # paw and toe creases: short strokes on the front of each mitt and foot
        pc = wpt(b, mirror(PAW_C, s)); fc = wpt(b, mirror(FOOT_C, s)) + A((0, 0, 0.02)); fr = FOOT_R * A((b['sx'] ** 0.5, 1, 1))
        for dx in (-0.044, 0.044):
            uv, F = ribbon(np.column_stack([np.zeros(4), np.linspace(-0.018, 0.016, 4)]), 0.014)
            add(uv, F, 'line', (pc[0] + dx, pc[2] - 0.03), 0.004, lambda n, uv, h: None, ell_sdf(pc, PAW_R), 'paw.' + sfx, pc[1])
            uv, F = ribbon(np.column_stack([np.zeros(4), np.linspace(-0.014, 0.014, 4)]), 0.012)
            add(uv, F, 'line', (fc[0] + dx * 0.9, fc[2] - 0.0), 0.004, lambda n, uv, h: None, ell_sdf(fc, fr), 'foot.' + sfx, fc[1])
    V, F, mats, keys, bones, off = [], [], [], {n: [] for n in MORPHS}, [], 0
    for uv, f, m, anchor, h0, morph, sdf, bone, oy in feats:
        base = head_front(b, uv[:, 0] + anchor[0], uv[:, 1] + anchor[1], h0, sdf, oy); V.append(base); bones += [bone] * len(uv)
        F += [[i + off for i in face] for face in f]; mats += [FACE_MATS.index(m)] * len(f); off += len(uv)
        for n in MORPHS:
            r = morph(n, uv, h0)
            keys[n].append(base if r is None else head_front(b, r[0][:, 0] + anchor[0], r[0][:, 1] + anchor[1], r[1], sdf, oy))
    bones = A(bones)
    return np.vstack(V), F, mats, {n: np.vstack(v) for n, v in keys.items()}, {bn: (bones == bn).astype(float) for bn in set(bones.tolist())}

# ---------------------------------------------------------------- rig + sockets (one per base; the Mayor's bone names and joints)
SOCKETS = ('socket_head', 'socket_face', 'socket_neck', 'socket_back', 'socket_hip')
NECK_Z = 0.98                                   # Mayor's chest->head joint; collars and capes sit here
for _b in BASES.values(): _b['neck'] = wpt(_b, (0, 0, NECK_Z))[2]
def socket_points(b):
    t = torso_sdf(b)
    return {'socket_head': ('head', crown(b)), 'socket_face': ('head', head_front(b, A([0.0]), A([face_z(b, EYE_Z)]), A([0.0]))[0]),
            'socket_neck': ('chest', A((0, 0, b['neck']))), 'socket_back': ('chest', surface_at(t, math.pi, face_z(b, 0.85), 0.0)),
            'socket_hip': ('pelvis', wpt(b, (0, 0, 0.42)))}
def build_rig(b):
    name = 'cat_rig__' + b['name']; arm = bpy.data.armatures.new(name); rig = link(bpy.data.objects.new(name, arm))
    bpy.context.view_layer.objects.active = rig; bpy.ops.object.mode_set(mode='EDIT')
    for bname in ('root', 'pelvis', 'chest', 'head', 'ear.L', 'ear.R', 'arm.L', 'paw.L', 'arm.R', 'paw.R', 'foot.L', 'foot.R', 'tail.1', 'tail.2', 'tail.3', 'tail.4'):
        e = arm.edit_bones.new(bname); e.head = tuple(wpt(b, MBONE[bname]['head'])); e.tail = tuple(wpt(b, MBONE[bname]['tail'])); e.roll = 0
    parents = {'pelvis': 'root', 'chest': 'pelvis', 'head': 'chest', 'ear.L': 'head', 'ear.R': 'head', 'arm.L': 'chest', 'arm.R': 'chest',
               'paw.L': 'arm.L', 'paw.R': 'arm.R', 'foot.L': 'pelvis', 'foot.R': 'pelvis', 'tail.1': 'pelvis', 'tail.2': 'tail.1', 'tail.3': 'tail.2', 'tail.4': 'tail.3'}
    for child, parent in parents.items(): arm.edit_bones[child].parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    pts = socket_points(b)
    for sname, (bn, pos) in pts.items():
        e = link(bpy.data.objects.new(f'{sname}__{b["name"]}', None)); e.empty_display_size = 0.08; e.parent = rig; e.parent_type = 'BONE'; e.parent_bone = bn
        e.matrix_world = Matrix.Translation(tuple(pos))
    return rig, {k: A(v[1], float) for k, v in pts.items()}

def skin(obj, rig, weights):
    obj.parent = rig; m = obj.modifiers.new('Armature', 'ARMATURE'); m.object = rig
    for name, w in weights.items():
        g = obj.vertex_groups.new(name=name)
        for i in np.nonzero(w > 1e-4)[0]: g.add([int(i)], float(w[i]), 'REPLACE')

# ---------------------------------------------------------------- costume parts
def clear_sdf(b, arms=True):
    t = torso_sdf(b); fs = [ell_sdf(wpt(b, mirror(c, s)), r) for s in (-1, 1) for c, r in ((ARM_C, ARM_R), (PAW_C, PAW_R))] if arms else []
    def f(P):
        d = t(P)
        for g in fs: d = np.minimum(d, g(P))
        return d
    return f
def surface_at(sdf, phi, z, off, centre_y=-0.02):
    """Horizontal ray from the axis at height z, angle phi (0=front/-Y, +=character left/+X)."""
    phi, z = np.broadcast_arrays(A(phi, float), A(z, float)); shp = phi.shape; phi, z = phi.ravel(), z.ravel()
    D = np.column_stack([np.sin(phi), -np.cos(phi), np.zeros(len(phi))]); O = np.column_stack([np.zeros(len(phi)), np.full(len(phi), centre_y), z])
    P = O + (raycast(sdf, O, D, tmax=1.6, steps=160)[:, None]) * D
    return (P + D * A(off).ravel()[:, None] if np.ndim(off) else P + D * off).reshape(*shp, 3)
def grid_faces(nu, nv, wrap_u=False):
    F = []
    for i in range(nv - 1):
        for j in range(nu if wrap_u else nu - 1):
            j1 = (j + 1) % nu; F.append([i * nu + j, i * nu + j1, (i + 1) * nu + j1, (i + 1) * nu + j])
    return F
def shell(name, G, thick, mats, wrap=False):
    """Grid of outer points (nv,nu,3) -> closed solid by offsetting inward along vertex normals."""
    nv, nu, _ = G.shape; V = G.reshape(-1, 3); F = grid_faces(nu, nv, wrap)
    if not thick: return V, F                          # single surface; the material is double-sided
    me = make_mesh(name + '_tmp', V, F); me.calc_normals_split() if hasattr(me, 'calc_normals_split') else None
    Nn = A([v.normal[:] for v in me.vertices]); bpy.data.meshes.remove(me)
    radial = V * A((1, 1, 0)) + A((0, 0.02, 0))
    if (Nn * radial).sum() < 0: Nn = -Nn                 # offset toward the body, whatever the grid winding
    inner = V - Nn * thick; n = len(V); Fi = [[i + n for i in reversed(f)] for f in F]
    rim = []
    loops = [[(0, j) for j in range(nu)], [(nv - 1, j) for j in range(nu)]]
    if not wrap: loops += [[(i, 0) for i in range(nv)], [(i, nu - 1) for i in range(nv)]]
    for li, loop in enumerate(loops):
        idx = [i * nu + j for i, j in loop]; seq = idx + ([idx[0]] if wrap and li < 2 else [])
        for a, c in zip(seq[:-1], seq[1:]):
            q = [a, c, c + n, a + n]; rim.append(q if li in (0, 3) else q[::-1])
    return np.vstack([V, inner]), F + Fi + rim
def obj_from(name, V, F, mats, mat_idx=None, sharp=55):
    me = make_mesh(name, V, F, sharp_deg=sharp, mats=mats, mat_idx=mat_idx, weld=True, recalc=True)
    return link(bpy.data.objects.new(name, me))
def fix_normals(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(obj.data); bm.free()
def star_mesh(R, r, depth, points=5):
    out = [(R if k % 2 == 0 else r) * A((math.sin(k * math.pi / points), math.cos(k * math.pi / points))) for k in range(points * 2)]
    V = [(*p, 0.0) for p in out] + [(0, 0, depth), (0, 0, -depth * 0.4)]; n = len(out)
    F = [[k, (k + 1) % n, n] for k in range(n)] + [[(k + 1) % n, k, n + 1] for k in range(n)]
    return A(V), F
def place(V, origin, x_axis, y_axis, z_axis):
    return A(origin) + V[:, :1] * A(x_axis) + V[:, 1:2] * A(y_axis) + V[:, 2:3] * A(z_axis)
def combine(chunks):
    V, F, M, off = [], [], [], 0
    for v, f, m in chunks:
        V.append(A(v, float)); F += [[i + off for i in face] for face in f]; M += [m] * len(f); off += len(v)
    return np.vstack(V), F, M

def part_hat(b):
    top = crown(b)[2] - 0.035; tilt = Matrix.Rotation(math.radians(-10), 3, 'X')
    def T(V): return A([tuple(tilt @ Vector(v)) for v in V]) + A((0, 0.02, top))
    brim_prof = [(0.0, 0.0), (0.30, 0.0), (0.355, -0.018), (0.37, -0.035), (0.35, -0.045), (0.29, -0.03), (0.0, -0.025)]
    segs = 28; V, F = [], []
    for i, (r, z) in enumerate(brim_prof):
        for j in range(segs):
            a = 2 * math.pi * j / segs; V.append((r * math.cos(a), r * math.sin(a), z))
    F = grid_faces(segs, len(brim_prof), True)
    brim = (T(A(V)), F, 0)
    path = [(0, 0.0, -0.01)] + [(0.05 * sstep(0.45, 1.0, t) + 0.19 * sstep(0.62, 1.0, t) ** 1.6, 0.04 * t, 0.68 * t - 0.17 * sstep(0.7, 1.0, t) ** 2) for t in np.linspace(0.08, 1, 15)]
    rad = lambda t: 0.235 * (1 - t) ** 1.15 + 0.012
    Vc, Fc, S = ring_tube(path, rad, 18, frames_up=(0, 1, 0), cap0=True, cap1=True)
    cone = (T(Vc), Fc, 0)
    band = ring_tube([(0, 0, 0.0), (0, 0.0, 0.07)], lambda t: 0.245 - 0.025 * t + 0.008, 24, frames_up=(0, 1, 0), cap0=False, cap1=False)
    band = (T(band[0]), band[1], 1)
    tip = T(A([path[-1]]))[0]
    Vs, Fs = star_mesh(0.065, 0.028, 0.02); star = (place(Vs, tip + A((0, 0.02, -0.075)), (1, 0, 0), (0, 0, 1), (0, -1, 0)), Fs, 2)
    string = ring_tube([tip, tip + A((0, 0.012, -0.04))], 0.006, 6, cap0=False, cap1=False); string = (string[0], string[1], 1)
    return combine([brim, cone, band, star, string]), ('cloth', 'trim', 'metal')

def part_spectacles(b):
    sdf = torso_sdf(b); ez = face_z(b, EYE_Z); chunks = []; R = 0.085
    for s in (-1, 1):
        c = head_front(b, A([s * EYE_X]), A([ez]), A([0.0]))[0]; n = normals(sdf, c[None])[0]
        up = norm(A((0, 0, 1)) - n * n[2]); x = np.cross(up, n)
        ring = [c + n * 0.045 + R * (math.cos(a) * x + math.sin(a) * up) for a in np.linspace(0, 2 * math.pi, 25)[:-1]]
        Vt, Ft, _ = ring_tube(ring + [ring[0]], 0.013, 8, frames_up=n, cap0=False, cap1=False); chunks.append((Vt, Ft, 0))
        outer = c + n * 0.045 + R * x * (1 if (x[0] * s) > 0 else -1)
        temple = [outer] + list(surface_at(sdf, A([s * 0.95, s * 1.15]), A([ez + 0.02, ez + 0.03]), A([0.025, -0.03])))
        Vt, Ft, _ = ring_tube(catmull(temple, 7), 0.010, 6, cap0=True, cap1=True); chunks.append((Vt, Ft, 0))
    inner = [head_front(b, A([s * (EYE_X - R)]), A([ez + 0.015]), A([0.045]))[0] for s in (-1, 1)]
    mid = (inner[0] + inner[1]) / 2 + A((0, -0.012, 0.025))
    Vt, Ft, _ = ring_tube(catmull([inner[0], mid, inner[1]], 9), 0.011, 6, cap0=True, cap1=True); chunks.append((Vt, Ft, 0))
    return combine(chunks), ('metal',)

def part_cape(b):
    sdf = clear_sdf(b, arms=True); z0 = b['neck'] + 0.02; nv, nu = 9, 30; rows = []
    for i in range(nv):
        t = i / (nv - 1); opening = math.radians(10 + 34 * t ** 1.3)
        phis = np.linspace(opening, 2 * math.pi - opening, nu); phis = np.where(phis > math.pi, phis - 2 * math.pi, phis)
        drop = 0.36 + 0.16 * (1 - np.cos(phis)) / 2                 # shorter at the front, longer down the back
        rows.append(surface_at(sdf, phis, z0 - drop * t ** 1.05, 0.03 + 0.1 * t + 0.05 * t * t))
    G = A(rows)
    for j in range(nu): G[-1, j, 2] -= 0.022 * (0.5 + 0.5 * math.cos(j / (nu - 1) * 2 * math.pi * 7))   # soft scallops
    V, F = shell('cape', G, 0, None)
    Vh, Fh, _ = ring_tube(catmull(list(G[-1]), 48), 0.016, 6)
    Vc, Fc, _ = ring_tube(catmull(list(G[0]), 30), 0.028, 8)
    front = surface_at(torso_sdf(b), 0.0, z0 - 0.04, 0.07)
    Vs, Fs = star_mesh(0.085, 0.038, 0.03); star = place(Vs, front, (1, 0, 0), (0, 0, 1), (0, -1, 0))
    return combine([(V, F, 0), (Vh, Fh, 1), (Vc, Fc, 1), (star, Fs, 2)]), ('cloth', 'trim', 'metal')

def part_waistcoat(b):
    sdf = clear_sdf(b, arms=False); top = b['neck'] - 0.02; bot = 0.17; nv, nu = 10, 26; rows = []
    for i in range(nv):
        t = i / (nv - 1); z = top - (top - bot) * t
        opening = math.radians(34 * (1 - sstep(0.0, 0.62, t)) + 4)
        phis = np.linspace(opening, 2 * math.pi - opening, nu); phis = np.where(phis > math.pi, phis - 2 * math.pi, phis)
        rows.append(surface_at(sdf, phis, z, 0.028))
    G = A(rows)
    for j in range(nu):                                        # pointed front tips
        ph = abs(((j / (nu - 1)) * 2 - 1))
        G[-1, j, 2] -= 0.07 * sstep(0.75, 0.97, ph)
        G[-2, j, 2] -= 0.035 * sstep(0.75, 0.97, ph)
    V, F = shell('waistcoat', G, 0, None)
    chunks = [(V, F, 0)]
    for side in (0, -1):                                       # edge piping along the opening and hem
        edge = list(G[:, side]); Vt, Ft, _ = ring_tube(catmull(edge, 16), 0.014, 5); chunks.append((Vt, Ft, 1))
    Vt, Ft, _ = ring_tube(catmull(list(G[-1]), 34), 0.013, 5); chunks.append((Vt, Ft, 1))
    for s in (-1, 1):                                          # small turned collar
        lap = [surface_at(sdf, s * math.radians(a), z, 0.05) for a, z in ((38, top + 0.02), (52, top - 0.06), (40, top - 0.14))]
        Vt, Ft, _ = ring_tube(catmull(lap, 8), lambda t: 0.03 * (1 - 0.6 * t) + 0.01, 8); chunks.append((Vt, Ft, 1))
    for k, z in enumerate(np.linspace(top - 0.18, bot + 0.08, 3)):
        c = surface_at(sdf, math.radians(-6), z, 0.055); Vb, Fb, _ = ring_tube([c - A((0, -0.012, 0)), c + A((0, -0.01, 0))], 0.026, 10)
        chunks.append((Vb, Fb, 2))
    return combine(chunks), ('cloth', 'trim', 'metal')

def part_apron(b):
    sdf = clear_sdf(b, arms=False); bib_top = b['neck'] - 0.03; waist = (b['neck'] + 0.17) / 2; hem = 0.13
    nv, nu = 14, 15; rows = []
    for i in range(nv):
        t = i / (nv - 1); z = bib_top - (bib_top - hem) * t
        half = math.radians(30 + 34 * sstep(waist + 0.04, waist - 0.06, z))
        rows.append(surface_at(sdf, np.linspace(-half, half, nu), z, 0.03 + 0.02 * sstep(waist, hem, z)))
    G = A(rows); V, F = shell('apron', G, 0.018, None); chunks = [(V, F, 0)]
    ring = surface_at(sdf, np.linspace(-math.pi, math.pi, 33), waist, 0.03)
    Vt, Ft, _ = ring_tube(list(ring), 0.017, 6, cap0=False, cap1=False); chunks.append((Vt, Ft, 1))
    for s in (-1, 1):
        strap = [G[0, 0 if s < 0 else -1] + A((0, 0, -0.01))] + list(surface_at(sdf, A([s * 0.62, s * 0.9]), A([b['neck'] + 0.0, b['neck'] + 0.05]), A([0.03, -0.04])))
        Vt, Ft, _ = ring_tube(catmull(strap, 8), 0.018, 6); chunks.append((Vt, Ft, 1))
    # tool pocket + tools
    pk = [surface_at(sdf, np.linspace(-0.42, 0.18, 6), z, 0.055) for z in np.linspace(waist - 0.07, hem + 0.06, 5)]
    PK = A(pk); Vp, Fp = shell('pocket', PK, 0.012, None); chunks.append((Vp, Fp, 1))
    top_c = PK[0, 1]; n = norm(top_c - A((0, -0.02, top_c[2]))); n[2] = 0; n = norm(n)
    handle = [top_c + n * 0.015 + A((0, 0, -0.03)), top_c + n * 0.03 + A((0.015, 0, 0.11))]
    Vt, Ft, _ = ring_tube(handle, 0.016, 8); chunks.append((Vt, Ft, 2))
    head = handle[1] + A((0.0, 0, 0.0)); Vh, Fh, _ = ring_tube([head + A((-0.05, 0, 0.01)), head + A((0.05, 0, 0.0))], 0.022, 8); chunks.append((Vh, Fh, 2))
    c2 = PK[0, 4]; wr = [c2 + n * 0.012 + A((0, 0, -0.03)), c2 + n * 0.028 + A((-0.02, 0, 0.09))]
    Vt, Ft, _ = ring_tube(wr, 0.012, 8); chunks.append((Vt, Ft, 2))
    jaw = wr[1]; Vj, Fj, _ = ring_tube([jaw + A((-0.02, 0, -0.005)), jaw + A((0.0, 0, 0.03)), jaw + A((0.025, 0, 0.012))], 0.016, 8); chunks.append((Vj, Fj, 2))
    return combine(chunks), ('cloth', 'trim', 'metal')

def part_bow(b):
    sdf = torso_sdf(b); c = surface_at(sdf, 0.0, b['neck'] - 0.04, 0.035); n = norm(A((0, -1, 0.3)))
    x = A((1, 0, 0)); up = norm(A((0, 0, 1)) - n * n[2]); chunks = []; D, F, E = cube_sphere(5)
    for s in (-1, 1):
        L = (D[:, 0] * s + 1) / 2
        V = np.column_stack([s * (0.03 + L * 0.19), D[:, 1] * (0.04 + 0.03 * L), D[:, 2] * (0.045 + 0.075 * L ** 0.7)])
        V[:, 1] -= 0.02 * L                                    # lobes lean back toward the chest
        chunks.append((place(V, c, x, -n, up), F, 0))
    chunks.append((place(D * A((0.05, 0.045, 0.058)), c + n * 0.015, x, -n, up), F, 1))
    return combine(chunks), ('cloth', 'trim')

def part_satchel(b):
    sdf = clear_sdf(b, arms=False); side = surface_at(sdf, math.radians(-108), 0.30, 0.0); out = norm(A((side[0], side[1], 0)))
    centre = side + out * 0.085; D, F, E = cube_sphere(6)
    Vb = project(lambda P: np.linalg.norm(np.maximum(np.abs(P) - A((0.13, 0.03, 0.095)), 0), axis=1) - 0.045, D * 0.35, 14)
    fw = norm(np.cross((0, 0, 1), out)); bag = place(Vb, centre, fw, out, (0, 0, 1)); chunks = [(bag, F, 0)]
    flap = [[centre + out * (0.078 + 0.004 * i) + fw * x + A((0, 0, 0.14 - 0.12 * i / 4)) for x in np.linspace(-0.165, 0.165, 7)] for i in range(5)]
    Vf, Ff = shell('flap', A(flap), 0.012, None); chunks.append((Vf, Ff, 1))
    bk = centre + out * 0.098 + A((0, 0, 0.035)); Vk, Fk, _ = ring_tube([bk - out * 0.015, bk + out * 0.01], 0.026, 10); chunks.append((Vk, Fk, 2))
    angs = (-80, -35, 10, 55, 95, 140, 180, -150); zs = (0.48, 0.56, b['neck'] - 0.05, b['neck'] - 0.01, b['neck'] + 0.0, b['neck'] - 0.06, 0.55, 0.45)
    mid = surface_at(sdf, A([math.radians(a) for a in angs]), A(zs), 0.025)
    strap = [centre + A((0, 0, 0.13)) + fw * 0.12] + list(mid[1:-1]) + [centre + A((0, 0, 0.13)) - fw * 0.12]
    nrm = normals(sdf, catmull(strap, 36))
    Vs, Fs, _ = ring_tube(catmull(strap, 36), 1.0, 6, frames_up=nrm, xsec=lambda a, t: (0.008 * math.cos(a), 0.028 * math.sin(a))); chunks.append((Vs, Fs, 1))
    return combine(chunks), ('leather', 'trim', 'metal')

# Wardrobe 2. Head parts sit inside the ears: the ears' inner edges meet the head about 0.035 below the crown, so
# anything that hugs the head starts above that (brims may reach the wizard hat's 0.37). Body parts ride clear_sdf offsets.
def lathe(prof, segs, wave=None):
    """Revolve (r, z) rows about Z; wave(phi, row) scales r (pleats, ribs)."""
    V = [(r * (wave(a, i) if wave else 1) * math.cos(a), r * (wave(a, i) if wave else 1) * math.sin(a), z)
         for i, (r, z) in enumerate(prof) for a in np.linspace(0, 2 * math.pi, segs + 1)[:-1]]
    return A(V), grid_faces(segs, len(prof), True)
def ball(c, r, n=2, axes=None):
    D, F, _ = cube_sphere(n); return place(D * A(r if np.ndim(r) else (r, r, r)), c, *(axes or ((1, 0, 0), (0, 1, 0), (0, 0, 1)))), F
def head_rows(b, rows, nu, dz0=-0.03):
    """Rows of the head contour at crown+dz0, scaled about the axis by s and lifted to crown+dz: [(s, dz)] -> (nv, nu, 3)."""
    top = crown(b)[2]; C = surface_at(torso_sdf(b), np.linspace(0, 2 * math.pi, nu + 1)[:-1], top + dz0, 0.0); ax = A((0, -0.02, 0))
    return A([[ax + (p - ax) * A((s, s, 0)) + A((0, 0, top + dz)) for p in C] for s, dz in rows])
def flower(c, n, R, petals=5):
    """Flat cupped flower facing n: one petal disc + a centre bead."""
    uv, F = disc(1.0, 1.0, 2, 30); a = np.arctan2(uv[:, 1], uv[:, 0]); rho = np.linalg.norm(uv, axis=1)
    k = R * (0.55 + 0.45 * np.abs(np.cos(petals / 2 * a))) * rho; n = norm(n); u = norm(np.cross(n, (0, 0, 1)) if abs(n[2]) < 0.95 else np.cross(n, (1, 0, 0))); v = np.cross(n, u)
    V = A(c) + np.outer(k * np.cos(a), u) + np.outer(k * np.sin(a), v) + np.outer(0.35 * R * rho ** 2, n)
    Vc, Fc = ball(A(c) + n * 0.012, (0.028, 0.028, 0.016), 2, (u, v, n)); return (V, F), (Vc, Fc)

def part_crown(b):
    nu = 40; tri = lambda j: 1 - abs(((j / nu * 5 + 0.5) % 1) * 2 - 1)            # five points, one at the front
    G = head_rows(b, [(1.0, -0.03), (1.03, 0.02), (1.05, 0.07), (1.07, 0.09), (1.09, 0.11)], nu)
    for j in range(nu): G[3, j, 2] += 0.045 * tri(j); G[4, j, 2] += 0.1 * tri(j)
    V, F = shell('crown', G, 0.02, None); chunks = [(V, F, 2)]
    for j in range(0, nu, nu // 5):
        Vb, Fb = ball(G[4, j] + A((0, 0, 0.02)), 0.032); chunks.append((Vb, Fb, 2))
        p = G[1, j]; out = norm(p * A((1, 1, 0)) + A((0, 0.02, 0))); up = A((0, 0, 1)); side = np.cross(up, out)
        Vg, Fg = ball(p + out * 0.015 + A((0, 0, 0.02)), (0.04, 0.045, 0.02) if j == 0 else (0.026, 0.03, 0.015), 3 if j == 0 else 2, (side, up, out))
        chunks.append((Vg, Fg, 0 if j == 0 else 1))
    return combine(chunks), ('cloth', 'trim', 'metal')

def part_flower_crown(b):
    G = head_rows(b, [(1.06, -0.025)], 36)[0]; ring = list(G) + [G[0]]; chunks = []
    Vt, Ft, _ = ring_tube(ring, 0.022, 6, cap0=False, cap1=False); chunks.append((Vt, Ft, 2))
    for deg, R in ((0, 0.1), (34, 0.088), (-34, 0.088), (64, 0.07), (-64, 0.07), (145, 0.08), (-145, 0.08), (180, 0.075)):
        j = int(round(deg / 360 * 36)) % 36; p = G[j]; out = norm(p * A((1, 1, 0)) + A((0, 0.02, 0)))
        (Vp, Fp), (Vc, Fc) = flower(p + out * 0.02 + A((0, 0, 0.035)), out + A((0, 0, 0.45)), R); chunks += [(Vp, Fp, 0), (Vc, Fc, 1)]
    for deg in (95, -95, 115, -115):
        j = int(round(deg / 360 * 36)) % 36; p = G[j]; t = norm(G[(j + 1) % 36] - G[j - 1]); out = norm(p * A((1, 1, 0)) + A((0, 0.02, 0)))
        Vl, Fl = ball(p + out * 0.012 + A((0, 0, 0.012)), (0.07, 0.03, 0.012), 2, (t, np.cross(A((0, 0, 1)), t), (0, 0, 1))); chunks.append((Vl, Fl, 2))
    return combine(chunks), ('cloth', 'metal', 'leather')

def part_beanie(b):
    nu = 48; rib = lambda a, i: 1 + 0.035 * math.cos(a * 12)
    G = head_rows(b, [(0.98, -0.035), (1.06, -0.015), (1.08, 0.025), (1.06, 0.065), (0.98, 0.08)], nu)
    G = A([[A((0, -0.02, 0)) + (p - A((0, -0.02, 0))) * A((rib(2 * math.pi * j / nu, 0), rib(2 * math.pi * j / nu, 0), 1)) for j, p in enumerate(row)] for row in G])
    Vc, Fc = shell('cuff', G, 0, None); chunks = [(Vc, Fc, 1)]
    dome = [(0.97 * math.cos(t * math.pi / 2) ** 0.7, 0.07 + 0.25 * math.sin(t * math.pi / 2)) for t in np.linspace(0, 1, 8)]
    D = head_rows(b, dome, nu); D[-1] = D[-1].mean(axis=0)
    for i in range(len(D) - 1):
        for j in range(nu): ax = A((0, -0.02, D[i, j, 2])); D[i, j] = ax + (D[i, j] - ax) * (1 + 0.03 * math.cos(2 * math.pi * j / nu * 12))
    Vd, Fd = shell('dome', D, 0, None); chunks.append((Vd, Fd, 0))
    pc = D[-1, 0] + A((0, 0, 0.06)); Dp, Fp, _ = cube_sphere(4); lump = 1 + 0.1 * np.sin(9 * Dp[:, 0]) * np.sin(9 * Dp[:, 1]) * np.sin(9 * Dp[:, 2] + 1)
    chunks.append((pc + Dp * 0.09 * lump[:, None], Fp, 1))
    return combine(chunks), ('cloth', 'trim')

def part_straw_hat(b):
    top = crown(b)[2] - 0.03; tilt = Matrix.Rotation(math.radians(-8), 3, 'X')
    def T(V): return A([tuple(tilt @ Vector(v)) for v in V]) + A((0, 0.015, top))
    weave = lambda a, i: 1 + 0.012 * math.cos(a * 40) * (i in (2, 3))
    Vb, Fb = lathe([(0.0, 0.0), (0.24, 0.0), (0.33, -0.004), (0.375, 0.012), (0.385, 0.0), (0.365, -0.022), (0.24, -0.02), (0.0, -0.02)], 36, weave)
    Vd, Fd = lathe([(0.215, -0.01), (0.225, 0.05), (0.222, 0.1), (0.2, 0.14), (0.14, 0.165), (0.0, 0.17)], 36, lambda a, i: 1 + 0.015 * math.cos(a * 18) * (i < 3))
    Vr, Fr = lathe([(0.226, 0.005), (0.232, 0.03), (0.232, 0.062), (0.226, 0.068)], 36)
    side = T(A([(0.21, -0.1, 0.04)]))[0]; (Vp, Fp), (Vc, Fc) = flower(side, T(A([(0.6, -0.8, 0.0)]))[0] - T(A([(0, 0, 0)]))[0], 0.055)
    return combine([(T(Vb), Fb, 3), (T(Vd), Fd, 3), (T(Vr), Fr, 0), (Vp, Fp, 1), (Vc, Fc, 2)]), ('cloth', 'trim', 'metal', 'leather')

def part_chef_hat(b):
    top = crown(b)[2]; puff = lambda a, i: 1 + 0.07 * math.cos(a * 7) * math.sin(math.pi * min(i, 6) / 6)
    Vb, Fb = lathe([(0.2, -0.045), (0.212, -0.02), (0.215, 0.05), (0.212, 0.1), (0.2, 0.11)], 40)
    Vp, Fp = lathe([(0.19, 0.09), (0.24, 0.13), (0.3, 0.2), (0.315, 0.27), (0.29, 0.33), (0.22, 0.37), (0.12, 0.395), (0.0, 0.4)], 40, puff)
    off = A((0, 0.01, top)); return combine([(Vb + off, Fb, 0), (Vp + off, Fp, 0)]), ('leather',)

def lens_frame(b, sz, n_ring=28):
    """Per eye: centre, normal, up, side and a rounded-rect outline in front of it (sunglasses, monocle)."""
    sdf = torso_sdf(b); ez = face_z(b, EYE_Z); out = []
    for s in (-1, 1):
        c = head_front(b, A([s * EYE_X]), A([ez]), A([0.0]))[0]; n = normals(sdf, c[None])[0]; up = norm(A((0, 0, 1)) - n * n[2]); x = np.cross(up, n)
        a = np.linspace(0, 2 * math.pi, n_ring + 1)[:-1]; sx, sy = sz
        o = [c + n * 0.05 + x * sx * np.sign(math.cos(t)) * abs(math.cos(t)) ** 0.6 + up * sy * np.sign(math.sin(t)) * abs(math.sin(t)) ** 0.6 for t in a]
        out.append((s, c, n, up, x, o))
    return sdf, ez, out
def part_sunglasses(b):
    sdf, ez, eyes = lens_frame(b, (0.115, 0.085)); chunks = []
    for s, c, n, up, x, o in eyes:
        Vt, Ft, _ = ring_tube(o + [o[0]], 0.015, 6, frames_up=n, cap0=False, cap1=False); chunks.append((Vt, Ft, 0))
        _, F = disc(1.0, 1.0, 2, len(o)); ctr = c + n * 0.05                  # disc() rings run at the outline's angles
        L = A([ctr + n * 0.012] + [ctr + (o[j] - ctr) * f + n * 0.012 * (1 - f * f) for f in (0.5, 1.0) for j in range(len(o))]); chunks.append((L, F, 1))
        outer = o[0] if (x[0] * s) > 0 else o[len(o) // 2]
        temple = [outer] + list(surface_at(sdf, A([s * 0.95, s * 1.15]), A([ez + 0.02, ez + 0.03]), A([0.025, -0.03])))
        Vt, Ft, _ = ring_tube(catmull(temple, 7), 0.012, 6); chunks.append((Vt, Ft, 0))
    inner = [e[5][len(e[5]) // 2] if (e[4][0] * e[0]) > 0 else e[5][0] for e in eyes]
    mid = (inner[0] + inner[1]) / 2 + A((0, -0.012, 0.03))
    Vt, Ft, _ = ring_tube(catmull([inner[0], mid, inner[1]], 9), 0.013, 6); chunks.append((Vt, Ft, 0))
    return combine(chunks), ('cloth', 'leather')

def part_monocle(b):
    sdf, ez, eyes = lens_frame(b, (0.095, 0.095), 26); s, c, n, up, x, o = eyes[0]          # the character's right eye
    chunks = []; Vt, Ft, _ = ring_tube(o + [o[0]], 0.016, 8, frames_up=n, cap0=False, cap1=False); chunks.append((Vt, Ft, 0))
    d = norm(-up + x * np.sign(x[0] * s)); start = o[int(np.argmax([(p - c) @ d for p in o]))]       # outer-lower rim
    path = [start] + list(surface_at(sdf, A([s * 0.55, s * 0.8, s * 1.05]), A([ez - 0.2, ez - 0.24, ez - 0.12]), A([0.03, 0.03, 0.02])))
    P = catmull(path, 40); Vc, Fc, _ = ring_tube(P, lambda t: 0.006 + 0.005 * abs(math.sin(t * math.pi * 22)), 5); chunks.append((Vc, Fc, 0))
    return combine(chunks), ('metal',)

def part_scarf(b):
    sdf = clear_sdf(b, arms=True); t0 = torso_sdf(b); z0 = b['neck'] - 0.01
    ring = surface_at(sdf, np.linspace(-math.pi, math.pi, 33), z0, 0.065); P = catmull(list(ring), 64)
    rad = (P - A((0, -0.02, 0))) * A((1, 1, 0)); rad /= np.linalg.norm(rad, axis=1)[:, None]
    knit = lambda a, t: ((0.062 * math.cos(a)) * (1 + 0.1 * math.sin(t * 2 * math.pi * 16)), 0.088 * math.sin(a) * (1 + 0.1 * math.sin(t * 2 * math.pi * 16)))
    V, F, _ = ring_tube(P, 1.0, 8, frames_up=rad, cap0=False, cap1=False, xsec=knit); chunks = [(V, F, 0)]
    tail = catmull([surface_at(t0, 0.42, z0 - 0.02, 0.11), surface_at(t0, 0.46, z0 - 0.15, 0.075), surface_at(t0, 0.5, z0 - 0.3, 0.065), surface_at(t0, 0.55, z0 - 0.44, 0.075)], 12)
    nt = normals(t0, project(t0, tail.copy())); flat = lambda w, d: (lambda a, t: (d * math.cos(a), w * math.sin(a)))
    Vt, Ft, _ = ring_tube(tail, 1.0, 8, frames_up=nt, xsec=flat(0.09, 0.028)); chunks.append((Vt, Ft, 0))
    for i0 in (6, 9):
        Vs, Fs, _ = ring_tube(tail[i0:i0 + 2], 1.0, 8, frames_up=nt[i0:i0 + 2], cap0=False, cap1=False, xsec=flat(0.096, 0.034)); chunks.append((Vs, Fs, 1))
    T_ = norm(tail[-1] - tail[-2]); w = norm(np.cross(T_, nt[-1]))
    for k in np.linspace(-0.07, 0.07, 5):
        p = tail[-1] + w * k; Vf, Ff, _ = ring_tube([p - T_ * 0.01, p + T_ * 0.07], lambda t: 0.014 * (1 - 0.4 * t), 5); chunks.append((Vf, Ff, 1))
    return combine(chunks), ('cloth', 'trim')

def part_bell_collar(b):
    sdf = clear_sdf(b, arms=True); t0 = torso_sdf(b); z0 = b['neck'] - 0.03
    ring = surface_at(sdf, np.linspace(-math.pi, math.pi, 41), z0, 0.032)
    Vt, Ft, _ = ring_tube(list(ring), 0.032, 6, cap0=False, cap1=False); chunks = [(Vt, Ft, 0)]
    bc = surface_at(t0, 0.0, z0 - 0.1, 0.09); Vb, Fb = ball(bc, (0.075, 0.072, 0.072), 5); chunks.append((Vb, Fb, 1))
    eq = [bc + 0.074 * A((math.cos(a), math.sin(a) * 0.97, 0)) for a in np.linspace(0, 2 * math.pi, 21)]
    Ve, Fe, _ = ring_tube(eq, 0.01, 5, cap0=False, cap1=False); chunks.append((Ve, Fe, 1))
    lp = [bc + A((0, 0, 0.085)) + 0.024 * A((0, math.cos(a), math.sin(a))) for a in np.linspace(0, 2 * math.pi, 13)]
    Vl, Fl, _ = ring_tube(lp, 0.008, 5, cap0=False, cap1=False); chunks.append((Vl, Fl, 1))
    Vs, Fs = ball(bc + A((0, -0.05, -0.04)), (0.04, 0.012, 0.014), 2, ((1, 0, 0), (0, 0.6, 0.8), (0, -0.8, 0.6))); chunks.append((Vs, Fs, 2))
    return combine(chunks), ('cloth', 'metal', 'leather')

def part_bandana(b):
    sdf = clear_sdf(b, arms=True); t0 = torso_sdf(b); z0 = b['neck'] - 0.01; nv, nu = 8, 17; rows = []
    for i in range(nv):
        t = i / (nv - 1); half = math.radians(66 * (1 - t) ** 0.9 + 0.3)
        rows.append(surface_at(sdf, np.linspace(-half, half, nu), z0 - 0.36 * t, 0.034 + 0.022 * t))
    G = A(rows); V, F = shell('bandana', G, 0, None); chunks = [(V, F, 0)]
    ring = surface_at(sdf, np.linspace(-math.pi, math.pi, 41), z0 + 0.01, 0.036)
    Vt, Ft, _ = ring_tube(list(ring), 0.036, 6, cap0=False, cap1=False); chunks.append((Vt, Ft, 0))
    back = surface_at(t0, math.pi, z0, 0.07)
    for s in (-1, 1):
        Vk, Fk = ball(back + A((s * 0.06, 0.0, 0.0)), (0.07, 0.035, 0.05), 3); chunks.append((Vk, Fk, 0))
        Vk, Fk = ball(back + A((s * 0.05, 0.02, -0.09)), (0.03, 0.02, 0.07), 2, ((math.cos(0.3 * s), 0, math.sin(0.3 * s)), (0, 1, 0), (-math.sin(0.3 * s), 0, math.cos(0.3 * s)))); chunks.append((Vk, Fk, 0))
    Vk, Fk = ball(back + A((0, 0.015, 0)), 0.035, 2); chunks.append((Vk, Fk, 0))
    for i, j in ((1, 4), (1, 12), (2, 8), (3, 5), (3, 11), (4, 8), (5, 7), (5, 9)):
        c = G[i, j]; Vd, Fd = bean_pad(c, normals(t0, c[None])[0], 0.026, 0.026, 0.006); chunks.append((Vd, Fd, 1))
    return combine(chunks), ('cloth', 'trim')

def part_backpack(b):
    sdf = clear_sdf(b, arms=False); arm_sdf = clear_sdf(b, arms=True); zc = socket_points(b)['socket_back'][1][2] - 0.1
    bk = surface_at(sdf, math.pi, zc, 0.0); out = norm(normals(torso_sdf(b), bk[None])[0] * A((1, 1, 0))); side = norm(np.cross(out, (0, 0, 1)))
    box = lambda h, r: (lambda P: np.linalg.norm(np.maximum(np.abs(P) - A(h), 0), axis=1) - r)
    D, F, _ = cube_sphere(6); Vb = project(box((0.24, 0.07, 0.26), 0.08), D * 0.45, 14); centre = bk + out * 0.145
    chunks = [(place(Vb, centre, side, out, (0, 0, 1)), F, 0)]
    D5, F5, _ = cube_sphere(5); Vp = project(box((0.15, 0.02, 0.08), 0.04), D5 * 0.25, 14)
    pc = centre + out * 0.15 + A((0, 0, -0.11)); chunks.append((place(Vp, pc, side, out, (0, 0, 1)), F5, 1))
    arc = [A((0.07, 0.26)) + 0.095 * A((math.sin(t), math.cos(t))) for t in np.linspace(-0.6, math.pi / 2, 5)] + [A((0.165, 0.18)), A((0.165, 0.1))]
    flap = [[centre + out * o_ + side * x + A((0, 0, z_)) for x in np.linspace(-0.25, 0.25, 7)] for o_, z_ in arc]
    Vf, Ff = shell('flap', A(flap), 0.014, None); chunks.append((Vf, Ff, 1))
    for s in (-1, 1):
        Vk, Fk, _ = ring_tube([pc + side * s * 0.08 + out * 0.055 + A((0, 0, 0.02)), pc + side * s * 0.08 + out * 0.075 + A((0, 0, 0.02))], 0.022, 8); chunks.append((Vk, Fk, 2))
        top = centre + side * s * 0.16 + A((0, 0, 0.32)); bot = centre + side * s * 0.22 + A((0, 0, -0.24))
        mid = surface_at(arm_sdf, A([s * math.radians(a) for a in (140, 112, 96, 100, 128)]), A([b['neck'] + 0.02, b['neck'] - 0.03, b['neck'] - 0.2, zc - 0.2, zc - 0.25]), 0.02)
        strap = catmull([top] + list(mid) + [bot], 28); nrm = normals(arm_sdf, strap)
        Vs, Fs, _ = ring_tube(strap, 1.0, 6, frames_up=nrm, xsec=lambda a, t: (0.012 * math.cos(a), 0.032 * math.sin(a))); chunks.append((Vs, Fs, 1))
    hl = [centre + A((0, 0, 0.35)) + side * 0.06 * math.cos(a) + A((0, 0, 0.06 * math.sin(a))) for a in np.linspace(0, math.pi, 8)]
    Vh, Fh, _ = ring_tube(hl, 0.014, 6); chunks.append((Vh, Fh, 1))
    return combine(chunks), ('cloth', 'trim', 'metal')

def part_fairy_wings(b):
    t0 = torso_sdf(b); zr = socket_points(b)['socket_back'][1][2] + 0.1; root = surface_at(t0, math.pi, zr, 0.05); chunks = []
    for s in (-1, 1):
        e1 = norm(A((s, 0.55, 0))); e2 = A((0, 0, 1.0)); n = np.cross(e1, e2); n = n if n[1] > 0 else -n
        for (cx, cy), (ra, rb), rot in (((0.36, 0.2), (0.36, 0.2), 32), ((0.24, -0.13), (0.24, 0.12), -38)):
            r = math.radians(rot); M = A(((math.cos(r), -math.sin(r)), (math.sin(r), math.cos(r))))
            ra, rb, cx, cy = ra * 1.35, rb * 1.35, cx * 1.35, cy * 1.35; uv, F = disc(ra, rb, 3, 24); pq = uv @ M.T + A((cx, cy)) * 0.98
            V = root + np.outer(pq[:, 0], e1) + np.outer(pq[:, 1], e2) + np.outer(0.08 * (pq[:, 0] / 0.9) ** 2, n); chunks.append((V, F, 0))
            rim = [root + e1 * p + e2 * q + n * 0.08 * (p / 0.9) ** 2 for p, q in (A([(ra * math.cos(a), rb * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 25)]) @ M.T + A((cx, cy)) * 0.98)]
            Vt, Ft, _ = ring_tube(catmull(rim, 32), 0.013, 5, cap0=False, cap1=False); chunks.append((Vt, Ft, 1))
    Vn, Fn = ball(root, (0.07, 0.06, 0.085), 3); chunks.append((Vn, Fn, 1))
    return combine(chunks), ('cloth', 'trim')

def part_tutu(b):
    t0 = torso_sdf(b); sdf = clear_sdf(b, arms=True); P = tail_path(b); k = int(np.argmax(t0(P) > 0)); tail = math.atan2(P[k + 2, 0], -P[k + 2, 1])
    gap = math.radians(26); phis = np.linspace(tail + gap, tail + 2 * math.pi - gap, 56); chunks = []
    zw = lambda z: wpt(b, (0, 0, z))[2]
    for layer, (drop, reach, phase, slot) in enumerate(((0.17, 0.2, 0.0, 1), (0.1, 0.26, math.pi, 0))):
        rows = []
        for i, t in enumerate(np.linspace(0, 1, 5)):
            row = surface_at(sdf, phis, zw(0.34 - drop * t ** 1.1), 0.03 + reach * t + 0.035 * t * np.sin(phis * 15 + phase))
            row[:, 2] += 0.022 * t * np.cos(phis * 15 + phase); rows.append(row)
        V, F = shell('tutu', A(rows), 0, None); chunks.append((V, F, slot))
    band = surface_at(sdf, phis, zw(0.345), 0.035); Vt, Ft, _ = ring_tube(list(band), 0.032, 6); chunks.append((Vt, Ft, 0))
    return combine(chunks), ('cloth', 'trim')

PARTS = {
    'wizard_hat': (part_hat, 'socket_head', 'head', {'cloth': '#7d5a9e', 'trim': '#e0b44f', 'metal': '#f2cf63'}),
    'spectacles': (part_spectacles, 'socket_face', 'head', {'metal': '#d9a640'}),
    'cape':       (part_cape, 'socket_neck', 'body', {'cloth': '#5f9e9a', 'trim': '#e0b44f', 'metal': '#f2cf63'}),
    'apron':      (part_apron, 'socket_hip', 'body', {'cloth': '#5b7fb5', 'trim': '#3f5d8a', 'metal': '#b9b4ad'}),
    'waistcoat':  (part_waistcoat, 'socket_hip', 'body', {'cloth': '#8a8f4e', 'trim': '#5d6233', 'metal': '#e0b44f'}),
    'neck_bow':   (part_bow, 'socket_neck', 'body', {'cloth': '#5a3a6b', 'trim': '#47294f'}),
    'satchel':    (part_satchel, 'socket_back', 'body', {'leather': '#8a5a3c', 'trim': '#6b4329', 'metal': '#e0b44f'}),
    # metal and leather keep these colours in game; cloth and trim take the cat's (catalog `cloth` can reroute cloth)
    'crown':        (part_crown, 'socket_head', 'head', {'cloth': '#c0392b', 'trim': '#4f7582', 'metal': '#f2cf63'}),
    'flower_crown': (part_flower_crown, 'socket_head', 'head', {'cloth': '#e89ab0', 'trim': '#f4f1ea', 'metal': '#f2cf63', 'leather': '#7aa35a'}),
    'knit_beanie':  (part_beanie, 'socket_head', 'head', {'cloth': '#c46e4f', 'trim': '#f4f1ea'}),
    'straw_hat':    (part_straw_hat, 'socket_head', 'head', {'cloth': '#5b7fb5', 'trim': '#f4f1ea', 'metal': '#f2cf63', 'leather': '#e3c27a'}),
    'chef_hat':     (part_chef_hat, 'socket_head', 'head', {'leather': '#f7f3ea'}),
    'sunglasses':   (part_sunglasses, 'socket_face', 'head', {'cloth': '#4a3b36', 'leather': '#2b2a33'}),
    'monocle':      (part_monocle, 'socket_face', 'head', {'metal': '#d9a640'}),
    'knit_scarf':   (part_scarf, 'socket_neck', 'body', {'cloth': '#9c5b6e', 'trim': '#f4f1ea'}),
    'bell_collar':  (part_bell_collar, 'socket_neck', 'body', {'cloth': '#c0392b', 'metal': '#f2cf63', 'leather': '#5a4237'}),
    'bandana':      (part_bandana, 'socket_neck', 'body', {'cloth': '#c46e4f', 'trim': '#f4f1ea'}),
    'backpack':     (part_backpack, 'socket_back', 'body', {'cloth': '#4f7a5a', 'trim': '#8e4a33', 'metal': '#e0b44f'}),
    'fairy_wings':  (part_fairy_wings, 'socket_back', 'body', {'cloth': '#b9dfe6', 'trim': '#f4f1ea'}),
    'tutu':         (part_tutu, 'socket_hip', 'body', {'cloth': '#e89ab0', 'trim': '#f4f1ea'}),
}

# ---------------------------------------------------------------- build
def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    face_mats = {n: mat(n, c, r, 0, d) for n, c, r, d in (('eye', '#231d18', 0.45, True), ('eye_highlight', '#ffffff', 0.3, True),
                                                           ('mouth', '#5c2a2c', 0.7, True), ('pink', '#e89a98', 0.6, True), ('blush', '#f5c4a6', 0.9, True),
                                                           ('line', '#231d18', 0.45, True), ('nose', '#b87655', 0.65, True))}
    out = {'bases': {}, 'faces': {}, 'parts': {}, 'sockets': {}, 'rigs': {}}; ears = {}
    def fit(pname, name, V):
        """Fit report: part vertices buried in the torso, and the closest part vertex to an ear."""
        t = kdtree.KDTree(len(ears[name])); [t.insert(v, i) for i, v in enumerate(ears[name])]; t.balance()
        print(f'FIT {pname:13s} {name:6s} inside={int((torso_sdf(BASES[name])(V) < -0.005).sum()):4d}/{len(V)} ear_gap={min(t.find(v)[2] for v in V):.3f}')
    for name, b in BASES.items():
        rig, sockets = build_rig(b); out['rigs'][name] = rig; out['sockets'][name] = sockets
        V, F, X = build_body(b)
        fur = mat('fur', '#f2a14f', 0.7); me = make_mesh('base_' + name, V, F, mats=[fur], recalc=True)
        a = me.attributes.new('_MASK', 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', np.clip(X['mask'], 0, 1).astype(np.float32).ravel())
        s = me.attributes.new('_SPOT', 'FLOAT2', 'POINT'); s.data.foreach_set('vector', np.clip(X['spot'], 0, 1).astype(np.float32).ravel())
        ob = link(bpy.data.objects.new('base_' + name, me))
        skin(ob, rig, {k[2:]: v for k, v in X.items() if k.startswith('w_')}); out['bases'][name] = ob
        Vf, Ff, Mf, keys, fweights = build_face(b)
        me = make_mesh('face__' + name, Vf, Ff, mats=[face_mats[n] for n in FACE_MATS], mat_idx=Mf)
        fo = link(bpy.data.objects.new('face__' + name, me)); fo.shape_key_add(name='Basis')
        for kn, kv in keys.items():
            k = fo.shape_key_add(name=kn); k.data.foreach_set('co', kv.astype(np.float32).ravel())
        skin(fo, rig, fweights); out['faces'][name] = fo
        ears[name] = V[(X['w_ear.L'] + X['w_ear.R']) > 0.5]
    out['part_info'] = {p: (sock, colors) for p, (_, sock, _, colors) in PARTS.items()}
    for pname, (fn, sock, kind, colors) in PARTS.items():
        shared = None
        for name, b in BASES.items():
            if kind == 'head' and shared is not None:     # same head on every base, socket moves with it: one mesh
                out['parts'][(pname, name)] = link(bpy.data.objects.new(f'part_{pname}__{name}', shared))
                fit(pname, name, Vs - out['sockets']['bean'][sock] + out['sockets'][name][sock]); continue
            (V, F, M), slots = fn(b); Vs = V; fit(pname, name, V)
            ms = [mat(sl, colors[sl], 0.75 if sl != 'metal' else 0.35, 0.6 if sl == 'metal' else 0, sl in ('cloth', 'leather')) for sl in slots]
            ob = obj_from(f'part_{pname}__{name}', V - out['sockets'][name][sock], F, ms, M)
            if kind == 'head': shared = ob.data
            out['parts'][(pname, name)] = ob
    return out

def strip_suffixes(path):
    """Blender appends .001 to duplicate datablock names; the kit's runtime contract wants the plain names."""
    data = bytearray(open(path, 'rb').read()); jlen = struct.unpack_from('<I', data, 12)[0]
    j = json.loads(data[20:20 + jlen]); rest = data[20 + jlen:]
    for key in ('materials', 'meshes'):
        for m in j.get(key, []): m['name'] = re.sub(r'\.\d{3}$', '', m.get('name', ''))
    for n in j.get('nodes', []): n['name'] = re.sub(r'^(socket_\w+?)__\w+$', r'\1', n.get('name', ''))
    js = json.dumps(j, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    body = struct.pack('<II', len(js), 0x4E4F534A) + js + rest
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)

def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_attributes=True, export_vertex_color='NONE',
                              export_animations=False, export_extras=False, export_yup=True, export_skins=True,
                              export_morph=True, export_morph_normal=False, export_try_sparse_sk=True, export_cameras=False,
                              export_lights=False, export_texcoords=False, export_materials='EXPORT')
    strip_suffixes(path); print('EXPORTED', path, os.path.getsize(path), 'bytes')

if __name__ == '__main__':
    kit = build()
    export(OUT)
    if RENDER:
        sys.dont_write_bytecode = True; sys.path.insert(0, os.path.dirname(__file__))
        import render_cat_kit; render_cat_kit.render_all(kit, BASES, RENDER, MAYOR, arg('--only'))
