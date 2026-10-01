const { contextBridge, ipcRenderer } = require("electron");

// ============================================================
// 安全 IPC 发送：把 undefined 替换为 null，
// 防止 Electron 的 V8 ValueSerializer 序列化 undefined 时崩溃
// ============================================================

/**
 * 递归消毒 IPC 参数中的字符串：
 * - 替换 \r\n / \r / \n 为空格（防止 V8 ValueSerializer 转换失败）
 * - 移除 ASCII 控制字符（码点 < 0x20，保留 \t 制表符）
 * - 纯对象和数组递归处理，其他类型原样返回
 */
function sanitizeIPC(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\r\n/g, ' ')
      .replace(/[\r\n]/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }
  // 数字消毒：消除可能在特定 CPU 上触发 V8 ValueSerializer 崩溃的浮点值
  // - NaN → 0（不同 CPU 对 NaN 编码处理不一致）
  // - Infinity / -Infinity → 安全边界值（避免序列化溢出）
  // - -0 → 0（负零在某些序列化路径中有已知问题）
  // - 次正规数 → 0（极小的浮点数，硬件行为不一致）
  if (typeof value === 'number') {
    if (isNaN(value)) return 0;
    if (!isFinite(value)) return value > 0 ? 1e308 : -1e308;
    if (value === 0) return 0; // 消除 -0
    // 次正规数检测：绝对值小于最小正规数的浮点值
    if (Math.abs(value) < 2.2250738585072014e-308) return 0;
    // 安全整数范围外的大数截断（防止序列化精度问题）
    if (value > 1e15) return 1e15;
    if (value < -1e15) return -1e15;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeIPC);
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = sanitizeIPC(value[keys[i]]);
    }
    return out;
  }
  return value;
}

// ============================================================
// 日志桥接：将日志转发到主进程写入文件
// ============================================================

function logToMain(level, source, message, data) {
  try {
    var safeArgs = [level, source, message, data].map(function(a) { return a === undefined ? null : a; }).map(sanitizeIPC);
    ipcRenderer.send('log-entry', safeArgs[0], safeArgs[1], safeArgs[2], safeArgs[3]);
  } catch (e) { /* 日志失败不影响业务 */ }
}

/** 参数摘要：避免在日志中记录完整大对象 */
function summarizeArgs(args) {
  return args.map(function(a) {
    if (a === undefined) return 'undefined';
    if (a === null) return 'null';
    var t = typeof a;
    if (t === 'string') {
      var truncated = a.length > 80 ? a.slice(0, 80) + '...' : a;
      return 'string(' + truncated + ')';
    }
    if (t === 'object') {
      if (Array.isArray(a)) return 'array(' + a.length + ')';
      try {
        var objKeys = Object.keys(a);
        var shortKeys = objKeys.slice(0, 5);
        var summary = 'object{' + shortKeys.join(',');
        if (objKeys.length > 5) summary += ',...(' + objKeys.length + ')';
        summary += '}';
        return summary;
      } catch(e) { return 'object'; }
    }
    return t;
  });
}

function safeSend(channel, ...args) {
  // 记录 IPC 调用
  logToMain('DEBUG', 'Preload', 'IPC→ ' + channel, { args: summarizeArgs(args) });

  // 检测 undefined 参数
  var hadUndefined = false;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === undefined) hadUndefined = true;
  }
  if (hadUndefined) {
    logToMain('WARN', 'Preload', 'undefined→null: ' + channel, { args: summarizeArgs(args) });
  }

  // 把所有 undefined 转成 null（structured clone 算法支持 null 但不支持 undefined）
  // 然后递归消毒字符串中的控制字符（防止 V8 ValueSerializer 转换失败）
  const safe = args.map(function(a) { return a === undefined ? null : a; }).map(sanitizeIPC);
  ipcRenderer.send(channel, ...safe);
}

function safeInvoke(channel, ...args) {
  // 记录 IPC 调用
  logToMain('DEBUG', 'Preload', 'IPC↔ ' + channel, { args: summarizeArgs(args) });

  // 检测 undefined 参数
  var hadUndefined = false;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === undefined) hadUndefined = true;
  }
  if (hadUndefined) {
    logToMain('WARN', 'Preload', 'undefined→null: ' + channel, { args: summarizeArgs(args) });
  }

  const safe = args.map(function(a) { return a === undefined ? null : a; }).map(sanitizeIPC);
  return ipcRenderer.invoke(channel, ...safe).catch(function(err) {
    logToMain('ERROR', 'Preload', 'IPC invoke 失败: ' + channel, { error: (err && err.message) || String(err) });
    throw err; // 继续传播，不改变原有行为
  });
}

