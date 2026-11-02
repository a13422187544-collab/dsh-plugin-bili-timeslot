// 极简 CDP 客户端 + 页面操作工具（被 timeslot 脚本复用）
const PORT = Number(process.env.CDP_PORT || 9333);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(wantUrlPart = "ad.bilibili.com") {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    throw new Error(`连不上浏览器调试端口 ${PORT}：请先运行 scripts/bili-cdp.mjs launch <url> 并完成登录`);
  }
  const target = list.find((t) => t.type === "page" && (t.url || "").includes(wantUrlPart)) || list.find((t) => t.type === "page");
  if (!target) throw new Error("没有可用标签页");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pend = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pend.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const nav = async (url, urlPart) => {
    await navTo(url, urlPart);
  };
  const navTo = async (url) => {
    await send("Page.navigate", { url: "about:blank" });
    await sleep(600);
    await send("Page.navigate", { url });
    await sleep(6500);
  };
  const clickAt = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(150);
  };
  const waitFor = async (expr, timeoutMs = 15000, stepMs = 600) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await ev(expr)) return true;
      } catch {}
      await sleep(stepMs);
    }
    return false;
  };
  return { send, ev, nav, navTo, clickAt, waitFor, close: () => ws.close() };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    out[k] = v === undefined ? true : v;
  }
  return out;
}

export const ACCOUNTS = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/* ------------------------------------------------------------------
 * 分页收集：列表页每页最多 100 条，几百条的对象必须翻页取全量
 * ------------------------------------------------------------------ */

/** 读分页信息：页面「共 N 条」、当前页、最大页码 */
export const PAGER_INFO_EXPR =
  "(() => {" +
  " const t = document.body.innerText || '';" +
  " const m = /共\\s*(\\d+)\\s*条/.exec(t);" +
  " const pager = document.querySelector('.bd-pagination, .ivu-page, [class*=\"pagination\"]');" +
  " let maxPage = null, cur = null;" +
  " if (pager) {" +
  "  const nums = [...pager.querySelectorAll('li, button, a, span')]" +
  "    .map(e => (e.innerText || '').trim()).filter(s => /^\\d+$/.test(s)).map(Number);" +
  "  if (nums.length) maxPage = Math.max(...nums);" +
  "  const act = pager.querySelector('.active, .ivu-page-item-active, [class*=\"active\"]');" +
  "  if (act) { const n = Number((act.innerText || '').trim()); if (Number.isFinite(n)) cur = n; }" +
  " }" +
  " return { total: m ? Number(m[1]) : null, maxPage, cur };" +
  "})()";

/** 点「下一页」：多套选择器兜底；成功返回 true */
export const CLICK_NEXT_EXPR =
  "(() => {" +
  " const sels = ['.ivu-page-next', '.bd-pagination__next', '.bd-pager-next', '.el-pagination .btn-next'," +
  "  'button[aria-label=\"next\"]', '[class*=\"pagination\"] [class*=\"next\"]', '[class*=\"pager\"] [class*=\"next\"]'];" +
  " for (const sel of sels) {" +
  "  for (const el of document.querySelectorAll(sel)) {" +
  "   const cls = String(el.className || '');" +
  "   if (/disabled/i.test(cls) || el.disabled) continue;" +
  "   const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;" +
  "   el.click(); return true;" +
  "  }" +
  " }" +
  " return false;" +
  "})()";

/** 按页码跳转；成功返回 true */
export const gotoPageExpr = (n) =>
  "(() => {" +
  " const pager = document.querySelector('.bd-pagination, .ivu-page, [class*=\"pagination\"]');" +
  " if (!pager) return false;" +
  " const cand = [...pager.querySelectorAll('li, button, a, span')]" +
  "   .find(e => (e.innerText || '').trim() === '" + n + "');" +
  " if (!cand) return false;" +
  " cand.click(); return true;" +
  "})()";

/**
 * 翻页收集全部行（按 keyOf 去重）
 * @returns { rows, pageTotal, pagesVisited, complete }
 */
export async function collectAllRows(ev, opts) {
  const { readExpr, maxPages = 80 } = opts;
  const keyOf = opts.keyOf || ((r) => r.id || r.pid);
  const sleepFn = opts.sleepFn || sleep;
  const log = opts.log || (() => {});

  const seen = new Map();
  let pageTotal = null;

  const info0 = await ev(PAGER_INFO_EXPR);
  if (info0 && info0.total) pageTotal = info0.total;

  for (const r of await ev(readExpr)) {
    const k = keyOf(r);
    if (k && !seen.has(k)) seen.set(k, r);
  }
  let pages = 1;

  const maxPage = info0 && info0.maxPage ? Math.min(info0.maxPage, maxPages) : maxPages;

  while (pages < maxPage) {
    const nextPage = pages + 1;
    let ok = await ev(gotoPageExpr(nextPage));
    if (!ok) ok = await ev(CLICK_NEXT_EXPR);
    if (!ok) break;

    const sig = [...seen.keys()].slice(0, 3).join("|");
    let changed = false;
    for (let i = 0; i < 12; i++) {
      await sleepFn(500);
      const rows = await ev(readExpr);
      const newSig = rows.slice(0, 3).map(keyOf).join("|");
      if (rows.length && newSig && newSig !== sig) { changed = true; break; }
    }
    if (!changed) { log("第 " + nextPage + " 页无变化，停止翻页"); break; }

    const rows = await ev(readExpr);
    for (const r of rows) {
      const k = keyOf(r);
      if (k && !seen.has(k)) seen.set(k, r);
    }
    pages = nextPage;
    if (pageTotal && seen.size >= pageTotal) break;
  }

  return {
    rows: [...seen.values()],
    pageTotal,
    pagesVisited: pages,
    complete: pageTotal ? seen.size >= pageTotal : true,
  };
}

