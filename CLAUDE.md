# 方舟桌面宠物 (Arknights Desktop Pet)

## 项目概述

Electron + Vue 3 + TypeScript 的 Windows 桌面宠物应用，渲染《明日方舟》干员的 Spine 2D 骨骼动画。

## 技术栈

- **框架**: Electron 33 + Vue 3.5 + TypeScript 5.7
- **构建**: Vite 6 + vite-plugin-electron + electron-builder
- **包管理**: pnpm
- **渲染**: 自封装 Spine WebGL 运行时 (`src/assets/spine/spine-webgl.js`)
- **打包目标**: Windows 便携版 (.exe) + 文件夹版 (win-unpacked) + NSIS 安装版

## 目录结构

```
arknights-desktop-pet/
├── electron/                  # Electron 主进程
│   ├── main.ts                # 窗口管理、系统托盘、IPC 处理
│   ├── preload.ts             # 预加载脚本（TS 源码，同 preload.cjs）
│   ├── preload.cjs            # 预加载脚本（CJS 版，由 vite 复制到 dist-electron/，实际被加载的版本）
│   ├── preload-anim.ts        # 动画窗口预加载（通过 vite-plugin-electron 编译，暴露 animAPI）
│   ├── logger.ts              # 主进程日志核心（文件写入、轮转、清理）
│   ├── update-characters.ts   # PRTS wiki 角色数据更新逻辑
│   └── tray-icon.png
├── src/
│   ├── main.ts                # Vue 入口
│   ├── App.vue                # 根组件（仅挂载 PetCanvas）
│   ├── types/index.ts         # Window.electronAPI 类型声明
│   ├── utils/
│   │   └── logger.ts          # 渲染进程日志桥接（IPC → 主进程写入文件）
│   ├── assets/spine/          # Spine WebGL 运行时（spine-webgl.js + .d.ts）
│   └── features/pet/          # 核心逻辑
│       ├── PetCanvas.vue       # 主画布组件（核心 UI：渲染、交互、点击穿透、面板）
│       ├── Bubble.vue          # 独立气泡组件（已不再被使用，由 PetCanvas 内联气泡替代）
│       ├── spine.ts            # Spine 引擎封装（加载、渲染、帧率控制）
│       ├── config.ts           # 角色配置、分组构建、类型定义
│       ├── characters.json     # 干员 Spine 元数据（自动生成，提交到仓库）
│       ├── character-groups.ts # 异格分组定义（ALTER_GROUPS）
│       ├── usePetState.ts      # 交互状态机（攻击/技能链状态转移）
│       ├── usePetScale.ts      # 缩放控制 composable
│       ├── usePetDrag.ts       # 窗口拖拽 composable（PointerEvent + setPointerCapture + IPC）
│       └── useAnimClassifier.ts # 动画分类器（数据驱动，适配多语言命名）
├── help/
│   └── index.html              # 使用说明（打包进 exe，托盘菜单打开）
├── scripts/
│   └── discover-characters.mjs # 从 PRTS wiki 自动发现角色并生成 characters.json
├── dist/                      # Vite 构建输出
├── dist-electron/             # Electron 构建输出
├── release/                   # electron-builder 打包输出
├── index.html                 # HTML 入口
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── 启动桌面宠物.cmd           # Windows 快捷启动（先清空 dist-electron，再 `pnpm dev`）
└── deepseek接口.url           # DeepSeek 用量链接（用户个人）
```

## 常用命令

```bash
pnpm dev            # 开发模式（Vite HMR + Electron）
pnpm build          # 仅构建前端
pnpm pack           # 自动 +0.0.1 版本号 → 构建 → 打包为 Windows 便携版 exe
pnpm pack-dir       # 自动 +0.0.1 版本号 → 构建 → 打包为文件夹版（win-unpacked/）
pnpm pack-installer # 自动 +0.0.1 版本号 → 构建 → 打包为 NSIS 安装版 exe
pnpm preview        # 预览 Vite 构建

## 打包教程

打包依赖 `electron-builder`，首次运行时可能需要下载 Electron 二进制文件（~130MB），国内网络环境下推荐以下方式加速：

### 1. 修改 package.json（推荐）

在 `"build"` 字段的 `"directories"` 下方添加 `"electronDist"`，让 electron-builder 直接用本地安装好的 Electron：

```json
"build": {
  "directories": { "output": "release" },
  "electronDist": "node_modules/electron/dist",
  ...
}
```

添加后运行 `pnpm pack` 会输出日志 `using custom unpacked Electron distribution`，跳过下载直接打包。

### 2. 设置国内镜像环境变量

```bash
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
pnpm run pack
```

### 3. 产物

打包完成后，exe 文件输出在 `release/` 目录下，文件名格式为 `方舟桌面宠物-${version}.exe`（如 `方舟桌面宠物-2.0.2.exe`），单文件便携版，无需安装即可运行。
```

