<script setup lang="ts">
import { onMounted, ref, computed, onUnmounted, watch, type Ref } from "vue";
import { Spine } from "./spine";
import { classifyAnimations, filterCompanionAnims, type ClassifyResult } from "./useAnimClassifier";
import { logError, logWarn, logInfo, logDebug } from "@/utils/logger";

// ============================================================
// 渲染模式检测（hash 路由）
//   #/anim-panel  → 仅动画面板（子窗口）
//   #/menu-panel  → 仅设置面板（子窗口）
//   无 hash       → 完整桌面宠物（主窗口）
// ============================================================

const isPanelMode = computed(() => {
  const h = window.location.hash;
  if (h === "#/anim-panel") return "anim" as const;
  if (h === "#/menu-panel") return "menu" as const;
  if (h === "#/action-panel") return "action" as const;
  return null;
});

// ============================================================
// 面板子窗口 IPC 通信
// ============================================================

/** 面板收到的动画列表（从主窗口同步） */
const panelAnimList = ref<string[]>([]);
/** 当前循环中的动画名（从主窗口同步，用于按钮高亮） */
const panelCurrentAnim = ref("");
/** 面板收到的角色/皮肤/模型信息 */
const panelCharState = ref<{
  charId?: string; charName?: string; groupId?: string;
  skinNames?: string[]; curSkin?: string;
  modelGroups?: string[]; curModel?: string;
  alterIds?: string[]; alterDisplayNames?: Record<string, string>;
  animClickPlay?: boolean; animLoop?: boolean;
}>({});
/** 面板收到的角色列表 */
const panelGroupList = ref<{ groupId: string; displayName: string; memberIds: string[] }[]>([]);
/** 面板内本地状态 */
const panelActiveGroup = ref(0);
const panelSearchQuery = ref("");
const panelLocalAnimClickPlay = ref(true);
const panelLocalAnimLoop = ref(true);

// ============================================================
// 操作面板状态（#/action-panel，从主窗口同步）
// ============================================================

/** 当前缩放比例（从主窗口同步） */
const actionFlipped = ref(false);
/** 动画面板可见性（从主窗口同步） */
const actionAnimVisible = ref(false);
/** 设置面板可见性（从主窗口同步） */
const actionMenuVisible = ref(false);
/** 操作面板拖拽按钮 ref */

/** 操作面板：互动 */
function actionInteract() {
  sendAction("interact");
}
/** 操作面板：翻转 */
function actionToggleFlip() {
  sendAction("toggle-flip");
}
/** 操作面板：动画面板开关 */
function actionToggleAnim() {
  sendAction("toggle-anim");
}
/** 操作面板：设置面板开关 */
function actionToggleMenu() {
  sendAction("toggle-menu");
}
/** 操作面板：打开使用说明 */
function actionHelp() {
  // 操作面板预加载也注入了 electronAPI，直接发 IPC 打开帮助窗口
  window.electronAPI?.showHelpWindow();
}

/** 面板搜索过滤后的角色列表 */
const panelFilteredGroups = computed(() => {
  const q = panelSearchQuery.value.trim().toLowerCase();
  if (!q) return panelGroupList.value;
  return panelGroupList.value.filter(g =>
    g.displayName.toLowerCase().includes(q)
  );
});

/** 发送操作到主窗口 */
function sendAction(type: string, payload?: Record<string, unknown>) {
  window.electronAPI?.sendPanelAction({ type, ...(payload ?? {}) });
}

/** 面板窗口的动画标签切换 */
function panelSwitchGroup(i: number) {
  panelActiveGroup.value = i;
}

/** 面板窗口播放动画 */
function panelPlayAnim(name: string) {
  if (!panelLocalAnimClickPlay.value) return;
  sendAction("play-anim", { name, loop: panelLocalAnimLoop.value });
}

/** 面板窗口切换角色 */
function panelSelectGroup(groupId: string) {
  sendAction("select-group", { groupId });
}

/** 面板窗口切换异格 */
function panelSelectAlter(charId: string) {
  sendAction("select-alter", { charId });
}

/** 面板窗口切换皮肤 */
function panelSelectSkin(skin: string) {
  sendAction("select-skin", { skin });
}

/** 面板窗口切换模型 */
function panelSelectModel(model: string) {
  sendAction("select-model", { model });
}

/** 面板窗口切换点播 */
function panelToggleClickPlay() {
  sendAction("toggle-click-play", { value: panelLocalAnimClickPlay.value });
}

/** 面板窗口切换循环 */
function panelToggleLoop() {
  sendAction("toggle-loop", { value: panelLocalAnimLoop.value });
}

// ============================================================
// 面板动画分组计算（复用主窗口逻辑的简化版）
// ============================================================

interface PanelAnimItem {
  name: string; label: string;
}
interface PanelAnimGroup {
  label: string; anims: PanelAnimItem[];
}

/** 翻译动画名：按下划线拆分，逐段翻译后拼接 */
function translateAnimName(name: string): string {
  // 提取 SkillN_ / Skill_N_ / SkillN / Skill_N 前缀（保留不翻译）
  const skillMatch = name.match(/^(Skill_?\d+[_]?)/i);
  const prefix = skillMatch ? skillMatch[1] : "";
  const rest = skillMatch ? name.slice(skillMatch[1].length) : name;

  // 逐段翻译
  const SEGMENT_MAP: Record<string, string> = {
    attack: "攻击", begin: "开始", end: "结束", loop: "循环",
    idle: "待机", relax: "休息", sit: "坐下", sleep: "睡眠",
    interact: "交互", combat: "战斗", die: "死亡", death: "死亡",
    start: "登场", born: "登场", appear: "登场",
    move: "移动", down: "向下", up: "向上",
    skill: "技能", spell: "施法",
    special: "特殊", win: "胜利", victory: "胜利", defeat: "失败",
    hit: "受击", buff: "增益", a: "A", b: "B",
    default: "默认", action: "动作", show: "展示",
    in: "入", out: "出", open: "开", close: "关",
    front: "正面", back: "背面", base: "基建",
    thinking: "思考", happy: "开心", angry: "生气", sad: "悲伤",
    surprised: "惊讶", touch: "触摸", head: "头", body: "身体",
  };

  const NUM_MAP: Record<string, string> = { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五" };
  const parts = rest.split("_").map(seg => {
    const lower = seg.toLowerCase();
    // 数字转中文
    if (/^\d+$/.test(seg)) return NUM_MAP[seg] || seg;
    return SEGMENT_MAP[lower] || seg;
  });

  return prefix + parts.join("_");
}

const panelAnimListFlat = computed<PanelAnimItem[]>(() => {
  return panelAnimList.value.map(name => ({
    name,
    label: translateAnimName(name),
  }));
});
import {
  CHARACTERS,
  getCharacter,
  GROUP_LIST,
  getGroup,
  getGroupId,
  getCharacterAlters,
  DEFAULT_CHAR_ID,
  DEFAULT_SKIN_NAME,
  DEFAULT_MODEL_GROUP,
  applyCharactersUpdate,
  type CharacterEntry,
  type SkinEntry,
  type GroupItem,
} from "./config";
import { getAlterGroup } from "./character-groups";
import { usePetScale } from "./usePetScale";
import { usePetState } from "./usePetState";
import { usePetDrag } from "./usePetDrag";

// ============================================================
// 持久化 Key
// ============================================================

const SETTINGS_KEY = "shu-pet-settings";

interface PetSettings {
  groupId?: string;
  characterId?: string;
  skin?: string;
  model?: string;
  scale?: number;
  flipped?: boolean;
  frameRate?: number;
  animClickPlay?: boolean;
  animLoop?: boolean;
  alwaysOnTop?: boolean;
  animPanelPos?: { x: number; y: number };
  menuPanelPos?: { x: number; y: number };
}

function loadSettings(): PetSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e: any) {
    logWarn("Renderer", "loadSettings 失败", { error: e?.message || String(e) });
  }
  return {};
}

function saveSettings(
  groupId: string, characterId: string, skin: string, model: string,
  scale: number, flipped: boolean, frameRate: number,
  animClickPlay: boolean, animLoop: boolean, alwaysOnTop: boolean,
  animPanelPos: { x: number; y: number }, menuPanelPos: { x: number; y: number }
) {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ groupId, characterId, skin, model, scale, flipped, frameRate, animClickPlay, animLoop, alwaysOnTop, animPanelPos, menuPanelPos })
    );
  } catch (e: any) {
    logError("Renderer", "saveSettings 失败", { error: e?.message || String(e) });
  }
}

// ============================================================
// Refs
// ============================================================

const canvas = ref<HTMLCanvasElement>();
const containerRef = ref<HTMLElement>();
const spineRef = ref<Spine | null>(null);
const isLoading = ref(true);
const loadError = ref("");
/** GPU 厂商（自适应 powerPreference），在 onMounted 中异步获取 */
let gpuVendor = 'unknown';

// ============================================================
// 窗口屏幕位置（3× 窗口 → 面板/场景坐标计算的基准）
// ============================================================

/** 当前窗口左上角的屏幕坐标（窗口始终从 (0,0) 启动，异步确认后会更新） */
const windowScreenPos = ref({ x: 0, y: 0 });
/** 屏幕工作区中心坐标（初始化后不变） */
let screenCenterX = 960; // 兜底默认
let screenCenterY = 540;
/** 屏幕工作区尺寸（初始化后不变） */
let workAreaW = 1920;
let workAreaH = 1080;

