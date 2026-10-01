import { contextBridge, ipcRenderer } from "electron";

/**
 * 递归消毒 IPC 参数中的字符串：
 * - 替换 \r\n / \r / \n 为空格（防止 V8 ValueSerializer 转换失败）
 * - 移除 ASCII 控制字符（码点 < 0x20，保留 \t 制表符）
 */
function sanitizeIPC(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\r\n/g, ' ')
      .replace(/[\r\n]/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
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
    if (t === 'string') return 'string(' + (a.length > 80 ? a.slice(0, 80) + '...' : a) + ')';
    if (t === 'object') {
      if (Array.isArray(a)) return 'array(' + a.length + ')';
      try {
        const keys = Object.keys(a as object);
        return 'object{' + keys.slice(0, 5).join(',') + (keys.length > 5 ? ',...' : '') + '}';
      } catch { return 'object'; }
    }
    return t;
  });
}

/**
 * 安全 IPC 发送：undefined → null + 递归消毒控制字符
 */
function safeSendAnim(channel: string, ...args: unknown[]) {
  logToMain('DEBUG', 'AnimPreload', 'IPC→ ' + channel, { args: summarizeArgs(args) });
  ipcRenderer.send(channel, ...args.map(a => a === undefined ? null : a).map(sanitizeIPC));
}

contextBridge.exposeInMainWorld("animAPI", {
  onAnimList: (callback: (names: string[]) => void) => {
    ipcRenderer.on("anim-list", (_event, names: string[]) => callback(names));
  },
  playAnim: (name: string) => {
    safeSendAnim("play-anim", name);
  },
  closeAnimWindow: () => {
    safeSendAnim("close-anim-window");
  },
});