## 关键架构决策

### 1. 窗口拖拽 + 点击穿透（JS 级双轨）

桌宠采用纯 JS 指针事件处理交互，没有 OS 级拖拽区域，透明区域可鼠标穿透。

**主窗口拖拽**
- **Alt+拖拽**：按住 `Alt` 键 + 鼠标左键拖拽主窗口任意位置
- 使用 `PointerEvent` + `setPointerCapture`，主进程 IPC `window-drag-start/move/end`
- 松开 Alt 键自动结束拖拽（兜底：`keyup` 监听），无需等待 `pointerup`
- 主窗口底部无任何按钮栏（全部移至独立操作面板）

**操作面板子窗口**（`#/action-panel`）
- 独立 BrowserWindow（透明、无边框、置顶），启动时自动打开
- 横向排列 5 个方形按钮：互动、翻转、动画面板开关、设置面板开关、帮助
- 帮助按钮发送 `open-help` IPC，主窗口打开 `help/index.html` 使用说明窗口
- 按钮为静态样式（无 hover/active 变色效果）
- 顶部胶囊拖拽条使用 `PointerEvent` + `setPointerCapture` 独立拖拽
- 缩放按钮已移除（主窗口滚轮缩放替代）
- 拖拽按钮已移除（顶部拖拽条替代）
- 面板位置持久化到 `pet-settings.json`，重启后自动恢复

**面板子窗口**
- 动画面板、设置面板、操作面板为独立 BrowserWindow（透明、无边框、置顶）
- 通过 hash 路由加载同一 Vue 应用：`#/anim-panel`、`#/menu-panel`、`#/action-panel`
- 面板窗口顶部的胶囊拖拽条使用 `PointerEvent` + `setPointerCapture` 独立拖拽（`panel-drag-start/move/end` IPC）
- 拖拽结束时面板位置自动保存到 `pet-settings.json`，下次打开恢复
- 跨窗口通信：主窗口 ↔ 面板窗口通过主进程中继 IPC（`panel-action` / `panel-state`）
- 面板窗口不可调整大小（`resizable: false`），内容自适应窗口尺寸（`fitPanelSize()` + `setPanelSize` IPC）

**UI 元素交互**：`.anim-bar`, `.context-menu`, `.menu-backdrop`, `.error-capture` 在 `isInsideUIElement()` 中标记，绕过像素检测强制接收事件

**像素级点击穿透**
- 鼠标每帧移动时读取 WebGL canvas 对应像素的 alpha 值
- alpha > 10（有模型渲染）→ `setIgnoreMouseEvents(false)` → 可交互
- alpha ≤ 10（空白区域）→ `setIgnoreMouseEvents(true, { forward: true })` → 事件穿透到下层窗口
- UI 面板区域跳过像素检测，始终接收事件
- 引入 `readPixelAlpha()` 方法到 `spine.ts`：`gl.readPixels(1px)` 读 alpha 通道

### 2. 透明窗口 + 帧率控制

**透明窗口 CLI 开关**（必须在 `app.whenReady()` 前设置）：
- `enable-transparent-visuals` — 启用透明窗口的软件渲染路径，解决部分 GPU 下透明窗口显示不透明
- `disable-gpu-compositing` — 禁用 GPU 合成，防止 DWM 与 WebGL 透明纹理合成时产生不透明背景

**窗口尺寸**：`screen.getPrimaryDisplay().workArea`（全屏工作区大小，排除任务栏）

**帧率控制**
- `app.commandLine.appendSwitch('disable-frame-rate-limit')` 解除 Chromium 帧率限制
- `app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')` 禁用 GPU 着色器磁盘缓存
- Spine 引擎内部使用 `frameInterval = 1 / rate` 跳帧渲染
- WebGL 渲染循环使用 `requestAnimationFrame`（Chromium 不会节流 RAF）
- 帧率变更通过 IPC 在主进程和渲染进程间同步
- 托盘菜单提供 **30 FPS / 60 FPS** 两个勾选选项（`FRAME_RATE_OPTIONS`）
- 支持无上限模式（`rate=0` 时 `frameInterval=0`，不跳帧直接渲染）

### 3. Spine 渲染

- 使用 `spine-webgl.js`（Spine 4.x WebGL 运行时），非官方 npm 包
- 自行管理 AssetManager 加载 `.skel` + `.atlas`
- 支持 JSON 和二进制两种 `.skel` 格式（通过文件头 `0x7b` = `{` 判断）
- 切换角色/皮肤时调用 `cleanupExcept()` 释放旧骨架 GPU 纹理防止 OOM
- **WebGL 上下文丢失恢复**：监听 `webglcontextlost` / `webglcontextrestored` 事件，丢失时暂停渲染，恢复时重建 Spine 实例重新加载模型
- **GPU 进程崩溃**：主进程监听 `gpu-process-crashed` 事件并通过 IPC 通知渲染进程，渲染进程销毁旧实例重建
- **像素 alpha 检测**：`readPixelAlpha(x, y)` 方法使用 `gl.readPixels(1px)` 读取指定坐标的 alpha 通道值，用于点击穿透判定

