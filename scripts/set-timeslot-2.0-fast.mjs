// 2.0 拉时段 · 接口版（快，推荐）
// 原理：同源 + sessionStorage['_session_<account_id>'] 里的 X-EffectAd-Token，直接调
//   GET  /athena/api/v1/promotions/<pid>        → data（含 promotion_time.launch_time）
//   POST /athena/api/v1/promotions               body = data 的 12 个字段（改 promotion_time 后回写）
// 用法：
//   node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883
//   node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883 --days=1,2,3,4,5 --hours=6-18
//   node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883 --days=1,2,3,4,5 --hours=9,10,14,15
//   node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883 --dry
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep, parseArgs, ACCOUNTS } from "./lib-cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKU_CFG_PATH = path.join(here, "..", "sku-accounts.json");
const loadCfg = () => {
  try { return JSON.parse(fs.readFileSync(SKU_CFG_PATH, "utf8")); } catch { return {}; }
};

const args = parseArgs();
const cfg = loadCfg();
const sku = args.sku ? String(args.sku) : null;
const skuEntry = sku ? cfg[sku] : null;
if (sku && !skuEntry) {
  const names = Object.keys(cfg).filter((k) => !k.startsWith("_"));
  console.error(`未知 SKU: ${sku}\n可选: ${names.join(" / ")}`);
  process.exit(1);
}

let accounts = ACCOUNTS(args.accounts);
let subject = args.subject || (skuEntry && skuEntry.subject) || "833883";
const daysSpec = args.days || (skuEntry && skuEntry.days) || "1,2,3,4,5";
const hoursSpec = args.hours || (skuEntry && skuEntry.hours);
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency || 4)));
const dry = !!args.dry;

// 小时解析（左闭右开）：
//   --hours=6-18  → 勾 6..17（06:00 投到 18:00 整，12 格）
//   --hours=0-24  → 勾 0..23（全天，默认）
//   --hours=9,10,14,15 → 直接指定小时（每晚 1 小时格）
function parseHours(spec) {
  const s = String(spec === undefined ? "0-24" : spec).trim();
  let hs = [];
  if (/^\d+\s*-\s*\d+$/.test(s)) {
    const [a, b] = s.split("-").map((x) => Number(x.trim()));
    if (!(a < b)) throw new Error(`--hours 区间非法：${s}（左闭右开，必须 起点 < 终点，例如 6-18）`);
    if (a < 0 || b > 24) throw new Error(`--hours 超出范围：${s}（区间端点须在 0~24 之间，全天用 0-24）`);
    for (let h = a; h < b; h++) hs.push(h);
  } else if (/^[\d,\s]+$/.test(s)) {
    hs = s.split(",").map((x) => Number(x.trim()));
  } else {
    throw new Error(`--hours 格式不对：${s}（示例：6-18 表示 6:00-18:00，或 9,10,14,15）`);
  }
  hs = [...new Set(hs)].sort((a, b) => a - b);
  if (!hs.length || hs.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
    throw new Error(`--hours 小时必须在 0~23：${s}`);
  }
  return hs;
}

const days = String(daysSpec).split(",").map((x) => Number(x.trim())).filter((x) => x >= 1 && x <= 7);
const hours = parseHours(hoursSpec);

