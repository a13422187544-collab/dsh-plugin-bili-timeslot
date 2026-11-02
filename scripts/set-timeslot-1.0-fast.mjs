// 1.0 设时段 · 接口版（v1：分页取全量 + 串行带间隔 + 失败重试 + 末尾全量校验）
// 原理：与拉空同一套接口，只是 launch_time 从「全空」换成目标时段
//   GET  /platform/api/web_api/v6/sanlian/unit/get_unit?unit_id=
//   POST /platform/api/web_api/v6/sanlian/unit/save_unit  {unit: {...launch_time = 目标...}}
//
// 用法：
//   node set-timeslot-1.0-fast.mjs --accounts=4620390 --subject=833883
//   node set-timeslot-1.0-fast.mjs --accounts=4620390 --days=1,2,3,4,5 --hours=6-18
//   node set-timeslot-1.0-fast.mjs --sku=AI绘画 --dry
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
const subject = args.subject || (skuEntry && skuEntry.subject) || "833883";
const daysSpec = args.days || (skuEntry && skuEntry.days) || "1,2,3,4,5";
const hoursSpec = args.hours || (skuEntry && skuEntry.hours);
const onlyUnits = args.units ? String(args.units).split(",").map((s) => s.trim()).filter(Boolean) : null;
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency || 1)));
const interval = Math.max(0, Number(args.interval === undefined ? 400 : args.interval));
const retries = Math.max(0, Number(args.retries === undefined ? 3 : args.retries));
const dry = !!args.dry;
const doVerify = args.verify === undefined ? true : String(args.verify) !== "false";

function parseHours(spec) {
  const s = String(spec === undefined ? "0-24" : spec).trim();
  let hs = [];
  if (/^\d+\s*-\s*\d+$/.test(s)) {
    const [a, b] = s.split("-").map((x) => Number(x.trim()));
    if (!(a < b)) throw new Error(`--hours 区间非法：${s}`);
    if (a < 0 || b > 24) throw new Error(`--hours 超出范围：${s}`);
    for (let h = a; h < b; h++) hs.push(h);
  } else if (/^[\d,\s]+$/.test(s)) {
    hs = s.split(",").map((x) => Number(x.trim()));
  } else {
    throw new Error(`--hours 格式不对：${s}`);
  }
  hs = [...new Set(hs)].sort((a, b) => a - b);
  if (!hs.length || hs.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
    throw new Error(`--hours 小时必须在 0~23：${s}`);
  }
  return hs;
}

const days = String(daysSpec).split(",").map((x) => Number(x.trim())).filter((x) => x >= 1 && x <= 7);
if (!days.length) throw new Error("--days 至少一天");
const hours = parseHours(hoursSpec);
const SCHEDULE = Array.from({ length: 7 }, (_, i) => (days.includes(i + 1) ? hours.slice() : []));

const log = (m) => process.stderr.write(m + "\n");
const { ev, navTo, waitFor, close } = await connect("ad.bilibili.com");
const t0 = Date.now();

// 未给账户：按 SKU 关键词解析（翻页）
if (!accounts.length && skuEntry) {
  const kws = skuEntry.keywords || [];
  await navTo("https://cm.bilibili.com/agent/#/customer.account/account");
  await waitFor("(() => document.body.innerText.includes('账户列表'))()", 30000);
  const readAcct =
    "(() => { const out = [];" +
    " for (const tr of document.querySelectorAll('tbody tr')) {" +
    "  const tds = [...tr.querySelectorAll('td')].map(td => (td.innerText||'').trim().replace(/\\s+/g,' '));" +
    "  if (tds.length < 12) continue; out.push({ id: tds[1], name: tds[2] }); } return out; })()";
  const collected = await collectAllRows(ev, { readExpr: readAcct, keyOf: (r) => r.id, log });
  const hit = collected.rows.filter((r) => kws.some((k) => (r.name || "").includes(k)));
  if (!hit.length) {
    console.error(`[SKU ${sku}] 当前登录主体下没命中账户（关键词：${kws.join(" / ")}）`);
    process.exit(2);
  }
  accounts = hit.map((h) => h.id);
  log(`[SKU ${sku}] 命中 ${hit.length} 个账户`);
}
if (!accounts.length) { console.error("缺少 --accounts 或 --sku"); process.exit(1); }

const report = [];
const readRowExpr =
  "(() => { const out = []; const seen = new Set();" +
  " for (const tr of document.querySelectorAll('tbody tr')) {" +
  "  const t = (tr.innerText||'').replace(/\\s+/g,' ').trim();" +
  "  const u = (t.match(/ID:(\\d{6,})/) || [])[1];" +
  "  if (!u || seen.has(u)) continue; seen.add(u); out.push({ id: u }); } return out; })()";