// ============================================================
// 角色 & 皮肤 & 模型（优先从 localStorage 恢复）
// ============================================================

const saved = loadSettings();

/** 当前角色 ID */
const curCharId = ref(saved.characterId || DEFAULT_CHAR_ID);

/** 当前角色组 ID */
const curGroupId = ref(saved.groupId || getGroupId(curCharId.value) || curCharId.value);

/** 当前角色完整配置 */
const curCharacter = computed<CharacterEntry | undefined>(() => getCharacter(curCharId.value));

/** 当前组内所有异格的角色 ID */
const curAlterIds = computed<string[]>(() => {
  const group = getGroup(curGroupId.value);
  return group ? group.memberIds : [curCharId.value];
});

/** 当前组信息 */
const curGroup = computed<GroupItem | undefined>(() => getGroup(curGroupId.value));

/** 当前角色的皮肤列表（"默认"排最前） */
const skinNames = computed<string[]>(() => {
  if (!curCharacter.value) return [];
  const keys = Object.keys(curCharacter.value.meta.skin);
  // 把"默认"移到最前
  const idx = keys.indexOf("默认");
  if (idx > 0) {
    keys.splice(idx, 1);
    keys.unshift("默认");
  }
  return keys;
});

/** 陪伴模式：统一使用基建模型 */
const modelGroups = computed<string[]>(() => {
  if (!curCharacter.value) return [];
  const skins = curCharacter.value.meta.skin;
  const curSkinName = curSkin.value;
  const keys = skins[curSkinName] ? Object.keys(skins[curSkinName]) : [];
  // 陪伴模式只保留"基建"模型（战斗用的正面/背面已清理）
  return keys.includes("基建") ? ["基建"] : (keys.length > 0 ? [keys[0]] : []);
});

/** 当前皮肤名 */
const curSkin = ref(DEFAULT_SKIN_NAME);

/** 当前模型组名 */
const curModel = ref(DEFAULT_MODEL_GROUP);

// 从保存的设置恢复
function restoreSettings() {
  const char = curCharacter.value;
  if (!char) return;

  // 恢复皮肤（优先用"默认"）
  const allSkinNames = Object.keys(char.meta.skin);
  if (saved.skin && allSkinNames.includes(saved.skin)) {
    curSkin.value = saved.skin;
  } else {
    curSkin.value = allSkinNames.includes("默认") ? "默认" : (allSkinNames[0] || DEFAULT_SKIN_NAME);
  }

  // 陪伴模式：统一使用基建模型，忽略保存的模型值
  const skinModels = Object.keys(char.meta.skin[curSkin.value] || {});
  curModel.value = skinModels.includes("基建") ? "基建" : (skinModels[0] || DEFAULT_MODEL_GROUP);

  // 确认 curCharId 属于 curGroupId
  const group = getGroup(curGroupId.value);
  if (group && !group.memberIds.includes(curCharId.value)) {
    curCharId.value = group.defaultId;
  }

  // 恢复缩放
  if (saved.scale && typeof saved.scale === "number") {
    setScale(saved.scale);
  }

  // 恢复其他设置
  isFlipped.value = saved.flipped ?? false;
  isAlwaysOnTop.value = saved.alwaysOnTop ?? true;
  // 恢复帧率（仅接受合法值）
  curFrameRateSetting.value = sanitizeFrameRate(saved.frameRate);
  animClickPlay.value = saved.animClickPlay ?? true;
  animLoop.value = saved.animLoop ?? true;
}

// ============================================================
// 菜单（固定在窗口底部弹出）
// ============================================================

const showMenu = ref(false);
const searchQuery = ref("");

/** 搜索过滤后的角色列表 */
const filteredGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return GROUP_LIST;
  return GROUP_LIST.filter((g) => {
    if (g.displayName.toLowerCase().includes(q)) return true;
    return g.memberIds.some((id) => {
      const char = getCharacter(id);
      return char?.meta.name.toLowerCase().includes(q);
    });
  });
});

// ============================================================
// 左右翻转（由按钮手动切换）
// ============================================================

const isFlipped = ref(saved.flipped ?? false);

function toggleFlip() {
  isFlipped.value = !isFlipped.value;
}

/** 置顶（与托盘同步） */
const isAlwaysOnTop = ref(saved.alwaysOnTop ?? true);

/**
 * 从 localStorage 恢复帧率
 * 必须是 number 类型 —— 防止 boolean / 字符串污染序列化结果
 */
function sanitizeFrameRate(raw: unknown): number {
  return typeof raw === "number" ? raw : 30;
}

/** 当前帧率设定值 */
const curFrameRateSetting = ref(sanitizeFrameRate(saved.frameRate));

/** 实际生效的 FPS */
const effectiveFrameRate = computed(() => curFrameRateSetting.value);

// ============================================================
// 面板拖拽位置
// ============================================================

/** 验证面板位置是否在屏幕附近，离太远则重置 */
function validatePanelPos(pos: { x: number; y: number } | undefined, defaultPos: { x: number; y: number }): { x: number; y: number } {
  if (!pos) return defaultPos;
  const margin = 200;
  const panelW = 190;
  const panelH = 280;
  // 面板存的是屏幕坐标，窗口从 (0,0) 启动覆盖整个工作区
  // 给予一定余量（可拖到屏幕外一点，Alt+拖窗口可见）
  if (pos.x + panelW < -margin || pos.x > workAreaW + margin ||
      pos.y + panelH < -margin || pos.y > workAreaH + margin) {
    return defaultPos;
  }
  return pos;
}

/** 动画面板位置（屏幕坐标） */
const animPanelPos = ref(validatePanelPos(saved.animPanelPos, {
  x: screenCenterX + workAreaW / 2 - 210,
  y: screenCenterY - workAreaH / 2 + 10,
}));
/** 设置菜单位置（屏幕坐标） */
const menuPanelPos = ref(validatePanelPos(saved.menuPanelPos, {
  x: screenCenterX - workAreaW / 2 + 10,
  y: screenCenterY - workAreaH / 2 + 10,
}));

/** 面板 CSS 样式：屏幕坐标 → 窗口 viewport 坐标 */
const animPanelStyle = computed(() => ({
  left: `${animPanelPos.value.x - windowScreenPos.value.x}px`,
  top: `${animPanelPos.value.y - windowScreenPos.value.y}px`,
}));
const menuPanelStyle = computed(() => ({
  left: `${menuPanelPos.value.x - windowScreenPos.value.x}px`,
  top: `${menuPanelPos.value.y - windowScreenPos.value.y}px`,
}));