contextBridge.exposeInMainWorld("electronAPI", {
  // 窗口控制 - 拖拽
  windowDragStart: () => safeSend("window-drag-start"),
  windowDragMove: (dx, dy) => safeSend("window-drag-move", dx, dy),
  windowDragEnd: () => safeSend("window-drag-end"),
  // 动态鼠标穿透（渲染进程基于像素 alpha 控制）
  setIgnoreMouseEvents: (ignore, options) => {
    safeSend("set-ignore-mouse-events", ignore, options);
  },
  quitApp: () => safeSend("quit-app"),
  resizeWindow: (width, height) =>
    safeSend("resize-window", width, height),
  setAlwaysOnTop: (on) => safeSend("set-always-on-top", on),

  // 面板子窗口控制
  showAnimPanel: () => safeSend("show-anim-panel"),
  showMenuPanel: () => safeSend("show-menu-panel"),
  hideAnimPanel: () => safeSend("hide-anim-panel"),
  hideMenuPanel: () => safeSend("hide-menu-panel"),
  showActionPanel: () => safeSend("show-action-panel"),
  hideActionPanel: () => safeSend("hide-action-panel"),

  // 跨窗口消息（面板 ↔ 主窗口）
  sendPanelAction: (data) => safeSend("panel-action", data),
  onPanelAction: (callback) => {
    ipcRenderer.on("panel-action", (_event, data) => callback(data));
  },
  sendPanelState: (data) => safeSend("panel-state", data),
  onPanelState: (callback) => {
    ipcRenderer.on("panel-state", (_event, data) => callback(data));
  },
  onPanelVisibilityChanged: (callback) => {
    ipcRenderer.on("panel-visibility-changed", (_event, info) => callback(info));
  },

  // 面板窗口请求初始状态
  requestPanelState: () => safeSend("request-panel-state"),
  onRequestPanelState: (callback) => {
    ipcRenderer.on("request-panel-state", () => callback());
  },

  // 面板窗口 JS 拖拽
  panelDragStart: (panel) => safeSend("panel-drag-start", panel),
  panelDragMove: (panel, dx, dy) => safeSend("panel-drag-move", panel, dx, dy),
  panelDragEnd: (panel) => safeSend("panel-drag-end", panel),
  setPanelSize: (panel, width, height) => safeSend("set-panel-size", panel, width, height),

  // 帧率 - 托盘菜单控制
  onFrameRateChange: (callback) => {
    ipcRenderer.on("set-frame-rate", (_event, rate) => callback(rate));
  },
  reportFrameRate: (rate) => {
    safeSend("report-frame-rate", rate);
  },
  reportAlwaysOnTop: (on) => {
    safeSend("report-always-on-top", on);
  },
  reportDebug: (on) => {
    safeSend("report-debug", on);
  },

  // GPU 进程崩溃通知
  onGpuCrashed: (callback) => {
    ipcRenderer.on("gpu-crashed", () => callback());
  },

  // 窗口位置查询（面板/场景坐标计算用）
  getWindowPosition: () => safeInvoke("get-window-position"),
  onWindowPositionChanged: (callback) => {
    ipcRenderer.on("window-position-changed", (_event, pos) => callback(pos));
  },

  // 托盘菜单"检查角色更新"触发
  onForceCharUpdate: (callback) => {
    ipcRenderer.on("force-char-update", () => callback());
  },

  // 资源缓存（24h 过期）
  cachePrepare: (characterId, skelUrl, atlasUrl) =>
    safeInvoke("cache-prepare", characterId, skelUrl, atlasUrl),
  cacheCleanExpired: () => safeInvoke("cache-clean-expired"),

  // 角色数据自动更新（7 天限流）
  checkCharactersUpdate: (currentIds) =>
    safeInvoke("check-characters-update", currentIds),
  getCharactersData: () => safeInvoke("get-characters-data"),

  // 使用说明窗口
  showHelpWindow: () => safeSend("show-help-window"),

  // 全局鼠标位置查询（渲染进程轮询恢复鼠标穿透用）
  getCursorPos: () => safeInvoke("get-cursor-pos"),

  // 日志记录：渲染进程将日志发送到主进程写入文件
  log: (level, source, message, data) => {
    logToMain(level, source, message, data);
  },

  // 查询 GPU 厂商（用于自适应渲染策略）
  getGpuVendor: () => safeInvoke("get-gpu-vendor"),
});
