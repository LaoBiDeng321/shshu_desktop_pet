import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, powerSaveBlocker, protocol, net } from "electron";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import type { CharacterEntry } from "./update-characters";
import { logError, logWarn, logInfo, logDebug, cleanOldLogs } from "./logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 进程级未捕获异常 — 在崩溃对话框弹出前写日志
// 这是最后的防线：IPC 反序列化崩溃发生在 C++ 层，
// ipcMain.on handler 里的 try/catch 根本执行不到
// ============================================================
process.on("uncaughtException", (error) => {
  // 用最原始的方式写日志，不依赖任何可能已损坏的状态
  try {
    logError("Main", "未捕获异常 (uncaughtException)", {
      message: error.message,
      stack: error.stack?.slice(0, 1000),
      name: error.name,
    });
  } catch {
    // 连日志都写不了就彻底没办法了
    console.error("[Main] 未捕获异常:", error);
  }
  // 重要：不调用 process.exit()，让 Electron 显示默认对话框
  // 用户至少能看到报错信息，也能截图发给我们
});

let mainWindow: BrowserWindow | null = null;
let animPanelWindow: BrowserWindow | null = null;
let menuPanelWindow: BrowserWindow | null = null;
let actionPanelWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// 持久化状态（从渲染器同步）
let currentFrameRate = 30;
let isAlwaysOnTop = true;
let isDebug = false;

const FRAME_RATE_OPTIONS = [
  { label: "30 FPS", value: 30 },
  { label: "60 FPS", value: 60 },
] as const;

// ============================================================
// 资源缓存 — 24h TTL
// ============================================================

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCacheDir(): string {
  return join(app.getPath("userData"), "assets", "cache");
}

/** 从 URL 中提取文件名（含扩展名），仅用于只需文件名的地方 */
function filenameFromUrl(url: string): string {
  return url.substring(url.lastIndexOf("/") + 1).split("?")[0];
}

/**
 * 从完整 URL 提取相对于角色目录的路径（保留子目录），
 * 用于区分正背面等不同视角的 Spine 文件。
 * URL: .../char_2025_shu/defaultskin/front/char_2025_shu.skel
 *   → "defaultskin/front/char_2025_shu.skel"
 */
function cacheRelPathFromUrl(url: string, characterId: string): string {
  const marker = `/${characterId}/`;
  const idx = url.indexOf(marker);
  if (idx !== -1) {
    return url.substring(idx + marker.length);
  }
  // 回退：只取文件名（保持兼容）
  return url.substring(url.lastIndexOf("/") + 1).split("?")[0];
}

/** 本地绝对路径 → file:// URL（encodeURI 处理中文路径，匹配 getAppURL 的做法） */
function localPathToFileUrl(filePath: string): string {
  return encodeURI("file:///" + filePath.replace(/\\/g, "/"));
}

/** 解析 .atlas 文件内容，提取所有纹理页文件名（.png 等） */
function parseAtlasPages(atlasText: string): string[] {
  const pages: string[] = [];
  for (const line of atlasText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 缩进的行是 region 名或属性，跳过
    if (trimmed !== line) continue;
    // 非缩进且扩展名匹配 → 纹理页文件名
    if (/\.(png|jpg|jpeg|gif|webp)$/i.test(trimmed)) {
      pages.push(trimmed);
    }
  }
  return pages;
}

/** 从 CDN 下载文件到本地缓存 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(destPath, buffer);
}

/**
 * 缓存准备：检查 / 下载角色所需的所有 Spine 文件
 * 返回 { skel, atlas } 可通过 asset-cache:// 协议访问的 URL
 */
