// ============================================================
// 桌面宠物日志系统 — 渲染进程日志桥接
// ============================================================
// 渲染进程/Vue 组件通过此模块将日志发送到主进程写入文件
// 同时保留 console.log/error 输出（dev 模式 DevTools 可见）
// ============================================================

type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

/** IPC 就绪前的日志缓冲区（最多 100 条） */
const pendingLogs: Array<{ level: LogLevel; source: string; message: string; data?: unknown }> = [];
const MAX_PENDING = 100;

/** 是否已尝试发送缓冲日志 */
let flushed = false;

function sendLog(level: LogLevel, source: string, message: string, data?: unknown): void {
  const api = (window as any).electronAPI;
  if (api?.log) {
    // 首次调用时，先发送缓冲区中的旧日志
    if (!flushed) {
      flushed = true;
      for (const pending of pendingLogs) {
        try { api.log(pending.level, pending.source, pending.message, pending.data); } catch { /* ignore */ }
      }
      pendingLogs.length = 0;
    }
    try {
      api.log(level, source, message, data);
    } catch {
      // IPC 发送失败，静默降级
    }
  } else {
    // electronAPI 还没就绪，缓存日志
    if (pendingLogs.length < MAX_PENDING) {
      pendingLogs.push({ level, source, message, data });
    }
  }
}

function createLogger(source: string) {
  return {
    error(message: string, data?: unknown) {
      console.error(`[${source}] ${message}`, data ?? "");
      sendLog("ERROR", source, message, data);
    },
    warn(message: string, data?: unknown) {
      console.warn(`[${source}] ${message}`, data ?? "");
      sendLog("WARN", source, message, data);
    },
    info(message: string, data?: unknown) {
      console.log(`[${source}] ${message}`, data ?? "");
      sendLog("INFO", source, message, data);
    },
    debug(message: string, data?: unknown) {
      console.log(`[${source}] ${message}`, data ?? "");
      sendLog("DEBUG", source, message, data);
    },
  };
}

/** 通用日志函数（用于 spine.ts 等不能 import 模块的场景，通过 electronAPI.log 直接调用） */
export function logError(source: string, message: string, data?: unknown): void {
  console.error(`[${source}] ${message}`, data ?? "");
  sendLog("ERROR", source, message, data);
}

export function logWarn(source: string, message: string, data?: unknown): void {
  console.warn(`[${source}] ${message}`, data ?? "");
  sendLog("WARN", source, message, data);
}

export function logInfo(source: string, message: string, data?: unknown): void {
  console.log(`[${source}] ${message}`, data ?? "");
  sendLog("INFO", source, message, data);
}

export function logDebug(source: string, message: string, data?: unknown): void {
  console.log(`[${source}] ${message}`, data ?? "");
  sendLog("DEBUG", source, message, data);
}

/** 创建带 source 前缀的 logger 实例（推荐在 Vue 组件中使用） */
export function useLogger(source: string) {
  return createLogger(source);
}
