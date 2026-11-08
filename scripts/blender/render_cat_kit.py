"""Preview sheets for the cat kit (docs/cat-kit/*.png). Called by build_cat_kit.py --render DIR after export,
so nothing created here can leak into the GLB."""
import bpy, math, os
from mathutils import Vector, Matrix

FUR = {'cream': '#f3e3c3', 'peach': '#f2c2a0', 'orange': '#eba264', 'grey': '#aaa6a6', 'brown': '#8a6248', 'white': '#fbf6ee', 'dark': '#4a3b36'}
LOOKS = {   # fur, patch(R), stripe(G), spotA, spotB, cream(B)   (None = channel off; pink(A) is always on)
    'solid_cream':  ('#f3e3c3', None, None, None, None, '#fbf3e6'),
    'orange_tabby': ('#eba264', None, '#c4713a', None, None, '#fbeedd'),
    'grey_tuxedo':  ('#fbf6ee', '#9c9898', None, None, None, '#fbf6ee'),
    'peach':        ('#f2c2a0', None, None, None, None, '#fbeee2'),
    'calico':       ('#fbf6ee', None, None, '#e8955a', '#5a4740', '#fbf6ee'),
    'black_tuxedo': ('#fbf6ee', '#3d3433', None, None, None, '#fbf6ee'),
    'brown_tabby':  ('#b08866', None, '#6e4c36', None, None, '#f3e3c3'),
    'grey_solid':   ('#aaa6a6', None, None, None, None, '#ecebe8'),
    'mayor':        ('#f2a14f', None, '#e18e3f', None, None, '#fadebf'),   # the Mayor's measured paint
}
PINK = '#f2b9a2'
ROLES = [  # label, base, look, [(part, {slot: colour})]
    ('Mayor', 'bean', 'mayor', [('cape', {'cloth': '#4f7582', 'trim': '#e8b354', 'metal': '#e8b354'})], {}),
    ('Scholar', 'bean', 'solid_cream', [('cape', {'cloth': '#7d5a9e', 'trim': '#e0b44f', 'metal': '#f2cf63'}), ('wizard_hat', {'cloth': '#7d5a9e', 'trim': '#e0b44f', 'metal': '#f2cf63'})], {}),
    ('Banker', 'sprout', 'grey_tuxedo', [('waistcoat', {'cloth': '#8a8f4e', 'trim': '#5d6233', 'metal': '#e0b44f'}), ('spectacles', {'metal': '#d9a640'})], {}),
    ('Builder', 'puff', 'peach', [('apron', {'cloth': '#5b7fb5', 'trim': '#3f5d8a', 'metal': '#b9b4ad'})], {'Happy': 1}),
    ('Merchant', 'sprout', 'calico', [('apron', {'cloth': '#c46e4f', 'trim': '#8e4a33', 'metal': '#b9b4ad'}), ('satchel', {'leather': '#8a5a3c', 'trim': '#6b4329', 'metal': '#e0b44f'})], {}),
    ('Critic', 'puff', 'solid_cream', [('waistcoat', {'cloth': '#d9a640', 'trim': '#a87a26', 'metal': '#7a5a2a'}), ('neck_bow', {'cloth': '#5a3a6b', 'trim': '#47294f'})], {'Curious': 1}),
]
OUTFITS = [  # look, parts (colours from the build's PARTS), worn on every base: covers the second wardrobe
    ('orange_tabby', ['crown', 'monocle', 'bell_collar']), ('calico', ['flower_crown', 'fairy_wings', 'tutu']),
    ('grey_tuxedo', ['knit_beanie', 'knit_scarf', 'backpack']), ('peach', ['straw_hat', 'sunglasses', 'bandana']),
    ('solid_cream', ['chef_hat', 'neck_bow', 'apron']),
]

def lin(h): return tuple((int(h[i:i + 2], 16) / 255) ** 2.2 for i in (1, 3, 5)) + (1.0,)
_mats = {}
def flat(hexc, rough=0.75, metal=0.0):
    key = (hexc, rough, metal)
    if key not in _mats:
        m = bpy.data.materials.new('r_' + hexc); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = lin(hexc); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
        _mats[key] = m
    return _mats[key]
