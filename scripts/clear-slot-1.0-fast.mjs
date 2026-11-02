// 1.0 拉空 · 接口版（v2：分页取全量 + 串行带间隔 + 失败重试 + 末尾全量校验）
// 原理：页面同源带 cookie + sessionStorage 里的 X-EffectAd-Token，直接调
//   GET  /platform/api/web_api/v6/sanlian/unit/get_unit?unit_id=
//   POST /platform/api/web_api/v6/sanlian/unit/save_unit  {unit: {...launch_time 置空...}}
//
// v2 修复（2026-11-02）：
//   1) 列表页每页最多 100 条 → 改为翻页取全量（几百条的账户不会再漏）
//   2) 并发写入触发限流 → 改默认串行（--concurrency=1），每笔之间间隔 --interval ms
//   3) 静默失败 → 每笔最多重试 --retries 次（指数退避），失败原因进报告
//   4) 末尾对每个单元回读 launch_time，全量核对，列出未生效的
//
// 用法：
//   node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883
//   node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883 --dry
//   node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883 --interval=500 --retries=3
//   node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883 --units=777025688
import { connect, sleep, parseArgs, ACCOUNTS, collectAllRows } from "./lib-cdp.mjs";

const args = parseArgs();
const accounts = ACCOUNTS(args.accounts);
const subject = args.subject || "833883";
const onlyUnits = args.units ? String(args.units).split(",").map((s) => s.trim()).filter(Boolean) : null;
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency || 1)));
const interval = Math.max(0, Number(args.interval === undefined ? 400 : args.interval));
const retries = Math.max(0, Number(args.retries === undefined ? 3 : args.retries));
const dry = !!args.dry;
const doVerify = args.verify === undefined ? true : String(args.verify) !== "false";

if (!accounts.length) {
  console.error("缺少 --accounts=账户ID,账户ID");
  process.exit(1);
}

const log = (m) => process.stderr.write(m + "\n");

const readRowExpr =
  "(() => { const out = []; const seen = new Set();" +
  " for (const tr of document.querySelectorAll('tbody tr')) {" +
  "  const t = (tr.innerText||'').replace(/\\s+/g,' ').trim();" +
  "  const u = (t.match(/ID:(\\d{6,})/) || [])[1];" +
  "  if (!u || seen.has(u)) continue; seen.add(u); out.push({ id: u }); } return out; })()";

const today = new Date().toISOString().slice(0, 10);
const { ev, navTo, waitFor, close } = await connect("ad.bilibili.com");
const t0 = Date.now();
const report = [];

for (const aid of accounts) {
  const listUrl = `https://ad.bilibili.com/#/promote/campaign/unit?account_id=${aid}&subject_id=${subject}&subject_type=3`;
  await navTo(listUrl);
  await waitFor("(() => document.body.innerText.includes('单元名称'))()", 25000);

  const hasToken = await ev("(() => !!sessionStorage.getItem('_session_" + aid + "'))()");
  if (!hasToken) { report.push({ aid, error: "该账户无 session token（可能未正确进入账户）" }); continue; }

  // ── 1) 翻页取全量 ──────────────────────────────────────
  const collected = await collectAllRows(ev, {
    readExpr: readRowExpr,
    keyOf: (r) => r.id,
    log,
  });
  let ids = collected.rows.map((r) => r.id);
  if (onlyUnits) ids = ids.filter((u) => onlyUnits.includes(u));

  if (!ids.length) { report.push({ aid, error: "未读到单元" }); continue; }
  log(`[${aid}] 取到单元 ${ids.length} 个（页面共 ${collected.pageTotal ?? "?"} 条，翻了 ${collected.pagesVisited} 页）`);

  // ── 2) 写入：串行 + 间隔 + 重试 ─────────────────────────
  const expr =
    "(async () => {" +
    " const ids = " + JSON.stringify(ids) + ";" +
    " const aid = " + JSON.stringify(aid) + ";" +
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
    "    const lens = (bo.launch_time || []).map(d => Array.isArray(d) ? d.length : -1);" +
    "    if (dry) return { id, ok: true, dry: true, before: lens, attempts: attempt + 1 };" +
    "    if (lens.every(x => x === 0)) return { id, ok: true, skipped: 'already-empty', attempts: attempt + 1 };" +
    "    bo.launch_time = [[],[],[],[],[],[],[]];" +
    "    bo.unit_id = String(bo.unit_id);" +
    "    const p = await fetch(base + 'save_unit', { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify({ unit: bo }) });" +
    "    const txt = await p.text();" +
    "    let pj = null; try { pj = JSON.parse(txt); } catch (e) { lastMsg = 'HTTP ' + p.status + ' 非JSON(可能限流)'; await wait(1200 * (attempt + 1)); continue; }" +
    "    const ok = pj && pj.status === 'success';" +
    "    if (ok) return { id, ok: true, before: lens, attempts: attempt + 1 };" +
    "    lastMsg = 'status=' + (pj && pj.status) + ' msg=' + String((pj && (pj.message || pj.msg)) || '').slice(0, 60);" +
    "    await wait(1200 * (attempt + 1));" +
    "   } catch (e) { lastMsg = String(e && e.message || e).slice(0, 80); await wait(900 * (attempt + 1)); }" +
    "  }" +
    "  return { id, ok: false, msg: lastMsg, attempts: RETRY + 1 };" +
    " };" +
    " const out = [];" +
    " for (let i = 0; i < ids.length; i += C) {" +
    "  const batch = ids.slice(i, i + C);" +
    "  for (const id of batch) { out.push(await work(id)); await wait(IV); }" +
    " }" +
    " return out;" +
    "})()";

  const rows = await ev(expr);
  const okRows = rows.filter((r) => r.ok);
  const failed = rows.filter((r) => !r.ok);

  // ── 3) 末尾全量校验 ───────────────────────────────────
  let verify = null;
  if (doVerify && !dry) {
    const vexpr =
      "(async () => {" +
      " const ids = " + JSON.stringify(ids) + ";" +
      " const aid = " + JSON.stringify(aid) + ";" +
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
      "   const lens = (bo && bo.launch_time || []).map(d => Array.isArray(d) ? d.length : -1);" +
      "   if (!lens.length || !lens.every(x => x === 0)) bad.push({ id, lens });" +
      "  } catch (e) { bad.push({ id, err: String(e && e.message || e).slice(0, 60) }); }" +
      "  await wait(" + Math.max(120, Math.floor(interval / 2)) + ");" +
      " }" +
      " return { checked: ids.length, bad };" +
      "})()";
    verify = await ev(vexpr);
  }

  report.push({
    aid,
    found: ids.length,
    pageTotal: collected.pageTotal,
    pagesVisited: collected.pagesVisited,
    fetchedComplete: collected.complete,
    total: ids.length,
    ok: okRows.length,
    skipped: okRows.filter((r) => r.skipped).length,
    failed,
    verify: verify || undefined,
    detail: rows,
  });
  await sleep(500);
}

console.log(JSON.stringify(report, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
close();
