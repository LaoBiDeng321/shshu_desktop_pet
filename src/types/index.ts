export interface ElectronAPI {
  windowDragStart: () => void;
  windowDragMove: (dx: number, dy: number) => void;
  windowDragEnd: () => void;
  /** 动态设置鼠标穿透，渲染进程基于像素 alpha 决定 */
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => void;
  quitApp: () => void;
  resizeWindow: (width: number, height: number) => void;
  setAlwaysOnTop: (on: boolean) => void;
  /** 监听托盘菜单的帧率切换 */
  onFrameRateChange: (callback: (rate: number) => void) => void;
  /** 向主进程报告当前帧率（用于托盘菜单勾选状态） */
  reportFrameRate: (rate: number) => void;
  /** 向主进程报告置顶状态 */
  reportAlwaysOnTop: (on: boolean) => void;
  /** 向主进程报告边界显示状态 */
  reportDebug: (on: boolean) => void;
  /** GPU 进程崩溃通知 */
  onGpuCrashed: (callback: () => void) => void;
  /** 托盘菜单"检查角色更新"触发 */
  onForceCharUpdate: (callback: () => void) => void;
  /** 查询当前窗口屏幕位置 + 工作区尺寸 */
  getWindowPosition: () => Promise<{ x: number; y: number; availLeft: number; availTop: number; availWidth: number; availHeight: number } | null>;
  /** 窗口移动时主进程推送新位置 */
  onWindowPositionChanged: (callback: (pos: { x: number; y: number }) => void) => void;
  /** 缓存准备：下载/校验角色 Spine 文件，返回 asset-cache:// URL */
  cachePrepare: (characterId: string, skelUrl: string, atlasUrl: string) => Promise<{ skel: string; atlas: string } | null>;
  /** 手动触发过期缓存清理，返回被清理的角色 ID 列表 */
  cacheCleanExpired: () => Promise<string[]>;
  /** 检查 PRTS wiki 是否有新干员（7 天限流），返回检查结果 */
  checkCharactersUpdate: (currentIds: string[]) => Promise<{ checked: boolean; updated: boolean; newCount: number }>;
  /** 读取 userData 中已更新的角色数据 JSON */
  getCharactersData: () => Promise<string | null>;
  /** 全局鼠标位置查询（渲染进程轮询恢复鼠标穿透用） */
  getCursorPos: () => Promise<{ x: number; y: number }>;
  /** 面板子窗口控制 */
  showAnimPanel: () => void;
  showMenuPanel: () => void;
  showHelpWindow: () => void;
  hideAnimPanel: () => void;
  hideMenuPanel: () => void;
  showActionPanel: () => void;
  hideActionPanel: () => void;
  /** 面板窗口 JS 拖拽 */
  panelDragStart: (panel: string) => void;
  panelDragMove: (panel: string, dx: number, dy: number) => void;
  panelDragEnd: (panel: string) => void;
  setPanelSize: (panel: string, width: number, height: number) => void;
  /** 跨窗口消息 */
  sendPanelAction: (data: unknown) => void;
  onPanelAction: (callback: (data: unknown) => void) => void;
  sendPanelState: (data: unknown) => void;
  onPanelState: (callback: (data: unknown) => void) => void;
  onPanelVisibilityChanged: (callback: (info: { panel: string; visible: boolean }) => void) => void;
  /** 面板窗口请求初始状态 */
  requestPanelState: () => void;
  onRequestPanelState: (callback: () => void) => void;
  /** 查询 GPU 厂商（用于自适应渲染策略） */
  getGpuVendor: () => Promise<string>;
  /** 日志记录：将日志发送到主进程写入文件 */
  log: (level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG', source: string, message: string, data?: unknown) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
