// 统一入口：按账户自动处理 1.0 + 2.0
//
// 默认行为（用户没明确说版本时）：**1.0 和 2.0 都检查、都处理**
//   - 拉空（--clear）：只有 1.0 能做；2.0 不能为空，自动跳过并说明
//   - 设时段：1.0 设 launch_time + 2.0 设 promotion_time，两套都跑
// 用户明确指定 --version=1.0 / 2.0 时，只做指定的那套。
//
// 用法：
//   node apply-timeslot.mjs --accounts=4620390 --days=1,2,3,4,5 --hours=6-18
//   node apply-timeslot.mjs --sku=AI绘画 --hours=6-18
//   node apply-timeslot.mjs --accounts=4620390 --clear          （拉空，仅 1.0）
//   node apply-timeslot.mjs --accounts=4620390 --version=2.0     （只做 2.0）
//   node apply-timeslot.mjs --accounts=4620390 --days=1-5 --hours=6-18 --dry
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib-cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();

const rawVersion = String(args.version || "both").toLowerCase();
const version = rawVersion === "1" || rawVersion === "1.0" ? "1.0"
  : rawVersion === "2" || rawVersion === "2.0" ? "2.0"
  : "both";
const clear = !!(args.clear || args["拉空"]);

const passthrough = [];
for (const k of ["accounts", "sku", "subject", "days", "hours", "units", "interval", "retries", "concurrency"]) {
  if (args[k] !== undefined && args[k] !== true) passthrough.push(`--${k}=${args[k]}`);
}
if (args.dry) passthrough.push("--dry");
const interval = Number(args.interval === undefined ? 400 : args.interval);

const log = (m) => process.stderr.write(m + "\n");

function runOne(script, extraArgs) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, script), ...passthrough, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    timeout: 30 * 60 * 1000,
  });
  const out = r.stdout || "";
  const err = r.stderr || "";
  let report = null;
  try {
    const s = out.indexOf("[");
    const e = out.lastIndexOf("]");
    if (s >= 0 && e > s) report = JSON.parse(out.slice(s, e + 1));
  } catch { /* ignore */ }
  return { report, err, code: r.status, ms: Date.now() - t0 };
}

/** 从子进程 stderr 里提取一行人类可读的错误（去掉堆栈与源码行） */
function extractErr(err) {
  const lines = String(err || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const errLine =
    lines.find((l) => /^Error:\s/.test(l)) ||
    lines.find((l) => /^(Error|TypeError|RangeError):/.test(l)) ||
    lines.find((l) => /连不上浏览器调试端口|ENOENT|ECONN|失败/.test(l));
  let line = errLine || lines[0] || "无输出";
  line = line.replace(/^(Error|TypeError|RangeError):\s*/, "");
  return line.slice(0, 140);
}

/** 把各版本报告整理成统一结构；「未读到单元/项目」视为该版本不存在，不算失败 */
function normalize(report, verLabel) {
  const out = [];
  for (const item of report || []) {
    const absent = item.error && /未读到(单元|项目)/.test(item.error);
    out.push({
      version: verLabel,
      aid: item.aid,
      status: absent ? "absent" : item.error ? "error" : "done",
      note: absent ? `该账户没有 ${verLabel} 的对象` : item.error || undefined,
      found: item.found,
      pageTotal: item.pageTotal,
      fetchedComplete: item.fetchedComplete,
      total: item.total,
      ok: item.ok,
      failed: item.failed,
      verifyBad: item.verify ? item.verify.bad : undefined,
    });
  }
  return out;
}

const combined = [];
const steps = [];

if (clear) {
  if (version === "1.0" || version === "both") {
    log("[1/1] 1.0 拉空…");
    const r = runOne("clear-slot-1.0-fast.mjs", []);
    if (r.report) combined.push(...normalize(r.report, "1.0"));
    else combined.push({ version: "1.0", status: "error", note: extractErr(r.err) });
    steps.push({ step: "1.0-clear", exit: r.code, ms: r.ms });
    if (version === "both") log("      注：2.0 不允许时段为空，拉空不适用于 2.0，已跳过");
  } else {
    log("⚠️ 2.0 无法拉空（平台要求至少选一天），本次未执行任何操作");
    console.log(JSON.stringify([{ error: "2.0 不支持拉空，请改用 --days/--hours 设时段" }], null, 2));
    process.exit(2);
  }
} else {
  const plan = version === "1.0" ? ["1.0"] : version === "2.0" ? ["2.0"] : ["1.0", "2.0"];
  plan.forEach((v, i) => {
    log(`[${i + 1}/${plan.length}] ${v} 设时段…`);
    const r = runOne(v === "1.0" ? "set-timeslot-1.0-fast.mjs" : "set-timeslot-2.0-fast.mjs", []);
    if (r.report) combined.push(...normalize(r.report, v));
    else combined.push({ version: v, status: "error", note: extractErr(r.err) });
    steps.push({ step: v, exit: r.code, ms: r.ms });
    if (i < plan.length - 1) {
      const wait = Math.max(400, interval);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  });
}

// ── 汇总 ──────────────────────────────────────────────
const summary = { version, clear, accountsHandled: 0, objectsFound: 0, objectsOk: 0, verifyBad: 0, absent: 0, errors: 0 };
for (const c of combined) {
  if (c.status === "absent") { summary.absent++; continue; }
  if (c.status === "error") { summary.errors++; continue; }
  summary.accountsHandled++;
  summary.objectsFound += c.found || 0;
  summary.objectsOk += c.ok || 0;
  summary.verifyBad += (c.verifyBad || []).length;
}
summary.steps = steps;

console.log(JSON.stringify({ summary, detail: combined }, null, 2));
log(`完成：${summary.objectsOk}/${summary.objectsFound} 成功，未生效 ${summary.verifyBad}，跳过(版本不存在) ${summary.absent}，错误 ${summary.errors}`);
process.exit(summary.errors > 0 || summary.verifyBad > 0 ? 1 : 0);
