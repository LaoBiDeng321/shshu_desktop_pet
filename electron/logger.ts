// ============================================================
// 桌面宠物日志系统 — 主进程日志核心
// ============================================================
// 所有日志写入 exe 同级目录的 logs/ 文件夹（按天分割）
// 渲染进程日志通过 IPC 'log-entry' 通道桥接到此模块
// ============================================================

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from "fs";
import { join, dirname, basename } from "path";
import { app } from "electron";

// ============================================================
// 日志目录 & 文件路径
// ============================================================

/** 首选日志目录是否可写（缓存判断结果，避免每次写日志都 stat） */
let logDirWritable: boolean | null = null;
let resolvedLogDir: string | null = null;

function getLogDir(): string {
  if (resolvedLogDir) return resolvedLogDir;

  // 开发模式：使用项目根目录
  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  const primary = isDev
    ? join(app.getAppPath(), "logs")
    : join(dirname(app.getPath("exe")), "logs");
  const fallback = join(app.getPath("userData"), "logs");

  // 尝试首选目录
  try {
    if (!existsSync(primary)) {
      mkdirSync(primary, { recursive: true });
    }
    // 测试写入
    const testPath = join(primary, ".write-test");
    appendFileSync(testPath, "");
    // 清理测试文件
    try { unlinkSync(testPath); } catch { /* ignore */ }
    logDirWritable = true;
    resolvedLogDir = primary;
    return primary;
  } catch {
    // 首选不可写 → 降级到 userData
    logDirWritable = false;
    try {
      if (!existsSync(fallback)) {
        mkdirSync(fallback, { recursive: true });
      }
    } catch { /* 最终降级失败，后续写日志会静默跳过 */ }
    resolvedLogDir = fallback;

    // 在降级目录写入一条说明日志
    try {
      const noticePath = join(fallback, `pet-${getDateStr()}.log`);
      appendFileSync(noticePath,
        `[${new Date().toISOString()}] [WARN] [Logger] 日志目录降级: 首选目录不可写, 原因: ${getLogDir.name}\n`
      );
    } catch { /* ignore */ }

    return fallback;
  }
}

function getDateStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function getLogPath(): string {
  return join(getLogDir(), `pet-${getDateStr()}.log`);
}

// ============================================================
// 日志写入
// ============================================================

/** 单文件最大字节数（10MB） */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

function writeToFile(line: string): void {
  try {
    const dir = getLogDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const logPath = getLogPath();

    // 检查文件大小，超过上限则轮转
    try {
      if (existsSync(logPath)) {
        const stat = statSync(logPath);
        if (stat.size > MAX_LOG_SIZE) {
          const oldPath = logPath.replace(/\.log$/, `.old-${Date.now()}.log`);
          renameSync(logPath, oldPath);
        }
      }
    } catch { /* 轮转失败不影响写入 */ }

    appendFileSync(logPath, line, "utf-8");
  } catch {
    // 日志写入失败静默跳过 —— 日志系统不能成为崩溃源
  }
}

// ============================================================
// 日志格式化
// ============================================================

function formatLog(level: string, source: string, message: string, data?: unknown): string {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] [${source}] ${message}`;
  if (data !== undefined) {
    try {
      const serialized = JSON.stringify(data);
      line += " " + serialized;
    } catch {
      line += " " + String(data);
    }
  }
  return line + "\n";
}

// ============================================================
// 导出便捷函数
// ============================================================

export function logError(source: string, message: string, data?: unknown): void {
  writeToFile(formatLog("ERROR", source, message, data));
}

export function logWarn(source: string, message: string, data?: unknown): void {
  writeToFile(formatLog("WARN", source, message, data));
}

export function logInfo(source: string, message: string, data?: unknown): void {
  writeToFile(formatLog("INFO", source, message, data));
}

export function logDebug(source: string, message: string, data?: unknown): void {
  writeToFile(formatLog("DEBUG", source, message, data));
}

/**
 * IPC 调用专用日志
 * @param direction '→' 发送 / '←' 接收
 * @param source 来源（Main / Preload / Renderer）
 * @param channel IPC 通道名
 * @param summary 参数摘要
 */
export function logIPC(
  direction: "→" | "←",
  source: string,
  channel: string,
  summary?: unknown,
): void {
  writeToFile(formatLog("DEBUG", source, `IPC${direction} ${channel}`, summary));
}

// ============================================================
// 旧日志清理（启动时调用）
// ============================================================

/** 保留最近 N 天的日志 */
const LOG_RETENTION_DAYS = 7;

export function cleanOldLogs(): number {
  let cleaned = 0;
  try {
    const dir = getLogDir();
    if (!existsSync(dir)) return 0;

    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      // 匹配 pet-YYYY-MM-DD.log 或 pet-YYYY-MM-DD.old-xxx.log
      if (!name.startsWith("pet-") || !name.endsWith(".log")) continue;

      // 提取文件日期
      const dateMatch = name.match(/pet-(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1]).getTime();
      if (fileDate < cutoff) {
        try {
          unlinkSync(join(dir, name));
          cleaned++;
        } catch { /* 单个文件删除失败不影响其他 */ }
      }
    }
  } catch { /* 清理失败不影响启动 */ }
  return cleaned;
}
