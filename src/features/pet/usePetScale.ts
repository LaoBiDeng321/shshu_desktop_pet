import { ref } from "vue";

/** 缩放范围 100%～150% */
export const SCALE_MIN = 1.0;
export const SCALE_MAX = 1.35;
export const SCALE_STEP = 0.05;

/** 右键菜单缩放预设 */
export const SCALE_PRESETS = [1.00, 1.25, 1.50, 1.75, 2.00];

/** 基础 Canvas CSS 尺寸 */
const BASE_CANVAS_SIZE = 400;

/**
 * 缩放管理 composable
 * 通过 .pet-scene 的 CSS transform: scale(S) 实现整体缩放
 * Canvas 保持 400x400 CSS 尺寸，内部 1000x1000 分辨率
 */
export function usePetScale() {
  const scale = ref(1.0);

  /**
   * 设置缩放比例
   * 钳制到合法范围并按步进取整
   */
  function setScale(s: number) {
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
    const rounded = Math.round(clamped / SCALE_STEP) * SCALE_STEP;
    // 避免浮点误差
    scale.value = Math.round(rounded * 100) / 100;
  }

  function zoomIn() {
    setScale(scale.value + SCALE_STEP);
  }

  function zoomOut() {
    setScale(scale.value - SCALE_STEP);
  }

  /** 鼠标滚轮缩放处理 */
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.deltaY < 0) {
      zoomIn();
    } else {
      zoomOut();
    }
  }

  return {
    scale,
    setScale,
    zoomIn,
    zoomOut,
    onWheel,
  };
}