def fur_material(look):
    """Mirrors the runtime recolour: fur -> patch(R) -> stripe(G) -> spot -> cream(B) -> pink(A)."""
    fur, patch, stripe, spot_a, spot_b, cream = LOOKS[look]
    m = bpy.data.materials.new('r_fur_' + look); m.use_nodes = True; nt = m.node_tree; N = nt.nodes; L = nt.links
    bsdf = N['Principled BSDF']; bsdf.inputs['Roughness'].default_value = 0.85
    att = N.new('ShaderNodeAttribute'); att.attribute_type = 'GEOMETRY'; att.attribute_name = '_MASK'
    spt = N.new('ShaderNodeAttribute'); spt.attribute_type = 'GEOMETRY'; spt.attribute_name = '_SPOT'
    sep = N.new('ShaderNodeSeparateColor'); L.new(att.outputs['Color'], sep.inputs['Color'])
    sxy = N.new('ShaderNodeSeparateXYZ'); L.new(spt.outputs['Vector'], sxy.inputs['Vector'])
    prev = None
    def sharp(socket, lo, hi):
        mr = N.new('ShaderNodeMapRange'); mr.inputs['From Min'].default_value = lo; mr.inputs['From Max'].default_value = hi
        mr.interpolation_type = 'SMOOTHSTEP'; L.new(socket, mr.inputs['Value']); return mr.outputs['Result']
    def mix(colour, fac):
        nonlocal prev
        n = N.new('ShaderNodeMix'); n.data_type = 'RGBA'; n.blend_type = 'MIX'
        if prev is None: n.inputs[6].default_value = lin(fur)
        else: L.new(prev, n.inputs[6])
        n.inputs[7].default_value = lin(colour); L.new(fac, n.inputs['Factor']); prev = n.outputs[2]
    if patch: mix(patch, sharp(sep.outputs['Red'], 0.15, 0.85))
    if stripe: mix(stripe, sharp(sep.outputs['Green'], 0.3, 0.7))
    if spot_a: mix(spot_a, sharp(sxy.outputs['X'], 0.15, 0.85))
    if spot_b: mix(spot_b, sharp(sxy.outputs['Y'], 0.15, 0.85))
    mix(cream, sharp(sep.outputs['Blue'], 0.15, 0.85)); mix(PINK, att.outputs['Alpha'])
    L.new(prev, bsdf.inputs['Base Color']); return m

def setup_scene(name, res, bg='#efe6d6'):
    sc = bpy.data.scenes.new(name); bpy.context.window.scene = sc if bpy.context.window else None
    sc.render.engine = 'BLENDER_EEVEE_NEXT'; sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = 'Standard'; sc.eevee.taa_render_samples = 48
    w = bpy.data.worlds.new(name); w.use_nodes = True; nt = w.node_tree; bgn = nt.nodes['Background']
    bgn.inputs[0].default_value = lin(bg); bgn.inputs[1].default_value = 0.62; sc.world = w
    # camera sees a brighter backdrop than the ambient light the cats receive
    cam_bg = nt.nodes.new('ShaderNodeBackground'); cam_bg.inputs[0].default_value = lin(bg); cam_bg.inputs[1].default_value = 1.0
    lp = nt.nodes.new('ShaderNodeLightPath'); mx = nt.nodes.new('ShaderNodeMixShader'); out = nt.nodes['World Output']
    nt.links.new(lp.outputs['Is Camera Ray'], mx.inputs[0]); nt.links.new(bgn.outputs[0], mx.inputs[1]); nt.links.new(cam_bg.outputs[0], mx.inputs[2]); nt.links.new(mx.outputs[0], out.inputs[0])
    sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN')); sun.data.energy = 2.5; sun.data.angle = math.radians(12)
    sun.rotation_euler = (math.radians(48), 0, math.radians(-28)); sc.collection.objects.link(sun)
    rim = bpy.data.objects.new('rim', bpy.data.lights.new('rim', 'SUN')); rim.data.energy = 0.9
    rim.rotation_euler = (math.radians(-60), 0, math.radians(160)); sc.collection.objects.link(rim)
    return sc
def camera(sc, loc, target, ortho=None, lens=50):
    c = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(c)
    if ortho: c.data.type = 'ORTHO'; c.data.ortho_scale = ortho
    else: c.data.lens = lens
    c.location = loc; c.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler(); sc.camera = c
    return c
