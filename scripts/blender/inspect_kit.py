"""Re-imports cat-kit.glb in a fresh Blender and prints what actually shipped.
  blender -b --factory-startup --python scripts/blender/inspect_kit.py -- public/assets/cat-kit.glb"""
import bpy, sys, os
path = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'cat-kit.glb')
bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.import_scene.gltf(filepath=path)
print('FILE', os.path.abspath(path), os.path.getsize(path), 'bytes')
shapes = {pb.custom_shape for a in bpy.data.objects if a.type == 'ARMATURE' for pb in a.pose.bones if pb.custom_shape}   # importer's bone gizmo, not in the GLB
for o in sorted(bpy.data.objects, key=lambda o: o.name):
    if o in shapes: continue
    if o.type == 'MESH':
        me = o.data; me.calc_loop_triangles()
        keys = [k.name for k in me.shape_keys.key_blocks[1:]] if me.shape_keys else []
        attrs = [a.name for a in me.attributes if a.name.startswith('_')]
        print(f'MESH {o.name:28s} tris={len(me.loop_triangles):5d} verts={len(me.vertices):5d} mats={[m.name for m in me.materials]} parent={o.parent.name if o.parent else None}'
              + (f' morphs={keys}' if keys else '') + (f' attrs={attrs}' if attrs else ''))
    elif o.type == 'ARMATURE':
        print('ARMATURE', o.name, 'bones=', [b.name for b in o.data.bones])
    elif o.type == 'EMPTY':
        print('EMPTY', o.name, 'parent=', o.parent.name if o.parent else None, 'bone=', o.parent_bone or '-')
