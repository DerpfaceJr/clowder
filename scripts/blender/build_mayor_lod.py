"""Builds public/assets/mayor-lod.glb: the Mayor with its dense meshes decimated for the game camera.
  blender -b --factory-startup --python scripts/blender/build_mayor_lod.py
The source public/assets/mayor.glb stays the style anchor and is never modified. Armature, skin weights, materials,
textures and shape keys are kept; meshes with shape keys are left untouched (Decimate cannot apply over them).
Every mesh above TARGET triangles is collapsed toward TARGET (never below MIN_RATIO of its triangles)."""
import bpy, os
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(ROOT, 'public', 'assets', 'mayor.glb'); OUT = os.path.join(ROOT, 'public', 'assets', 'mayor-lod.glb')
TARGET, MIN_RATIO = 3500, 0.08
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
before = after = 0
for o in [o for o in bpy.data.objects if o.type == 'MESH']:
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons); before += tris
    if tris > TARGET and not o.data.shape_keys:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('lod', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = max(MIN_RATIO, TARGET / tris)
        # Armature modifiers must stay last so skinning still applies on top of the decimated mesh.
        while o.modifiers.find('lod') > 0: bpy.ops.object.modifier_move_up(modifier='lod')
        bpy.ops.object.modifier_apply(modifier='lod')
    after += sum(len(p.vertices) - 2 for p in o.data.polygons)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_skins=True, export_morph=True, export_animations=False, export_yup=True)
print(f'mayor-lod: {before} -> {after} triangles, {OUT}')