### 4. 交互状态机

定义在 `usePetState.ts`，状态转移链：

```
                    ┌──────────────────────┐
                    │  互动点击 (handleClick)│
                    │  打断当前所有状态      │
                    └────────┬─────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │ currentSkill 有值 │                  │ currentSkill = "none"
          ▼                  │                  ▼
   SKILL_ATTACKING           │           ATTACKING
          │                  │               │
          ▼                  │               ▼
   SKILL_ENDING (播放 End)   │           IDLE
          │                  │
     ┌────┴────┐             │
     │30% 切换  │70% 不切换   │
     ▼         ▼             │
SKILL_BEGINNING IDLE         │
     │                       │
     ▼                       │
  SKILL_IDLE                 │
     │                       │
     └── 下次互动点击 ───────┘

STARTING → IDLE → ATTACKING
    ↓
  DYING → quitApp
```

- **全打断**：`handleClick()` 除 `DYING` 外不检查当前状态，任何状态下点击互动都立即打断进入攻击，`pendingAutoSkill` / `excludeSkill` 同步清空
- **End 即连接**：`SKILL_ATTACKING` 攻击播完后 **100% 播放 End 动画**（`SKILL_ENDING`），不再有直接跳回 `SKILL_IDLE` 的路径。End 是技能过渡的唯一连接点
- **切换概率**：`STATE_CONFIG.P_skill_switch: 0.3`，End 播完后 30% 概率尝试切换到另一个 skill
- **排除来源**：`excludeSkill` 记录切换来源，防止 3→2→3→2 来回弹跳（仅 2 个 skill 时最多切一次就回落 IDLE）
- **降级安全**：目标 skill 缺少 `Begin` / `Idle` 动画时，`pendingAutoSkill` 置 `none`，End 后直接回 IDLE
- **气泡系统**（PetCanvas.vue 内联实现）：
  - 多气泡堆叠：使用 `column-reverse` flex 布局，新气泡在底部，旧气泡往上挤
  - 气泡 2.5s 后渐出（0.3s 过渡动画），无最大数量限制
  - 角色专属气泡：通过 `CHAR_BUBBLE_TEXTS` 按角色 ID 配置，同异格组可共享
  - 通用气泡兜底：`GENERIC_TEXTS` 列表

**气泡系统**（PetCanvas.vue 内联实现）：
- 多气泡堆叠：使用 `column-reverse` flex 布局，新气泡在底部，旧气泡往上挤
- 气泡 2.5s 后渐出（0.3s 过渡动画），无最大数量限制
- 角色专属气泡：通过 `CHAR_BUBBLE_TEXTS` 按角色 ID 配置，同异格组可共享
- 通用气泡兜底：`GENERIC_TEXTS` 列表

### 5. 角色数据模型

`characters.json` 结构（自动生成）：

```json
{
  "id": "char_2025_shu",
  "name": "黍",
  "meta": {
    "prefix": "https://torappu.prts.wiki/assets/char_spine/char_2025_shu/",
    "name": "黍",
    "skin": {
      "默认": { "正面": { "file": "front_default" }, "背面": { "file": "back_default" } },
      "皮肤名": { "正面": { "file": "front_skin1" } }
    }
  }
}
```

- `file` 值会追加到 `prefix` 后，自动拼接 `.skel` / `.atlas` 加载
- 每个 `skin` 下的 model 可以指定 `skin` 字段覆盖骨架内部皮肤名

**分组系统**（`config.ts` + `character-groups.ts`）：
- `ALTER_GROUPS` 手动维护异格分组（如阿米娅 3 个版本、德克萨斯 2 个版本等）
- `buildGroupList()` 自动将分组角色和单角色合并为 `GROUP_LIST`，按字数 → 拼音排序
- `getCharacterAlters()`、`getGroup()`、`getGroupId()` 提供运行时查询
- `NAME_TRANSLATIONS` 将 PRTS wiki 的英文名映射为中文社区名

**异格分组**（`character-groups.ts` 手动维护）：
- 34 个异格组，涵盖罗德岛干员的各种异格版本
- 导出 `getAlterGroup()`、`isSameCharacter()`、`getSiblingAlters()` 等查询函数

### 6. 构建配置

