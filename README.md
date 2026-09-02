# 方舟桌面宠物 (Shu Desktop Pet)

一个基于 **Electron + Vue 3 + Spine** 的 Windows 桌面宠物应用，将《明日方舟》干员的 Spine 2D 骨骼动画直接呈现在桌面上，支持交互、动画播放、角色切换等丰富功能。

![preview](https://img.shields.io/badge/Electron-33-blue?logo=electron)
![preview](https://img.shields.io/badge/Vue-3.5-brightgreen?logo=vue.js)
![preview](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)
![preview](https://img.shields.io/badge/license-MIT-green)

---

## 特性

- 🖼️ **全屏透明窗口** — 无边框、全屏透明背景，角色悬浮在桌面上；透明区域点击穿透，非透明区域（角色/UI）正常交互
- 🎮 **Spine 骨骼动画** — WebGL 渲染，支持所有干员正面 / 背面 / 基建模型
- 🎯 **交互状态机** — 点击触发攻击、技能连段、技能切换等复杂动画序列
- 💬 **气泡对话** — 交互时弹出随机气泡文字
- 🎯 **Alt+拖拽** — 按住 Alt 键 + 左键拖拽移动主窗口；面板顶部胶囊条可直接拖拽
- 🎬 **动画面板** — 独立子窗口点播任意动画，支持循环播放，当前循环动画按钮高亮
- ⚙️ **操作面板** — 独立浮动的快捷工具栏（互动/翻转/动画面板/设置面板），启动自动打开，位置可记忆
- 🖱️ **智能点击穿透** — 鼠标在角色/UI上正常交互，在空白区域自动穿透到下层窗口
- ⚡ **帧率控制** — 30/60 FPS 可选，限制 GPU 占用
- 🔧 **调试工具** — Ctrl+Shift+D 调试模式（红框包场景/蓝框标交互区）、Ctrl+Shift+F 帧率监视

---

## 截图

| 桌面宠物（主窗口） | 设置面板 | 动画面板 | 操作面板 |
|---------|---------|---------|---------|
| (运行后可见) | 操作面板 → 齿轮图标打开 | 操作面板 → 书图标打开 | 启动时自动出现 |

---

## 快速开始

### 前置要求

- Node.js >= 18
- pnpm >= 8

### 安装 & 运行

```bash
# 克隆项目
cd arknights-desktop-pet

# 安装依赖
pnpm install

# 开发模式运行（同时启动 Vite dev server + Electron）
pnpm dev
```

### 构建发布

```bash
# 打包为 Windows 便携版 (.exe)
pnpm pack
```

产物输出到 `release/` 目录，文件名为 `ShuDesktopPet-${version}.exe`。

Windows 下也可直接双击 `启动桌面宠物.cmd` 启动开发模式。

---

## 使用指南

### 基本操作

| 操作 | 说明 |
|------|------|
| **Alt+拖拽** | 按住 Alt + 左键拖拽移动主窗口位置 |
| **面板拖拽** | 动画面板、设置面板、操作面板顶部 `⋮⋮` 拖拽条任意摆放 |
| **点击角色** | 点击模型触发互动（攻击/技能/气泡） |
| **滚轮缩放** | 在角色上滚动滚轮缩放大小（100%～135%） |
| **操作面板** | 浮动工具栏：互动 / 翻转 / 动画面板 / 设置面板 |
| **交互反馈** | 循环中的动画按钮自动变蓝高亮 |
| **系统托盘** | 右键托盘图标 → 显示隐藏、置顶、帧率、显示/隐藏操作栏、退出 |

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt + 左键拖拽` | 移动主窗口位置 |
| `Ctrl+Shift+D` | 切换调试模式（红框包场景 / 蓝框标交互区） |
| `Ctrl+Shift+F` | 切换 FPS 覆盖层 |

### 角色切换

1. 点击操作面板的 **设置** 按钮（⚙️）
2. 在设置面板的搜索框中输入角色名（支持中文模糊搜索）
3. 点击角色切换
4. 选择 **皮肤** 和 **模型视角**（正面/背面/基建）

### 动画播放

1. 点击操作面板的 **动画** 按钮（📄）
2. 切换 **播放** 开关开启点播模式
3. 点击动画名称播放
4. 开启 **循环** 可让动画循环播放，当前循环动画按钮会变蓝高亮

### 异格切换

部分角色（如阿米娅、陈、德克萨斯等）有多个异格版本，在设置菜单中切换角色后，会出现 **异格** 按钮组，点击即可在不同版本间切换。

---

## 项目结构

```
arknights-desktop-pet/
├── electron/                  # Electron 主进程
│   ├── main.ts                # 主进程入口（窗口管理、托盘、IPC、面板位置持久化）
│   ├── preload.ts             # 预加载脚本（TypeScript 版）
│   ├── preload.cjs            # 预加载脚本（CommonJS 版，实际被加载版本）
│   ├── preload-anim.ts        # 动画窗口预加载（通过 vite-plugin-electron 编译）
│   ├── update-characters.ts   # 角色数据自动更新（7 天限流检查 PRTS wiki）
│   └── tray-icon.png          # 托盘图标
├── src/                       # 渲染进程（Vue 3）
│   ├── main.ts                # Vue 应用入口
│   ├── App.vue                # 根组件（仅挂载 PetCanvas）
│   ├── types/
│   │   └── index.ts           # Window.electronAPI 类型声明
│   ├── assets/
│   │   └── spine/             # Spine WebGL 运行时（spine-webgl.js + .d.ts）
│   └── features/
│       └── pet/
│           ├── PetCanvas.vue   # 主画布组件（核心 UI：渲染、交互、点击穿透、三面板模式）
│           ├── spine.ts        # Spine 引擎封装（加载、渲染、像素检测、动画控制、帧率控制）
│           ├── config.ts       # 角色配置、分组管理、自动更新合并
│           ├── characters.json # 所有干员的 Spine 元数据（自动生成）
│           ├── character-groups.ts  # 异格分组定义
│           ├── usePetState.ts  # 交互状态机（攻击/技能等状态转移）
│           ├── usePetScale.ts  # 缩放控制 composable
│           └── usePetDrag.ts   # 窗口拖拽 composable（PointerEvent + setPointerCapture）
├── help/
│   └── index.html              # 使用说明（打包进 exe，托盘菜单打开）
├── scripts/
│   └── discover-characters.mjs # 角色发现脚本（从 PRTS wiki 拉取数据）
├── dist/                      # Vite 构建输出
├── dist-electron/             # Electron 构建输出
├── release/                   # 打包发布目录
├── package.json
├── vite.config.ts             # Vite + Electron 配置
├── tsconfig.json
└── 启动桌面宠物.cmd           # Windows 快捷启动脚本
```

---

## 技术架构

### 渲染管线

```
Spine .skel + .atlas 文件
        ↓  (网络加载，来自 PRTS wiki CDN)
  AssetManager (spine-webgl)
        ↓
  Skeleton + AnimationState
        ↓
  WebGL PolygonBatcher 渲染
        ↓
  requestAnimationFrame 循环
```

### 状态机

交互状态机采用"全打断 + End 即连接"设计：

```
互动点击 (handleClick) — 打断当前所有状态
  ├─ currentSkill 有值 → SKILL_ATTACKING → SKILL_ENDING (播 End)
  │     └─ 30% 切换 → SKILL_BEGINNING → SKILL_IDLE
  │     └─ 70% 不切换 → IDLE
  └─ currentSkill 无值 → ATTACKING → IDLE
```

- **点击立即打断**：任何状态下（除死亡外）点击互动都立即进入攻击，不等待当前动画播完
- **End 是连接动画**：每次技能攻击后必播 End，不再跳过。End 之后 30% 概率切到另一个 skill
- **排除来源**：`excludeSkill` 记录上次来源，防止 3→2→3→2 来回弹跳
- **技能切换概率**：`STATE_CONFIG.P_skill_switch = 0.3`

### 数据来源

角色 Spine 数据来自 [PRTS Wiki](https://prts.wiki) 的 CDN：

- `https://torappu.prts.wiki/assets/char_spine/{char_id}/meta.json` — 角色元数据
- `https://torappu.prts.wiki/assets/char_spine/{char_id}/{model}.skel` — 骨骼数据
- `https://torappu.prts.wiki/assets/char_spine/{char_id}/{model}.atlas` — 纹理图集

运行 `node scripts/discover-characters.mjs` 可从 PRTS wiki 重新拉取所有干员列表和 Spine 元数据。

---

## 开发

### 添加新角色

角色数据存储在 `src/features/pet/characters.json`，格式如下：

```json
{
  "id": "char_2025_shu",
  "name": "黍",
  "meta": {
    "prefix": "https://torappu.prts.wiki/assets/char_spine/char_2025_shu/",
    "name": "黍",
    "skin": {
      "默认": {
        "正面": { "file": "front_default" },
        "背面": { "file": "back_default" },
        "基建": { "file": "build_default" }
      },
      "春日宴": {
        "正面": { "file": "front_skin1" }
      }
    }
  }
}
```

1. 确认角色在 PRTS wiki CDN 上有 Spine 资源
2. 手动编辑 `characters.json` 添加条目，或运行 `node scripts/discover-characters.mjs` 自动拉取
3. 如需异格分组，在 `character-groups.ts` 中添加分组

### 添加新动画

动画状态定义在 `usePetState.ts` 的 `STATE_CONFIG` 中：

```ts
export const STATE_CONFIG = {
  P_skill_switch: 0.3,         // 技能攻击后切换到另一个技能的概率
  bubble_probability: 1.0,     // 点击气泡概率
  bubble_idle_probability: 0.08,  // 待机气泡概率
};
```

---

## 构建说明

### 打包为 Windows 便携版

```bash
pnpm pack
```

使用 electron-builder 的 portable 目标打包为单文件 `.exe`，无需安装。

### 配置

electron-builder 配置在 `package.json` 的 `"build"` 字段中：

```json
{
  "appId": "arknights-desktop-pet",
  "productName": "方舟桌面宠物",
  "win": { "target": "portable" },
  "portable": { "artifactName": "ShuDesktopPet-${version}.exe" }
}
```

---

## 致谢

- [PRTS Wiki](https://prts.wiki) — 《明日方舟》中文 Wiki，提供干员 Spine 资源
- [Spine](https://esotericsoftware.com/) — 2D 骨骼动画引擎
- [Electron](https://www.electronjs.org/) — 桌面框架
- [Vue 3](https://vuejs.org/) — 前端框架

---

## 许可

本项目仅用于学习和个人使用，所有游戏资源版权归 **鹰角网络（Hypergryph）** 所有。