for (const aid of accounts) {
  const listUrl = `https://ad.bilibili.com/#/promote/campaign/unit?account_id=${aid}&subject_id=${subject}&subject_type=3`;
  await navTo(listUrl);
  await waitFor("(() => document.body.innerText.includes('单元名称'))()", 25000);

  const hasToken = await ev("(() => !!sessionStorage.getItem('_session_" + aid + "'))()");
  if (!hasToken) { report.push({ aid, version: "1.0", error: "无 session token" }); continue; }

  const collected = await collectAllRows(ev, { readExpr: readRowExpr, keyOf: (r) => r.id, log });
  let ids = collected.rows.map((r) => r.id);
  if (onlyUnits) ids = ids.filter((u) => onlyUnits.includes(u));
  if (!ids.length) { report.push({ aid, version: "1.0", error: "未读到单元" }); continue; }
  log(`[${aid}] 1.0 取到单元 ${ids.length} 个（页面共 ${collected.pageTotal ?? "?"} 条）`);

  const expr =
    "(async () => {" +
    " const ids = " + JSON.stringify(ids) + ";" +
    " const aid = " + JSON.stringify(aid) + ";" +
    " const sched = " + JSON.stringify(SCHEDULE) + ";" +
    " const dry = " + JSON.stringify(dry) + ";" +
    " const C = " + concurrency + ";" +
    " const IV = " + interval + ";" +
    " const RETRY = " + retries + ";" +
    " const wait = (ms) => new Promise(r => setTimeout(r, ms));" +
    " const token = sessionStorage.getItem('_session_' + aid);" +
    " const base = 'https://ad.bilibili.com/platform/api/web_api/v6/sanlian/unit/';" +
    " const hdr = { 'X-EffectAd-Token': token, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' };" +
    " const getOne = async (id) => { const g = await fetch(base + 'get_unit?unit_id=' + id, { credentials: 'include', headers: hdr }); return await g.json(); };" +
    " const work = async (id) => {" +
    "  let lastMsg = '';" +
    "  for (let attempt = 0; attempt <= RETRY; attempt++) {" +
    "   try {" +
    "    const gj = await getOne(id);" +
    "    const bo = gj && gj.result && gj.result.unit_bo;" +
    "    if (!bo) { lastMsg = 'get_unit 无 unit_bo'; await wait(600 * (attempt + 1)); continue; }" +
    "    const before = (bo.launch_time || []).map(d => Array.isArray(d) ? d.length : -1);" +
    "    if (dry) return { id, ok: true, dry: true, before, attempts: attempt + 1 };" +
    "    const cur = JSON.stringify((bo.launch_time || []).map(d => Array.isArray(d) ? d.slice().sort((a,b)=>a-b) : []));" +
    "    if (cur === JSON.stringify(sched)) return { id, ok: true, skipped: 'already-set', before, attempts: attempt + 1 };" +
    "    bo.launch_time = sched.map(d => d.slice());" +
    "    bo.unit_id = String(bo.unit_id);" +
    "    const p = await fetch(base + 'save_unit', { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify({ unit: bo }) });" +
    "    const txt = await p.text();" +
    "    let pj = null; try { pj = JSON.parse(txt); } catch (e) { lastMsg = 'HTTP ' + p.status + ' 非JSON(可能限流)'; await wait(1200 * (attempt + 1)); continue; }" +
    "    if (pj && pj.status === 'success') return { id, ok: true, before, attempts: attempt + 1 };" +
    "    lastMsg = 'status=' + (pj && pj.status);" +
    "    await wait(1200 * (attempt + 1));" +
    "   } catch (e) { lastMsg = String(e && e.message || e).slice(0, 80); await wait(900 * (attempt + 1)); }" +
    "  }" +
    "  return { id, ok: false, msg: lastMsg, attempts: RETRY + 1 };" +
    " };" +
    " const out = [];" +
    " for (let i = 0; i < ids.length; i += C) {" +
    "  for (const id of ids.slice(i, i + C)) { out.push(await work(id)); await wait(IV); }" +
    " }" +
    " return out;" +
    "})()";

  const rows = await ev(expr);
  const okRows = rows.filter((r) => r.ok);
  const failed = rows.filter((r) => !r.ok);

  let verify = null;
  if (doVerify && !dry) {
    const vexpr =
      "(async () => {" +
      " const ids = " + JSON.stringify(ids) + ";" +
      " const aid = " + JSON.stringify(aid) + ";" +
      " const sched = " + JSON.stringify(SCHEDULE) + ";" +
      " const wait = (ms) => new Promise(r => setTimeout(r, ms));" +
      " const token = sessionStorage.getItem('_session_' + aid);" +
      " const hdr = { 'X-EffectAd-Token': token, 'Accept': 'application/json, text/plain, */*' };" +
      " const base = 'https://ad.bilibili.com/platform/api/web_api/v6/sanlian/unit/get_unit?unit_id=';" +
      " const bad = [];" +
      " for (const id of ids) {" +
      "  try {" +
      "   const g = await fetch(base + id, { credentials: 'include', headers: hdr });" +
      "   const gj = await g.json();" +
      "   const bo = gj && gj.result && gj.result.unit_bo;" +
      "   const lt = (bo && bo.launch_time) || [];" +
      "   const got = Array.from({ length: 7 }, (_, i) => Array.isArray(lt[i]) ? lt[i].slice().sort((a,b)=>a-b) : []);" +
      "   if (JSON.stringify(got) !== JSON.stringify(sched)) bad.push({ id, lens: got.map(d => d.length) });" +
      "  } catch (e) { bad.push({ id, err: String(e && e.message || e).slice(0, 60) }); }" +
      "  await wait(" + Math.max(120, Math.floor(interval / 2)) + ");" +
      " }" +
      " return { checked: ids.length, bad };" +
      "})()";
    verify = await ev(vexpr);
  }

  report.push({
    aid,
    version: "1.0",
    days,
    hours,
    found: ids.length,
    pageTotal: collected.pageTotal,
    fetchedComplete: collected.complete,
    total: ids.length,
    ok: okRows.length,
    failed,
    verify: verify || undefined,
  });
  await sleep(500);
}

console.log(JSON.stringify(report, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
close();
