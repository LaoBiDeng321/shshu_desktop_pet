import charactersData from "./characters.json";
import { ALTER_GROUPS, getAlterGroup } from "./character-groups";

// ============================================================
// 类型定义
// ============================================================

export interface SkinEntry {
  file: string;
  skin?: string;
}

export interface ModelGroup {
  [modelName: string]: SkinEntry;
}

export interface SkinGroup {
  [skinName: string]: ModelGroup;
}

export interface CharacterMeta {
  prefix: string;
  name: string;
  skin: SkinGroup;
}

export interface CharacterEntry {
  id: string;
  name: string;
  meta: CharacterMeta;
}

// ============================================================
// 角色列表
// ============================================================

export const CHARACTERS: CharacterEntry[] = charactersData as CharacterEntry[];

/** 默认角色 ID（黍） */
export const DEFAULT_CHAR_ID = "char_2025_shu";

/** 默认皮肤名 */
export const DEFAULT_SKIN_NAME = "默认";

/** 默认模型组（陪伴模式，统一使用基建） */
export const DEFAULT_MODEL_GROUP = "基建";

/**
 * 根据角色 ID 获取角色配置
 */
export function getCharacter(id: string): CharacterEntry | undefined {
  return CHARACTERS.find((c) => c.id === id);
}

export interface GroupItem {
  groupId: string;
  displayName: string;
  memberIds: string[];
  defaultId: string;
}

/**
 * 英文名 → 中文社区名映射（部分干员在 meta.json 中为英文名）
 */
const NAME_TRANSLATIONS: Record<string, string> = {
  Sharp: "锋刃",
  Pith: "术髓",
  Touch: "触痕",
  Stormeye: "风暴眼",
  "U-Official": "尤里卡",
  Raidian: "电弧",
  Mechanist: "机械师",
  "Miss.Christine": "克里斯汀小姐",
};

function getName(charId: string): string {
  const c = getCharacter(charId);
  if (!c) return charId;
  return NAME_TRANSLATIONS[c.meta.name] || c.meta.name;
}

/**
 * 构建分组角色列表
 * 先处理异格组，再处理单角色组
 * 排序：单字 > 双字 > 三字 > 更多，同字数内按拼音
 */
function buildGroupList(): GroupItem[] {
  const groups: GroupItem[] = [];

  // 1. 异格组
  const groupedIds = new Set<string>();
  for (const ag of ALTER_GROUPS) {
    for (const id of ag.memberIds) groupedIds.add(id);
    groups.push({
      groupId: ag.groupId,
      displayName: ag.displayName,
      memberIds: ag.memberIds,
      defaultId: ag.memberIds[0],
    });
  }

  // 2. 未被分组的角色（自身成组）
  const seenIds = new Set<string>();
  for (const c of CHARACTERS) {
    if (groupedIds.has(c.id) || seenIds.has(c.id)) continue;
    // 检查是否有同名角色（如预备干员、暮落等 wiki 同名不同 ID 的）
    const sameNameChars = CHARACTERS.filter(
      (x) => x.meta.name === c.meta.name && !groupedIds.has(x.id),
    );
    const memberIds = sameNameChars.map((x) => x.id);
    for (const id of memberIds) seenIds.add(id);

    groups.push({
      groupId: c.id,
      displayName: NAME_TRANSLATIONS[c.meta.name] || c.meta.name,
      memberIds,
      defaultId: memberIds[0],
    });
  }

  // 3. 排序：按 displayName 字数 → 拼音
  return groups.sort((a, b) => {
    const lenA = [...a.displayName].length;
    const lenB = [...b.displayName].length;
    if (lenA !== lenB) return lenA - lenB;
    return a.displayName.localeCompare(b.displayName, "zh-CN");
  });
}

/**
 * 分组角色列表（一个异格组只显示一条）
 */
export const GROUP_LIST = buildGroupList();

/**
 * 角色 ID → 所属组的 GroupId
 */
const CHAR_TO_GROUP: Record<string, string> = {};
for (const g of GROUP_LIST) {
  for (const id of g.memberIds) {
    CHAR_TO_GROUP[id] = g.groupId;
  }
}

export function getGroupId(charId: string): string | undefined {
  return CHAR_TO_GROUP[charId];
}

/**
 * 获取组的信息
 */
export function getGroup(groupId: string): GroupItem | undefined {
  return GROUP_LIST.find((g) => g.groupId === groupId);
}

/**
 * 获取角色的所有异格版本（包括自身）
 */
export function getCharacterAlters(charId: string): string[] {
  const group = getGroup(getGroupId(charId) || "");
  return group ? group.memberIds : [charId];
}

// ============================================================
// 旧接口兼容
// ============================================================

export const SHU_MODEL_CONFIG = (() => {
  const shu = getCharacter("char_2025_shu");
  if (!shu) throw new Error("黍的配置未找到");
  return shu.meta as typeof shu.meta & {
    prefix: "https://torappu.prts.wiki/assets/char_spine/char_2025_shu/";
    skin: {
      默认: { 正面: { file: string }; 背面: { file: string }; 基建: { file: string } };
      春日宴: { 正面: { file: string }; 背面: { file: string }; 基建: { file: string } };
    };
  };
})();

export type SkinName = keyof typeof SHU_MODEL_CONFIG.skin;
export type ModelGroupName = keyof (typeof SHU_MODEL_CONFIG.skin)[SkinName];

// ============================================================
// 角色数据动态更新（由 auto-update 在启动时触发）
// ============================================================

/**
 * 用 userData 中的更新版本替换当前角色数据
 * 保持数组/对象引用不变，让所有已有的 computed/watch 继续生效
 */
export function applyCharactersUpdate(newData: CharacterEntry[]): void {
  // 替换 CHARACTERS（保持引用，仅修改内容）
  CHARACTERS.length = 0;
  CHARACTERS.push(...newData);

  // 重建 GROUP_LIST（原地替换，computed 仍有效）
  const newGroups = buildGroupList();
  GROUP_LIST.length = 0;
  GROUP_LIST.push(...newGroups);

  // 重建 CHAR_TO_GROUP 查找表
  for (const key of Object.keys(CHAR_TO_GROUP)) {
    delete CHAR_TO_GROUP[key];
  }
  for (const g of newGroups) {
    for (const id of g.memberIds) {
      CHAR_TO_GROUP[id] = g.groupId;
    }
  }
}