async function cachePrepareHandler(
  _event: Electron.IpcMainInvokeEvent,
  characterId: string,
  skelUrl: string,
  atlasUrl: string
): Promise<{ skel: string; atlas: string } | null> {
  try {
    const cacheDir = getCacheDir();
    const charDir = join(cacheDir, characterId);
    const metaPath = join(charDir, ".meta.json");

    // 使用相对路径（含子目录，如 "defaultskin/front/..."）区分正背面
    const skelRel = cacheRelPathFromUrl(skelUrl, characterId);
    const atlasRel = cacheRelPathFromUrl(atlasUrl, characterId);

    let cacheFresh = false;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const age = Date.now() - new Date(meta.cachedAt).getTime();
        // 必须同时满足：未过期 + 本次请求的 .skel 和 .atlas 都在缓存中
        if (age < CACHE_TTL_MS && meta.files?.includes(skelRel) && meta.files?.includes(atlasRel)) {
          cacheFresh = true;
        }
      } catch { /* 损坏的 meta → 重新下载 */ }
    }
    if (cacheFresh) {
      return {
        skel: "asset-cache://" + characterId + "/" + skelRel.replace(/\\/g, "/"),
        atlas: "asset-cache://" + characterId + "/" + atlasRel.replace(/\\/g, "/"),
      };
    }
    // 过期或不完整 → 重新下载

    mkdirSync(charDir, { recursive: true });

    // 相对路径转本地路径（替换 / 为 \\）
    const relToLocal = (p: string) => p.replace(/\//g, "\\");

    // 1. 下载 .atlas（保留子目录结构）
    const atlasLocal = join(charDir, relToLocal(atlasRel));
    await downloadFile(atlasUrl, atlasLocal);

    // 2. 解析 .atlas 找出所有 .png 纹理页
    const atlasText = readFileSync(atlasLocal, "utf-8");
    const pages = parseAtlasPages(atlasText);

    // 3. 下载每个纹理页（与 .atlas 同目录）
    const baseUrl = atlasUrl.substring(0, atlasUrl.lastIndexOf("/") + 1);
    const atlasDir = dirname(atlasRel.replace(/\//g, "\\"));
    for (const page of pages) {
      const pageRel = atlasDir ? `${atlasDir}\\${page}` : page;
      const pagePath = join(charDir, pageRel);
      if (!existsSync(dirname(pagePath))) {
        mkdirSync(dirname(pagePath), { recursive: true });
      }
      if (!existsSync(pagePath)) {
        await downloadFile(baseUrl + page, pagePath);
      }
    }

    // 4. 下载 .skel（保留子目录结构）
    await downloadFile(skelUrl, join(charDir, relToLocal(skelRel)));

    // 5. 写元信息
    const filesList = [skelRel, atlasRel];
    for (const page of pages) {
      filesList.push(atlasDir ? `${atlasDir.replace(/\\/g, "/")}/${page}` : page);
    }
    writeFileSync(
      metaPath,
      JSON.stringify({
        version: 2,
        cachedAt: new Date().toISOString(),
        characterId,
        files: filesList,
      })
    );

    return {
      skel: "asset-cache://" + characterId + "/" + skelRel.replace(/\\/g, "/"),
      atlas: "asset-cache://" + characterId + "/" + atlasRel.replace(/\\/g, "/"),
    };
  } catch (e) {
    console.error("[Cache] cachePrepare 失败:", e);
    return null; // 让调用方回退 CDN
  }
}

/** 清理所有过期缓存（>24h） */
function cleanExpiredCache(): string[] {
  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) return [];
  const removed: string[] = [];
  const entries = readdirSync(cacheDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(cacheDir, entry.name, ".meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      const age = Date.now() - new Date(meta.cachedAt).getTime();
      if (age >= CACHE_TTL_MS) {
        rmSync(join(cacheDir, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
    } catch {
      // 损坏的元信息 → 删掉
      rmSync(join(cacheDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

// ============================================================
// 设置持久化（窗口位置 + 面板位置）
// ============================================================

interface PetSettings {
  x?: number; y?: number;
  animPanel?: { x: number; y: number };
  menuPanel?: { x: number; y: number };
  actionPanel?: { x: number; y: number };
}

function getSettingsPath(): string {
  const userData = app.getPath("userData");
  return join(userData, "pet-settings.json");
}

function loadAllSettings(): PetSettings {
  try {
    const p = getSettingsPath();
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch { /* 静默忽略 */ }
  return {};
}

function saveSettings(partial: Partial<PetSettings>): void {
  try {
    const userData = app.getPath("userData");
    if (!existsSync(userData)) mkdirSync(userData, { recursive: true });
    const existing = loadAllSettings();
    writeFileSync(getSettingsPath(), JSON.stringify({ ...existing, ...partial }));
  } catch { /* 静默忽略 */ }
}

function loadWindowSettings(): { x?: number; y?: number } {
  const data = loadAllSettings();
  if (typeof data.x === "number" && typeof data.y === "number") {
    return { x: data.x, y: data.y };
  }
  return {};
}

// 保留旧接口兼容性（被主窗口 moved 事件间接调用）
function saveWindowSettings(x: number, y: number): void {
  saveSettings({ x, y });
}

function loadPanelPosition(panelKey: keyof PetSettings): { x: number; y: number } | null {
  const data = loadAllSettings();
  const pos = data[panelKey];
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    return pos;
  }
  return null;
}

function createWindow() {
  // workArea 含 x,y,width,height（考虑任务栏位置），比 workAreaSize 更准确
  const { x: areaX, y: areaY, width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workArea;

  mainWindow = new BrowserWindow({
    width: screenWidth,
    height: screenHeight,
    x: areaX,
    y: areaY,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    webSecurity: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  // 提升置顶层级（pop-up-menu 为最高可用级别）
  mainWindow.setAlwaysOnTop(true, "pop-up-menu");

  // 开发模式加载 Vite dev server，生产模式加载打包文件
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }

  // 窗口移动时通知渲染进程更新 windowScreenPos（用于面板/场景坐标计算）
  mainWindow.on("moved", () => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.webContents.send("window-position-changed", { x, y });
    }
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

// ============================================================
// 面板子窗口（独立 BrowserWindow，不受主窗口边界限制）
// ============================================================

/** 获取当前加载 URL（开发模式 Vite dev server 或生产模式 file://） */
function getAppURL(hash: string): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL + "#" + hash;
  }
  // 用 encodeURI 编码非 ASCII 字符（如中文用户名），防止 Electron 加载失败
  const indexPath = join(__dirname, "../dist/index.html");
  const fileUrl = "file:///" + indexPath.replace(/\\/g, "/");
  return encodeURI(fileUrl) + "#" + hash;
}

function createPanelWindow(hash: string, width: number, height: number): BrowserWindow {
  // 尝试恢复上次保存的面板位置
  const panelKey = hash === "/anim-panel" ? "animPanel"
    : hash === "/menu-panel" ? "menuPanel"
    : "actionPanel";
  const saved = loadPanelPosition(panelKey);
  const win = new BrowserWindow({
    width,
    height,
    x: saved?.x ?? 100,
    y: saved?.y ?? 100,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.loadURL(getAppURL(hash));

  // 点击关闭按钮隐藏面板，不退出
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      // 通知主窗口面板已关闭
      mainWindow?.webContents.send("panel-visibility-changed", { panel: hash, visible: false });
    }
  });

  return win;
}

let helpWindow: BrowserWindow | null = null;

function openHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    width: 640,
    height: 520,
    resizable: false,
    title: "使用说明 - 方舟桌面宠物",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  helpWindow.loadFile(join(__dirname, "../help/index.html"));
  helpWindow.on("closed", () => { helpWindow = null; });
}

function createTray() {
  const iconPath = join(__dirname, "../electron/tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);

  buildTrayMenu();

  tray.setToolTip("黍 - 桌面宠物");
  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function buildTrayMenu() {
  const frameRateSubmenu = FRAME_RATE_OPTIONS.map((opt) => ({
    label: opt.label,
    type: "checkbox" as const,
    checked: currentFrameRate === opt.value,
    click: () => {
      currentFrameRate = opt.value;
      mainWindow?.webContents.send("set-frame-rate", opt.value);
      buildTrayMenu();
    },
  }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示/隐藏",
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow?.show();
          mainWindow?.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "置顶",
      type: "checkbox",
      checked: isAlwaysOnTop,
      click: (e) => {
        isAlwaysOnTop = e.checked;
        mainWindow?.setAlwaysOnTop(e.checked, "pop-up-menu");
        buildTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "帧率",
      submenu: frameRateSubmenu,
    },
    { type: "separator" },
    {
      label: "显示/隐藏操作栏",
      click: () => {
        if (actionPanelWindow && !actionPanelWindow.isDestroyed() && actionPanelWindow.isVisible()) {
          actionPanelWindow.hide();
        } else {
          if (!actionPanelWindow || actionPanelWindow.isDestroyed()) {
            actionPanelWindow = createPanelWindow("/action-panel", 242, 90);
          }
          actionPanelWindow.show();
          actionPanelWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "显示边界",
      type: "checkbox",
      checked: isDebug,
      click: (e) => {
        isDebug = e.checked;
        mainWindow?.webContents.executeJavaScript("window.__toggleDebug && window.__toggleDebug()");
      },
    },
    {
      label: "使用说明",
      click: () => openHelpWindow(),
    },
    { type: "separator" },
    {
      label: "检查角色更新",
      click: () => {
        mainWindow?.webContents.send("force-char-update");
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray?.setContextMenu(contextMenu);
}

// IPC 处理
let dragStartWinPos = { x: 0, y: 0 };

ipcMain.on("window-drag-start", () => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  dragStartWinPos = { x, y };
  logDebug("Main", "IPC← window-drag-start", { winPos: { x, y } });
});

ipcMain.on("window-drag-move", (_event, dx: number, dy: number) => {
  if (!mainWindow) return;
  if (typeof dx !== "number" || typeof dy !== "number" || isNaN(dx) || isNaN(dy)) {
    logWarn("Main", "window-drag-move 参数非法", { dx: typeof dx, dy: typeof dy });
    return;
  }
  mainWindow.setPosition(dragStartWinPos.x + dx, dragStartWinPos.y + dy);
});

ipcMain.on("window-drag-end", () => {
  if (mainWindow) {
    const [x, y] = mainWindow.getPosition();
    dragStartWinPos = { x, y };
    logDebug("Main", "IPC← window-drag-end", { finalPos: { x, y } });
  }
});

// 窗口位置查询（渲染进程初始化 + 面板坐标计算用）
ipcMain.handle("get-window-position", async () => {
  if (!mainWindow) return null;
  const [x, y] = mainWindow.getPosition();
  const { x: ax, y: ay, width: aw, height: ah } = screen.getPrimaryDisplay().workArea;
  const result = { x, y, availLeft: ax, availTop: ay, availWidth: aw, availHeight: ah };
  logDebug("Main", "IPC↔ get-window-position", result);
  return result;
});

ipcMain.on("resize-window", (_event, width: number, height: number) => {
  if (!mainWindow) return;
  if (typeof width !== "number" || typeof height !== "number" || isNaN(width) || isNaN(height)) {
    logWarn("Main", "resize-window 参数非法", { width: typeof width, height: typeof height });
    return;
  }
  const [x, y] = mainWindow.getPosition();
  logInfo("Main", "IPC← resize-window", { width, height });
  // setBounds 比 setSize 更可靠，在透明窗口下也能正常生效
  mainWindow.setBounds({ x, y, width, height });
});

// ============================================================
// 面板子窗口 — 显示/隐藏控制
// ============================================================

ipcMain.on("show-anim-panel", () => {
  logInfo("Main", "IPC← show-anim-panel");
  if (!animPanelWindow || animPanelWindow.isDestroyed()) {
    animPanelWindow = createPanelWindow("/anim-panel", 200, 300);
  }
  animPanelWindow.show();
  animPanelWindow.focus();
});

ipcMain.on("show-menu-panel", () => {
  logInfo("Main", "IPC← show-menu-panel");
  if (!menuPanelWindow || menuPanelWindow.isDestroyed()) {
    menuPanelWindow = createPanelWindow("/menu-panel", 200, 350);
  }
  menuPanelWindow.show();
  menuPanelWindow.focus();
});

ipcMain.on("hide-anim-panel", () => {
  logDebug("Main", "IPC← hide-anim-panel");
  animPanelWindow?.hide();
});

ipcMain.on("hide-menu-panel", () => {
  logDebug("Main", "IPC← hide-menu-panel");
  menuPanelWindow?.hide();
});

// ============================================================
// 操作面板（替代底部按钮栏，启动时自动打开）
// ============================================================

ipcMain.on("show-action-panel", () => {
  logInfo("Main", "IPC← show-action-panel");
  if (!actionPanelWindow || actionPanelWindow.isDestroyed()) {
    actionPanelWindow = createPanelWindow("/action-panel", 242, 90);
  }
  actionPanelWindow.show();
  actionPanelWindow.focus();
});

ipcMain.on("hide-action-panel", () => {
  logDebug("Main", "IPC← hide-action-panel");
  actionPanelWindow?.hide();
});

ipcMain.on("show-help-window", () => {
  logInfo("Main", "IPC← show-help-window");
  openHelpWindow();
});

// 面板窗口 JS 拖拽
let panelDragStart = { x: 0, y: 0, winX: 0, winY: 0 };

function getPanelWindow(panel: string): BrowserWindow | null {
  if (!panel) return null;
  return panel === "/anim-panel" ? animPanelWindow
    : panel === "/menu-panel" ? menuPanelWindow
    : actionPanelWindow;
}

ipcMain.on("panel-drag-start", (_event, panel: string) => {
  const win = getPanelWindow(panel);
  if (!win || win.isDestroyed()) return;
  const [wx, wy] = win.getPosition();
  panelDragStart = { x: 0, y: 0, winX: wx, winY: wy };
  logDebug("Main", "IPC← panel-drag-start", { panel, winPos: { x: wx, y: wy } });
});

ipcMain.on("panel-drag-move", (_event, panel: string, dx: number, dy: number) => {
  const win = getPanelWindow(panel);
  if (!win || win.isDestroyed()) return;
  if (typeof dx !== "number" || typeof dy !== "number" || isNaN(dx) || isNaN(dy)) {
    logWarn("Main", "panel-drag-move 参数非法", { panel, dx: typeof dx, dy: typeof dy });
    return;
  }
  win.setPosition(panelDragStart.winX + dx, panelDragStart.winY + dy);
});

ipcMain.on("panel-drag-end", (_event, panel: string) => {
  const win = getPanelWindow(panel);
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const panelKey = panel === "/anim-panel" ? "animPanel"
    : panel === "/menu-panel" ? "menuPanel"
    : "actionPanel";
  saveSettings({ [panelKey]: { x, y } });
  logDebug("Main", "IPC← panel-drag-end", { panel, savedPos: { x, y } });
});

// 面板窗口自适应大小
ipcMain.on("set-panel-size", (_event, panel: string, width: number, height: number) => {
  const win = getPanelWindow(panel);
  if (!win || win.isDestroyed()) return;
  // 防御非数字/NaN — 防止 IPC 序列化异常扩散到 C++ setBounds
  if (typeof width !== "number" || typeof height !== "number" || isNaN(width) || isNaN(height)) {
    logWarn("Main", "set-panel-size 参数非法", { panel, width: typeof width, height: typeof height });
    return;
  }
  logDebug("Main", "IPC← set-panel-size", { panel, width, height });
  const [x, y] = win.getPosition();
  // 限制最小/最大尺寸
  // 操作面板窄一些（按钮竖排），其他面板需要更宽
  const minW = panel === "/action-panel" ? 220 : 180;
  const maxW = panel === "/action-panel" ? 300 : 280;
  const w = Math.max(minW, Math.min(width + 12, maxW));
  // 传进来的 height 是内容实际高度，+12 只留圆角呼吸空间
  const minH = panel === "/action-panel" ? 70 : 100;
  const h = Math.max(minH, Math.min(height + 12, 600));
  win.setBounds({ x, y, width: w, height: h });
});

// ============================================================
// 跨窗口消息中继 — 主窗口 ↔ 面板窗口
// ============================================================

/** 面板窗口 → 主窗口：用户操作（选皮肤/角色/动画等） */
ipcMain.on("panel-action", (_event, data: unknown) => {
  if (!data) return; // 防止空数据转发触发 IPC 序列化错误
  try {
    const type = (data as any)?.type ?? "unknown";
    logDebug("Main", "IPC← panel-action", { type });
    // JSON 序列化消毒：剥离 Vue proxy / 非克隆值，防止 V8 ValueSerializer 转换失败
    const clean = JSON.parse(JSON.stringify(data));
    mainWindow?.webContents.send("panel-action", clean);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[Main] panel-action 转发失败:", e);
    logError("Main", "panel-action 转发失败", { dataType: typeof data, error: errMsg });
  }
});

/** 主窗口 → 面板窗口：状态同步（角色信息/动画列表等） */
ipcMain.on("panel-state", (_event, data: unknown) => {
  if (!data) return;
  // 深克隆净化：剥离 Vue proxy / 非克隆值，防止 V8 ValueSerializer 转换失败
  let safe: unknown;
  try { safe = JSON.parse(JSON.stringify(data)); }
  catch { safe = null; }
  if (!safe) return;
  const dataKeys = Object.keys(safe as object);
  logDebug("Main", "IPC← panel-state", { keys: dataKeys });
  // 每个窗口独立 try/catch，一个失败不影响其他窗口
  try {
    if (animPanelWindow && !animPanelWindow.isDestroyed()) {
      animPanelWindow.webContents.send("panel-state", safe);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[Main] panel-state 转发到 animPanel 失败:", e);
    logError("Main", "panel-state 转发到 animPanel 失败", { keys: dataKeys, error: errMsg });
  }
  try {
    if (menuPanelWindow && !menuPanelWindow.isDestroyed()) {
      menuPanelWindow.webContents.send("panel-state", safe);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[Main] panel-state 转发到 menuPanel 失败:", e);
    logError("Main", "panel-state 转发到 menuPanel 失败", { keys: dataKeys, error: errMsg });
  }
  try {
    if (actionPanelWindow && !actionPanelWindow.isDestroyed()) {
      actionPanelWindow.webContents.send("panel-state", safe);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[Main] panel-state 转发到 actionPanel 失败:", e);
    logError("Main", "panel-state 转发到 actionPanel 失败", { keys: dataKeys, error: errMsg });
  }
});

/** 面板窗口 → 主窗口：请求当前状态（面板首次打开时） */
ipcMain.on("request-panel-state", () => {
  logDebug("Main", "IPC← request-panel-state");
  mainWindow?.webContents.send("request-panel-state");
});

// ============================================================
// 动态鼠标穿透控制（渲染进程基于像素 alpha 决定）
// ============================================================

ipcMain.on("set-ignore-mouse-events", (_event, ignore: boolean, options?: { forward?: boolean }) => {
  if (!mainWindow) return;
  // 避免传 undefined 给 C++ 层导致 gin 序列化转换失败
  try {
    if (options !== undefined) {
      mainWindow.setIgnoreMouseEvents(ignore, options);
    } else {
      mainWindow.setIgnoreMouseEvents(ignore);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[Main] setIgnoreMouseEvents 失败:", e);
    logError("Main", "setIgnoreMouseEvents 失败", { ignore, hasOptions: options !== undefined, error: errMsg });
  }
});

ipcMain.on("set-always-on-top", (_event, on: boolean) => {
  if (typeof on !== "boolean") {
    logWarn("Main", "set-always-on-top 参数非法", { on: typeof on });
    return;
  }
  logInfo("Main", "IPC← set-always-on-top", { on });
  isAlwaysOnTop = on;
  mainWindow?.setAlwaysOnTop(on, "pop-up-menu");
  buildTrayMenu();
});

ipcMain.on("report-always-on-top", (_event, on: boolean) => {
  if (typeof on !== "boolean") {
    logWarn("Main", "report-always-on-top 参数非法", { on: typeof on });
    return;
  }
  logDebug("Main", "IPC← report-always-on-top", { on });
  isAlwaysOnTop = on;
  mainWindow?.setAlwaysOnTop(on, "pop-up-menu");
  buildTrayMenu();
});

ipcMain.on("report-debug", (_event, on: boolean) => {
  if (typeof on !== "boolean") {
    logWarn("Main", "report-debug 参数非法", { on: typeof on });
    return;
  }
  logDebug("Main", "IPC← report-debug", { on });
  isDebug = on;
  buildTrayMenu();
});

ipcMain.on("quit-app", () => {
  logInfo("Main", "收到退出请求");
  isQuitting = true;
  app.quit();
});

// ============================================================
// 日志桥接：接收渲染进程/preload 发来的日志条目
// ============================================================
ipcMain.on("log-entry", (_event, level: string, source: string, message: string, data?: unknown) => {
  switch (level) {
    case "ERROR": logError(source, message, data); break;
    case "WARN": logWarn(source, message, data); break;
    case "INFO": logInfo(source, message, data); break;
    case "DEBUG": logDebug(source, message, data); break;
    default: logDebug(source, message, data); break;
  }
});

ipcMain.on("report-frame-rate", (_event, rate: number) => {
  if (typeof rate !== "number" || isNaN(rate)) {
    logWarn("Main", "report-frame-rate 参数非法", { rate: typeof rate });
    return;
  }
  logInfo("Main", "IPC← report-frame-rate", { rate });
  currentFrameRate = rate;
  buildTrayMenu();
});

// ============================================================
// 全局鼠标位置查询（渲染进程轮询恢复鼠标穿透用）
// ============================================================

ipcMain.handle("get-cursor-pos", async (): Promise<{ x: number; y: number }> => {
  const point = screen.getCursorScreenPoint();
  return { x: point.x, y: point.y };
  // 注：此通道调用频率极高（RAF 级别），不加日志避免刷屏
});

// ============================================================
// Cache IPC（invoke / handle 模式）
// ============================================================

ipcMain.handle("cache-prepare", async (_event, characterId, skelUrl, atlasUrl) => {
  const result = await cachePrepareHandler(_event, characterId, skelUrl, atlasUrl);
  logInfo("Main", "IPC↔ cache-prepare", {
    characterId,
    hit: result !== null,
    skelUrl: skelUrl.slice(skelUrl.lastIndexOf("/") + 1),
  });
  return result;
});

ipcMain.handle("cache-clean-expired", () => {
  const result = cleanExpiredCache();
  logInfo("Main", "IPC↔ cache-clean-expired", { cleaned: result.length });
  return result;
});

// ============================================================
// 角色数据自动更新 IPC（7 天限流）
// ============================================================

const CHAR_CHECK_FILE = "characters-check.json";

function getCharCheckPath(): string {
  return join(app.getPath("userData"), CHAR_CHECK_FILE);
}

/** 7 天 = 604800000 ms */
const CHAR_UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000;

ipcMain.handle(
  "check-characters-update",
  async (_event, currentIds: string[]): Promise<{ checked: boolean; updated: boolean; newCount: number }> => {
    logInfo("Main", "IPC↔ check-characters-update", { currentCount: currentIds.length });
    // 限流检查
    const checkPath = getCharCheckPath();
    let lastCheck = 0;
    try {
      if (existsSync(checkPath)) {
        lastCheck = JSON.parse(readFileSync(checkPath, "utf-8")).lastCheck || 0;
      }
    } catch { /* 忽略损坏 */ }

    const now = Date.now();
    if (now - lastCheck < CHAR_UPDATE_INTERVAL) {
      logDebug("Main", "check-characters-update: 限流中，跳过检查");
      return { checked: false, updated: false, newCount: 0 };
    }

    // 记录本次检查时间
    try {
      writeFileSync(checkPath, JSON.stringify({ lastCheck: now }));
    } catch { /* 静默 */ }

    // 查询 PRTS wiki
    try {
      const { checkForNewCharacters } = await import("./update-characters");
      const { result, data } = await checkForNewCharacters(currentIds);

      if (result.updated && data && data.length > 0) {
        // 读取现有 userData 版本（如果有），合并新角色
        const userDataDir = join(app.getPath("userData"), "assets");
        const localPath = join(userDataDir, "characters.json");
        let existing: CharacterEntry[] = [];
        if (existsSync(localPath)) {
          try {
            existing = JSON.parse(readFileSync(localPath, "utf-8"));
          } catch { /* 损坏则重新构建 */ }
        } else {
          // 如果 userData 没有，从 currentIds 重建占位
          existing = currentIds.map((id) => ({ id, name: id, meta: { prefix: "", name: id, skin: {} } }));
        }

        // 合并（去重）
        const existingIds = new Set(existing.map((c) => c.id));
        const merged = [...existing];
        for (const entry of data) {
          if (!existingIds.has(entry.id)) {
            merged.push(entry);
            existingIds.add(entry.id);
          }
        }

        // 保存到 userData
        if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
        writeFileSync(localPath, JSON.stringify(merged, null, 2));

        logInfo("Main", "check-characters-update: 发现新干员", { newCount: data.length });
        return { checked: true, updated: true, newCount: data.length };
      }

      logInfo("Main", "check-characters-update: 无新干员");
      return { checked: true, updated: false, newCount: 0 };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("[Characters] 检查更新失败:", e);
      logError("Main", "check-characters-update 失败", { error: errMsg });
      return { checked: true, updated: false, newCount: 0 };
    }
  },
);

/** 查询 GPU 厂商（渲染进程自适应 powerPreference 用） */
ipcMain.handle("get-gpu-vendor", (): string => {
  return gpuVendor;
});

/** 读取 userData 中已更新的角色数据（渲染进程调用） */
ipcMain.handle("get-characters-data", async (): Promise<string | null> => {
  const path = join(app.getPath("userData"), "assets", "characters.json");
  try {
    if (existsSync(path)) {
      const data = readFileSync(path, "utf-8");
      logDebug("Main", "IPC↔ get-characters-data", { hasData: true, size: data.length });
      return data;
    }
  } catch { /* 静默 */ }
  logDebug("Main", "IPC↔ get-characters-data", { hasData: false });
  return null;
});

// ============================================================
// 单实例锁 — 防止用户切换 Windows 账号后残留进程导致多实例冲突
// 单文件便携版每次解压到 %TEMP% 不同目录，残留旧实例的 IPC
// 通道仍指向已销毁的窗口，跨实例通信必定触发序列化崩溃
// ============================================================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 已有实例运行，退出当前实例
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户尝试启动第二个实例时，激活现有主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============================================================
// GPU 厂商检测（必须在 app.whenReady() 之前）
// 通过 WMI 查询显卡信息，用于动态调整渲染策略
// ============================================================
let gpuVendor: string = 'unknown';
try {
  const wmiOut = execSync('wmic path win32_VideoController get name', {
    encoding: 'utf-8',
    timeout: 3000,
  });
  const lines = wmiOut.split('\n').map(l => l.trim()).filter(Boolean);
  // 第一行是表头 "Name"，从第二行开始读
  for (let i = 1; i < lines.length; i++) {
    const name = lines[i].toLowerCase();
    if (/radeon|amd|vega|rx |rx\d/.test(name)) { gpuVendor = 'amd'; break; }
    if (/nvidia|geforce|quadro|rtx|gtx/.test(name)) { gpuVendor = 'nvidia'; break; }
    if (/intel|hd graphics|iris|uhd/.test(name)) { gpuVendor = 'intel'; break; }
  }
} catch {
  // WMI 查询失败时保持 unknown，走保守配置
  gpuVendor = 'unknown';
}

// ============================================================
// 命令行开关（必须在 app.whenReady() 之前设置，否则 GPU 进程
// 启动后才设置就无效了）
// ============================================================
// 始终启用的通用开关
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// 透明窗口所需开关（必须 app.whenReady() 前设置）
app.commandLine.appendSwitch('enable-transparent-visuals');

// disable-gpu-compositing: 禁用 GPU 合成，防止 DWM 与 WebGL
// 透明纹理合成时产生不透明背景。但 AMD Vega 核显在此模式下
// GPU→CPU 回读路径不稳定，可能引发 DWM 挂死，因此仅对
// 非 AMD 显卡启用
if (gpuVendor === 'amd') {
  // AMD 显卡：保留 GPU 合成，避免 DWM 回读压力
  logInfo("Main", "检测到 AMD 显卡，跳过 disable-gpu-compositing", { gpuVendor });
} else {
  app.commandLine.appendSwitch('disable-gpu-compositing');
}
// 禁用 GPU 进程沙箱可能有助于某些环境下的稳定性
// （如果不需要沙箱安全性，可以取消注释下面这行）
// app.commandLine.appendSwitch('disable-gpu-sandbox');

// 注册自定义协议，允许渲染进程通过 fetch/XHR 访问 asset-cache://
protocol.registerSchemesAsPrivileged([
  { scheme: "asset-cache", privileges: { supportFetchAPI: true, bypassCSP: true } },
]);

app.whenReady().then(() => {
  // ============================================================
  // 启动日志
  // ============================================================
  logInfo("Main", "应用启动", {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    gpuVendor, // 显卡厂商检测结果
    transparentCompositing: gpuVendor === 'amd' ? 'gpu-compositing' : 'cpu-compositing',
    execPath: process.execPath,
    userData: app.getPath("userData"),
    isPackaged: app.isPackaged,
    argv: process.argv.slice(1),
  });

  // 清理旧日志（>7 天）
  const cleanedLogs = cleanOldLogs();
  if (cleanedLogs > 0) {
    logInfo("Main", `已清理 ${cleanedLogs} 个过期日志文件`);
  }

  // 防止系统电源管理节流此进程
  const pbId = powerSaveBlocker.start('prevent-app-suspension');

  // ============================================================
  // 清理 %TEMP% 中的旧便携版解压残留目录
  // 单文件便携版每次运行解压到 %TEMP%/xxxxxx.../app-name/
  // 通过当前 exe 路径区分"自身目录"和"旧目录"
  // ============================================================
  try {
    const exeDir = dirname(process.execPath);
    // 判断是否在 Temp 目录中运行（便携版特征）
    if (exeDir.toLowerCase().includes('temp')) {
      const tempRoot = dirname(exeDir);
      const currentDirName = basename(exeDir);
      if (existsSync(tempRoot)) {
        const entries = readdirSync(tempRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === currentDirName) continue;
          const dirPath = join(tempRoot, entry.name);
          try {
            // 检查是否为同类应用解压目录（含 index.html 或 .exe）
            const contents = readdirSync(dirPath).slice(0, 10);
            if (contents.some(f => f === 'index.html' || f.endsWith('.exe'))) {
              rmSync(dirPath, { recursive: true, force: true });
              console.log(`[Cleanup] 已清理旧解压目录: ${entry.name}`);
              logInfo("Main", `已清理旧解压目录: ${entry.name}`);
            }
          } catch { /* 无法清理则跳过 */ }
        }
      }
    }
  } catch { /* 静默 */ }

  // 注册 asset-cache 协议，将 asset-cache://xxx 映射到本地缓存目录
  protocol.handle("asset-cache", (request) => {
    const relativePath = decodeURIComponent(request.url.slice("asset-cache://".length));
    const filePath = join(getCacheDir(), relativePath);
    return net.fetch(localPathToFileUrl(filePath));
  });

  // 启动时清理过期缓存
  const cleaned = cleanExpiredCache();
  if (cleaned.length > 0) {
    console.log(`[Cache] 已清理 ${cleaned.length} 个过期缓存: ${cleaned.join(", ")}`);
    logInfo("Main", `已清理 ${cleaned.length} 个过期缓存`, { chars: cleaned });
  }

  createWindow();
  logInfo("Main", "主窗口已创建", {
    preload: "preload.cjs",
    transparent: true,
    alwaysOnTop: true,
  });
  createTray();
  logInfo("Main", "系统托盘已创建");

  // 启动时自动打开操作面板（替代底部按钮栏）
  setTimeout(() => {
    if (!actionPanelWindow || actionPanelWindow.isDestroyed()) {
      actionPanelWindow = createPanelWindow("/action-panel", 242, 90);
    }
    actionPanelWindow.show();
  }, 500);

  // GPU 进程崩溃事件监听 — 尝试自动恢复
  app.on('gpu-process-crashed', (_event, killed) => {
    console.error(`[Main] GPU process ${killed ? 'killed' : 'crashed'} — 尝试恢复`);
    logError("Main", `GPU 进程${killed ? '被杀死' : '崩溃'}`, { killed });
    // 通知渲染进程 WebGL 上下文可能已失效
    mainWindow?.webContents.send('gpu-crashed');
  });

  // 窗口关闭时释放 powerSaveBlocker
  app.on('before-quit', () => {
    if (powerSaveBlocker.isStarted(pbId)) {
      powerSaveBlocker.stop(pbId);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // 不退出，保持托盘运行
  }
});

app.on("before-quit", () => {
  logInfo("Main", "应用退出");
  isQuitting = true;
  // 关闭面板子窗口
  if (animPanelWindow && !animPanelWindow.isDestroyed()) {
    animPanelWindow.destroy();
  }
  if (menuPanelWindow && !menuPanelWindow.isDestroyed()) {
    menuPanelWindow.destroy();
  }
  if (actionPanelWindow && !actionPanelWindow.isDestroyed()) {
    actionPanelWindow.destroy();
  }
});
