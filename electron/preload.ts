import { contextBridge, ipcRenderer } from "electron";

/** 把所有 undefined 替换为 null，防止 Electron 序列化崩溃 */

/**
 * 递归消毒 IPC 参数中的字符串：
 * - 替换 \r\n / \r / \n 为空格（防止 V8 ValueSerializer 转换失败）
 * - 移除 ASCII 控制字符（码点 < 0x20，保留 \t 制表符）
 * - 纯对象和数组递归处理，其他类型原样返回
 */
function sanitizeIPC(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\r\n/g, ' ')
      .replace(/[\r\n]/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }
  // 数字消毒：消除可能在特定 CPU 上触发 V8 ValueSerializer 崩溃的浮点值
  if (typeof value === 'number') {
    if (isNaN(value)) return 0;
    if (!isFinite(value)) return value > 0 ? 1e308 : -1e308;
    if (value === 0) return 0; // 消除 -0
    // 次正规数检测
    if (Math.abs(value) < 2.2250738585072014e-308) return 0;
    // 安全整数范围外截断
    if (value > 1e15) return 1e15;
    if (value < -1e15) return -1e15;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeIPC);
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeIPC(v);
    }
    return out;
  }
  return value;
}

// ============================================================
// 日志桥接：将日志转发到主进程写入文件
// ============================================================

function logToMain(level: string, source: string, message: string, data?: unknown): void {
  try {
    const safe = [level, source, message, data].map(a => a === undefined ? null : a).map(sanitizeIPC);
    ipcRenderer.send('log-entry', ...safe);
  } catch { /* 日志失败不影响业务 */ }
}

/** 参数摘要：避免在日志中记录完整大对象 */
function summarizeArgs(args: unknown[]): string[] {
  return args.map((a) => {
    if (a === undefined) return 'undefined';
    if (a === null) return 'null';
    const t = typeof a;
    if (t === 'string') {
      return 'string(' + (a.length > 80 ? a.slice(0, 80) + '...' : a) + ')';
    }
    if (t === 'object') {
      if (Array.isArray(a)) return 'array(' + a.length + ')';
      try {
        const keys = Object.keys(a as object);
        const short = keys.slice(0, 5);
        let s = 'object{' + short.join(',');
        if (keys.length > 5) s += ',...(' + keys.length + ')';
        s += '}';
        return s;
      } catch { return 'object'; }
    }
    return t;
  });
}

function safeSend(channel: string, ...args: unknown[]) {
  // 记录 IPC 调用
  logToMain('DEBUG', 'Preload', 'IPC→ ' + channel, { args: summarizeArgs(args) });

  // 检测 undefined 参数
  const hadUndefined = args.some((a) => a === undefined);
  if (hadUndefined) {
    logToMain('WARN', 'Preload', 'undefined→null: ' + channel, { args: summarizeArgs(args) });
  }

  ipcRenderer.send(channel, ...args.map(a => a === undefined ? null : a).map(sanitizeIPC));
}
function safeInvoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  // 记录 IPC 调用
  logToMain('DEBUG', 'Preload', 'IPC↔ ' + channel, { args: summarizeArgs(args) });

  // 检测 undefined 参数
  const hadUndefined = args.some((a) => a === undefined);
  if (hadUndefined) {
    logToMain('WARN', 'Preload', 'undefined→null: ' + channel, { args: summarizeArgs(args) });
  }

  return (ipcRenderer.invoke(channel, ...args.map(a => a === undefined ? null : a).map(sanitizeIPC)) as Promise<T>)
    .catch((err: Error) => {
      logToMain('ERROR', 'Preload', 'IPC invoke 失败: ' + channel, { error: err?.message || String(err) });
      throw err; // 继续传播，不改变原有行为
    });
}

