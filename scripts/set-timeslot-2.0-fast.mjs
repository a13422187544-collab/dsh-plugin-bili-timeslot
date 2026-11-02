// 2.0 拉时段 · 接口版（v2：分页取全量 + 串行带间隔 + 失败重试 + 末尾全量校验）
// 原理：同源 + sessionStorage['_session_<account_id>'] 里的 X-EffectAd-Token，直接调
//   GET  /athena/api/v1/promotions/<pid>        → data（含 promotion_time.launch_time）
//   POST /athena/api/v1/promotions               body = data 的 12 个字段（改 promotion_time 后回写）
//
// v2 修复（2026-11-02）：
//   1) 列表每页最多 100 条 → 翻页取全量（几百个项目的账户不漏）
//   2) 并发写入触发限流（大量静默失败）→ 默认串行 --concurrency=1，笔间隔 --interval
//   3) 每笔最多重试 --retries 次（指数退避），失败原因进报告
//   4) 末尾对每个项目回读 launch_time，与目标时段逐天比对，列出未生效的
//
// 用法：
//   node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883
//   node set-timeslot-2.0-fast.mjs --sku=AI绘画 --days=1,2,3,4,5 --hours=6-18
//   node set-timeslot-2.0-fast.mjs --accounts=4620390 --dry
//   node set-timeslot-2.0-fast.mjs --accounts=4620390 --interval=500 --retries=3
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep, parseArgs, ACCOUNTS, collectAllRows } from "./lib-cdp.mjs";

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
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency || 1)));
const interval = Math.max(0, Number(args.interval === undefined ? 400 : args.interval));
const retries = Math.max(0, Number(args.retries === undefined ? 3 : args.retries));
const dry = !!args.dry;
const doVerify = args.verify === undefined ? true : String(args.verify) !== "false";

// 小时解析（左闭右开）：
//   --hours=6-18  → 勾 6..17（06:00 投到 18:00 整，12 格）
//   --hours=0-24  → 勾 0..23（全天，默认）
//   --hours=9,10,14,15 → 直接指定小时
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

const log = (m) => process.stderr.write(m + "\n");
const today = new Date().toISOString().slice(0, 10);
const { ev, navTo, waitFor, close } = await connect("ad.bilibili.com");
const t0 = Date.now();

// 未显式给账户时：按 SKU 关键词从代理商账户列表里解析（也翻页）
if (!accounts.length && skuEntry) {
  const kws = skuEntry.keywords || [];
  if (!kws.length) { console.error(`SKU ${sku} 既没配 accounts 也没配 keywords，无法定位账户`); process.exit(1); }
  await navTo("https://cm.bilibili.com/agent/#/customer.account/account");
  await waitFor("(() => document.body.innerText.includes('账户列表'))()", 30000);
  const readAcct =
    "(() => { const out = [];" +
    " for (const tr of document.querySelectorAll('tbody tr')) {" +
    "  const tds = [...tr.querySelectorAll('td')].map(td => (td.innerText||'').trim().replace(/\\s+/g,' '));" +
    "  if (tds.length < 12) continue; out.push({ id: tds[1], name: tds[2] }); } return out; })()";
  const collected = await collectAllRows(ev, { readExpr: readAcct, keyOf: (r) => r.id, log });
  const rows = collected.rows;
  const hit = rows.filter((r) => kws.some((k) => (r.name || "").includes(k)));
  if (!hit.length) {
    console.error(`[SKU ${sku}] 当前登录主体下没命中账户（关键词：${kws.join(" / ")}，扫了 ${rows.length} 个账户）。` +
      `该 SKU 可能在另一个投放后台账号下，需要先人工切换登录。`);
    process.exit(2);
  }
  accounts = hit.map((h) => h.id);
  log(`[SKU ${sku}] 命中 ${hit.length} 个账户（共扫 ${rows.length} 个）：` + hit.map((h) => `${h.id}(${h.name})`).join(" | "));
}
if (!accounts.length) { console.error("缺少 --accounts=账户ID,... 或 --sku=SKU名"); process.exit(1); }

const report = [];
const SCHEDULE = Array.from({ length: 7 }, (_, i) => (days.includes(i + 1) ? hours.slice() : []));

const readRowExpr =
  "(() => { const out = []; const seen = new Set();" +
  " for (const tr of document.querySelectorAll('tbody tr')) {" +
  "  const t = (tr.innerText||'').replace(/\\s+/g,' ').trim();" +
  "  const m = t.match(/ID (\\d{6,})/); if (!m || seen.has(m[1])) continue; seen.add(m[1]); out.push({ pid: m[1] }); } return out; })()";