/** 面板拖拽处理器：存屏幕坐标（不受窗口移动影响） */
function usePanelDrag(panelRef: Ref<HTMLElement | undefined>, pos: Ref<{ x: number; y: number }>) {
  function onPointerDown(e: PointerEvent) {
    const el = panelRef.value;
    if (!el) return;
    // 跳过按钮、输入框等交互元素
    const target = e.target as HTMLElement;
    if (target.closest("button, input, label, select, textarea, a")) return;
    // 用屏幕坐标计算偏移，确保拖拽结果存的是屏幕绝对坐标
    const startScreenX = e.screenX;
    const startScreenY = e.screenY;
    const startPosX = pos.value.x;
    const startPosY = pos.value.y;
    el.setPointerCapture(e.pointerId);

    function onMove(ev: PointerEvent) {
      pos.value = {
        x: startPosX + (ev.screenX - startScreenX),
        y: startPosY + (ev.screenY - startScreenY),
      };
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return onPointerDown;
}

const animBarRef = ref<HTMLElement>();
const contextMenuRef = ref<HTMLElement>();
const onAnimBarDrag = usePanelDrag(animBarRef, animPanelPos);
const onContextMenuDrag = usePanelDrag(contextMenuRef, menuPanelPos);

// ============================================================
// 动画列表（Skill 三组）
// ============================================================

/** 动画面板开关（子窗口模式下追踪面板可见性） */
const showAnimPanel = ref(false);
/** 设置面板开关 */
const showMenuPanel = ref(false);

/** 切换动画面板子窗口 */
function toggleAnimPanel() {
  if (showAnimPanel.value) {
    window.electronAPI?.hideAnimPanel();
    showAnimPanel.value = false;
  } else {
    window.electronAPI?.showAnimPanel();
    showAnimPanel.value = true;
  }
}

/** 切换设置面板子窗口 */
function toggleMenuPanel() {
  if (showMenuPanel.value) {
    window.electronAPI?.hideMenuPanel();
    showMenuPanel.value = false;
  } else {
    window.electronAPI?.showMenuPanel();
    showMenuPanel.value = true;
  }
}
/** 当前骨架的所有动画名 */
const animNames = ref<string[]>([]);
/** 当前选中的分组索引 */
const activeGroup = ref(0);
/** 点播模式：开=点击播放，关=只读 */
const animClickPlay = ref(saved.animClickPlay ?? true);
/** 循环播放 */
const animLoop = ref(saved.animLoop ?? true);
/** 当前正在循环播放的动画名（用于按钮高亮） */
const currentAnim = ref("");

// 关闭点播时自动关闭循环 + 回到状态机交互
watch(animClickPlay, (v) => {
  if (!v) {
    animLoop.value = false;
    currentAnim.value = "";
    resetState();
  }
});

/** 陪伴模式：动画已扁平化，不再按技能分组 */
const animGroups = computed(() => {
  // 陪伴模式下直接返回扁平列表，无需技能分组
  const items = animNames.value.map(name => ({
    name,
    label: name,
  }));
  return items.length > 0 ? [{ label: "动画", anims: items }] : [];
});

function refreshAnimList() {
  const spine = spineRef.value;
  if (spine) {
    const rawAnims = spine.getAnimationNames();
    // 陪伴模式：过滤掉战斗动画（attack/skill_begin/combat/die 等）
    const companionAnims = filterCompanionAnims(rawAnims);
    animNames.value = companionAnims;
    classifierResult.value = classifyAnimations(companionAnims);
  } else {
    classifierResult.value = null;
  }
  activeGroup.value = 0;
}

function playAnim(name: string) {
  if (!animClickPlay.value) return;
  currentAnim.value = animLoop.value ? name : "";
  const spine = spineRef.value;
  if (spine) {
    spine.setAnimation(name, animLoop.value);
  }
}

/** 同步角色/动画状态到面板子窗口 */
function syncPanelState() {
  try {
    const char = curCharacter.value;
    if (!char) return;

    // 构建异格显示名
    const alterDisplayNames: Record<string, string> = {};
    for (const id of curAlterIds.value) {
      const c = getCharacter(id);
      if (c) {
        const group = getGroup(curGroupId.value);
        if (group) {
          const names = group.memberIds.map((mid) => getCharacter(mid)?.meta.name);
          const uniqueNames = [...new Set(names)];
          if (uniqueNames.length === 1 && group.memberIds.length > 1) {
            const wikiName = c.name;
            const paren = wikiName.match(/[（(]([^）)]+)[）)]/);
            alterDisplayNames[id] = paren ? paren[1] : c.meta.name;
          } else {
            alterDisplayNames[id] = c.meta.name;
          }
        }
      }
    }

    // JSON 序列化确保 IPC 可克隆（去除 Vue proxy / 非标准对象）
    const state = JSON.parse(JSON.stringify({
      animList: animNames.value,
      charState: {
        charId: curCharId.value,
        charName: curCharName.value,
        groupId: curGroupId.value,
        skinNames: skinNames.value,
        curSkin: curSkin.value,
        modelGroups: modelGroups.value,
        curModel: curModel.value,
        alterIds: curAlterIds.value,
        alterDisplayNames,
        animClickPlay: animClickPlay.value,
        animLoop: animLoop.value,
        currentAnim: currentAnim.value,
      },
      // 完整角色列表（供设置面板搜索用）
      groupList: groupList.value.map(g => ({
        groupId: g.groupId,
        displayName: g.displayName,
        memberIds: g.memberIds,
      })),
      // 操作面板状态（翻转、面板可见性）
      actionState: {
        flipped: isFlipped.value,
        showAnimPanel: showAnimPanel.value,
        showMenuPanel: showMenuPanel.value,
      },
    }));
    window.electronAPI?.sendPanelState(state);
  } catch (e: any) {
    // 静默失败，面板同步不是关键路径，但记录日志以便排查 IPC 问题
    logWarn("Renderer", "syncPanelState 失败", { error: e?.message || String(e) });
  }
}

// ============================================================
// 气泡列表（多气泡往上挤）
// ============================================================

interface BubbleItem {
  id: number;
  text: string;
  fading: boolean;
}
const bubbleList = ref<BubbleItem[]>([]);
let bubbleNextId = 0;

function addBubble(text: string) {
  const id = ++bubbleNextId;
  bubbleList.value = [{ id, text, fading: false }, ...bubbleList.value];
  setTimeout(() => {
    bubbleList.value = bubbleList.value.map(b => b.id === id ? { ...b, fading: true } : b);
    setTimeout(() => {
      bubbleList.value = bubbleList.value.filter(b => b.id !== id);
    }, 300);
  }, 2500);
}

const debug = ref(false);
/** 显示 FPS 覆盖层 */
const showFps = ref(false);
const fpsHistory = ref<number[]>([]);
const fpsAvg = ref(0);
/** 捕获到的渲染/JS 错误 */
const capturedErrors = ref<string[]>([]);
const showErrors = ref(false);

/** Alt 键按下时关闭鼠标穿透，让 Alt+拖拽能收到 pointerdown */
function onAltKeyDown(e: KeyboardEvent) {
  if (e.key === "Alt" && !e.repeat && lastIgnoreState !== false) {
    window.electronAPI?.setIgnoreMouseEvents(false);
    lastIgnoreState = false;
  }
}

/** Alt 键松开时强制结束拖拽 */
function onAltKeyUp(e: KeyboardEvent) {
  if (e.key === "Alt" && isDragging.value) {
    isDragging.value = false;
    hasMoved.value = false;
    dragStartedWithAlt = false;
    window.electronAPI?.windowDragEnd();
  }
}

/** 全局错误捕获（因为拖拽导致 DevTools 不可点） */
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    const msg = `${e.message || e.error?.message || e}`.slice(0, 200);
    if (!capturedErrors.value.includes(msg)) {
      capturedErrors.value = [...capturedErrors.value, msg].slice(-10);
      showErrors.value = true;
    }
    // 写入日志文件
    logError("Renderer", "window.onerror", {
      message: msg,
      filename: e.filename?.slice(-60),
      lineno: e.lineno,
      colno: e.colno,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = `[Promise] ${e.reason?.message || e.reason || e}`.slice(0, 200);
    if (!capturedErrors.value.includes(msg)) {
      capturedErrors.value = [...capturedErrors.value, msg].slice(-10);
      showErrors.value = true;
    }
    // 写入日志文件
    logError("Renderer", "unhandledrejection", {
      message: msg,
      stack: e.reason?.stack?.slice(0, 300),
    });
  });
}

// 暴露全局切换函数，供托盘"显示边界"调用
(window as any).__toggleDebug = () => {
  debug.value = !debug.value;
  window.electronAPI?.reportDebug(debug.value);
};

// Ctrl+Shift+F 切换 FPS 覆盖层
function onKeyDown(e: KeyboardEvent) {
  if (e.ctrlKey && e.shiftKey && e.key === "F") {
    e.preventDefault();
    showFps.value = !showFps.value;
    if (showFps.value) {
      // 在 spine 上挂一个 FPS 采样钩子
      const spine = spineRef.value;
      if (spine) {
        (spine as any).__fpsCallback = (dt: number) => {
          const now = performance.now();
          fpsHistory.value.push(dt);
          if (fpsHistory.value.length > 60) fpsHistory.value.shift();
          // FPS = 1000 / 平均帧耗时
          const sum = fpsHistory.value.reduce((a, b) => a + b, 0);
          fpsAvg.value = Math.round(fpsHistory.value.length / (sum / 1000));
        };
      }
    } else {
      (spineRef.value as any).__fpsCallback = undefined;
      fpsHistory.value = [];
    }
  }
}

// ============================================================
// 每个角色的气泡文本
// ============================================================

interface BubbleTextEntry {
  texts: string[];
  /** true=同异格组共享，false=仅本角色 */
  shared: boolean;
}

const CHAR_BUBBLE_TEXTS: Record<string, BubbleTextEntry> = {
  char_2025_shu: { texts: ["黍来了~", "稻田守望", "别踩麦子！", "哼~", "种田去"], shared: false },
};

const GENERIC_TEXTS = [
  "嘿！", "看招~", "别点啦", "哼！", "嘻嘻", "再来一次？",
  "好困...", "活动一下~", "啊！", "不错嘛", "小心了！", "干嘛呀~",
];

const curBubbleTexts = computed(() => {
  // 1. 精确匹配
  const exact = CHAR_BUBBLE_TEXTS[curCharId.value];
  if (exact) return exact.texts;

  // 2. 看同异格组有没有 shared 的
  const group = getAlterGroup(curCharId.value);
  if (group) {
    for (const id of group.memberIds) {
      const entry = CHAR_BUBBLE_TEXTS[id];
      if (entry?.shared) return entry.texts;
    }
  }

  // 3. 通用兜底
  return GENERIC_TEXTS;
});

// ============================================================
// Composables
// ============================================================

const { scale, setScale, onWheel } =
  usePetScale();
const classifierResult = ref<ClassifyResult | null>(null);
const { state: petState, handleClick, init: initState, reset: resetState } =
  usePetState(spineRef, classifierResult, (text: string) => {
    addBubble(text);
  }, curBubbleTexts);
// JS 拖拽 composable（替代 OS 级 -webkit-app-region: drag）
const { isDragging, hasMoved, onPointerDown: onDragPointerDown, onPointerMove: onDragPointerMove, onPointerUp: onDragPointerUp, onPointerCancel: onDragPointerCancel } =
  usePetDrag(containerRef);
// ============================================================
// 画布样式（含翻转）
// ============================================================

/** 场景包装器：CSS 50vh/50vw 居中 + JS 缩放 */
const sceneStyle = computed(() => ({
  transform: `translate(-50%, -50%) scale(${scale.value})`,
}));

/** Canvas 仅处理翻转（居中由场景层处理） */
const canvasFlipStyle = computed(() => ({
  transform: isFlipped.value ? 'scaleX(-1)' : 'none',
}));

// ============================================================
// 自动保存：皮肤 / 模型 / 缩放变化时写入 localStorage
// ============================================================

