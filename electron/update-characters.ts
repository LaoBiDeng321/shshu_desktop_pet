/**
 * 角色数据自动更新模块
 * 7 天限流检查 PRTS wiki，发现新干员时自动下载 meta.json
 * 合并后保存到 userData，供渲染进程优先加载
 */

interface WikiPage {
  title: string;
  pageid: number;
}

interface WikiMember {
  pageid: number;
  ns: number;
  title: string;
}

interface CharacterMeta {
  prefix: string;
  name: string;
  skin: Record<string, unknown>;
}

export interface CharacterEntry {
  id: string;
  name: string;
  meta: CharacterMeta;
}

const PRTS_API = "https://prts.wiki/api.php";
const PRTS_CDN = "https://torappu.prts.wiki/assets/char_spine";

// ============================================================
// MediaWiki API 封装
// ============================================================

async function wikiApi(params: Record<string, string>): Promise<any> {
  const url = PRTS_API + "?" + new URLSearchParams(params).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Wiki API HTTP ${res.status}`);
  return res.json();
}

/** 获取所有干员页面 */
async function fetchAllOperatorPages(): Promise<WikiMember[]> {
  const members: WikiMember[] = [];
  let cmcontinue: string | undefined;
  while (true) {
    const params: Record<string, string> = {
      action: "query",
      list: "categorymembers",
      cmtitle: "Category:干员",
      format: "json",
      cmlimit: "max",
      cmtype: "page",
    };
    if (cmcontinue) params.cmcontinue = cmcontinue;
    const data = await wikiApi(params);
    members.push(...(data.query?.categorymembers || []));
    cmcontinue = data.continue?.cmcontinue;
    if (!cmcontinue) break;
  }
  return members;
}

/** 从页面内容中提取所有干员 ID */
async function extractCharIds(members: WikiMember[]): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();

  for (let i = 0; i < members.length; i += 50) {
    const batch = members.slice(i, i + 50);
    const titles = batch.map((m) => m.title).join("|");
    const data = await wikiApi({
      action: "query",
      prop: "revisions",
      titles,
      format: "json",
      rvprop: "content",
    });

    for (const page of Object.values(data.query?.pages || {}) as WikiPage[]) {
      const content = (page as any).revisions?.[0]?.["*"] || "";
      const match = content.match(/\|干员id\s*=\s*(char_[0-9]+_[a-zA-Z0-9_]+)/);
      if (match) idMap.set(match[1], page.title);
    }
  }

  return idMap;
}

/** 从 CDN 获取角色的 Spine 元数据 */
async function fetchMeta(charId: string): Promise<CharacterMeta | null> {
  try {
    const url = `${PRTS_CDN}/${charId}/meta.json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return res.json();
  } catch {
    // 静默忽略 — 部分干员可能没有 Spine 数据
  }
  return null;
}

// ============================================================
// 公开接口
// ============================================================

export interface UpdateResult {
  checked: boolean;   // 本次是否真的检查了
  updated: boolean;   // 是否有更新下载
  newCount: number;   // 新增角色数
}

/**
 * 检查 PRTS wiki 是否有新干员
 * @param currentIds 当前 characters.json 中的所有角色 ID 列表
 * @returns 更新结果
 */
export async function checkForNewCharacters(currentIds: string[]): Promise<{
  result: UpdateResult;
  data?: CharacterEntry[];
}> {
  console.log("[Characters] 正在检查 PRTS wiki 新干员...");

  // 1. 获取所有干员页面
  const members = await fetchAllOperatorPages();
  console.log(`[Characters] 干员页面总数: ${members.length}`);

  // 2. 提取干员 ID
  const charIdMap = await extractCharIds(members);
  const allIds = [...charIdMap.keys()];
  console.log(`[Characters] 提取干员 ID: ${allIds.length}`);

  // 3. 对比本地 ID，找出新增的
  const newIds = allIds.filter((id) => !currentIds.includes(id));
  if (newIds.length === 0) {
    console.log("[Characters] 无新干员");
    return { result: { checked: true, updated: false, newCount: 0 } };
  }
  console.log(`[Characters] 发现 ${newIds.length} 个新干员: ${newIds.join(", ")}`);

  // 4. 逐个获取新干员的 meta.json
  const newEntries: CharacterEntry[] = [];
  for (let i = 0; i < newIds.length; i++) {
    const id = newIds[i];
    const meta = await fetchMeta(id);
    if (meta) {
      newEntries.push({ id, name: charIdMap.get(id) || id, meta });
    }
    if ((i + 1) % 30 === 0) {
      console.log(`[Characters] 已检查 ${i + 1}/${newIds.length}...`);
    }
  }
  console.log(`[Characters] 新增 ${newEntries.length} 个有 Spine 数据的角色`);

  if (newEntries.length === 0) {
    return { result: { checked: true, updated: false, newCount: 0 } };
  }

  return {
    result: { checked: true, updated: true, newCount: newEntries.length },
    data: newEntries,
  };
}