- `vite.config.ts`：自动在启动前复制 `electron/preload.cjs` 到 `dist-electron/`
- `vite-plugin-electron` 配置两个入口：`electron/main.ts`（主进程）+ `electron/preload-anim.ts`（动画窗口预加载）
- `electron/preload-anim.ts` 通过 vite-plugin-electron 编译到 `dist-electron/`，暴露 `animAPI`（`onAnimList` / `playAnim` / `closeAnimWindow`）
- electron-builder 配置在 `package.json` 的 `"build"` 字段中
- 打包为 portable（单 exe 文件），无需安装
- 窗口设置：`transparent: true`、`frame: false`、`skipTaskbar: true`、`resizable: false`、`hasShadow: false`、`backgroundThrottling: false`

**主进程额外特性**：
- `powerSaveBlocker.start('prevent-app-suspension')` 防止系统电源管理节流
- `app.on('gpu-process-crashed')` 监听 GPU 进程崩溃，通过 IPC 通知渲染进程自动恢复
- 命令行开关：`disable-frame-rate-limit` + `disable-gpu-shader-disk-cache`
- 窗口关闭隐藏而非退出（隐藏到托盘），`isQuitting` 标记控制真正退出
- 窗口位置通过 `moved` / `resized` 事件自动保存
- **使用说明窗口**：`openHelpWindow()` 打开内嵌的 `help/index.html`（640x480 无边框窗口，随 exe 打包）

### 7. PetCanvas.vue 功能总览

**渲染模式**
- 通过 `window.location.hash` 区分三种渲染模式：`#/anim-panel`（动画面板子窗口）、`#/menu-panel`（设置面板子窗口）、`#/action-panel`（操作面板子窗口）、无 hash（主窗口）

**角色管理**（设置面板子窗口 `#/menu-panel`）
- **角色搜索**：设置面板带搜索框，按角色名过滤 `GROUP_LIST`（通过 IPC 同步）
- **异格切换**：组内多角色（如阿米娅 3 个版本）通过异格按钮行横排切换
- **皮肤 & 模型选择**：皮肤列表自动排序（"默认"置顶），模型按"正面→背面→基建"排序
- 角色列表区域 `max-height: 200px`，防止滚动过快

**动画面板**（独立子窗口 `#/anim-panel`，胶囊拖拽条可移动）
- 所有动画平铺显示，无分组
- 动画名按 `_` 拆分逐段翻译（如 `attack_begin` → `攻击_开始`）
- **点播开关**：开启后点击动画名立即播放；关闭后按钮置灰只读
- **循环开关**：开启后当前动画持续循环播放
- **循环高亮**：循环中的动画按钮自动变蓝高亮（`.menu-btn.active`），让用户知道当前循环的是哪个动作

**操作面板**（独立子窗口 `#/action-panel`，启动时自动打开）
- 横向 4 个方形按钮（42×42），图标在上文字在下：
  - **互动**：触发 PetState `handleClick`，基建模式下随机播放动画
  - **翻转**：左右镜像（`scaleX(-1)`）
  - **动画**：开关动画面板子窗口
  - **设置**：开关设置面板子窗口
- 按钮为静态样式（无 hover/active 变色）
- 顶部胶囊拖拽条移动面板位置
- 位置自动保存到 `pet-settings.json`

**主窗口**（无 hash）
- 底部无任何按钮栏
- 交互方式：Alt+拖拽移动窗口，滚轮缩放角色
- 点击 canvas 区域可关闭面板子窗口

**Debug 工具**
- `Ctrl+Shift+F`：切换 FPS 覆盖层（实时帧率显示，通过 `__fpsCallback` 采样）
- **错误捕获**：`window.onerror` + `unhandledrejection` 自动捕获运行时错误，显示在左下角
- 托盘菜单「显示边界」可切换 Debug 模式（红色场景边界 + 蓝色交互区边界）

**跨窗口通信**
- 主窗口 ↔ 面板子窗口通过主进程中继 IPC
- `panel-action`：面板 → 主窗口（用户操作）
- `panel-state`：主窗口 → 面板（状态同步）
- `request-panel-state`：面板窗口首次打开时请求初始状态
- `panel-visibility-changed`：面板关闭时通知主窗口

**页面可见性处理**
- 窗口隐藏时暂停 Spine 渲染（`document.hidden` → `spine.pause()`）释放 GPU 负载
- 窗口恢复时自动恢复渲染循环（`spine.resume()`）

**缩放系统**
- 窗口尺寸 = 屏幕工作区（`workArea`），无边框全屏透明
- Canvas 内部分辨率 1000x1000
- CSS 尺寸 = `baseCanvasSize(400) × scale`，范围 100%～135%，步进 5%