watch([curGroupId, curCharId, curSkin, curModel, scale, isFlipped, curFrameRateSetting, animClickPlay, animLoop, currentAnim, isAlwaysOnTop, animPanelPos, menuPanelPos], () => {
  saveSettings(curGroupId.value, curCharId.value, curSkin.value, curModel.value, scale.value, isFlipped.value, curFrameRateSetting.value, animClickPlay.value, animLoop.value, isAlwaysOnTop.value, animPanelPos.value, menuPanelPos.value);
  // 状态变化时同步到所有面板（缩放/翻转/可见性/当前动画）
  syncPanelState();
});

// 动画列表变化时也同步（确保动画面板无论何时打开都能拿到最新列表）
watch(animNames, () => {
  syncPanelState();
}, { deep: false });

// ============================================================
// 计算属性
// ============================================================

/** 当前角色显示名 */
const curCharName = computed(() => curCharacter.value?.meta.name || "未知");

/** 分组角色列表（config.ts 中已按字数+拼音排序） */
const groupList = computed(() => GROUP_LIST);

// ============================================================
// 模型加载
// ============================================================

async function loadModel() {
  isLoading.value = true;
  loadError.value = "";
  const loadKey = `${curCharId.value}/${curSkin.value}/${curModel.value}`;
  logInfo("Renderer", `模型加载开始: ${loadKey}`);
  try {
    const char = curCharacter.value;
    if (!char) {
      loadError.value = `角色 ${curCharId.value} 未找到`;
      isLoading.value = false;
      logWarn("Renderer", "模型加载失败: 角色未找到", { charId: curCharId.value });
      return;
    }

    const spine = spineRef.value!;
    const skinData = char.meta.skin[curSkin.value];
    const modelData: SkinEntry | undefined = skinData?.[curModel.value];
    if (!modelData) {
      loadError.value = `模型配置缺失：${curSkin.value}/${curModel.value}`;
      isLoading.value = false;
      logWarn("Renderer", "模型加载失败: 配置缺失", { skin: curSkin.value, model: curModel.value });
      return;
    }

    const path = char.meta.prefix + modelData.file;
    const key = `${curCharId.value}-${curSkin.value}-${curModel.value}`;
    // 加载新模型前释放旧骨架的 GPU 纹理，防止 OOM 崩溃
    if (!spine.hasModel(key)) spine.cleanupExcept(key);
    await spine.load(
      key,
      `${path}.skel`,
      `${path}.atlas`,
      { x: -375, y: -175, scale: 0.75 },
      modelData.skin,
    );
    isLoading.value = false;

    spine.play(key);
    resetState();
    applyFrameRate();
    refreshAnimList();

    logInfo("Renderer", `模型加载成功: ${loadKey}`, { animCount: animNames.value.length });
    // 同步状态到面板子窗口
    syncPanelState();
  } catch (e: any) {
    const errMsg = e.message || String(e);
    loadError.value = `加载失败: ${errMsg}`;
    isLoading.value = false;
    logError("Renderer", `模型加载失败: ${loadKey}`, { error: errMsg, stack: e.stack?.slice(0, 300) });
    // 加载失败时也同步一次，让面板拿到当前状态（animNames 可能还是空的）
    syncPanelState();
  }
}

// ============================================================
// 交互处理
// ============================================================

// ============================================================
// 点击穿透 — 像素级别 alpha 检测 + 动态 setIgnoreMouseEvents
// ============================================================

/** 像素 alpha 检测阈值 (0-255)，低于此值认为鼠标下方无内容 */
const ALPHA_THRESHOLD = 10;
/** 像素读取节流间隔 (ms)，0 = 每次移动都检测 */
const PIXEL_CHECK_INTERVAL_MS = 0;
/** 上次像素检查的时间戳 */
let lastPixelCheckTime = 0;
/** 缓存的忽略鼠标事件状态，避免重复 IPC 调用 */
let lastIgnoreState: boolean | null = null;
/** Alt键拖拽标记：true = 本次拖拽由 Alt+click 发起 */
let dragStartedWithAlt = false;

/** 鼠标穿透恢复轮询：通过全局鼠标位置 + 直接读 WebGL alpha 恢复 */
let recoveryRAF: number | null = null;

function startRecoveryPolling() {
  // 已经启动则不重复
  if (recoveryRAF !== null) return;

  async function poll() {
    // 如果已经恢复（lastIgnoreState 不再是 true），停止轮询
    if (lastIgnoreState !== true) {
      recoveryRAF = null;
      return;
    }

    try {
      const cursorPos = await window.electronAPI?.getCursorPos();
      if (!cursorPos) { recoveryRAF = requestAnimationFrame(poll); return; }

      // 屏幕坐标 → 窗口视口坐标（窗口从 workArea 原点启动）
      const relX = cursorPos.x - windowScreenPos.value.x;
      const relY = cursorPos.y - windowScreenPos.value.y;

      // 视口坐标 → Canvas 内部像素坐标
      const mapped = mapMouseToCanvasInternal(relX, relY);
      if (!mapped) { recoveryRAF = requestAnimationFrame(poll); return; }

      // 直接读 GPU framebuffer alpha（无需鼠标事件触发）
      const spine = spineRef.value;
      if (!spine) { recoveryRAF = requestAnimationFrame(poll); return; }

      const alpha = spine.readPixelAlpha(mapped.x, mapped.y);
      if (alpha > ALPHA_THRESHOLD) {
        // 鼠标在模型像素上 → 恢复事件接收
        window.electronAPI?.setIgnoreMouseEvents(false);
        lastIgnoreState = false;
        recoveryRAF = null;
      } else {
        // 仍然在空白区域 → 继续轮询
        recoveryRAF = requestAnimationFrame(poll);
      }
    } catch {
      recoveryRAF = requestAnimationFrame(poll);
    }
  }

  recoveryRAF = requestAnimationFrame(poll);
}

function stopRecoveryPolling() {
  if (recoveryRAF !== null) {
    cancelAnimationFrame(recoveryRAF);
    recoveryRAF = null;
  }
}

/**
 * 将鼠标窗口坐标映射到 canvas 内部像素坐标
 */
function mapMouseToCanvasInternal(clientX: number, clientY: number): { x: number; y: number } | null {
  const el = canvas.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // 鼠标相对于 canvas CSS 盒子的偏移
  const relX = clientX - rect.left;
  const relY = clientY - rect.top;
  // CSS 尺寸 → canvas 内部尺寸映射
  const internalX = relX * (el.width / rect.width);
  const internalY = relY * (el.height / rect.height);
  return { x: internalX, y: internalY };
}

/**
 * 检查鼠标下方是否有渲染的模型像素
 * 通过读取 WebGL framebuffer 中对应像素的 alpha 通道判断
 */
function isOverRenderedPixel(clientX: number, clientY: number): boolean {
  const spine = spineRef.value;
  if (!spine) return false;
  const mapped = mapMouseToCanvasInternal(clientX, clientY);
  if (!mapped) return false;
  const alpha = spine.readPixelAlpha(mapped.x, mapped.y);
  return alpha > ALPHA_THRESHOLD;
}

/**
 * 更新鼠标穿透状态（节流版）
 */
function updateMouseIgnore(clientX: number, clientY: number, altKey = false): void {
  const now = performance.now();
  if (!altKey && now - lastPixelCheckTime < PIXEL_CHECK_INTERVAL_MS) return;
  lastPixelCheckTime = now;

  // 正在拖拽时不改变穿透状态
  if (isDragging.value) return;

  // Alt 键按下时保持接收事件，否则无法收到 pointerdown 进行拖拽
  if (altKey) {
    if (lastIgnoreState !== false) {
      window.electronAPI?.setIgnoreMouseEvents(false);
      lastIgnoreState = false;
      stopRecoveryPolling();
    }
    return;
  }

  const shouldIgnore = !isOverRenderedPixel(clientX, clientY);

  // 避免重复 IPC 调用
  if (shouldIgnore !== lastIgnoreState) {
    lastIgnoreState = shouldIgnore;
    window.electronAPI?.setIgnoreMouseEvents(shouldIgnore, shouldIgnore ? { forward: true } : undefined);

    // 进入穿透模式时启动恢复轮询，退出时停止
    if (shouldIgnore) {
      startRecoveryPolling();
    } else {
      stopRecoveryPolling();
    }
  }
}

/**
 * 判断事件目标是否在交互式 UI 元素内
 * 这些元素始终接收事件，不受像素检测影响
 */
function isInsideUIElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return !!el.closest('.anim-bar, .context-menu, .menu-backdrop, .error-capture');
}

/**
 * 统一 pointerdown：开始 JS 拖拽（仅左键）
 * Alt 按下 → 任意位置开始拖拽（移动窗口）
 * 未按 Alt → 仅在模型区域拖拽 / 交互
 */

// 不再使用：拖拽按钮已移至操作面板
// 主窗口使用 Alt+拖拽移动

function onInteractPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;

  // 注意：面板子窗口关闭不由主窗口控制
  // 面板透明区域的点击会被 Windows 自动转发到下层窗口（主窗口），
  // 因此这里不自动隐藏面板，避免面板透明区域误触导致面板消失。
  // 面板由操作面板按钮或面板自身的 close 事件管理。

  dragStartedWithAlt = e.altKey;

  if (e.altKey) {
    // Alt 拖拽：忽略 UI 元素检测，直接拖拽
    window.electronAPI?.setIgnoreMouseEvents(false);
    lastIgnoreState = false;
    onDragPointerDown(e);
    return;
  }

  // 普通模式：跳过 UI 元素
  if (isInsideUIElement(e.target)) return;
  // 开始拖拽前确保接收鼠标事件
  window.electronAPI?.setIgnoreMouseEvents(false);
  lastIgnoreState = false;
  onDragPointerDown(e);
}

