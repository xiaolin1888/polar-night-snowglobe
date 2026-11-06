"""
新角色处理流水线：减面 → 摆正朝向 → 自动绑骨 → 导出
用法: blender -b -P rig_newboy.py -- <input.glb> <output.glb> [target_tris]
"""
import bpy
import bmesh
import sys
import math
import os
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
SRC = os.path.abspath(argv[0])
OUT = os.path.abspath(argv[1])
TARGET = int(argv[2]) if len(argv) > 2 else 40000

print('=' * 60)
print('输入:', SRC)
print('目标面数:', TARGET)
print('=' * 60)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
bpy.context.view_layer.update()

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print('导入网格数:', len(meshes))
if not meshes:
    raise SystemExit('没有网格')

obj = max(meshes, key=lambda o: len(o.data.polygons))
print('主网格:', obj.name, '顶点', len(obj.data.vertices), '面', len(obj.data.polygons))

# ---------- 1. 摆正：把最高维度的轴转成 Z 轴（Blender 里 Z 是上） ----------
# 当前模型：X=0.942(宽), Y=0.392(厚), Z=1.101(高) -> Z 已经是高度，但 glTF 导入后
# Blender 的 Z 向上，模型却是 1.101 在 Z，说明它躺着（原 glTF 里高度在 Z）
bbox_min = Vector((1e9, 1e9, 1e9))
bbox_max = Vector((-1e9, -1e9, -1e9))
for v in obj.data.vertices:
    w = obj.matrix_world @ v.co
    for i in range(3):
        bbox_min[i] = min(bbox_min[i], w[i])
        bbox_max[i] = max(bbox_max[i], w[i])
size = bbox_max - bbox_min
print('原始尺寸 X=%.3f Y=%.3f Z=%.3f' % (size.x, size.y, size.z))

# 若 Y 或 Z 不是最大维度，则旋转让最大维度朝上
if size.y > size.z:
    # 绕 X 轴 -90°：把 Y 转到 Z
    obj.rotation_euler = (math.radians(-90), 0, 0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    print('已旋转 -90° 绕 X（Y->Z）')

# 重新计算
bbox_min = Vector((1e9, 1e9, 1e9))
bbox_max = Vector((-1e9, -1e9, -1e9))
for v in obj.data.vertices:
    w = obj.matrix_world @ v.co
    for i in range(3):
        bbox_min[i] = min(bbox_min[i], w[i])
        bbox_max[i] = max(bbox_max[i], w[i])
size = bbox_max - bbox_min
print('摆正后尺寸 X=%.3f Y=%.3f Z=%.3f' % (size.x, size.y, size.z))

# ---------- 2. 减面 ----------
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj

cur = len(obj.data.polygons)
if cur > TARGET:
    before = cur
    # 用 collapse 减面，保留 UV
    dec = obj.modifiers.new('Dec', 'DECIMATE')
    dec.decimate_type = 'COLLAPSE'
    dec.ratio = TARGET / cur
    dec.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=dec.name)
    print('减面: %d -> %d' % (before, len(obj.data.polygons)))

# 焊接重复顶点，避免自动绑骨因顶点分离而失败
bm = bmesh.new()
bm.from_mesh(obj.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bm.to_mesh(obj.data)
bm.free()
obj.data.update()
print('焊接后顶点:', len(obj.data.vertices))

# ---------- 3. 自动绑骨 ----------
# Blender 自带 Rigify 需要人形骨骼模板，这里用更简单的方案：
# 手工构建一个基础人形骨架，再自动计算权重
from mathutils import Vector as V

h = size.z
w = size.x
d = size.y
cx = (bbox_min.x + bbox_max.x) / 2
cy = (bbox_min.y + bbox_max.y) / 2
z0 = bbox_min.z

print('构建人形骨架: 高=%.3f 宽=%.3f 厚=%.3f' % (h, w, d))

# 创建骨架
arm_data = bpy.data.armatures.new('Armature')
arm_obj = bpy.data.objects.new('Armature', arm_data)
bpy.context.scene.collection.objects.link(arm_obj)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode='EDIT')

eb = arm_data.edit_bones

def add_bone(name, head, tail, parent=None, connected=False):
    b = eb.new(name)
    b.head = head
    b.tail = tail
    if parent:
        b.parent = parent
        b.use_connect = connected
    return b