**点击穿透系统**
- 鼠标每帧移动时调用 `spine.readPixelAlpha()` 读 WebGL canvas 对应像素的 alpha
- alpha > 10（在模型上）→ `setIgnoreMouseEvents(false)` → 正常交互
- alpha ≤ 10（空白区域）→ `setIgnoreMouseEvents(true, { forward: true })` → 穿透到下层窗口
- UI 按钮/面板区域（`.bottom-bar`、`.anim-bar`、`.context-menu`）跳过检测，始终可交互
- Alt 键按下时强制关闭穿透，确保 `pointerdown` 能到达 JS 触发拖拽

### 8. 资源缓存（24h TTL）

**动机**：Spine 资源依赖 PRTS wiki CDN，翻墙不稳定。缓存让常用角色离线可用，每天清理一次确保及时响应 CDN 更新。

**存储位置**：`app.getPath("userData")/assets/cache/{characterId}/`
- `.meta.json` — 缓存元信息（版本、缓存时间、文件列表）
- `.skel` / `.atlas` / `.png` — 原始 Spine 文件

**缓存逻辑**（`cachePrepareHandler` in `electron/main.ts`）：
1. 检查 `.meta.json` 是否存在且 `cachedAt < 24h`
2. 同时检查本次请求的 `.skel` / `.atlas` 是否在文件列表中
3. 有效 → 返回 `asset-cache://` 协议 URL
4. 过期或不完整 → 下载缺失文件，写 `.meta.json`
5. 解析 `.atlas` 自动发现所有纹理页 `.png` 一并缓存

**传输机制**：
- `protocol.handle('asset-cache', ...)` 在 `app.whenReady()` 中注册
- 将 `asset-cache://{charId}/{filename}` 映射到本地缓存目录
- 使用 `net.fetch(file://URL)` 从磁盘读取
- 必须先通过 `protocol.registerSchemesAsPrivileged` 注册以支持 fetch API

**调用链路**（自动透明，PetCanvas.vue 无感知）：
```
spine.load(name, skelUrl, atlasUrl, ...)
  → resolveCachePaths(name, skelUrl, atlasUrl)
    → electronAPI.cachePrepare(charId, skelUrl, atlasUrl)
      → [main] cachePrepareHandler() — 检查/下载
      ← { skel: "asset-cache://...", atlas: "asset-cache://..." } | null
  → 若成功，AssetManager 从 asset-cache:// 加载；否则走原始 CDN URL
```

**启动清理**：`app.whenReady()` 时自动调用 `cleanExpiredCache()`，扫描所有缓存目录，删除 `cachedAt > 24h` 的角色缓存。

**降级**：缓存系统所有环节均有 try/catch，任意失败静默回退 CDN URL。

### 9. 角色数据自动更新（7 天限流）

**动机**：`characters.json` 需要手动跑脚本更新，新干员上线后不会自动出现。本机制在启动时静默检查 PRTS wiki，有新干员时自动下载合并。

**检查逻辑**（`electron/update-characters.ts` + `electron/main.ts`）：
1. 启动时检查 `app.getPath("userData")/characters-check.json` 中的上次检查时间
2. 若距上次检查 **≥7 天**，向 PRTS wiki (MediaWiki API) 发起一次请求获取干员总数
3. 比较本地 `characters.json` 中的角色 ID 列表
4. 如有新 ID，逐个请求 CDN 上的 `meta.json` 获取 Spine 数据
5. 合并到 `app.getPath("userData")/assets/characters.json`

**调用链路**（PetCanvas.vue onMounted 时自动执行）：
```
PetCanvas onMounted
  → electronAPI.getCharactersData()     // 读取 userData 已有版本
  → 若有更新版且比内置多 → applyCharactersUpdate()
  → electronAPI.checkCharactersUpdate()  // 7 天限流检查 PRTS wiki
  → 若有新角色 → getCharactersData() 读取 → applyCharactersUpdate()
```

**`applyCharactersUpdate()`**（`config.ts`）：
- 原地替换 `CHARACTERS` / `GROUP_LIST` / `CHAR_TO_GROUP` 的内容
- 保持数组和对象引用不变，所有 computed / watch 自动跟踪新数据
- 新角色立刻出现在设置菜单的角色列表中

**核心文件**：
- `electron/update-characters.ts` — MediaWiki API 查询 + meta.json 下载逻辑
- `electron/main.ts` — IPC handler（`check-characters-update` + `get-characters-data`）
- `electron/preload.ts` / `.cjs` — 暴露 API
- `src/features/pet/config.ts` — `applyCharactersUpdate()` 数据替换函数
- `src/features/pet/PetCanvas.vue` — onMounted 触发检查 + `onForceCharUpdate` 监听

**手动触发**：托盘菜单「检查角色更新」按钮始终可用，不受 7 天限制，结果通过气泡反馈。

### 10. 使用说明窗口