/**
 * 统一 pointermove：拖拽中 → 继续拖拽；非拖拽 → 像素穿透检测
 */
function onInteractPointerMove(e: PointerEvent) {
  if (isDragging.value) {
    onDragPointerMove(e);
    return;
  }

  // UI 元素上始终关闭穿透
  if (isInsideUIElement(e.target)) {
    if (lastIgnoreState !== false) {
      window.electronAPI?.setIgnoreMouseEvents(false);
      lastIgnoreState = false;
    }
    return;
  }

  updateMouseIgnore(e.clientX, e.clientY, e.altKey);
}

/**
 * 统一 pointerup：结束拖拽
 * Alt 拖拽 → 仅结束，不触发互动
 * 普通拖拽 → 无移动视为点击，触发互动
 */
function onInteractPointerUp(e: PointerEvent) {
  const wasAltDrag = dragStartedWithAlt;
  dragStartedWithAlt = false;

  onDragPointerUp(e);
  if (!wasAltDrag && !hasMoved.value) {
    onInteractClickInBar();
  }
}

/** pointercancel：系统取消指针捕获时清理拖拽状态 */
function onInteractPointerCancel(e: PointerEvent) {
  onDragPointerCancel(e);
}

/**
 * 鼠标离开窗口时立即启用穿透，防止残留在窗口内状态
 */
function onContainerMouseLeave() {
  if (!isDragging.value && lastIgnoreState !== true) {
    window.electronAPI?.setIgnoreMouseEvents(true, { forward: true });
    lastIgnoreState = true;
    startRecoveryPolling();
  }
}

(function initIgnoreState() {
  // 初始状态：接收所有鼠标事件，首帧 pointermove 会根据像素 alpha 自动切换穿透
  window.electronAPI?.setIgnoreMouseEvents(false);
  lastIgnoreState = false;
})();

function onInteractClickInBar() {
  // 新状态机自动适配所有动画命名风格，统一走 handleClick
  handleClick();
}

function onSelectSkin(skin: string) {
  curSkin.value = skin;
  // 切换皮肤时优先选"基建"，没有才取第一个
  const char = curCharacter.value;
  if (char) {
    const models = Object.keys(char.meta.skin[skin] || {});
    curModel.value = models.includes("基建") ? "基建" : (models[0] || DEFAULT_MODEL_GROUP);
  }
  loadModel();
}

function onSelectModel(model: string) {
  curModel.value = model;
  loadModel();
}

/**
 * 获取异格版本的显示名
 * 对于同名异格（如阿米娅 ×3），追加 (近卫) (医疗) 后缀
 * 对于不同名异格，直接使用角色名
 */
function getAlterDisplayName(alterId: string): string {
  const char = getCharacter(alterId);
  if (!char) return alterId;
  const group = getGroup(curGroupId.value);
  if (!group) return char.meta.name;
  // 如果组内有多个同名角色，用 wiki 页名中的括号后缀区分
  const names = group.memberIds.map((id) => getCharacter(id)?.meta.name);
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 1 && group.memberIds.length > 1) {
    // 同名异格：从 wiki 页名中提取括号里的内容
    const wikiName = char.name;
    const paren = wikiName.match(/[（(]([^）)]+)[）)]/);
    return paren ? paren[1] : char.meta.name;
  }
  // 不同名异格（如 W / 维什戴尔）
  return char.meta.name;
}

/** 切换角色组 */
function onSelectGroup(groupId: string) {
  if (groupId === curGroupId.value) return;
  curGroupId.value = groupId;
  const group = getGroup(groupId);
  if (group) {
    curCharId.value = group.defaultId;
    const char = getCharacter(curCharId.value);
    if (char) {
      const skinList = Object.keys(char.meta.skin);
      curSkin.value = skinList.includes("默认") ? "默认" : (skinList[0] || DEFAULT_SKIN_NAME);
      const models = Object.keys(char.meta.skin[curSkin.value] || {});
      curModel.value = models.includes("基建") ? "基建" : (models[0] || DEFAULT_MODEL_GROUP);
    }
  }
  loadModel();
}

/** 切换异格（组内切换） */
function onSelectAlter(charId: string) {
  if (charId === curCharId.value) return;
  curCharId.value = charId;
  const char = getCharacter(charId);
  if (char) {
    const skinList = Object.keys(char.meta.skin);
    curSkin.value = skinList.includes("默认") ? "默认" : (skinList[0] || DEFAULT_SKIN_NAME);
    const models = Object.keys(char.meta.skin[curSkin.value] || {});
    curModel.value = models.includes("基建") ? "基建" : (models[0] || DEFAULT_MODEL_GROUP);
  }
  loadModel();
}

function closeMenu() {
  showMenu.value = false;
  searchQuery.value = "";
}

// ============================================================
// 帧率控制
// ============================================================

function applyFrameRate() {
  const spine = spineRef.value;
  if (!spine) return;
  const rate = effectiveFrameRate.value;
  spine.setFrameRate(rate > 0 ? rate : 0);
}

// 帧率设定变化时动态应用
watch(curFrameRateSetting, () => {
  applyFrameRate();
  // 向主进程报告当前帧率（更新托盘菜单勾选）
  window.electronAPI?.reportFrameRate(curFrameRateSetting.value);
});

// ============================================================
// 可见性 & WebGL 上下文事件处理
// ============================================================

/** 页面可见性变化：隐藏时暂停渲染释放 GPU，可见时恢复 */
function onVisibilityChange() {
  const spine = spineRef.value;
  if (!spine) return;
  if (document.hidden) {
    spine.pause();
  } else {
    spine.resume();
  }
}

/** WebGL 上下文丢失：暂停渲染，避免崩溃扩散 */
function onContextLost(e: Event) {
  e.preventDefault();
  console.warn("[Pet] WebGL context lost, rendering paused");
  logWarn("Renderer", "WebGL context lost");
}

/** WebGL 上下文恢复：尝试重新加载模型 */
function onContextRestored() {
  console.log("[Pet] WebGL context restored, reloading model");
  logInfo("Renderer", "WebGL context restored，重建 Spine");
  const spine = spineRef.value;
  if (spine && spine.isContextLost) {
    // 上下文恢复后，旧 GPU 资源全部失效，需要重建 Spine 实例
    spine.destroy();
    if (canvas.value) {
      spineRef.value = new Spine(canvas.value, gpuVendor);
      loadModel();
    }
  }
}

// ============================================================
// 生命周期
// ============================================================