def label(sc, text, loc, size=0.16, rotz=0):
    cu = bpy.data.curves.new('t', 'FONT'); cu.body = text; cu.align_x = 'CENTER'; cu.size = size
    o = bpy.data.objects.new('t', cu); o.location = loc; o.rotation_euler = (math.radians(90), 0, rotz)
    o.data.materials.append(flat('#5a4237', 0.9)); sc.collection.objects.link(o); return o
def holder(sc, loc, rotz=0):
    h = bpy.data.objects.new('h', None); h.location = loc; h.rotation_euler = (0, 0, rotz); sc.collection.objects.link(h); return h

def place_cat(sc, kit, base, loc, look, parts=(), expr=None, rotz=0, pose=None, rig=None):
    h = holder(sc, loc, rotz); arm_obj = None; rig = kit['rigs'][base]
    if pose:
        arm_obj = rig.copy(); arm_obj.data = rig.data.copy(); sc.collection.objects.link(arm_obj); arm_obj.parent = h
        for bone, rot in pose.items():
            pb = arm_obj.pose.bones[bone]; pb.rotation_mode = 'XYZ'
            # rotate in model space about the bone head, like cat-animation.js bonePose (world-frame rotation)
            # rot is a three.js Euler (glTF axes): X=X, Y=Blender Z, Z=Blender -Y
            R = Matrix.Rotation(rot[0], 4, 'X') @ Matrix.Rotation(rot[1], 4, 'Z') @ Matrix.Rotation(-rot[2], 4, 'Y')
            rest = arm_obj.data.bones[bone].matrix_local; head = rest.translation.copy()
            world = Matrix.Translation(head) @ R @ Matrix.Translation(-head) @ rest
            pb.matrix = world
    for src in (kit['bases'][base], kit['faces'][base]):
        o = src.copy(); o.data = src.data.copy() if src is kit['faces'][base] else src.data
        sc.collection.objects.link(o); o.parent = h; o.matrix_parent_inverse = Matrix.Identity(4); o.matrix_basis = Matrix.Identity(4)
        for m in o.modifiers:
            if m.type == 'ARMATURE': m.object = arm_obj or rig
        if src is kit['bases'][base]:
            o.material_slots[0].link = 'OBJECT'; o.material_slots[0].material = fur_material(look)
        elif expr and o.data.shape_keys:
            for k, v in expr.items(): o.data.shape_keys.key_blocks[k].value = v
    for pname, colours in parts:
        src = kit['parts'][(pname, base)]; o = src.copy(); sc.collection.objects.link(o); o.parent = h
        o.matrix_parent_inverse = Matrix.Identity(4); o.matrix_basis = Matrix.Translation(Vector(kit['sockets'][base][kit['part_info'][pname][0]])) @ src.matrix_basis
        for slot in o.material_slots:
            nm = slot.material.name.split('.')[0]; slot.link = 'OBJECT'
            slot.material = flat(colours.get(nm, '#999999'), 0.4 if nm == 'metal' else 0.75, 0.6 if nm == 'metal' else 0)
    return h

def render(sc, path):
    sc.render.filepath = path; bpy.context.window_manager  # noqa
    win = bpy.context.window
    if win: win.scene = sc
    bpy.ops.render.render(write_still=True, scene=sc.name); print('RENDERED', path)

def import_mayor(sc, loc, rotz, scale=1.0):
    h = holder(sc, loc, rotz); before = set(bpy.data.objects)
    if bpy.context.window: bpy.context.window.scene = sc
    bpy.ops.import_scene.gltf(filepath=MAYOR_PATH)
    for o in [o for o in bpy.data.objects if o not in before]:
        if o.name.startswith('Icosphere'): bpy.data.objects.remove(o); continue
        if o.name not in sc.collection.objects: sc.collection.objects.link(o)
        if o.parent is None: o.parent = h; o.scale = (scale, scale, scale)
    return h