- `help/index.html` 静态 HTML 使用手册，通过 `electron-builder` 的 `files` 配置打包进 exe
- 托盘菜单「使用说明」按钮调用 `openHelpWindow()` 打开 640×480 的 BrowserWindow
- 窗口加载 `join(__dirname, "../help/index.html")`（开发/打包路径一致）
- 单例窗口（已打开时 focus，关闭时置 null）

### 11. 操作面板开发规范（`#/action-panel`）

操作面板是替代原底部按钮栏的独立 BrowserWindow，遵循以下规范：

**窗口管理**（`electron/main.ts`）
- 变量 `actionPanelWindow`，与 `animPanelWindow`/`menuPanelWindow` 并列
- `createPanelWindow("/action-panel", 210, 90)` 创建，初始尺寸 210×90
- 启动时 500ms 延迟自动打开（`setTimeout` in `app.whenReady()`）
- `ipcMain.on("show-action-panel")` / `"hide-action-panel"` 控制显隐
- 托盘菜单「显示/隐藏操作栏」控制开关
- `panel-drag-start/move/end` IPC 共享同一套拖拽逻辑
- `panel-state` IPC 同时分发给 actionPanelWindow
- `before-quit` 时 destroy

**面板位置持久化**
- 通过 `panel-drag-end` IPC（`onPanelHeaderUp` 中调用）保存到 `pet-settings.json`
- `createPanelWindow` 中调用 `loadPanelPosition(panelKey)` 恢复位置
- panelKey: `"actionPanel"`，与 `"animPanel"`/`"menuPanel"` 并列

**Hash 路由**（`PetCanvas.vue`）
- `isPanelMode` computed 必须包含 `"action"` 分支：
  ```ts
  if (h === "#/action-panel") return "action" as const;
  ```
- 模板分支：`v-else-if="isPanelMode === 'action'"`，位于 menu 之后、main 之前

**UI 设计**
- 横向排列方形按钮（42×42），图标在上、文字在下
- 按钮总数：5 个（互动、翻转、动画、设置、帮助）
- 帮助按钮发送 `open-help` → 主窗口 IPC 调用 `openHelpWindow()` 打开 `help/index.html`
- 按钮**静态样式**：无 `:hover` 变色、无 `:active` 缩放、无 `.active` 高亮
- 使用 `cursor: default` 而非 `pointer`
- 类名：`.action-row`（flex 容器）、`.action-btn`（方形按钮）、`.action-label`（文字）
- 顶部胶囊拖拽条 `.drag-pill` 复用其他面板样式

**缩放/拖拽按钮已移除**
- 缩放功能由主窗口鼠标滚轮替代（`@wheel.prevent="onWheel"` 在 `.interact-layer`）
- 拖拽功能由顶部胶囊拖拽条替代，**不再有独立的拖拽按钮**

**数据交互**
- 按钮发送 IPC：`sendAction("interact")`、`sendAction("toggle-flip")`、`sendAction("toggle-anim")`、`sendAction("toggle-menu")`
- 主窗口 `onPanelAction` handler 接收并执行（`else if (type === "interact")` 等分支）
- 主窗口通过 `syncPanelState` 的 `actionState` 字段同步翻转和面板可见性：
  ```ts
  actionState: {
    flipped: isFlipped.value,
    showAnimPanel: showAnimPanel.value,
    showMenuPanel: showMenuPanel.value,
  }
  ```
- `onPanelState` handler 中更新 `actionFlipped`、`actionAnimVisible`、`actionMenuVisible`
- 操作面板不接收 `scale`（已删除缩放功能）

**面板自适应大小**
- `fitPanelSize` 中对 action panel 特殊处理：固定宽度 210px，不额外加 padding
- `setPanelSize` IPC handler 中对 action panel 特殊处理：`minW=190, maxW=280, minH=70`
- 操作面板只有 4 个按钮 + 拖拽条，紧凑布局

**尺寸计算**
- 5 个按钮（42×42 + 6px gap + 8px padding）= 242px 宽
- 拖拽条（~20px）+ 按钮行（42px）+ padding = ~80px 高
- `fitPanelSize` 只传实际内容高度，`setPanelSize` 统一 +12px 间距

### 12. IPC 序列化规则（从崩溃中总结）

**绝对不要传 `undefined` 给 `ipcRenderer.send()` / `ipcRenderer.invoke()`。**

Electron 的 V8 ValueSerializer 不支持 `undefined` 作为顶层 IPC 参数值，在部分环境（如用户名含中文的用户电脑）下会直接抛 `Uncaught Exception` 崩溃。

**七层防御体系**（按发现顺序逐层加固）：

