// ============================================================
// 互动状态机（v3 — 极致简化版）
// ============================================================
//
// 状态转移:
//   STARTING → IDLE → INTERACTING → IDLE
//                → DYING
//
// 互动时从 actionAnims 随机选一个动画播一次，播完回 IDLE。
// 不再依赖命名规则做三段式拆分（begin/loop/end）。
// 不再做技能链式转换。
// ============================================================

import { ref, type Ref } from "vue";
import type { Spine } from "./spine";
import type { ClassifyResult } from "./useAnimClassifier";
import { pickRandom } from "./useAnimClassifier";

// ============================================================
// 日志：通过 electronAPI 发送到主进程写入文件
// ============================================================
function stateLog(level: string, message: string, data?: unknown): void {
  try {
    (window as any).electronAPI?.log?.(level, 'PetState', message, data);
  } catch { /* ignore */ }
}

// ============================================================
// 状态枚举
// ============================================================

export type PetStateName = "STARTING" | "IDLE" | "INTERACTING" | "DYING";

// ============================================================
// 可调参数
// ============================================================

export const STATE_CONFIG = {
  /** 点击时冒泡概率 */
  bubble_probability: 1.0,
  /** 待机时每个循环尾帧冒泡概率 */
  bubble_idle_probability: 0.08,
};

// ============================================================
// 冒泡短语
// ============================================================

export const BUBBLE_TEXTS = [
  "嘿！",
  "看招~",
  "别点啦",
  "哼！",
  "嘻嘻",
  "再来一次？",
  "好困...",
  "活动一下~",
  "啊！",
  "不错嘛",
  "小心了！",
  "干嘛呀~",
  "黍来了！",
];

// ============================================================
// usePetState
// ============================================================

export function usePetState(
  spineRef: { value: Spine | null },
  classifierResult: Ref<ClassifyResult | null>,
  onBubble: (text: string) => void,
  bubbleTexts: Ref<string[]>,
) {
  const state = ref<PetStateName>("STARTING");

  function s(): Spine {
    if (!spineRef.value) throw new Error("Spine not initialized");
    return spineRef.value;
  }

  function availableAnims(): string[] {
    try { return s().getAnimationNames(); } catch { return []; }
  }

  // ============================================================
  // 播放辅助
  // ============================================================

  function playOnce(animName: string, onComplete: () => void) {
    try {
      s().setAnimation(animName, false, onComplete);
    } catch (e: any) {
      stateLog('WARN', `playOnce 失败: ${animName}`, { error: e?.message || String(e) });
      onComplete();
    }
  }

  function playLoop(animName: string, onEachLoop?: () => void) {
    try {
      s().setAnimation(animName, true, onEachLoop);
    } catch (e: any) {
      console.warn(`[PetState] Cannot play loop: ${animName}`);
      stateLog('WARN', `playLoop 失败: ${animName}`, { error: e?.message || String(e) });
    }
  }

  // ============================================================
  // 状态转移
  // ============================================================

  function transitionTo(newState: PetStateName) {
    const prev = state.value;
    state.value = newState;
    stateLog('DEBUG', `状态转移: ${prev} → ${newState}`);

    switch (newState) {
      // ----------------------------------------------------
      case "IDLE": {
        const result = classifierResult.value;
        const idlePool = result?.idleAnims ?? [];
        const idle =
          idlePool.length > 0
            ? pickRandom(idlePool)
            : (availableAnims()[0] || null);

        if (idle) {
          playLoop(idle, () => {
            // 每个待机循环尾帧：概率冒泡
            if (Math.random() < STATE_CONFIG.bubble_idle_probability) {
              onBubble(pickRandom(bubbleTexts.value));
            }
          });
        }
        break;
      }

      // ----------------------------------------------------
      case "INTERACTING": {
        const result = classifierResult.value;
        const pool = result?.actionAnims ?? [];
        const anim = pool.length > 0 ? pickRandom(pool) : null;

        if (anim) {
          playOnce(anim, () => transitionTo("IDLE"));
        } else {
          // 没有可用动作也回待机，至少吐个泡
          transitionTo("IDLE");
        }
        break;
      }

      // ----------------------------------------------------
      case "DYING": {
        const dieAnim = availableAnims().find((a) =>
          ["Die", "die", "Death", "death", "死亡"].includes(a),
        );

        // 兜底 2.5s 强制退出
        const forceQuit = setTimeout(() => {
          window.electronAPI?.quitApp();
        }, 2500);

        if (dieAnim) {
          playOnce(dieAnim, () => {
            clearTimeout(forceQuit);
            window.electronAPI?.quitApp();
          });
        } else {
          clearTimeout(forceQuit);
          window.electronAPI?.quitApp();
        }
        break;
      }

      default:
        break;
    }
  }

  // ============================================================
  // 外部接口
  // ============================================================

  /** 点击角色：开始新互动 */
  function handleClick() {
    if (state.value === "DYING") return;

    stateLog('DEBUG', '互动点击', { currentState: state.value });

    if (Math.random() < STATE_CONFIG.bubble_probability) {
      onBubble(pickRandom(bubbleTexts.value));
    }

    transitionTo("INTERACTING");
  }

  /** 启动状态机（模型加载完成后调用） */
  function init() {
    const result = classifierResult.value;
    const startAnim =
      (result?.startAnims.length ?? 0) > 0
        ? pickRandom(result!.startAnims)
        : availableAnims().find((a) =>
            ["Start", "start", "Appear", "appear", "登场"].includes(a),
          );

    if (startAnim) {
      state.value = "STARTING";
      playOnce(startAnim, () => transitionTo("IDLE"));
    } else {
      transitionTo("IDLE");
    }
  }

  /** 触发退出序列 */
  function startDie() {
    transitionTo("DYING");
  }

  /** 重置状态机（切换皮肤 / 角色时调用） */
  function reset() {
    init();
  }

  return {
    state,
    handleClick,
    init,
    startDie,
    reset,
  };
}
