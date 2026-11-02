// 1.0 拉空 · 接口版（快，推荐）
// 原理：页面同源带 cookie + sessionStorage 里的 X-EffectAd-Token，直接调
//   GET  /platform/api/web_api/v6/sanlian/unit/get_unit?unit_id=
//   POST /platform/api/web_api/v6/sanlian/unit/save_unit  {unit: {...launch_time 置空...}}
// 用法：
//   node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883
//   node clear-slot-1.0-fast.mjs --accounts=4620390,4564097 --subject=833883 --concurrency=4
//   node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883 --units=777025688 --dry
import { connect, sleep, parseArgs, ACCOUNTS } from "./lib-cdp.mjs";

const args = parseArgs();
const accounts = ACCOUNTS(args.accounts);
const subject = args.subject || "833883";
const onlyUnits = args.units ? String(args.units).split(",").map((s) => s.trim()).filter(Boolean) : null;
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency || 4)));
const dry = !!args.dry;

if (!accounts.length) {
  console.error("缺少 --accounts=账户ID,账户ID");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const { ev, navTo, waitFor, close } = await connect("ad.bilibili.com");
const t0 = Date.now();
const report = [];

for (const aid of accounts) {
  const listUrl = `https://ad.bilibili.com/#/promote/campaign/unit?account_id=${aid}&subject_id=${subject}&subject_type=3`;
  await navTo(listUrl);
  await waitFor("(() => document.body.innerText.includes('单元名称'))()", 25000);

  let ids = await ev(
    "(() => { const out = []; const seen = new Set();" +
    " for (const tr of document.querySelectorAll('tbody tr')) {" +
    "  const t = (tr.innerText||'').replace(/\\s+/g,' ').trim();" +
    "  const u = (t.match(/ID:(\\d{6,})/) || [])[1];" +
    "  if (!u || seen.has(u)) continue; seen.add(u); out.push(u); } return out; })()"
  );
  if (onlyUnits) ids = ids.filter((u) => onlyUnits.includes(u));
  if (!ids.length) { report.push({ aid, error: "未读到单元" }); continue; }

  const hasToken = await ev("(() => !!sessionStorage.getItem('_session_" + aid + "'))()");
  if (!hasToken) { report.push({ aid, error: "该账户无 session token（可能未正确进入账户）" }); continue; }

  const expr =
    "(async () => {" +
    " const ids = " + JSON.stringify(ids) + ";" +
    " const aid = " + JSON.stringify(aid) + ";" +
    " const dry = " + JSON.stringify(dry) + ";" +
    " const C = " + concurrency + ";" +
    " const token = sessionStorage.getItem('_session_' + aid);" +
    " const base = 'https://ad.bilibili.com/platform/api/web_api/v6/sanlian/unit/';" +
    " const hdr = { 'X-EffectAd-Token': token, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' };" +
    " const work = async (id) => {" +
    "  try {" +
    "   const g = await fetch(base + 'get_unit?unit_id=' + id, { credentials: 'include', headers: hdr });" +
    "   const gj = await g.json();" +
    "   const bo = gj && gj.result && gj.result.unit_bo;" +
    "   if (!bo) return { id, ok: false, msg: 'get_unit 无 unit_bo' };" +
    "   const lens = (bo.launch_time || []).map(d => Array.isArray(d) ? d.length : -1);" +
    "   if (dry) return { id, ok: true, dry: true, before: lens };" +
    "   if (lens.every(x => x === 0)) return { id, ok: true, skipped: 'already-empty' };" +
    "   bo.launch_time = [[],[],[],[],[],[],[]];" +
    "   bo.unit_id = String(bo.unit_id);" +
    "   const p = await fetch(base + 'save_unit', { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify({ unit: bo }) });" +
    "   const pj = await p.json();" +
    "   const ok = pj && pj.status === 'success';" +
    "   return { id, ok, before: lens, resp: pj && pj.status };" +
    "  } catch (e) { return { id, ok: false, msg: String(e && e.message || e).slice(0,80) }; }" +
    " };" +
    " const out = [];" +
    " for (let i = 0; i < ids.length; i += C) {" +
    "  const batch = ids.slice(i, i + C).map(work);" +
    "  out.push(...await Promise.all(batch));" +
    " }" +
    " return out;" +
    "})()";

  const rows = await ev(expr);
  const ok = rows.filter((r) => r.ok).length;
  report.push({ aid, total: ids.length, ok, failed: rows.filter((r) => !r.ok), detail: rows });
  await sleep(500);
}

console.log(JSON.stringify(report, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
close();