```
渲染进程 IPC 调用
    │
    ▼
① safeSend / safeInvoke：undefined → null
② sanitizeIPC：控制字符 + 异常浮点数消毒
③ 拖拽节流：pointermove → 最多 30fps 发 IPC（防高刷屏 DWM 卡死）
    │
    ▼
④ main.ts typeof/NaN 类型守卫
⑤ JSON.parse(JSON.stringify()) 深度净化（panel-action/state）
⑥ 逐窗口独立 try/catch（panel-state）
⑦ process.on('uncaughtException') 最后兜底
```

**sanitizeIPC 整数消毒**（v2.1.2+）：拖拽时 IPC 传的 `dx/dy` 浮点数，在高刷屏（144Hz+）或特定 GPU 驱动下可能产生异常值（NaN / Infinity / -0 / 次正规数）。V8 ValueSerializer 在不同 CPU/GPU 微架构上对这些值的处理不一致，导致序列化崩溃。

```js
// sanitizeIPC 中的数字消毒
if (typeof value === 'number') {
  if (isNaN(value)) return 0;
  if (!isFinite(value)) return value > 0 ? 1e308 : -1e308;
  if (value === 0) return 0; // 消除 -0
  if (Math.abs(value) < 2.2250738585072014e-308) return 0; // 次正规数 → 0
  return value;
}
```

**拖拽 IPC 节流**（v2.1.2+）：主窗口和面板拖拽时，pointermove 每帧都发 `window-drag-move` / `panel-drag-move` IPC。高刷屏（165Hz）每秒 165 次 `setPosition()` 调用 Windows DWM 合成透明窗口，在 AMD Vega 核显 + Win11 组合下 DWM 可能挂住，导致主进程事件循环阻塞，所有交互停止但进程不崩溃。

```ts
// usePetDrag.ts + PetCanvas.vue 面板拖拽
const DRAG_MOVE_THROTTLE_MS = 33; // ~30fps
const now = performance.now();
if (now - lastDragMoveTime < DRAG_MOVE_THROTTLE_MS) return;
lastDragMoveTime = now;
```

**GPU 偏好**（v2.1.3+）：Spine WebGL 上下文创建时设置 `powerPreference: "high-performance"`，引导 Chromium 优先使用独立显卡（如 RTX 3060）而非核显（AMD Vega 8）。Vega 核显的 OpenGL 驱动在 Win11 上稳定性差，复杂模型下易出现驱动重置或线条错乱。此设置无独显时自动回退核显，不影响无独显的电脑。

```ts
this.context = new sp.webgl.ManagedWebGLRenderingContext(canvas, {
  alpha: true,
  premultipliedAlpha: true,
  powerPreference: "high-performance", // 优先独显
});
```

### 13. 日志系统

**动机**：用户电脑上多次出现 IPC 序列化崩溃，无法在本机复现，需要完整的文件日志来远程排查。

**日志位置**：
- **开发模式**（`pnpm dev`）：项目根目录 `logs/pet-YYYY-MM-DD.log`
- **打包后**：exe 同级目录 `logs/pet-YYYY-MM-DD.log`
  - 便携版：`%TEMP%/xxx/logs/`（运行期有效，系统可能清理）
  - 文件夹版：`win-unpacked/logs/`（持久保留，**推荐用于排查问题**）
  - NSIS 安装版：安装目录 `logs/`
- **降级**：exe 同级目录不可写时自动降级到 `app.getPath("userData")/logs/`

**架构**：
```
渲染进程 (PetCanvas / spine / usePetState / usePetDrag)
  │  logError / logWarn / logInfo / logDebug
  ▼
src/utils/logger.ts          ← 渲染进程日志桥接（IPC 'log-entry' 通道）
  │
  ▼
electron/preload.cjs         ← safeSend/safeInvoke 内联日志（IPC 参数摘要 + undefined 检测）
  │
  ▼
electron/main.ts             ← log-entry IPC handler + 全量 IPC handler 日志
  │
  ▼
electron/logger.ts           ← 文件写入（appendFileSync）+ 按天轮转 + 旧日志清理
  │
  ▼
logs/pet-YYYY-MM-DD.log      ← 最终落盘
```

**日志格式**：`[ISO时间戳] [级别] [来源] 消息 {JSON数据}`

```
[2026-07-23T14:30:05.123Z] [ERROR] [Main] panel-action 转发失败 {"dataType":"object","error":"..."}
[2026-07-23T14:30:05.456Z] [DEBUG] [Preload] IPC→ set-ignore-mouse-events {"args":["boolean","object"]}
[2026-07-23T14:30:06.789Z] [WARN] [Main] window-drag-move 参数非法 {"dx":"undefined","dy":123}
[2026-07-23T14:30:07.012Z] [INFO] [Renderer] 模型加载成功 {"charId":"char_2025_shu","skin":"默认","model":"正面"}
```

**日志级别**：

