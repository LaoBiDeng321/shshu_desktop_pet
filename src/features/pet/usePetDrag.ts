import { ref, type Ref } from "vue";

/**
 * 窗口拖拽 composable
 * 使用 PointerEvent + setPointerCapture 解决透明窗口拖拽时鼠标移出窗口后事件丢失的问题
 */

// ============================================================
// 日志：通过 electronAPI 发送到主进程写入文件
// ============================================================
function dragLog(level: string, message: string, data?: unknown): void {
  try {
    (window as any).electronAPI?.log?.(level, 'PetDrag', message, data);
  } catch { /* ignore */ }
}

export function usePetDrag(container: Ref<HTMLElement | undefined>) {
  const isDragging = ref(false);
  /** 是否确实发生过拖拽移动（用于区分拖拽和点击） */
  const hasMoved = ref(false);
  const dragStartScreen = { x: 0, y: 0 };
  /** 拖拽 IPC 节流：上次发送的时间戳，防止高频调 DWM 导致主进程卡死 */
  let lastDragMoveTime = 0;
  const DRAG_MOVE_THROTTLE_MS = 33; // ~30fps，足够流畅，不给 DWM 压力

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    isDragging.value = true;
    hasMoved.value = false;
    lastDragMoveTime = 0;

    const el = container.value;
    if (el) {
      el.setPointerCapture(e.pointerId);
    }

    dragStartScreen.x = e.screenX;
    dragStartScreen.y = e.screenY;
    window.electronAPI?.windowDragStart();
    dragLog('DEBUG', '拖拽开始', { screenX: e.screenX, screenY: e.screenY });
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDragging.value) return;
    // 防御：如果没有任何按钮按下，自动结束拖拽
    // 防止 pointerup 丢失导致拖拽状态卡死（模型吸附鼠标）
    if (e.buttons === 0) {
      isDragging.value = false;
      window.electronAPI?.windowDragEnd();
      return;
    }
    // 节流：最多 30fps 发 IPC，防止高刷屏（144Hz+）每秒调 setPosition 上百次
    // 导致 Windows DWM 透明窗口合成卡死（尤其 AMD Vega 驱动）
    const now = performance.now();
    if (now - lastDragMoveTime < DRAG_MOVE_THROTTLE_MS) return;
    lastDragMoveTime = now;

    const dx = e.screenX - dragStartScreen.x;
    const dy = e.screenY - dragStartScreen.y;
    // 只有实际移动超过阈值才算拖拽
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      hasMoved.value = true;
    }
    window.electronAPI?.windowDragMove(dx, dy);
  }

  function onPointerUp(_e: PointerEvent) {
    if (!isDragging.value) return;
    dragLog('DEBUG', '拖拽结束', { hasMoved: hasMoved.value });
    isDragging.value = false;
    window.electronAPI?.windowDragEnd();
  }

  /** pointercancel：系统取消指针捕获时清理拖拽状态 */
  function onPointerCancel(_e: PointerEvent) {
    if (!isDragging.value) return;
    dragLog('DEBUG', '拖拽取消');
    isDragging.value = false;
    window.electronAPI?.windowDragEnd();
  }

  return {
    isDragging,
    hasMoved,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
