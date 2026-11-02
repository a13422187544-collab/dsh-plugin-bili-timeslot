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
