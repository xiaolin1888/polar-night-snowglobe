"""诊断：检查自动权重是否真的写进了顶点组"""
import bpy, sys, os
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
SRC = os.path.abspath(argv[0])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
obj = max(meshes, key=lambda o: len(o.data.polygons))
print('网格:', obj.name)
print('顶点组数:', len(obj.vertex_groups))
print('顶点组名:', [g.name for g in obj.vertex_groups])

# 统计有多少顶点真的有权重
n_total = len(obj.data.vertices)
n_weighted = 0
n_multi = 0
weight_sum_bad = 0
for v in obj.data.vertices:
    if len(v.groups) > 0:
        n_weighted += 1
        s = sum(g.weight for g in v.groups)
        if len(v.groups) > 1:
            n_multi += 1
        if abs(s - 1.0) > 0.05:
            weight_sum_bad += 1
print(f'有権重的顶点: {n_weighted}/{n_total} ({n_weighted/max(n_total,1)*100:.1f}%)')
print(f'多骨骼影响的顶点: {n_multi}')
print(f'权重和偏离1.0的顶点: {weight_sum_bad}')

# 检查 armature
arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
print('骨架数:', len(arms))
for a in arms:
    print('  骨架:', a.name, '骨头数:', len(a.data.bones), '父级:', a.parent.name if a.parent else None)
    print('  骨名:', [b.name for b in a.data.bones])

print('mesh 父级:', obj.parent.name if obj.parent else None)
print('mesh 修改器:', [(m.name, m.type, getattr(m, 'object', None).name if getattr(m, 'object', None) else None) for m in obj.modifiers])