onMounted(() => {
  logInfo("Renderer", "PetCanvas onMounted", { isPanelMode: isPanelMode.value || "main" });

  // 获取 GPU 厂商（异步），存到模块变量供 Spine 构造函数用
  window.electronAPI?.getGpuVendor().then(vendor => {
    gpuVendor = vendor || 'unknown';
    logInfo("Renderer", "GPU 厂商检测", { gpuVendor });
  }).catch(() => { /* 静默失败，保持 unknown */ });

  // Debug 快捷键
  window.addEventListener("keydown", onKeyDown);

  // Alt 键按下时确保关闭鼠标穿透，让拖拽能收到 pointerdown
  window.addEventListener("keydown", onAltKeyDown);
  // Alt 键松开时强制结束拖拽
  window.addEventListener("keyup", onAltKeyUp);

  // 页面可见性：隐藏时暂停渲染 → 减少 GPU 负载
  document.addEventListener("visibilitychange", onVisibilityChange);

  // WebGL 上下文丢失/恢复
  canvas.value?.addEventListener("webglcontextlost", onContextLost);
  canvas.value?.addEventListener("webglcontextrestored", onContextRestored);

  // ============================================================
  // 面板子窗口 IPC 通信设置
  // ============================================================

  // 面板窗口自适应大小
  function fitPanelSize() {
    if (!isPanelMode.value) return;
    const pId = isPanelMode.value === "anim" ? "/anim-panel"
      : isPanelMode.value === "menu" ? "/menu-panel"
      : "/action-panel";
    setTimeout(() => {
      const win = document.querySelector(".panel-window");
      if (!win) return;
      // 测量所有子元素的实际边界（不受窗口尺寸限制）
      let maxW = 0, maxH = 0;
      for (const child of win.children) {
        const r = (child as HTMLElement).getBoundingClientRect();
        const w = r.right - win.getBoundingClientRect().left;
        const h = r.bottom - win.getBoundingClientRect().top;
        if (w > maxW) maxW = w;
        if (h > maxH) maxH = h;
      }
      // setPanelSize 会统一加 30px 底部间距，这里只传实际内容高度
      maxW += 12;
      if (isPanelMode.value === "action") {
        window.electronAPI?.setPanelSize(pId, 242, maxH);
      } else if (maxW > 100 && maxH > 50) {
        window.electronAPI?.setPanelSize(pId, maxW, maxH);
      }
    }, 100);
  }

  // 面板窗口：接收主窗口发来的状态同步
  window.electronAPI?.onPanelState((data: any) => {
    if (data.animList) panelAnimList.value = data.animList;
    if (data.charState) {
      panelCharState.value = data.charState;
      panelLocalAnimClickPlay.value = data.charState.animClickPlay ?? true;
      panelLocalAnimLoop.value = data.charState.animLoop ?? true;
      panelCurrentAnim.value = data.charState.currentAnim ?? "";
    }
    if (data.groupList) panelGroupList.value = data.groupList;
    // 操作面板状态同步
    if (data.actionState) {
      actionFlipped.value = data.actionState.flipped ?? false;
      actionAnimVisible.value = data.actionState.showAnimPanel ?? false;
      actionMenuVisible.value = data.actionState.showMenuPanel ?? false;
    }
    // 内容更新后自适应窗口大小（仅面板模式）
    if (isPanelMode.value) fitPanelSize();
  });

  if (isPanelMode.value) {
    window.electronAPI?.requestPanelState();
    const panelId = isPanelMode.value === "anim" ? "/anim-panel"
      : isPanelMode.value === "menu" ? "/menu-panel"
      : "/action-panel";

    // 面板窗口 JS 拖拽（setPointerCapture 防止鼠标移出窗口丢事件）
    let dragStart = { x: 0, y: 0 };
    let lastPanelMoveTime = 0;

    function onPanelHeaderDown(e: PointerEvent) {
      const header = e.currentTarget as HTMLElement;
      lastPanelMoveTime = 0;
      dragStart = { x: e.screenX, y: e.screenY };
      window.electronAPI?.panelDragStart(panelId);
      header.setPointerCapture(e.pointerId);
      header.addEventListener("pointermove", onPanelHeaderMove);
      header.addEventListener("pointerup", onPanelHeaderUp);
    }

    function onPanelHeaderMove(e: PointerEvent) {
      // 节流：最多 30fps 发 IPC，防止高刷屏拖拽时 DWM 卡死
      const now = performance.now();
      if (now - lastPanelMoveTime < 33) return;
      lastPanelMoveTime = now;
      window.electronAPI?.panelDragMove(panelId, e.screenX - dragStart.x, e.screenY - dragStart.y);
    }

    function onPanelHeaderUp(e: PointerEvent) {
      const header = e.currentTarget as HTMLElement;
      header.removeEventListener("pointermove", onPanelHeaderMove);
      header.removeEventListener("pointerup", onPanelHeaderUp);
      window.electronAPI?.panelDragEnd(panelId);
    }

    // 给 header 绑定拖拽（等 DOM 渲染后）
    setTimeout(() => {
      const header = document.querySelector(".drag-pill");
      if (header) {
        (header as HTMLElement).style.cursor = "grab";
        header.addEventListener("pointerdown", onPanelHeaderDown);
      }
    }, 100);
  }

  // 主窗口：接收面板发来的用户操作
  if (!isPanelMode.value) {
    // 面板窗口请求状态时，重新同步
    window.electronAPI?.onRequestPanelState(() => {
      syncPanelState();
    });
    window.electronAPI?.onPanelAction((data: any) => {
      const type = data?.type;
      if (!type) return;
      logDebug("Renderer", "onPanelAction", { type });
      try {
        if (type === "play-anim") {
          animClickPlay.value = true;
          animLoop.value = data.loop ?? false;
          currentAnim.value = data.loop ? data.name : "";
          spineRef.value?.setAnimation(data.name, data.loop ?? false);
        } else if (type === "select-group") {
          onSelectGroup(data.groupId);
        } else if (type === "select-alter") {
          onSelectAlter(data.charId);
        } else if (type === "select-skin") {
          onSelectSkin(data.skin);
        } else if (type === "select-model") {
          onSelectModel(data.model);
        } else if (type === "toggle-click-play") {
          animClickPlay.value = data.value;
        } else if (type === "toggle-loop") {
          animLoop.value = data.value;
        }
        // 操作面板操作
        else if (type === "interact") {
          onInteractClickInBar();
        } else if (type === "toggle-flip") {
          toggleFlip();
        } else if (type === "toggle-anim") {
          toggleAnimPanel();
        } else if (type === "toggle-menu") {
          toggleMenuPanel();
        } else if (type === "open-help") {
          window.electronAPI?.showHelpWindow();
        }
      } catch(e: any) {
        console.error("[Pet] panel-action 处理失败:", e);
        logError("Renderer", "panel-action 处理失败", { type, error: e?.message || String(e) });
      }
    });

    // 主窗口：追踪面板可见性（同步到操作面板）
    window.electronAPI?.onPanelVisibilityChanged((info: any) => {
      if (info.panel === "/anim-panel") showAnimPanel.value = info.visible;
      if (info.panel === "/menu-panel") showMenuPanel.value = info.visible;
      syncPanelState(); // 通知操作面板更新按钮高亮状态
    });
  }

  // GPU 进程崩溃通知（来自主进程）
  window.electronAPI?.onGpuCrashed(() => {
    console.warn("[Pet] GPU process crashed — attempting reload");
    logError("Renderer", "GPU 进程崩溃，尝试重建 Spine");
    const spine = spineRef.value;
    if (spine) {
      spine.destroy();
      if (canvas.value) {
        spineRef.value = new Spine(canvas.value, gpuVendor);
        loadModel();
      }
    }
  });

  // 从保存的设置恢复
  restoreSettings();

  // ============================================================
  // 窗口位置初始化（3× 窗口 → 获取屏幕坐标，计算场景/面板位置）
  // ============================================================
  (async () => {
    try {
      const pos = await window.electronAPI?.getWindowPosition();
      if (pos) {
        console.log("[Pet] 窗口位置:", JSON.stringify(pos));
        windowScreenPos.value = { x: pos.x, y: pos.y };
        screenCenterX = pos.availLeft + pos.availWidth / 2;
        screenCenterY = pos.availTop + pos.availHeight / 2;
        workAreaW = pos.availWidth;
        workAreaH = pos.availHeight;
        console.log("[Pet] 屏幕中心:", { screenCenterX, screenCenterY, workAreaW, workAreaH });
      }
    } catch(e) { console.error("[Pet] getWindowPosition 失败:", e); }

    // 重新验证面板位置（现在 screenCenter 已知，旧坐标可能是窗口坐标）
    const animDefault = { x: screenCenterX + workAreaW / 2 - 210, y: screenCenterY - workAreaH / 2 + 10 };
    const menuDefault = { x: screenCenterX - workAreaW / 2 + 10, y: screenCenterY - workAreaH / 2 + 10 };
    animPanelPos.value = validatePanelPos(saved.animPanelPos, animDefault);
    menuPanelPos.value = validatePanelPos(saved.menuPanelPos, menuDefault);
  })();

  // 窗口移动时更新位置
  window.electronAPI?.onWindowPositionChanged((pos) => {
    windowScreenPos.value = { x: pos.x, y: pos.y };
  });

  // ============================================================
  // 角色数据自动更新（7 天限流）
  // 先尝试加载 userData 已有版本，再检查 PRTS wiki 更新
  // ============================================================
  (async () => {
    try {
      const api = window.electronAPI;
      if (!api?.getCharactersData) return;

      // 1. 优先加载 userData 中已保存的更新版本（如有）
      const savedJson = await api.getCharactersData();
      if (savedJson) {
        const savedData = JSON.parse(savedJson);
        if (Array.isArray(savedData) && savedData.length > CHARACTERS.length) {
          applyCharactersUpdate(savedData);
        }
      }

      // 2. 静默检查 PRTS wiki 是否有新干员（7 天限流）
      if (!api.checkCharactersUpdate) return;
      const currentIds = CHARACTERS.map((c) => c.id);
      const result = await api.checkCharactersUpdate(currentIds);

      if (result.updated && result.newCount > 0) {
        console.log(`[Pet] 发现 ${result.newCount} 个新干员，更新角色列表`);
        const json = await api.getCharactersData();
        if (json) {
          const updatedData = JSON.parse(json);
          if (Array.isArray(updatedData) && updatedData.length > 0) {
            applyCharactersUpdate(updatedData);
          }
        }
      }
    } catch (e: any) {
      // 静默失败，不影响使用
      logDebug("Renderer", "角色数据自动更新失败", { error: e?.message || String(e) });
    }
  })();

  // 监听托盘菜单"检查角色更新"
  window.electronAPI?.onForceCharUpdate(async () => {
    try {
      addBubble("正在检查新干员…");
      const currentIds = CHARACTERS.map((c) => c.id);
      const result = await window.electronAPI!.checkCharactersUpdate!(currentIds);
      if (result.updated && result.newCount > 0) {
        const json = await window.electronAPI!.getCharactersData!();
        if (json) {
          const data = JSON.parse(json);
          if (Array.isArray(data) && data.length > 0) {
            applyCharactersUpdate(data);
          }
        }
        addBubble(`发现 ${result.newCount} 个新干员，已更新！`);
      } else {
        addBubble("暂无新干员");
      }
    } catch (e: any) {
      logWarn("Renderer", "强制角色更新失败", { error: e?.message || String(e) });
      addBubble("检查失败，请检查网络");
    }
  });

  // 监听托盘菜单发来的帧率切换
  window.electronAPI?.onFrameRateChange((rate: number) => {
    curFrameRateSetting.value = rate;
  });

  // 向主进程报告当前帧率（让托盘菜单勾选正确）
  window.electronAPI?.reportFrameRate(curFrameRateSetting.value);

  // 向主进程报告置顶状态
  window.electronAPI?.reportAlwaysOnTop(isAlwaysOnTop.value);

  // 向主进程报告边界显示状态
  window.electronAPI?.reportDebug(debug.value);

  if (canvas.value) {
    spineRef.value = new Spine(canvas.value, gpuVendor);
    loadModel();
  }
});

