# 极夜雪境 · 水晶球

一个 three.js 单页互动场景：一颗水晶球里的雪镇。

球里有木屋、摩天轮、热气球、小火车、雪人、冰湖，一个角色坐在冰湖边钓鱼。
玩家盯着他看 5 秒，他会害羞地低下头。

---

## 快速开始

**双击 `start.bat`**

或者手动：

```bash
python serve.py 8940 .
```

浏览器打开 `http://127.0.0.1:8940/index.html`

> 必须用本地服务，不能双击 index.html —— `file://` 协议加载不了 GLB 模型。
> 需要 Python 3（`python --version` 能跑就行）。

---

## 操作

| 按键 | 作用 |
|---|---|
| 拖动 | 旋转视角 |
| 滚轮 | 拉近拉远 |
| 点击物件 | 触发小动作 |
| 双击 | 回到默认视角 |
| 空格 | 摇一摇（雪飞起来） |
| **V** | **走进球里（第一人称，WASD 走动）** |
| N | 昼夜切换 |
| C | 打开设置面板 |
| M | 流星 |
| F | 全屏 |
| H | 隐藏界面 |

---

## 这个版本有什么

### 被注视 → 害羞

**核心新功能。**

盯着角色看，**连续 5 秒**后：

| 时间 | 表现 |
|---|---|
| 0–5 秒 | 正常钓鱼 |
| 满 5 秒 | 低头、视线偏开、冒「……你别一直看」 |
| 再看 2 秒 | 完全转开，低头看竿 |
| 移开 2 秒 | 恢复钓鱼 |

中途移开视线，计时以 1.6 倍速回退，不会扫一眼就累积。

想改时间，在 `app.js` 里搜 `SHY_AFTER`（当前 5.0 秒）。

### 钓鱼动作

角色不是静止的，有四层动作：

- **呼吸**：脊柱和肩部随呼吸起伏（周期 4 秒）
- **环顾**：头部缓慢左右扫视水面
- **握竿手跟随**：双手跟着竿的摆动走
- **咬钩反应**：抬头、前倾、手抬起

### 极光

夜空里两层极光，近层青绿、远层紫蓝，反向流动 + 呼吸式明暗。
设置面板里有强度滑块（0~200%）。

### 画质档位

按 `C` 打开设置，有高/中/低三档：

| 档位 | 渲染倍率 | 阴影 |
|---|---|---|
| 高 | 1.75× | 4096 |
| 中（默认） | 1.35× | 2048 |
| 低 | 1.00× | 1024 |

如果卡，直接选「低」。

---

## 文件结构

```
极夜雪境_完整项目/
├── start.bat           双击启动
├── serve.py            本地静态服务
├── index.html          页面 + CSS
├── app.js              主程序（约 6500 行）
├── package.json        Node 依赖（可选）
│
├── assets/opt/         16 个模型（45 MB）
│   ├── boy.glb         ★ 主角（带眼睛嘴巴）
│   ├── cabin.glb       木屋
│   ├── gondola.glb     摩天轮座舱
│   ├── balloon.glb     热气球
│   ├── train-loco.glb  火车头
│   ├── train-car.glb   火车车厢
│   ├── tree-a/b.glb    针叶树
│   ├── snowman.glb     雪人
│   ├── bench.glb       长椅
│   ├── lamp.glb        路灯
│   ├── fence.glb       栅栏
│   ├── postbox.glb     邮筒
│   ├── sled.glb        雪橇
│   └── giftbox.glb     礼物盒
│
├── vendor/three/       three.js r160（本地，无 CDN）
└── tools/              开发工具
    ├── shot.mjs        截图
    ├── shots.mjs       多机位批量截图
    ├── probe.mjs       运行时状态检查
    └── ...
```

---

## 已知问题

### 1. 表情是静态的

眼睛嘴巴是固定几何，不会眨眼、不会变形。

要做动态表情，部件名字是 `Eye_L` / `Eye_R` / `Mouth`，可以直接按名字取到：

```js
const eye = hero.wrap.getObjectByName('Eye_L');
eye.scale.z = 0;      // 闭眼
eye.scale.z = 0.3;    // 眯眼
```

### 2. 鱼线偏长

鱼洞在角色正前方 300mm，竿长 175mm 够不到，中间靠鱼线连。
如果觉得突兀，改 `app.js` 里 `buildFishingGear()` 的 `HOLE_DIST`（当前 0.30），或加长 `rodLen`（当前 0.175）。

### 3. 雪人模型偏大

`snowman.glb` 是 13.92MB / 8 万面，比别的资产大很多。
如果包体要紧，可以重新压到 2-3 万面。

---

## 改代码前必看

### 坐标系

模型在 Blender 里是 **Z 向上、脸朝 +Y**。
导出成 glTF 后变成 **Y 向上、脸朝 -Z**。

代码里角色朝向：

```js
// 模型面朝 -Z
const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
```

> 这里踩过坑：一开始写成 `(+sin, +cos)`，结果鱼竿甩到身后。

### 骨骼

28 根，Mixamo 命名：

```
Hips / Spine / Spine1 / Spine2 / Neck / Head
LeftUpLeg / LeftLeg / LeftFoot
LeftArm / LeftForeArm / LeftHand
（右侧同理）
```

**注意**：`LeftUpLeg`、`LeftArm` 这些是「别名尾骨」，
真正控制这一节的是它们的**父级**（`L_Thigh`、`L_Upperarm`）。
见 `sitPose()` 里的 `P()` 函数。

### 鱼竿和手

**不要用 IK 把手搬到竿上** —— 手会被拉脱原位，看着像插兜。

正确做法（已实现）：**竿穿过双手**。

```js
const midG = pR.clone().lerp(pL, 0.35);   // 两手中点，偏右手
const handAxis = pL.clone().sub(pR);      // 右手→左手的连线
// 竿沿这个方向摆，自然穿过双手
```

实测两手到竿轴距离 0.3~0.5mm。

---

## 开发工具

```bash
# 单张截图
node tools/shot.mjs --url "http://127.0.0.1:8940/index.html" --out shots/x.png --wait 40000 --size 1400x900

# 多机位一次拍（推荐，避免反复冷启动）
node tools/shots.mjs --url "http://127.0.0.1:8940/index.html" --plan plan.json --size 900x900
```

`probe.mjs` 默认连 8940，可用环境变量 `PROBE_URL` 改。

---

## 想继续做什么

按性价比排序：

1. **眨眼**（简单，效果明显）
   每 3-5 秒把 `Eye_L/Eye_R.scale.z` 从 1 快速降到 0 再回来

2. **害羞时眯眼**（让 5 秒害羞更有表现力）
   `shy` 状态时把眼睛 `scale.z` 压到 0.4

3. **鱼线长度微调**

4. **雪人减面**

### 不要做的事

- **不要用 X 形眼睛** —— 那是死亡/昏厥的符号
- **不要用 IK 搬手去够竿** —— 手会脱臼
- **不要改骨骼名字** —— 代码按名字找

---

## 原始素材

如果需要重新生成资产，原始高模在（未包含在本包内）：

```
<原项目>\assets\raw\
```

生成脚本在 `tools/`：
- `hero_opt.mjs` —— 角色优化
- `fbx2glb.mjs` —— FBX 转 GLB
- `assets_opt2.mjs` —— 场景资产批量优化

---

> 一颗球。一个雪镇。一个会害羞的钓鱼小孩。