if (!days.length) { console.error("--days 至少一天（2.0 不允许为空）"); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const { ev, navTo, waitFor, close } = await connect("ad.bilibili.com");
const t0 = Date.now();

// 未显式给账户时：按 SKU 关键词从代理商账户列表里解析
if (!accounts.length && skuEntry) {
  const kws = skuEntry.keywords || [];
  if (!kws.length) { console.error(`SKU ${sku} 既没配 accounts 也没配 keywords，无法定位账户`); process.exit(1); }
  await navTo("https://cm.bilibili.com/agent/#/customer.account/account");
  await waitFor("(() => document.body.innerText.includes('账户列表'))()", 30000);
  const rows = await ev(
    "(() => { const out = [];" +
    " for (const tr of document.querySelectorAll('tbody tr')) {" +
    "  const tds = [...tr.querySelectorAll('td')].map(td => (td.innerText||'').trim().replace(/\\s+/g,' '));" +
    "  if (tds.length < 12) continue; out.push({ id: tds[1], name: tds[2] }); } return out; })()"
  );
  const hit = rows.filter((r) => kws.some((k) => (r.name || "").includes(k)));
  if (!hit.length) {
    console.error(`[SKU ${sku}] 当前登录主体下没命中账户（关键词：${kws.join(" / ")}）。` +
      `该 SKU 可能在另一个投放后台账号下，需要先人工切换登录。`);
    process.exit(2);
  }
  accounts = hit.map((h) => h.id);
  console.error(`[SKU ${sku}] 命中 ${hit.length} 个账户：` + hit.map((h) => `${h.id}(${h.name})`).join(" | "));
}
if (!accounts.length) { console.error("缺少 --accounts=账户ID,... 或 --sku=SKU名"); process.exit(1); }
const report = [];

const SCHEDULE = Array.from({ length: 7 }, (_, i) => (days.includes(i + 1) ? hours.slice() : []));

for (const aid of accounts) {
  const listUrl = `https://ad.bilibili.com/#/promote/promotion?account_id=${aid}&subject_id=${subject}&subject_type=3&from=${today}&to=${today}`;
  await navTo(listUrl);
  await waitFor("(() => document.body.innerText.includes('项目信息'))()", 25000);

  const pids = await ev(
    "(() => { const out = []; const seen = new Set();" +
    " for (const tr of document.querySelectorAll('tbody tr')) {" +
    "  const t = (tr.innerText||'').replace(/\\s+/g,' ').trim();" +
    "  const m = t.match(/ID (\\d{6,})/); if (!m || seen.has(m[1])) continue; seen.add(m[1]); out.push(m[1]); } return out; })()"
  );
  if (!pids.length) { report.push({ aid, error: "未读到项目" }); continue; }

  const hasToken = await ev("(() => !!sessionStorage.getItem('_session_" + aid + "'))()");
  if (!hasToken) { report.push({ aid, error: "无 session token" }); continue; }

  const expr =
    "(async () => {" +
    " const pids = " + JSON.stringify(pids) + ";" +
    " const aid = " + JSON.stringify(aid) + ";" +
    " const sched = " + JSON.stringify(SCHEDULE) + ";" +
    " const dry = " + JSON.stringify(dry) + ";" +
    " const C = " + concurrency + ";" +
    " const token = sessionStorage.getItem('_session_' + aid);" +
    " const hdr = { 'X-EffectAd-Token': token, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' };" +
    " const API = 'https://ad.bilibili.com/athena/api/v1/promotions';" +
    " const work = async (pid) => {" +
    "  try {" +
    "   const g = await fetch(API + '/' + pid, { credentials: 'include', headers: hdr });" +
    "   const gj = await g.json();" +
    "   const d = gj && gj.data; if (!d) return { pid, ok: false, msg: 'detail 无 data', code: gj && gj.code };" +
    "   const before = (d.promotion_time && d.promotion_time.launch_time || []).map(x => Array.isArray(x) ? x.length : -1);" +
    "   if (dry) return { pid, ok: true, dry: true, before };" +
    "   const payload = {" +
    "    promotion_id: d.promotion_id, promotion_name: d.promotion_name, promotion_type: d.promotion_type," +
    "    promotion_content: d.promotion_content, promotion_monitor: d.promotion_monitor, promotion_bid: d.promotion_bid," +
    "    promotion_search: d.promotion_search, promotion_budget: d.promotion_budget, promotion_time: d.promotion_time," +
    "    promotion_target: d.promotion_target, promotion_scene: d.promotion_scene, promotion_aigc: d.promotion_aigc" +
    "   };" +
    "   payload.promotion_time = Object.assign({}, d.promotion_time, { launch_time: sched });" +
    "   const p = await fetch(API, { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify(payload) });" +
    "   const pj = await p.json();" +
    "   return { pid, ok: pj && String(pj.code) === '0', before, code: pj && pj.code, msg: pj && pj.message };" +
    "  } catch (e) { return { pid, ok: false, msg: String(e && e.message || e).slice(0, 80) }; }" +
    " };" +
    " const out = [];" +
    " for (let i = 0; i < pids.length; i += C) out.push(...await Promise.all(pids.slice(i, i + C).map(work)));" +
    " return out;" +
    "})()";

  const rows = await ev(expr);
  report.push({ aid, days, hours, total: pids.length, ok: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok), detail: rows });
  await sleep(500);
}

console.log(JSON.stringify(report, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
close();