for (const aid of accounts) {
  const listUrl = `https://ad.bilibili.com/#/promote/promotion?account_id=${aid}&subject_id=${subject}&subject_type=3&from=${today}&to=${today}`;
  await navTo(listUrl);
  await waitFor("(() => document.body.innerText.includes('项目信息'))()", 25000);

  const hasToken = await ev("(() => !!sessionStorage.getItem('_session_" + aid + "'))()");
  if (!hasToken) { report.push({ aid, error: "无 session token" }); continue; }

  // ── 1) 翻页取全量 ──────────────────────────────────────
  const collected = await collectAllRows(ev, { readExpr: readRowExpr, keyOf: (r) => r.pid, log });
  const pids = collected.rows.map((r) => r.pid);
  if (!pids.length) { report.push({ aid, error: "未读到项目" }); continue; }
  log(`[${aid}] 取到项目 ${pids.length} 个（页面共 ${collected.pageTotal ?? "?"} 条，翻了 ${collected.pagesVisited} 页）`);

  // ── 2) 写入：串行 + 间隔 + 重试 ─────────────────────────
  const expr =
    "(async () => {" +
    " const pids = " + JSON.stringify(pids) + ";" +
    " const aid = " + JSON.stringify(aid) + ";" +
    " const sched = " + JSON.stringify(SCHEDULE) + ";" +
    " const dry = " + JSON.stringify(dry) + ";" +
    " const C = " + concurrency + ";" +
    " const IV = " + interval + ";" +
    " const RETRY = " + retries + ";" +
    " const wait = (ms) => new Promise(r => setTimeout(r, ms));" +
    " const token = sessionStorage.getItem('_session_' + aid);" +
    " const hdr = { 'X-EffectAd-Token': token, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' };" +
    " const API = 'https://ad.bilibili.com/athena/api/v1/promotions';" +
    " const getOne = async (pid) => { const g = await fetch(API + '/' + pid, { credentials: 'include', headers: hdr }); return await g.json(); };" +
    " const work = async (pid) => {" +
    "  let lastMsg = '';" +
    "  for (let attempt = 0; attempt <= RETRY; attempt++) {" +
    "   try {" +
    "    const gj = await getOne(pid);" +
    "    const d = gj && gj.data; if (!d) { lastMsg = 'detail 无 data (code=' + (gj && gj.code) + ')'; await wait(700 * (attempt + 1)); continue; }" +
    "    const before = (d.promotion_time && d.promotion_time.launch_time || []).map(x => Array.isArray(x) ? x.length : -1);" +
    "    if (dry) return { pid, ok: true, dry: true, before, attempts: attempt + 1 };" +
    "    const payload = {" +
    "     promotion_id: d.promotion_id, promotion_name: d.promotion_name, promotion_type: d.promotion_type," +
    "     promotion_content: d.promotion_content, promotion_monitor: d.promotion_monitor, promotion_bid: d.promotion_bid," +
    "     promotion_search: d.promotion_search, promotion_budget: d.promotion_budget, promotion_time: d.promotion_time," +
    "     promotion_target: d.promotion_target, promotion_scene: d.promotion_scene, promotion_aigc: d.promotion_aigc" +
    "    };" +
    "    payload.promotion_time = Object.assign({}, d.promotion_time, { launch_time: sched });" +
    "    const p = await fetch(API, { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify(payload) });" +
    "    const txt = await p.text();" +
    "    let pj = null; try { pj = JSON.parse(txt); } catch (e) { lastMsg = 'HTTP ' + p.status + ' 非JSON(可能限流)'; await wait(1200 * (attempt + 1)); continue; }" +
    "    if (pj && String(pj.code) === '0') return { pid, ok: true, before, attempts: attempt + 1 };" +
    "    lastMsg = 'code=' + (pj && pj.code) + ' msg=' + String((pj && (pj.message || pj.msg)) || '').slice(0, 60);" +
    "    await wait(1500 * (attempt + 1));" +
    "   } catch (e) { lastMsg = String(e && e.message || e).slice(0, 80); await wait(900 * (attempt + 1)); }" +
    "  }" +
    "  return { pid, ok: false, msg: lastMsg, attempts: RETRY + 1 };" +
    " };" +
    " const out = [];" +
    " for (let i = 0; i < pids.length; i += C) {" +
    "  const batch = pids.slice(i, i + C);" +
    "  for (const pid of batch) { out.push(await work(pid)); await wait(IV); }" +
    " }" +
    " return out;" +
    "})()";

  const rows = await ev(expr);
  const okRows = rows.filter((r) => r.ok);
  const failed = rows.filter((r) => !r.ok);

  // ── 3) 末尾全量校验：逐项目回读 launch_time 与目标比对 ──
  let verify = null;
  if (doVerify && !dry) {
    const vexpr =
      "(async () => {" +
      " const pids = " + JSON.stringify(pids) + ";" +
      " const aid = " + JSON.stringify(aid) + ";" +
      " const sched = " + JSON.stringify(SCHEDULE) + ";" +
      " const wait = (ms) => new Promise(r => setTimeout(r, ms));" +
      " const token = sessionStorage.getItem('_session_' + aid);" +
      " const hdr = { 'X-EffectAd-Token': token, 'Accept': 'application/json, text/plain, */*' };" +
      " const bad = [];" +
      " for (const pid of pids) {" +
      "  try {" +
      "   const g = await fetch('https://ad.bilibili.com/athena/api/v1/promotions/' + pid, { credentials: 'include', headers: hdr });" +
      "   const gj = await g.json();" +
      "   const lt = ((gj && gj.data && gj.data.promotion_time && gj.data.promotion_time.launch_time) || []);" +
      "   const got = Array.from({ length: 7 }, (_, i) => Array.isArray(lt[i]) ? lt[i].slice().sort((a,b)=>a-b) : []);" +
      "   const same = JSON.stringify(got) === JSON.stringify(sched);" +
      "   if (!same) bad.push({ pid, lens: got.map(d => d.length) });" +
      "  } catch (e) { bad.push({ pid, err: String(e && e.message || e).slice(0, 60) }); }" +
      "  await wait(" + Math.max(120, Math.floor(interval / 2)) + ");" +
      " }" +
      " return { checked: pids.length, bad };" +
      "})()";
    verify = await ev(vexpr);
  }

  report.push({
    aid,
    days,
    hours,
    found: pids.length,
    pageTotal: collected.pageTotal,
    pagesVisited: collected.pagesVisited,
    fetchedComplete: collected.complete,
    total: pids.length,
    ok: okRows.length,
    failed,
    verify: verify || undefined,
    detail: rows,
  });
  await sleep(500);
}

console.log(JSON.stringify(report, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
close();