def render_mayor_match(kit, outdir):
    """mayor.glb next to the kit Bean in the Mayor's colours, front and three-quarter."""
    sc = setup_scene('mayor-match', (2000, 860)); cape = [('cape', {'cloth': '#4f7582', 'trim': '#e8b354', 'metal': '#e8b354'})]
    for row, (x0, rot, tag) in enumerate(((-5.3, 0, 'front'), (1.5, -38, '3/4'))):
        r = math.radians(rot); import_mayor(sc, (x0, 0, 0), r); label(sc, 'mayor.glb ' + tag, (x0, -1.3, -0.35), 0.15)
        place_cat(sc, kit, 'bean', (x0 + 2.2, 0, 0), 'mayor', rotz=r); label(sc, 'kit Bean ' + tag, (x0 + 2.2, -1.3, -0.35), 0.15)
        if row == 0: place_cat(sc, kit, 'bean', (x0 + 4.4, 0, 0), 'mayor', cape, rotz=r); label(sc, 'kit Bean + cape', (x0 + 4.4, -1.3, -0.35), 0.15)
        else: place_cat(sc, kit, 'bean', (x0 + 4.4, 0, 0), 'mayor', cape, rotz=r); label(sc, 'kit Bean + cape 3/4', (x0 + 4.4, -1.3, -0.35), 0.15)
    camera(sc, (0.2, -14, 1.2), (0.2, 0, 0.9), ortho=13.6); render(sc, os.path.join(outdir, 'mayor-match.png'))
MAYOR_PATH = None
def render_all(kit, BASES, outdir, mayor_path, only=None):
    global MAYOR_PATH; MAYOR_PATH = mayor_path; rig = None
    os.makedirs(outdir, exist_ok=True)
    if only in (None, 'mayor-match'): render_mayor_match(kit, outdir)
    if only == 'mayor-match': return
    for o in list(kit['bases'].values()) + list(kit['faces'].values()) + list(kit['parts'].values()): o.hide_render = False
    render_parts(kit, outdir)
    if only == 'parts': return
    # bases: front row + side row
    sc = setup_scene('bases', (1800, 1000))
    for i, base in enumerate(('bean', 'puff', 'sprout')):
        place_cat(sc, kit, base, (-3.6 + i * 1.6, 0, 0), 'orange_tabby' if i == 0 else 'grey_tuxedo' if i == 1 else 'calico', rig=rig)
        place_cat(sc, kit, base, (1.2 + i * 1.6, 0, 0), 'orange_tabby' if i == 0 else 'grey_tuxedo' if i == 1 else 'calico', rotz=math.radians(-90), rig=rig)
        label(sc, base.capitalize(), (-3.6 + i * 1.6, -0.6, -0.32)); label(sc, base.capitalize() + ' side', (1.2 + i * 1.6, -0.6, -0.32))
    camera(sc, (0.4, -12, 1.0), (0.4, 0, 0.95), ortho=10.6); render(sc, os.path.join(outdir, 'bases.png'))
    # markings on one base
    sc = setup_scene('markings', (1800, 700))
    for i, look in enumerate(('solid_cream', 'black_tuxedo', 'brown_tabby', 'orange_tabby', 'calico', 'grey_solid')):
        place_cat(sc, kit, 'bean', (-4.0 + i * 1.6, 0, 0), look, rotz=math.radians(-20), rig=rig)
        label(sc, look.replace('_', ' '), (-4.0 + i * 1.6, -0.6, -0.3), 0.14)
    camera(sc, (0, -13, 1.6), (0, 0, 0.9), ortho=10.2); render(sc, os.path.join(outdir, 'markings.png'))
    # roles + the existing Mayor GLB
    sc = setup_scene('roles', (2000, 900))
    for i, (name, base, look, parts, expr) in enumerate(ROLES):
        place_cat(sc, kit, base, (-3.6 + i * 1.75, 0, 0), look, parts, expr, rotz=math.radians(-12), rig=rig)
        label(sc, name + (' (kit)' if name == 'Mayor' else ''), (-3.6 + i * 1.75, -0.8, -0.3), 0.17)
    before = set(bpy.data.objects)
    win = bpy.context.window
    if win: win.scene = sc
    bpy.ops.import_scene.gltf(filepath=mayor_path)
    imported = [o for o in bpy.data.objects if o not in before]
    h = holder(sc, (-5.5, 0, 0), math.radians(-12)); s = 1.75 / 1.915
    for o in imported:
        if o.name.startswith('Icosphere'): bpy.data.objects.remove(o); continue
        if o.name not in sc.collection.objects: sc.collection.objects.link(o)
        if o.parent is None: o.parent = h; o.scale = (s, s, s)
    label(sc, 'mayor.glb (current)', (-5.5, -0.8, -0.3), 0.15)
    camera(sc, (0, -16, 2.2), (0, 0, 0.95), ortho=13.2); render(sc, os.path.join(outdir, 'roles.png'))
    # expressions
    sc = setup_scene('expressions', (1800, 650))
    exprs = [('neutral', {}), ('Happy', {'Happy': 1}), ('Curious', {'Curious': 1}), ('Sleepy', {'Sleepy': 1}),
             ('Blink', {'Blink_L': 1, 'Blink_R': 1}), ('MouthOpen (talk)', {'MouthOpen': 1})]
    for i, (n, e) in enumerate(exprs):
        place_cat(sc, kit, 'bean', (-5.5 + i * 2.2, 0, -0.75), 'mayor', expr=e, rig=rig); label(sc, n, (-5.5 + i * 2.2, -1.2, -1.0), 0.15)
    camera(sc, (0, -12, 0.5), (0, 0, 0.35), ortho=13.6); render(sc, os.path.join(outdir, 'expressions.png'))
    # paws: rest vs posed (talk arm raise -0.94, walk toe lift -0.58), low angle to show pads
    sc = setup_scene('paws', (1600, 800))
    place_cat(sc, kit, 'bean', (-1.2, 0, 0), 'peach', rotz=math.radians(-25), rig=rig)
    place_cat(sc, kit, 'bean', (1.4, 0, 0), 'peach', rotz=math.radians(-25), rig=rig,
              pose={'arm.L': (-0.94, 0, 0.3), 'arm.R': (-0.5, 0, -0.3), 'foot.L': (-0.58, 0, 0), 'foot.R': (0.2, 0, 0)})
    label(sc, 'rest', (-1.2, -1.3, -0.12), 0.11); label(sc, 'posed: arm -0.94 / foot -0.58 rad', (1.4, -1.3, -0.12), 0.11)
    camera(sc, (0.1, -7.5, 0.35), (0.1, 0, 0.6), lens=50); render(sc, os.path.join(outdir, 'paws.png'))