contextBridge.exposeInMainWorld("electronAPI", {
  // 窗口控制 - 拖拽
  windowDragStart: () => safeSend("window-drag-start"),
  windowDragMove: (dx: number, dy: number) => safeSend("window-drag-move", dx, dy),
  windowDragEnd: () => safeSend("window-drag-end"),
  // 动态鼠标穿透（渲染进程基于像素 alpha 控制）
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) =>
    safeSend("set-ignore-mouse-events", ignore, options),
  quitApp: () => safeSend("quit-app"),
  resizeWindow: (width: number, height: number) =>
    safeSend("resize-window", width, height),
  setAlwaysOnTop: (on: boolean) => safeSend("set-always-on-top", on),

  // 面板子窗口控制
  showAnimPanel: () => safeSend("show-anim-panel"),
  showMenuPanel: () => safeSend("show-menu-panel"),
  hideAnimPanel: () => safeSend("hide-anim-panel"),
  hideMenuPanel: () => safeSend("hide-menu-panel"),

  // 跨窗口消息（面板 ↔ 主窗口）
  sendPanelAction: (data: unknown) => safeSend("panel-action", data),
  onPanelAction: (callback: (data: unknown) => void) => {
    ipcRenderer.on("panel-action", (_event, data: unknown) => callback(data));
  },
  sendPanelState: (data: unknown) => safeSend("panel-state", data),
  onPanelState: (callback: (data: unknown) => void) => {
    ipcRenderer.on("panel-state", (_event, data: unknown) => callback(data));
  },
  onPanelVisibilityChanged: (callback: (info: { panel: string; visible: boolean }) => void) => {
    ipcRenderer.on("panel-visibility-changed", (_event, info) => callback(info));
  },
  requestPanelState: () => safeSend("request-panel-state"),
  onRequestPanelState: (callback: () => void) => {
    ipcRenderer.on("request-panel-state", () => callback());
  },

  // 帧率 - 托盘菜单控制
  onFrameRateChange: (callback: (rate: number) => void) => {
    ipcRenderer.on("set-frame-rate", (_event, rate: number) => callback(rate));
  },
  reportFrameRate: (rate: number) => {
    safeSend("report-frame-rate", rate);
  },
  reportAlwaysOnTop: (on: boolean) => {
    safeSend("report-always-on-top", on);
  },
  reportDebug: (on: boolean) => {
    safeSend("report-debug", on);
  },

  // GPU 进程崩溃通知
  onGpuCrashed: (callback: () => void) => {
    ipcRenderer.on("gpu-crashed", () => callback());
  },

  // 窗口位置查询（面板/场景坐标计算用）
  getWindowPosition: () => safeInvoke<{ x: number; y: number; availLeft: number; availTop: number; availWidth: number; availHeight: number } | null>("get-window-position"),
  onWindowPositionChanged: (callback: (pos: { x: number; y: number }) => void) => {
    ipcRenderer.on("window-position-changed", (_event, pos) => callback(pos));
  },

  // 托盘菜单"检查角色更新"触发
  onForceCharUpdate: (callback: () => void) => {
    ipcRenderer.on("force-char-update", () => callback());
  },

  // 资源缓存（24h 过期）
  cachePrepare: (characterId: string, skelUrl: string, atlasUrl: string) =>
    safeInvoke("cache-prepare", characterId, skelUrl, atlasUrl),
  cacheCleanExpired: () => safeInvoke("cache-clean-expired"),

  // 角色数据自动更新（7 天限流）
  checkCharactersUpdate: (currentIds: string[]) =>
    safeInvoke("check-characters-update", currentIds),
  getCharactersData: () => safeInvoke("get-characters-data"),

  // 全局鼠标位置查询（渲染进程轮询恢复鼠标穿透用）
  getCursorPos: () => safeInvoke<{ x: number; y: number }>("get-cursor-pos"),

  // 日志记录：渲染进程将日志发送到主进程写入文件
  log: (level: string, source: string, message: string, data?: unknown) => {
    logToMain(level, source, message, data);
  },

  // 查询 GPU 厂商（用于自适应渲染策略）
  getGpuVendor: () => safeInvoke<string>("get-gpu-vendor"),
});
