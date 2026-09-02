// ============================================================
// 动画分类器 — 陪伴模式（仅保留陪伴友好动画）
// ============================================================
//
// 陪伴模式统一使用基建模型，过滤掉所有战斗动画（attack / skill /
// combat / die 等），只保留待机、休息、互动等陪伴动画。
// ============================================================

export interface ClassifyResult {
  /** 待机动画（首尾相同，可循环） */
  idleAnims: string[];
  /** 登场动画（陪伴模式下被过滤，始终为空） */
  startAnims: string[];
  /** 死亡动画（陪伴模式下被过滤，始终为空） */
  dieAnims: string[];
  /** 互动可用动画（除 idle 外的陪伴动画） */
  actionAnims: string[];
}

// ============================================================
// 已知动画名分类
// ============================================================

const IDLE_NAMES = new Set([
  "待机", "平靜", "Idle", "idle", "Relax", "relax", "默认", "default",
]);

const START_NAMES = new Set([
  "登场", "Start", "start", "Appear", "appear",
]);

const DIE_NAMES = new Set([
  "死亡", "Die", "die", "Death", "death",
]);

/** 陪伴模式下要保留的非 idle 动作动画名 */
const COMPANION_ACTION_KEEP = new Set([
  "Sit", "sit", "坐下",
  "Sleep", "sleep", "睡眠",
  "Interact", "interact", "交互",
  "Thinking", "thinking", "思考",
  "Happy", "happy", "开心",
  "Angry", "angry", "生气",
  "Sad", "sad", "悲伤",
  "Surprised", "surprised", "惊讶",
  "Touch", "touch", "触摸",
  "Move", "move", "移动",
  "Special", "special", "特殊",
  "Show", "show", "展示",
]);

/** 陪伴模式要排除的战斗动画关键词（含大小写不敏感匹配） */
const BATTLE_KEYWORDS = [
  "attack", "skill", "combat", "spell", "die", "death", "dead",
  "win", "victory", "defeat",
  "buff", "hit", "hurt",
  "start", "appear", "born", "登场",
];

// ============================================================
// 工具
// ============================================================

export function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================
// 陪伴模式过滤
// ============================================================

/**
 * 判断动画名是否包含战斗关键词（用于排除）
 */
function isBattleAnim(name: string): boolean {
  const lower = name.toLowerCase();
  return BATTLE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 陪伴模式过滤器：从完整动画列表中提取陪伴友好的动画
 * 1. 保留所有 idle 动画
 * 2. 保留 COMPANION_ACTION_KEEP 中的动作动画
 * 3. 排除包含战斗关键词的动画
 * 4. 去掉 Skill_N_ / Skill_N 前缀仍匹配战斗关键词的也排除
 */
export function filterCompanionAnims(animNames: string[]): string[] {
  return animNames.filter((name) => {
    const clean = name.replace(/^Skill_\d+_/i, "").replace(/^Skill_\d+/i, "").trim();
    // idle 类始终保留
    if (IDLE_NAMES.has(name)) return true;
    // 明确列出的陪伴动作保留
    if (COMPANION_ACTION_KEEP.has(name)) return true;
    // 含战斗关键词的排除
    if (isBattleAnim(name)) return false;
    // 去掉技能前缀后看是否含战斗关键词
    if (clean !== name && isBattleAnim(clean)) return false;
    // Skill_X_Idle → idle 类保留
    if (/^Skill_\d+_?(Idle|idle|待机|Relax|relax)$/i.test(name)) return true;
    // 其余未分类的（如自定义动画、未知名）保留，宁多勿少
    return true;
  });
}

// ============================================================
// 核心分类函数
// ============================================================

export function classifyAnimations(animNames: string[]): ClassifyResult {
  const idleAnims: string[] = [];
  const startAnims: string[] = [];
  const dieAnims: string[] = [];
  const actionAnims: string[] = [];

  for (const name of animNames) {
    if (IDLE_NAMES.has(name)) {
      idleAnims.push(name);
    } else if (START_NAMES.has(name)) {
      startAnims.push(name);
    } else if (DIE_NAMES.has(name)) {
      dieAnims.push(name);
    } else {
      actionAnims.push(name);
    }
  }

  return { idleAnims, startAnims, dieAnims, actionAnims };
}
