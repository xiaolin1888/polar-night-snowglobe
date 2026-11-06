"""
新角色处理流水线 v2：减面 → 摆正 → 自动绑骨 → 导出
关键修正：导出前必须确保 armature 是 active 且被选中，且 mesh 保持在父级关系里，
否则 Blender 的 glTF 导出器不会写出 skin 数据。

用法: blender -b -P rig_newboy2.py -- <input.glb> <output.glb> [target_tris]
"""
import bpy
import bmesh
import sys
import math
import os
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
SRC = os.path.abspath(argv[0])
OUT = os.path.abspath(argv[1])
TARGET = int(argv[2]) if len(argv) > 2 else 40000

print('=' * 60)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
bpy.context.view_layer.update()

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
obj = max(meshes, key=lambda o: len(o.data.polygons))
print('主网格:', obj.name, '顶点', len(obj.data.vertices), '面', len(obj.data.polygons))

# ---------- 1. 摆正 ----------
def bbox_of(o):
    mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
    for v in o.data.vertices:
        w = o.matrix_world @ v.co
        for i in range(3):
            mn[i] = min(mn[i], w[i]); mx[i] = max(mx[i], w[i])
    return mn, mx

mn, mx = bbox_of(obj)
size = mx - mn
print('原始尺寸 X=%.3f Y=%.3f Z=%.3f' % (size.x, size.y, size.z))
if size.y > size.z * 1.2:
    obj.rotation_euler = (math.radians(-90), 0, 0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    mn, mx = bbox_of(obj)
    size = mx - mn
    print('已摆正，尺寸 X=%.3f Y=%.3f Z=%.3f' % (size.x, size.y, size.z))

# ---------- 2. 减面 ----------
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
cur = len(obj.data.polygons)
if cur > TARGET:
    dec = obj.modifiers.new('Dec', 'DECIMATE')
    dec.decimate_type = 'COLLAPSE'
    dec.ratio = TARGET / cur
    dec.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=dec.name)
    print('减面: %d -> %d' % (cur, len(obj.data.polygons)))

bm = bmesh.new(); bm.from_mesh(obj.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bm.to_mesh(obj.data); bm.free(); obj.data.update()

# ---------- 3. 人形骨架 ----------
h = size.z; w = size.x; d = size.y
cx = (mn.x + mx.x) / 2; cy = (mn.y + mx.y) / 2; z0 = mn.z

arm_data = bpy.data.armatures.new('Armature')
arm_obj = bpy.data.objects.new('Armature', arm_data)
bpy.context.scene.collection.objects.link(arm_obj)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones

def add_bone(name, head, tail, parent=None, connected=False):
    b = eb.new(name)
    b.head = head; b.tail = tail
    if parent:
        b.parent = parent; b.use_connect = connected
    return b

z_hip = z0 + h * 0.48
z_chest = z0 + h * 0.66
z_neck = z0 + h * 0.79
z_head = z0 + h * 0.84
z_top = z0 + h * 1.00
z_knee = z0 + h * 0.26
z_foot = z0 + h * 0.04
z_sh = z0 + h * 0.77
x_sh = w * 0.17
x_hp = w * 0.09
x_ft = w * 0.13

B = {}
B['root'] = add_bone('root', Vector((cx, cy, z0)), Vector((cx, cy, z0 + h * 0.04)))
B['Hips'] = add_bone('Hips', Vector((cx, cy, z_hip)), Vector((cx, cy, z_hip + h * 0.05)), B['root'])
B['Spine'] = add_bone('Spine', Vector((cx, cy, z_hip + h * 0.05)), Vector((cx, cy, z_chest)), B['Hips'], True)
B['Spine1'] = add_bone('Spine1', Vector((cx, cy, z_chest)), Vector((cx, cy, z_neck)), B['Spine'], True)
B['Neck'] = add_bone('Neck', Vector((cx, cy, z_neck)), Vector((cx, cy, z_head)), B['Spine1'], True)
B['Head'] = add_bone('Head', Vector((cx, cy, z_head)), Vector((cx, cy, z_top)), B['Neck'], True)

for side, sx in (('Left', -1), ('Right', 1)):
    x_shi = cx + sx * x_sh
    x_hpi = cx + sx * x_hp
    x_fti = cx + sx * x_ft
    x_hand = cx + sx * w * 0.46
    B[side + 'Shoulder'] = add_bone(side + 'Shoulder',
        Vector((cx + sx * w * 0.04, cy, z_sh)), Vector((x_shi, cy, z_sh)), B['Spine1'])
    B[side + 'Arm'] = add_bone(side + 'Arm',
        Vector((x_shi, cy, z_sh)), Vector((cx + sx * w * 0.31, cy, z_sh)), B[side + 'Shoulder'], True)
    B[side + 'ForeArm'] = add_bone(side + 'ForeArm',
        Vector((cx + sx * w * 0.31, cy, z_sh)), Vector((cx + sx * w * 0.42, cy, z_sh)), B[side + 'Arm'], True)
    B[side + 'Hand'] = add_bone(side + 'Hand',
        Vector((cx + sx * w * 0.42, cy, z_sh)), Vector((x_hand, cy, z_sh)), B[side + 'ForeArm'], True)
    B[side + 'UpLeg'] = add_bone(side + 'UpLeg',
        Vector((x_hpi, cy, z_hip)), Vector((x_hpi, cy, z_knee)), B['Hips'])
    B[side + 'Leg'] = add_bone(side + 'Leg',
        Vector((x_hpi, cy, z_knee)), Vector((x_fti, cy, z_foot)), B[side + 'UpLeg'], True)
    B[side + 'Foot'] = add_bone(side + 'Foot',
        Vector((x_fti, cy, z_foot)), Vector((x_fti, cy - d * 0.3, z_foot)), B[side + 'Leg'], True)

bpy.ops.object.mode_set(mode='OBJECT')
print('骨骼数:', len(arm_data.bones))

# ---------- 4. 权重 ----------
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
arm_obj.select_set(True)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.parent_set(type='ARMATURE_AUTO')

# 确认权重真的写进去了
n_w = sum(1 for v in obj.data.vertices if len(v.groups) > 0)
print('有权重顶点: %d / %d' % (n_w, len(obj.data.vertices)))
print('顶点组:', [g.name for g in obj.vertex_groups])

# ---------- 5. 导出 ----------
# 关键：先确保 mesh 有 Armature 修改器指向 arm_obj
if not any(m.type == 'ARMATURE' for m in obj.modifiers):
    m = obj.modifiers.new('Armature', 'ARMATURE')
    m.object = arm_obj
    print('补加 Armature 修改器')

bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = arm_obj
print('导出前检查: mesh修改器=', [(m.name, m.type) for m in obj.modifiers],
      ' 父级=', obj.parent.name if obj.parent else None,
      ' 顶点组数=', len(obj.vertex_groups))

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    use_selection=False,
    export_skins=True,
    export_animations=False,
    export_apply=False,
    export_yup=True,
)
print('导出:', OUT, os.path.getsize(OUT), 'bytes')
print('DONE')
