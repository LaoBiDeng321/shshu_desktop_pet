/**
 * 角色发现脚本
 * 从 PRTS wiki 获取所有干员 ID，从 CDN 获取 Spine 元数据，
 * 生成 characters.json 供桌面宠物使用。
 *
 * 用法: node scripts/discover-characters.mjs
 * 输出: src/features/pet/characters.json
 */

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(
  __dirname,
  "../src/features/pet/characters.json",
);

function api(params) {
  return new Promise((resolve, reject) => {
    const url = "https://prts.wiki/api.php?" + new URLSearchParams(params).toString();
    https.get(url, { timeout: 15000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function fetchMeta(charId) {
  return new Promise((resolve) => {
    const url = `https://torappu.prts.wiki/assets/char_spine/${charId}/meta.json`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 200) { try { resolve(JSON.parse(data)); } catch { resolve(null); } }
        else resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function main() {
  console.log("Step 1: 获取所有干员...");
  const params = {
    action: "query", list: "categorymembers",
    cmtitle: "Category:干员", format: "json", cmlimit: "max", cmtype: "page",
  };
  const allMembers = [];
  while (true) {
    const data = await api(params);
    allMembers.push(...(data.query?.categorymembers || []));
    if (data.continue?.cmcontinue) params.cmcontinue = data.continue.cmcontinue;
    else break;
  }
  console.log(`  → 共 ${allMembers.length} 个干员`);

  const charIdMap = {};
  for (let i = 0; i < allMembers.length; i += 50) {
    const batch = allMembers.slice(i, i + 50);
    const titles = batch.map((m) => m.title).join("|");
    const data = await api({
      action: "query", prop: "revisions", titles, format: "json", rvprop: "content",
    });
    for (const page of Object.values(data.query?.pages || {})) {
      const content = page.revisions?.[0]?.["*"] || "";
      const match = content.match(/\|干员id\s*=\s*(char_[0-9]+_[a-zA-Z0-9_]+)/);
      if (match) charIdMap[match[1]] = page.title;
    }
    process.stdout.write(`  → 已提取 ${Object.keys(charIdMap).length} 个 ID\r`);
  }
  console.log(`\n  → 共提取 ${Object.keys(charIdMap).length} 个干员ID`);

  const charIds = Object.keys(charIdMap);
  const results = [];
  for (let i = 0; i < charIds.length; i++) {
    const meta = await fetchMeta(charIds[i]);
    if (meta) results.push({ id: charIds[i], name: charIdMap[charIds[i]], meta });
    if ((i + 1) % 50 === 0) console.log(`  → 已检查 ${i + 1}/${charIds.length}...`);
  }
  console.log(`  → 找到 ${results.length} 个有 Spine 数据的角色`);

  // 归一化：PRTS wiki 部分角色使用"战斗"代替"正面"，统一处理
  for (const r of results) {
    for (const skin of Object.values(r.meta.skin)) {
      if (skin["战斗"]) {
        skin["正面"] = skin["战斗"];
        delete skin["战斗"];
      }
    }
  }

  const output = JSON.stringify(results, null, 2);
  fs.writeFileSync(OUT_PATH, output, "utf-8");
  console.log(`  → 已保存到 ${OUT_PATH} (${(output.length / 1024).toFixed(1)} KB)`);
}

main().catch(console.error);
