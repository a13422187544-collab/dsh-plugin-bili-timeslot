// 只读：按 SKU 关键词从代理商账户列表里找账户（自动翻完所有页），打印命中结果
// 用法：node find-accounts.mjs --sku=AI绘画
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep, parseArgs } from "./lib-cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, "..", "sku-accounts.json"), "utf8"));
const args = parseArgs();
const sku = args.sku ? String(args.sku) : null;
if (!sku) { console.error("用法: node find-accounts.mjs --sku=AI绘画"); process.exit(1); }
const entry = cfg[sku];
if (!entry) {
  console.error(`未知 SKU: ${sku}\n可选: ${Object.keys(cfg).filter((k) => !k.startsWith("_")).join(" / ")}`);
  process.exit(1);
}

const { ev, navTo, waitFor, close } = await connect("cm.bilibili.com");
await navTo("https://cm.bilibili.com/agent/#/customer.account/account");
await waitFor("(() => document.body.innerText.includes('账户列表'))()", 30000);
await sleep(1500);

const readRows =
  "(() => { const out = [];" +
  " for (const tr of document.querySelectorAll('tbody tr')) {" +
  "  const tds = [...tr.querySelectorAll('td')].map(td => (td.innerText||'').trim().replace(/\\s+/g,' '));" +
  "  if (tds.length < 12) continue;" +
  "  out.push({ id: tds[1], name: tds[2], cash: tds[4], spend: tds[8] }); } return out; })()";

const pageNums =
  "(() => { const p = document.querySelector('.bd-pagination, .el-pagination, .ivu-page'); if (!p) return [1];" +
  " const nums = [...p.querySelectorAll('.bd-pager li, .bd-pager button, .el-pager li, .ivu-page-item, li')]" +
  "  .map(e => Number((e.innerText||'').trim())).filter(n => Number.isInteger(n) && n > 0);" +
  " return nums.length ? [...new Set(nums)].sort((a,b)=>a-b) : [1]; })()";

const gotoPage = (n) =>
  ev(
    "(() => { const p = document.querySelector('.bd-pagination, .el-pagination, .ivu-page'); if (!p) return false;" +
    " const el = [...p.querySelectorAll('.bd-pager li, .bd-pager button, .el-pager li, .ivu-page-item, li, button')]" +
    "  .find(e => (e.innerText||'').trim() === '" + n + "');" +
    " if (!el) return false; el.click(); return true; })()"
  );

const seen = new Map();
const pages = await ev(pageNums);
for (const p of pages) {
  if (p !== pages[0]) { const ok = await gotoPage(p); if (!ok) continue; await sleep(1500); }
  const rows = await ev(readRows);
  for (const r of rows) if (r.id) seen.set(r.id, r);
}

const rows = [...seen.values()];
const kws = entry.keywords || [];
const hit = rows.filter((r) => kws.some((k) => (r.name || "").includes(k)));
console.log(JSON.stringify({
  sku,
  client: entry.client,
  version: entry.version,
  keywords: kws,
  pagesScanned: pages.length,
  accountsScanned: rows.length,
  matched: hit,
  note: hit.length
    ? "同一 SKU 可能还分布在其它代理主体（其它登录账号），需逐个主体核对"
    : "当前登录主体下没有命中 —— 该 SKU 很可能在另一个投放后台账号里，需先切换登录",
}, null, 2));
close();