# 比例（相对身高 h，脚底 z0）
# 关键位置
z_hip = z0 + h * 0.48
z_chest = z0 + h * 0.68
z_neck = z0 + h * 0.80
z_head = z0 + h * 0.86
z_head_top = z0 + h * 1.00
z_knee = z0 + h * 0.26
z_foot = z0 + h * 0.03
z_shoulder = z0 + h * 0.78
x_shoulder = w * 0.20
x_hip = w * 0.10
x_foot = w * 0.15

bones = {}
bones['root'] = add_bone('root', V((cx, cy, z0)), V((cx, cy, z0 + h * 0.04)))
bones['Hips'] = add_bone('Hips', V((cx, cy, z_hip)), V((cx, cy, z_hip + h * 0.06)), bones['root'])
bones['Spine'] = add_bone('Spine', V((cx, cy, z_hip + h * 0.06)), V((cx, cy, z_chest)), bones['Hips'], True)
bones['Spine1'] = add_bone('Spine1', V((cx, cy, z_chest)), V((cx, cy, z_neck)), bones['Spine'], True)
bones['Neck'] = add_bone('Neck', V((cx, cy, z_neck)), V((cx, cy, z_head)), bones['Spine1'], True)
bones['Head'] = add_bone('Head', V((cx, cy, z_head)), V((cx, cy, z_head_top)), bones['Neck'], True)

# 左右
for side, sx in (('Left', -1), ('Right', 1)):
    x_sh = cx + sx * x_shoulder
    x_hp = cx + sx * x_hip
    x_ft = cx + sx * x_foot
    # 手臂：从肩到手腕（T-pose 水平伸展）
    x_hand = cx + sx * w * 0.48
    bones[side + 'Shoulder'] = add_bone(
        side + 'Shoulder',
        V((cx + sx * w * 0.05, cy, z_shoulder)),
        V((x_sh, cy, z_shoulder)),
        bones['Spine1'])
    bones[side + 'Arm'] = add_bone(
        side + 'Arm', V((x_sh, cy, z_shoulder)),
        V((cx + sx * w * 0.33, cy, z_shoulder)),
        bones[side + 'Shoulder'], True)
    bones[side + 'ForeArm'] = add_bone(
        side + 'ForeArm', V((cx + sx * w * 0.33, cy, z_shoulder)),
        V((cx + sx * w * 0.44, cy, z_shoulder)),
        bones[side + 'Arm'], True)
    bones[side + 'Hand'] = add_bone(
        side + 'Hand', V((cx + sx * w * 0.44, cy, z_shoulder)),
        V((x_hand, cy, z_shoulder)),
        bones[side + 'ForeArm'], True)
    # 腿
    bones[side + 'UpLeg'] = add_bone(
        side + 'UpLeg', V((x_hp, cy, z_hip)),
        V((x_hp, cy, z_knee)), bones['Hips'])
    bones[side + 'Leg'] = add_bone(
        side + 'Leg', V((x_hp, cy, z_knee)),
        V((x_ft, cy, z_foot)), bones[side + 'UpLeg'], True)
    bones[side + 'Foot'] = add_bone(
        side + 'Foot', V((x_ft, cy, z_foot)),
        V((x_ft, cy - d * 0.35, z_foot)), bones[side + 'Leg'], True)

bpy.ops.object.mode_set(mode='OBJECT')
print('骨骼数:', len(arm_data.bones))

# ---------- 4. 自动权重 ----------
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
arm_obj.select_set(True)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
print('自动权重完成')
print('顶点组数:', len(obj.vertex_groups))

# ---------- 5. 导出 ----------
# 关键：必须让 armature 与 mesh 一起导出，并且 mesh 的父级保持 armature。
# 之前 skins=0 是因为导出时骨骼未被识别——需要确认 mesh 有 Armature 修改器。
print('mesh 修改器:', [(m.name, m.type) for m in obj.modifiers])
print('mesh 父级:', obj.parent.name if obj.parent else None)

# 确保有 Armature 修改器
has_arm_mod = any(m.type == 'ARMATURE' for m in obj.modifiers)
if not has_arm_mod:
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_obj
    print('手动添加 Armature 修改器')

bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    use_selection=False,
    export_skins=True,
    export_animations=False,
    export_yup=True,
    export_apply=False,
    export_def_bones=False,
    export_all_influences=False,
)
print('导出:', OUT, os.path.getsize(OUT), 'bytes')
print('DONE')