onUnmounted(() => {
  // 停止恢复轮询
  stopRecoveryPolling();

  // 清理事件监听器
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keydown", onAltKeyDown);
  window.removeEventListener("keyup", onAltKeyUp);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  canvas.value?.removeEventListener("webglcontextlost", onContextLost);
  canvas.value?.removeEventListener("webglcontextrestored", onContextRestored);

  // 清理全局钩子
  delete (window as any).__toggleDebug;

  // 销毁 Spine（释放 GPU 资源）
  spineRef.value?.destroy();
  spineRef.value = null;

  // 恢复默认鼠标事件状态
  window.electronAPI?.setIgnoreMouseEvents(false);
  lastIgnoreState = null;
});
</script>

<template>

<!-- ============================================================
     面板子窗口：动画面板 (#/anim-panel)
     ============================================================ -->
<div v-if="isPanelMode === 'anim'" class="panel-window anim-panel-window">
  <div class="drag-pill"><span>⋮⋮ 拖拽移动 ⋮⋮</span></div>
  <div class="panel-window-toggles">
    <label class="pill-toggle" title="点播">
      <span class="pill-label">播放</span>
      <input type="checkbox" v-model="panelLocalAnimClickPlay" @change="panelToggleClickPlay()" />
      <span class="pill-slider" />
    </label>
    <label class="pill-toggle" title="循环">
      <span class="pill-label">循环</span>
      <input type="checkbox" v-model="panelLocalAnimLoop" @change="panelToggleLoop()" />
      <span class="pill-slider" />
    </label>
  </div>
  <!-- 动画按钮（平铺全部） -->
  <div class="menu-section">
    <button
      v-for="item in panelAnimListFlat"
      :key="item.name"
      class="menu-btn"
      :class="{ inactive: !panelLocalAnimClickPlay, active: item.name === panelCurrentAnim }"
      @click="panelPlayAnim(item.name)"
    >
      {{ item.label }}
    </button>
  </div>
  <div v-if="panelAnimList.length === 0" class="anim-bar-empty">暂无动画数据</div>
</div>

<!-- ============================================================
     面板子窗口：设置面板 (#/menu-panel)
     ============================================================ -->
<div v-else-if="isPanelMode === 'menu'" class="panel-window menu-panel-window">
  <div class="drag-pill"><span>⋮⋮ 拖拽移动 ⋮⋮</span></div>
  <span class="panel-window-title">{{ panelCharState.charName || '设置' }}</span>
  <!-- 角色搜索 -->
  <div class="menu-section">
    <input
      class="char-search"
      v-model="panelSearchQuery"
      type="text"
      placeholder="搜索角色名…"
    />
    <div class="char-list">
      <button
        v-for="group in panelFilteredGroups"
        :key="group.groupId"
        class="menu-btn char-option"
        :class="{ active: panelCharState.groupId === group.groupId }"
        @click="panelSelectGroup(group.groupId); panelSearchQuery = ''"
      >
        {{ group.displayName }}
      </button>
      <div v-if="panelFilteredGroups.length === 0" class="char-no-result">无匹配角色</div>
    </div>
  </div>
  <!-- 异格选择 -->
  <div v-if="panelCharState.alterIds && panelCharState.alterIds.length > 1" class="menu-section">
    <div class="menu-label">异格</div>
    <div class="alter-buttons">
      <button
        v-for="alterId in panelCharState.alterIds"
        :key="alterId"
        class="menu-btn alter-btn"
        :class="{ active: panelCharState.charId === alterId }"
        @click="panelSelectAlter(alterId)"
      >
        {{ panelCharState.alterDisplayNames?.[alterId] || alterId }}
      </button>
    </div>
  </div>
  <div class="menu-divider" />
  <!-- 皮肤选择 -->
  <div class="menu-section" v-if="panelCharState.skinNames?.length">
    <div class="menu-label">皮肤</div>
    <button
      v-for="skin in panelCharState.skinNames"
      :key="skin"
      class="menu-btn"
      :class="{ active: panelCharState.curSkin === skin }"
      @click="panelSelectSkin(skin)"
    >
      {{ skin }}
    </button>
  </div>
  <!-- 陪伴模式：模型统一为基建，不再需要模型选择 -->
</div>

<!-- ============================================================
     面板子窗口：操作面板 (#/action-panel) — 横向排列
     ============================================================ -->
<div v-else-if="isPanelMode === 'action'" class="panel-window action-panel-window">
  <div class="drag-pill"><span>⋮⋮ 拖拽移动 ⋮⋮</span></div>
  <div class="action-row">
    <button class="action-btn" @click="actionInteract" title="互动">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 14a8 8 0 0 1-8 8" />
        <path d="M18 11v-1a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
        <path d="M14 10V9a2 2 0 0 0-2-2 2 2 0 0 0-2 2v1" />
        <path d="M10 9.5V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v10" />
        <path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
      </svg>
      <span class="action-label">互动</span>
    </button>
    <button class="action-btn" @click="actionToggleFlip" title="翻转">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" />
      </svg>
      <span class="action-label">翻转</span>
    </button>
    <button class="action-btn" @click="actionToggleAnim" title="动画面板">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
        <path d="M8 11h8" /><path d="M8 7h6" />
      </svg>
      <span class="action-label">动画</span>
    </button>
    <button class="action-btn" @click="actionToggleMenu" title="设置面板">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4 2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.22-.07.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
      </svg>
      <span class="action-label">设置</span>
    </button>
    <button class="action-btn" @click="actionHelp" title="使用说明">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
      </svg>
      <span class="action-label">帮助</span>
    </button>
  </div>
</div>

<!-- ============================================================
     主窗口：完整桌面宠物
     ============================================================ -->
<div v-else>
  <div
    ref="containerRef"
    class="pet-container"
    :class="{ debug: debug }"
    @pointermove="onInteractPointerMove"
    @mouseleave="onContainerMouseLeave"
  >
    <!-- 加载状态：浮动提示，不遮挡桌面 -->
    <div v-if="isLoading" class="loading-pill">
      {{ loadError ? loadError : `加载 ${curCharName} 中⋯ Alt+拖拽移动窗口` }}
    </div>

    <!-- 错误状态 -->
    <div v-if="loadError && !isLoading" class="loading-pill error">
      {{ loadError }}
    </div>

    <!-- ===== 场景包装器（居中 + 缩放） ===== -->
    <div class="pet-scene" :style="sceneStyle">
    <!-- 气泡堆叠（在 canvas 上方） -->
    <div v-if="bubbleList.length" class="bubble-stack">
      <div
        v-for="item in bubbleList"
        :key="item.id"
        class="bubble"
        :class="{ 'bubble--fading': item.fading }"
      >
        <span class="bubble__text">{{ item.text }}</span>
        <div class="bubble__arrow" />
      </div>
    </div>

    <!-- 画布 (1000x1000 内部分辨率，CSS 固定 400x400) -->
    <canvas
      ref="canvas"
      width="1000"
      height="1000"
      class="pet-canvas"
      :style="canvasFlipStyle"
      v-show="!isLoading && !loadError"
    />

    <!--
      交互层：统一 pointer 事件处理（拖拽 + 点击穿透检测）
    -->
    <div
      class="interact-layer"
      @pointerdown="onInteractPointerDown"
      @pointermove="onInteractPointerMove"
      @pointerup="onInteractPointerUp"
      @pointercancel="onInteractPointerCancel"
      @wheel.prevent="onWheel"
    />

    <!-- 底部按钮栏已全部移至独立操作面板 -->
    </div>
    <!-- ===== /场景包装器 ===== -->

    <!-- 动画列表和设置菜单已移至独立子窗口，此处不再渲染 -->
    <!-- FPS 覆盖层（Ctrl+Shift+F 切换） -->
    <div v-if="showFps" class="fps-overlay">
      <div class="fps-value">{{ fpsAvg }} FPS</div>
    </div>

    <!-- 错误显示 -->
    <div v-if="showErrors && capturedErrors.length" class="error-capture">
      <div class="error-capture__header" @click="showErrors = !showErrors">
        ⚠ 捕获到 {{ capturedErrors.length }} 个错误
        <span class="error-capture__toggle">{{ showErrors ? '▼' : '▶' }}</span>
      </div>
      <div v-if="showErrors" class="error-capture__list">
        <div v-for="(err, i) in capturedErrors" :key="i" class="error-capture__item">{{ err }}</div>
      </div>
    </div>
  </div>

  </div> <!-- v-else -->

</template>

<style scoped>
/* ============================================================
   容器 — JS 拖拽（PointerEvent + setPointerCapture）
   无 OS 级 drag，透明区域可鼠标穿透
   ============================================================ */
.pet-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  background: transparent;
}

/* Debug 模式：红框包场景，蓝框标交互区 */
.pet-container.debug .pet-scene {
  outline: 2px solid rgba(255, 50, 50, 0.9);
  outline-offset: -1px;
}
.pet-container.debug .interact-layer {
  outline: 2px dashed rgba(50, 150, 255, 0.8);
  outline-offset: -1px;
  background: rgba(0, 100, 255, 0.1) !important;
}

/* ============================================================
   场景包装器：居中，整体缩放
   内部元素均基于 400x400 基础坐标系布局
   ============================================================ */
.pet-scene {
  position: fixed;
  top: 50vh;
  left: 50vw;
  width: 400px;
  height: 400px;
  z-index: 1;
  transform-origin: center center;
}

/* ============================================================
   画布
   ============================================================ */
.pet-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 400px;
  height: 400px;
  image-rendering: auto;
  pointer-events: none;
}

/* ============================================================
   交互层：统一 pointer 事件处理（拖拽 + 点击穿透检测）
   ============================================================ */
.interact-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 400px;
  height: 400px;
  z-index: 2;
  cursor: default;
  background: transparent;
  touch-action: none;
}

