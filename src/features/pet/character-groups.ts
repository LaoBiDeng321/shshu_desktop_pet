/**
 * 角色异格分组定义
 * 将同一角色的不同版本（异格）归为一组
 */

export interface AlterGroup {
  /** 组标识（英文，用于内部引用） */
  groupId: string;
  /** 用于显示的组名（最简洁/最众所周知的名字） */
  displayName: string;
  /** 该组包含的角色 ID，第一个为默认 */
  memberIds: string[];
}

/**
 * 异格分组表
 * 注意：卫戍协议重复角色（Sharp/Pith/Touch/Stormeye 等）已在同名分组中以"同名"方式合并
 */
export const ALTER_GROUPS: AlterGroup[] = [
  {
    groupId: "amiya",
    displayName: "阿米娅",
    memberIds: ["char_002_amiya", "char_1001_amiya2", "char_1037_amiya3"],
  },
  {
    groupId: "texas",
    displayName: "德克萨斯",
    memberIds: ["char_102_texas", "char_1028_texas2"],
  },
  {
    groupId: "chen",
    displayName: "陈",
    memberIds: ["char_010_chen", "char_1013_chen2", "char_1050_chen3"],
  },
  {
    groupId: "skadi",
    displayName: "斯卡蒂",
    memberIds: ["char_263_skadi", "char_1012_skadi2"],
  },
  {
    groupId: "specter",
    displayName: "幽灵鲨",
    memberIds: ["char_143_ghost", "char_1023_ghost2"],
  },
  {
    groupId: "gavial",
    displayName: "嘉维尔",
    memberIds: ["char_187_ccheal", "char_1026_gvial2"],
  },
  {
    groupId: "reed",
    displayName: "苇草",
    memberIds: ["char_261_sddrag", "char_1020_reed2"],
  },
  {
    groupId: "exusiai",
    displayName: "能天使",
    memberIds: ["char_103_angel", "char_1041_angel2"],
  },
  {
    groupId: "silverash",
    displayName: "银灰",
    memberIds: ["char_172_svrash", "char_1045_svash2"],
  },
  {
    groupId: "hoshiguma",
    displayName: "星熊",
    memberIds: ["char_136_hsguma", "char_1044_hsgma2"],
  },
  {
    groupId: "pramanix",
    displayName: "初雪",
    memberIds: ["char_174_slbell", "char_1046_sbell2"],
  },
  {
    groupId: "jessica",
    displayName: "杰西卡",
    memberIds: ["char_235_jesica", "char_1034_jesca2"],
  },
  {
    groupId: "hibiscus",
    displayName: "芙蓉",
    memberIds: ["char_120_hibisc", "char_1024_hbisc2"],
  },
  {
    groupId: "greyy",
    displayName: "格雷伊",
    memberIds: ["char_253_greyy", "char_1027_greyy2"],
  },
  {
    groupId: "kroos",
    displayName: "克洛丝",
    memberIds: ["char_124_kroos", "char_1021_kroos2"],
  },
  {
    groupId: "fang",
    displayName: "芬",
    memberIds: ["char_123_fang", "char_1036_fang2"],
  },
  {
    groupId: "zima",
    displayName: "凛冬",
    memberIds: ["char_115_headbr", "char_1051_headb2"],
  },
  {
    groupId: "lava",
    displayName: "炎熔",
    memberIds: ["char_121_lava", "char_1011_lava2"],
  },
  {
    groupId: "yato",
    displayName: "夜刀",
    memberIds: ["char_502_nblade", "char_1029_yato2"],
  },
  {
    groupId: "noircorne",
    displayName: "黑角",
    memberIds: ["char_500_noirc", "char_1030_noirc2"],
  },
  {
    groupId: "lapland",
    displayName: "拉普兰德",
    memberIds: ["char_140_whitew", "char_1038_whitw2"],
  },
  {
    groupId: "perfumer",
    displayName: "调香师",
    memberIds: ["char_181_flower", "char_1022_flwr2"],
  },
  {
    groupId: "catapult",
    displayName: "空爆",
    memberIds: ["char_282_catap", "char_1049_catap2"],
  },
  {
    groupId: "orchid",
    displayName: "梓兰",
    memberIds: ["char_278_orchid", "char_1048_orchd2"],
  },
  {
    groupId: "nearl",
    displayName: "临光",
    memberIds: ["char_148_nearl", "char_1014_nearl2"],
  },
  {
    groupId: "executor",
    displayName: "送葬人",
    memberIds: ["char_279_excu", "char_1032_excu2"],
  },
  {
    groupId: "thorns",
    displayName: "棘刺",
    memberIds: ["char_293_thorns", "char_1039_thorn2"],
  },
  {
    groupId: "blaze",
    displayName: "煌",
    memberIds: ["char_017_huang", "char_1040_blaze2"],
  },
  {
    groupId: "leizi",
    displayName: "惊蛰",
    memberIds: ["char_306_leizi", "char_1043_leizi2"],
  },
  {
    groupId: "halo",
    displayName: "星源",
    memberIds: ["char_135_halo", "char_1047_halo2"],
  },
  {
    groupId: "kaltsit",
    displayName: "凯尔希",
    memberIds: ["char_003_kalts", "char_1052_kalts2"],
  },
  {
    groupId: "silence",
    displayName: "赫默",
    memberIds: ["char_108_silent", "char_1031_slent2"],
  },
  {
    groupId: "swire",
    displayName: "诗怀雅",
    memberIds: ["char_308_swire", "char_1033_swire2"],
  },
  {
    groupId: "aprot",
    displayName: "暮落",
    memberIds: ["char_4025_aprot2", "char_512_aprot"],
  },
  {
    groupId: "w",
    displayName: "W",
    memberIds: ["char_113_cqbw", "char_1035_wisdel"],
  },
];

/** 角色 ID → 所属组的查找表 */
const MEMBER_TO_GROUP: Record<string, AlterGroup> = {};
for (const group of ALTER_GROUPS) {
  for (const id of group.memberIds) {
    MEMBER_TO_GROUP[id] = group;
  }
}

/**
 * 根据角色 ID 获取其所属的异格组
 */
export function getAlterGroup(charId: string): AlterGroup | undefined {
  return MEMBER_TO_GROUP[charId];
}

/**
 * 判断两个角色是否属于同一个异格组
 */
export function isSameCharacter(idA: string, idB: string): boolean {
  if (idA === idB) return true;
  const gA = getAlterGroup(idA);
  const gB = getAlterGroup(idB);
  return !!gA && !!gB && gA.groupId === gB.groupId;
}

/**
 * 获取组内其他异格角色 ID（排除当前角色）
 */
export function getSiblingAlters(charId: string): string[] {
  const group = getAlterGroup(charId);
  if (!group) return [];
  return group.memberIds.filter((id) => id !== charId);
}