| 级别 | 用途 | 示例 |
|------|------|------|
| ERROR | 崩溃、不可恢复错误 | IPC 序列化失败、GPU 崩溃、模型加载失败 |
| WARN | 可恢复异常、防御性拦截 | undefined→null 转换、参数非法被跳过、WebGL context lost |
| INFO | 正常业务流程 | 启动完成、模型加载成功、角色切换、窗口创建 |
| DEBUG | 详细 IPC 追踪 | 每次 IPC send/invoke、状态转移、面板拖拽 |

**覆盖范围**：
- **38 个 IPC 通道**全量追踪（preload 层记录每次调用的参数类型，main 层记录处理结果）
- **所有错误处理点**：~15 处空 catch 全部增强为文件日志
- **7 层 IPC 防御**每层加观测：undefined→null (WARN)、参数非法 (WARN)、序列化失败 (ERROR)
- **应用生命周期**：启动、窗口创建、面板创建/销毁、GPU 崩溃、退出
- **Spine 引擎**：构造、加载开始/成功/失败、context lost/restored、render 异常、destroy
- **状态机**：每次状态转移 (DEBUG)、playOnce/playLoop 失败 (WARN)
- **高频路径限频**：render 异常每 10s 最多记一次，防止日志爆炸

**关键模块**：

| 文件 | 职责 |
|------|------|
| `electron/logger.ts` | 主进程日志核心：`getLogDir()`、`getLogPath()`、`writeToFile()`、`cleanOldLogs()`、导出 `logError/logWarn/logInfo/logDebug` |
| `src/utils/logger.ts` | 渲染进程日志桥接：IPC 'log-entry' 通道 + 就绪前缓冲（100条）+ console 双写 |
| `electron/preload.cjs` | 新增 `logToMain()` + `summarizeArgs()`，safeSend/safeInvoke 增强：记录 IPC 调用 + 检测 undefined→null + invoke 失败 catch |
| `electron/preload.ts` | 与 preload.cjs 保持同步 |
| `electron/preload-anim.ts` | `safeSendAnim` 增强，记录动画窗口 IPC 调用 |

**设计原则**：
1. 日志本身不能崩溃：所有 log 调用最外层 try/catch，写文件失败静默跳过
2. 不记录完整大对象：panel-state data 只记录顶层 keys，字符串超过 80 字符截断
3. safeInvoke 的 `.catch()` 必须 re-throw：记录 ERROR 日志后 `throw err`，保持原有行为
4. 不改变任何现有业务逻辑：日志纯粹是观测性代码
5. `process.on('uncaughtException')` 是最后防线：在 Electron 弹出崩溃对话框之前把错误写进日志，定位 IPC 反序列化等发生在 C++ 层的崩溃

## 编码约定

- **语言**: 中文注释（代码中用中文解释业务逻辑）
- **类型**: 所有 Vue 组件使用 `<script setup lang="ts">`
- **样式**: `<style scoped>` 书写 CSS，不用预处理器
- **状态管理**: 使用 Vue ref / computed / composable，无 Pinia/Vuex
- **IPC 通信**: 渲染器通过 `window.electronAPI`（contextBridge 暴露） → 主进程 `ipcMain.on`
- **资源路径**: 使用 `@/` 别名指向 `src/`
- **持久化**: 用户设置存 `localStorage`（key: `shu-pet-settings`，含 groupId/characterId/skin/model/scale/flipped/frameRate/animClickPlay/animLoop/alwaysOnTop/面板位置），窗口位置存 `app.getPath("userData")/pet-settings.json`

## 角色数据维护

运行 `node scripts/discover-characters.mjs` 可从 PRTS wiki 自动拉取所有干员 ID 和 Spine 元数据。该脚本：
1. 通过 MediaWiki API 获取所有干员页面
2. 提取 `char_xxxx_name` 格式的干员 ID
3. 逐个请求 CDN 上的 `meta.json` 检查是否有 Spine 数据
4. 输出到 `src/features/pet/characters.json`

异格分组需手动维护 `src/features/pet/character-groups.ts`。

## 常见问题

- **角色加载失败**: CDN 资源可能需翻墙，或角色 ID 变更
- **GPU 内存不足**: `cleanupExcept()` 会释放旧纹理，如果仍有 OOM 可降低帧率
- **窗口移动**：使用 Alt+拖拽（主窗口）或拖拽面板顶部的 `⋮⋮` 胶囊条
- **操作面板不见了**：托盘菜单 → 「显示/隐藏操作栏」可重新打开
- **窗口不透明**: 确保 Canvas 背景为透明（`alpha: true` + `premultipliedAlpha: true`）
- **WebGL 上下文丢失**: 程序会自动尝试重建 Spine 实例并重新加载模型，GPU 进程崩溃也会自动恢复
- **动画面板不显示动画**: 部分干员没有技能动画（无 `Skill_` 前缀分组），动画面板可能为空