def render_parts(kit, outdir):
    """parts.png: every part on its own, in a grid; outfits.png: the second wardrobe on all three bases, front and back."""
    info = kit['part_info']; names = list(info); cols = 7; sc = setup_scene('parts', (2100, 1200))
    for i, pname in enumerate(names):
        colours = info[pname][1]; x, z = -6.0 + (i % cols) * 2.0, 2.6 - (i // cols) * 2.35
        src = kit['parts'][(pname, 'bean')]; o = src.copy(); sc.collection.objects.link(o)
        k = 1.0 if info[pname][0] in ('socket_neck', 'socket_back', 'socket_hip') else 1.7; lift = -k * sum(v[2] for v in src.bound_box) / 8   # small head pieces drawn larger, each centred on its cell
        o.matrix_basis = Matrix.Translation(Vector((x, 0, z + lift))) @ Matrix.Rotation(math.radians(-25), 4, 'Z') @ Matrix.Scale(k, 4)
        for slot in o.material_slots:
            nm = slot.material.name.split('.')[0]; slot.link = 'OBJECT'; slot.material = flat(colours.get(nm, '#999999'), 0.4 if nm == 'metal' else 0.75, 0.6 if nm == 'metal' else 0)
        label(sc, pname.replace('_', ' '), (x, -1.2, z - 0.85), 0.17)
    camera(sc, (0, -14, 0.7), (0, 0, 0.3), ortho=14.4); render(sc, os.path.join(outdir, 'parts.png'))
    for tag, rot in (('outfits', -18), ('outfits-back', 160)):
        sc = setup_scene(tag, (2100, 1800))
        for r, base in enumerate(('bean', 'puff', 'sprout')):
            for c, (look, parts) in enumerate(OUTFITS):
                place_cat(sc, kit, base, (-4.8 + c * 2.4, r * 2.2, -r * 2.9 + 2.9), look, [(p, kit['part_info'][p][1]) for p in parts], rotz=math.radians(rot))
            label(sc, base, (-6.6, r * 2.2 - 1.0, -r * 2.9 + 2.9 + 0.9), 0.2)
        camera(sc, (0, -16, 2.2), (0, 0, 0.9), ortho=14.0); render(sc, os.path.join(outdir, tag + '.png'))