/* ============================================================
   加载 & 错误（浮动提示，不遮挡桌面）
   ============================================================ */
.loading-pill {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 18px;
  background: rgba(20, 20, 30, 0.82);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  white-space: nowrap;
  z-index: 10;
  pointer-events: none;
  animation: loadPulse 1.8s ease-in-out infinite;
}
.loading-pill.error {
  background: rgba(60, 20, 20, 0.85);
  border-color: rgba(255, 80, 80, 0.25);
  color: #ff8a8a;
  animation: none;
}

@keyframes loadPulse {
  0%, 100% { opacity: 0.9; }
  50% { opacity: 0.5; }
}

/* ============================================================
   气泡堆叠
   ============================================================ */
.bubble-stack {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  z-index: 100;
}

.bubble {
  padding: 6px 14px;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  color: #fff;
  font-size: 13px;
  white-space: nowrap;
  opacity: 1;
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.bubble--fading {
  opacity: 0;
  transform: translateY(-6px);
}

.bubble__arrow {
  position: absolute;
  bottom: -6px;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 6px solid rgba(0, 0, 0, 0.72);
}

/* ============================================================
   操作按钮已移至独立子窗口，此区域 CSS 不再使用
   右键菜单：固定在窗口底部弹出
   ============================================================ */
.menu-backdrop {
  position: absolute;
  inset: 0;
  z-index: 98;
  -webkit-app-region: no-drag;
}

.context-menu {
  position: fixed;
  z-index: 99;
  -webkit-app-region: no-drag;
  width: 190px;
  max-height: 320px;
  padding: 6px;
  padding-top: 28px; /* 给关闭按钮留空间 */
  cursor: grab;
  background: rgba(28, 28, 38, 0.94);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  overflow-y: auto;
}

/* 关闭按钮 */
.menu-close {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  font-size: 16px;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
}
.menu-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

/* ============================================================
   动画列表浮动条（顶部）
   ============================================================ */
.anim-bar {
  position: fixed;
  width: 190px;
  max-height: 280px;
  z-index: 99;
  -webkit-app-region: no-drag;
  padding: 24px 8px 8px;
  cursor: grab;
  background: rgba(28, 28, 38, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  overflow-y: auto;
  scrollbar-width: none;
}
.anim-bar::-webkit-scrollbar {
  display: none;
}

.anim-bar-header {
  display: flex;
  align-items: center;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 4px;
  padding: 0 24px 0 2px;
}

.anim-bar-close {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  font-size: 16px;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
}
.anim-bar-close:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }

.anim-bar-empty {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.25);
  padding: 4px 6px;
}

/* 动画头部：标签 + 胶囊开关横排 */
.anim-bar-toggles {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 胶囊开关 */
.pill-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  padding: 4px 0;
}
.pill-toggle input { display: none; }
.pill-label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pill-slider {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  transition: background 0.2s;
}
.pill-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.pill-toggle input:checked + .pill-slider {
  background: rgba(100, 140, 255, 0.5);
}
.pill-toggle input:checked + .pill-slider::before {
  transform: translateX(16px);
}

/* 点播关闭时按钮置灰 */
.menu-btn.inactive {
  opacity: 0.35;
  cursor: default;
  pointer-events: none;
}

/* 异格按钮组（横排滚动） */
.alter-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  width: 100%;
}
.alter-btn {
  flex: 0 0 auto;
  min-width: 36px;
  max-width: 100%;
  font-size: 9px;
  padding: 3px 5px;
}

/* 循环模式：按钮变蓝 */
.menu-btn.looping {
  background: rgba(100, 140, 255, 0.15);
  border-color: rgba(100, 140, 255, 0.25);
  color: rgba(180, 210, 255, 0.9);
}
.menu-btn.looping:hover {
  background: rgba(100, 140, 255, 0.25);
  border-color: rgba(100, 140, 255, 0.4);
}

/* 分组标签 */
.anim-tabs {
  display: flex;
  gap: 3px;
  margin-bottom: 5px;
  flex-wrap: wrap;
}

.anim-tab {
  padding: 2px 7px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 3px;
}
.anim-tab:hover {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
}
.anim-tab.active {
  background: rgba(100, 140, 255, 0.2);
  border-color: rgba(100, 140, 255, 0.3);
  color: #fff;
}

.menu-section {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  cursor: default;
}

.menu-label {
  width: 100%;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.35);
  padding: 2px 6px;
  text-transform: uppercase;
  letter-spacing: 1px;
}


.menu-btn {
  flex: 0 0 auto;
  min-width: 44px;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.menu-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.menu-btn.active {
  background: rgba(100, 140, 255, 0.3);
  border-color: rgba(100, 140, 255, 0.45);
  color: #fff;
}

.menu-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 4px 0;
}

/** 角色搜索框 */
.char-search {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.char-search:focus {
  border-color: rgba(100, 140, 255, 0.4);
}
.char-search::placeholder {
  color: rgba(255, 255, 255, 0.25);
}

/** 角色搜索结果列表 */
.char-list {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  max-height: 200px;
  overflow-y: auto;
  margin-top: 4px;
  scrollbar-width: none;
}
.char-list::-webkit-scrollbar {
  display: none;
}
.char-option {
  font-size: 10px;
  padding: 3px 8px;
}
.char-no-result {
  width: 100%;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.25);
  text-align: center;
  padding: 8px 0;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.menu-item.quit:hover {
  background: rgba(255, 70, 70, 0.2);
  color: #ff6b6b;
}

.menu-check {
  margin-left: auto;
  font-size: 11px;
  color: rgba(100, 180, 100, 0.8);
}

/* 滚动条 */
.context-menu::-webkit-scrollbar {
  width: 4px;
}
.context-menu::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

/* ============================================================
   FPS 覆盖
   ============================================================ */
.fps-overlay {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  pointer-events: none;
}
.fps-value {
  padding: 2px 8px;
  background: rgba(0, 0, 0, 0.6);
  color: #0f0;
  font-family: monospace;
  font-size: 12px;
  border-radius: 4px;
}
.fps-hint {
  padding: 2px 8px;
  background: rgba(0, 0, 0, 0.4);
  color: rgba(255, 255, 255, 0.5);
  font-size: 9px;
  border-radius: 4px;
}

/* ============================================================
   错误捕获显示
   ============================================================ */
.error-capture {
  position: absolute;
  bottom: 52px;
  left: 8px;
  z-index: 200;
  max-width: 300px;
  pointer-events: auto;
}
.error-capture__header {
  padding: 3px 8px;
  background: rgba(200, 40, 40, 0.85);
  color: #fff;
  font-size: 10px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.error-capture__toggle {
  margin-left: 4px;
}
.error-capture__list {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.error-capture__item {
  padding: 4px 8px;
  background: rgba(40, 10, 10, 0.9);
  color: #ff8a8a;
  font-size: 10px;
  font-family: monospace;
  border-radius: 4px;
  word-break: break-all;
  line-height: 1.4;
  white-space: pre-wrap;  /* 正确渲染错误信息中的换行符 */
}

/* ============================================================
   面板子窗口样式（独立 BrowserWindow，200×300 左右）
   ============================================================ */
.panel-window {
  width: 100vw;
  height: 100vh;
  background: rgba(28, 28, 38, 0.94);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  overflow-y: auto;
  scrollbar-width: none;
  box-sizing: border-box;
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  padding: 4px 6px 6px;
  position: relative;
}

.drag-pill {
  width: 100%;
  padding: 14px 0;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.drag-pill span {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  width: 100%;
  margin: 0 6px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: rgba(255, 255, 255, 0.3);
  font-size: 9px;
  letter-spacing: 2px;
  pointer-events: none;
}
.drag-pill:active span {
  background: rgba(255, 255, 255, 0.14);
}
.panel-window-title {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.4);
  text-transform: uppercase;
  letter-spacing: 1px;
}
.panel-window-toggles {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

/* 面板窗口内隐藏主窗口专属内容 */
.panel-window .pet-container,
.panel-window .pet-scene,
.panel-window .loading-pill,
.panel-window .bubble-stack,
.panel-window .bottom-bar,
.panel-window .interact-layer,
.panel-window .fps-overlay,
.panel-window .drag-off-hint,
.panel-window .error-capture {
  display: none !important;
}

/* ============================================================
   操作面板样式（#/action-panel）— 横向方按钮
   ============================================================ */
.action-panel-window {
  padding: 2px 6px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.action-panel-window .drag-pill {
  padding: 6px 0;
  margin-bottom: 2px;
}
.action-panel-window .drag-pill span {
  height: 14px;
  font-size: 7px;
}

.action-row {
  display: flex;
  flex-direction: row;
  gap: 6px;
  padding: 0 2px;
}
.action-btn {
  width: 42px;
  height: 42px;
  padding: 6px 2px 4px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-size: 10px;
  -webkit-app-region: no-drag;
  cursor: default;
}

.action-label {
  line-height: 1;
  font-size: 10px;
}

</style>
