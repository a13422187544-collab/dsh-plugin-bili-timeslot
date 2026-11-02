/**
 * dsh-plugin-bili-timeslot — 宿主半侧入口（Cordis 插件）
 *
 * 命令：
 *   /timeslot  （/拉时段）：2.0 批量设置投放时段
 *   /clearslot （/拉空）  ：1.0 批量拉空（清空时段 = 不投放）
 *   /timeslot fp           ：显示本机指纹（申请许可证用，无需授权）
 *   /timeslot activate=<许可证>：激活本机（管理员签发的机器绑定许可证）
 *
 * 授权模型：**按机器绑定、一次激活、长期可用**
 *   - 许可证由管理员私钥签发，插件内只有公钥，别人拿到包也伪造不出
 *   - 许可证写死机器指纹，拷到别的机器直接失效
 *   - 可限定 SKU / 账户 / 星期 / 小时范围
 *   - 另保留一次性授权码（auth=）用于临时执行
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  verifyAuth,
  verifyLicense,
  verifyLicenseToken,
  writeLicense,
  machineFingerprint,
  checkScope,
  hasPublicKey,
} from "./auth.mjs";

export const name = "dsh-plugin-bili-timeslot";

/** 只依赖命令服务；拿不到命令服务时 cordis 不会激活本插件，不会半死。 */
export const inject = ["commands"];

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, "..", "scripts");

function runScript(scriptFile, args, timeoutMs = 240000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [path.join(scriptsDir, scriptFile), ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, out: "", err: String((e && e.message) || e) });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}

function parseInput(raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  const r = { target: "", days: "", hours: "", subject: "", auth: "", activate: "", dry: false };
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (low.startsWith("days=")) r.days = t.slice(5);
    else if (low.startsWith("hours=")) r.hours = t.slice(6);
    else if (low.startsWith("subject=")) r.subject = t.slice(8);
    else if (low.startsWith("auth=")) r.auth = t.slice(5);
    else if (low.startsWith("activate=")) r.activate = t.slice(9);
    else if (low === "--dry" || low === "dry") r.dry = true;
    else if (!r.target) r.target = t;
  }
  return r;
}

const expandDays = (spec) =>
  String(spec || "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);

function expandHours(spec) {
  const s = String(spec || "").trim();
  if (!s) return [];
  if (/^\d+\s*-\s*\d+$/.test(s)) {
    const [a, b] = s.split("-").map((x) => Number(x.trim()));
    const out = [];
    for (let h = a; h < b; h++) if (h >= 0 && h <= 23) out.push(h);
    return out;
  }
  return s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
}

function summarize(out, err) {
  let report = null;
  try {
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (start >= 0 && end > start) report = JSON.parse(out.slice(start, end + 1));
  } catch { /* 用原文 */ }

  const lines = [];
  const warn = err.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^at\s/.test(s) && !s.includes("Electron"));
  for (const w of warn.slice(0, 6)) lines.push(w);

  if (Array.isArray(report)) {
    for (const acc of report) {
      if (acc.error) { lines.push(`账户 ${acc.aid}：${acc.error}`); continue; }
      const total = acc.total ?? (acc.detail ? acc.detail.length : 0);
      const ok = acc.ok ?? 0;
      const hours = Array.isArray(acc.hours) && acc.hours.length
        ? `${acc.hours[0]}~${acc.hours[acc.hours.length - 1]} 点（${acc.hours.length} 格）` : "";
      const days = Array.isArray(acc.days) && acc.days.length ? `周${acc.days.join("/")}` : "";
      lines.push(`账户 ${acc.aid}：${ok}/${total} 成功` + (days ? `｜${days}` : "") + (hours ? `｜${hours}` : ""));
      if (Array.isArray(acc.failed) && acc.failed.length) {
        for (const f of acc.failed.slice(0, 5)) lines.push(`  ✗ ${f.pid || f.id || f.unit || ""} ${f.msg || f.code || ""}`);
      }
    }
  } else if (out.trim()) {
    lines.push(out.trim().slice(0, 800));
  }

  const cost = /耗时\s*([\d.]+)s/.exec(out);
  if (cost) lines.push(`耗时 ${cost[1]}s`);
  return lines.join("\n");
}

/** 未授权时的统一提示（带本机指纹，方便直接去找管理员） */
function needLicense(reason) {
  return (
    `⛔ 本机未激活：${reason}\n` +
    `本机指纹：${machineFingerprint()}\n` +
    `把指纹发给管理员申请许可证，再用  /timeslot activate=<许可证>  激活（激活后长期可用）。`
  );
}

/** 授权门：许可证优先；其次一次性授权码；都没有就拒绝。返回 null = 通过 */
function gate(p, req) {
  if (!hasPublicKey()) return "本机插件未配置授权公钥：需管理员重新分发插件（先跑 authorize.mjs --init）。";

  const lic = verifyLicense();
  if (lic.ok) {
    const err = checkScope(lic.payload, req);
    return err ? `⛔ 超出授权范围：${err}` : null;
  }
  if (p.auth) {
    const r = verifyAuth(p.auth);
    if (!r.ok) return `⛔ ${r.reason}`;
    const err = checkScope(r.payload, req);
    return err ? `⛔ 超出授权范围：${err}` : null;
  }
  return needLicense(lic.reason);
}

/** 处理 fp / activate 这类与业务无关的子命令；返回 null 表示不是这类命令 */
function handleMeta(p) {
  const t = (p.target || "").toLowerCase();
  if (p.activate) {
    try {
      // 先校验、通过才落盘（避免伪造许可证把本机已有许可证覆盖坏）
      const v = verifyLicenseToken(p.activate);
      if (!v.ok) return { kind: "error", text: `⛔ 激活失败：${v.reason}\n本机指纹：${machineFingerprint()}` };

      const file = writeLicense(p.activate);
      const sc = [];
      if (v.payload.name) sc.push(`授权对象 ${v.payload.name}`);
      if (v.payload.exp) sc.push(`到期 ${new Date(v.payload.exp).toLocaleString("zh-CN")}`);
      if (v.payload.skus) sc.push(`SKU ${v.payload.skus.join("/")}`);
      if (v.payload.accounts) sc.push(`账户 ${v.payload.accounts.join(",")}`);
      if (v.payload.days) sc.push(`星期 ${v.payload.days.join(",")}`);
      if (v.payload.hours) sc.push(`小时 ${v.payload.hours.length} 格`);
      return { kind: "success", text: `✅ 激活成功（${file}）\n` + sc.join("｜") };
    } catch (e) {
      return { kind: "error", text: "激活失败：" + ((e && e.message) || String(e)) };
    }
  }
  if (t === "fp" || t === "whoami" || t === "指纹") {
    const lic = verifyLicense();
    return {
      kind: "success",
      text:
        `本机指纹：${machineFingerprint()}\n` +
        (lic.ok
          ? `当前许可证：有效` +
            (lic.payload.exp ? `，到期 ${new Date(lic.payload.exp).toLocaleString("zh-CN")}` : "")
          : `当前许可证：未激活（${lic.reason}）`),
    };
  }
  return null;
}

export function apply(ctx) {
  const timeslotHandler = async ({ rawInput }) => {
    try {
      const p = parseInput(rawInput);
      const meta = handleMeta(p);
      if (meta) return meta;
      if (!p.target) {
        return {
          kind: "error",
          text:
            "用法：/timeslot <SKU 或 账户ID列表> [days=1-5] [hours=6-18] [--dry]\n" +
            "激活：/timeslot activate=<许可证>　查看指纹：/timeslot fp\n" +
            "SKU：建模 / 原画 / AI绘画 / AI视频 / AI写作",
        };
      }
      const isAccounts = /^[\d,]+$/.test(p.target);
      const req = {
        sku: isAccounts ? undefined : p.target,
        accounts: isAccounts ? p.target.split(",").filter(Boolean) : undefined,
        days: expandDays(p.days) || undefined,
        hours: expandHours(p.hours) || undefined,
      };
      const deny = gate(p, req);
      if (deny) return { kind: "error", text: deny };

      const args = [isAccounts ? `--accounts=${p.target}` : `--sku=${p.target}`];
      if (p.days) args.push(`--days=${p.days}`);
      if (p.hours) args.push(`--hours=${p.hours}`);
      if (p.subject) args.push(`--subject=${p.subject}`);
      if (p.dry) args.push("--dry");

      const { code, out, err } = await runScript("set-timeslot-2.0-fast.mjs", args);
      const body = summarize(out, err);
      if (code === 2) return { kind: "error", text: "没找到该 SKU 的账户：请直接给账户ID，或确认当前登录的投放后台。\n" + body };
      if (code !== 0) return { kind: "error", text: `执行失败（exit ${code}）\n` + body };
      return { kind: "success", text: (p.dry ? "【预演，未写入】\n" : "") + body };
    } catch (e) {
      return { kind: "error", text: "插件异常：" + ((e && e.message) || String(e)) };
    }
  };

  const clearslotHandler = async ({ rawInput }) => {
    try {
      const p = parseInput(rawInput);
      const meta = handleMeta(p);
      if (meta) return meta;
      if (!p.target) {
        return {
          kind: "error",
          text:
            "用法：/clearslot <账户ID列表> [subject=833883] [--dry]\n" +
            "激活：/clearslot activate=<许可证>　查看指纹：/clearslot fp\n" +
            "注意：1.0 拉空 = 清空投放时段，广告将不再展示。",
        };
      }
      if (!/^[\d,]+$/.test(p.target)) {
        return { kind: "error", text: "1.0 拉空必须给账户ID列表（不接受 SKU，因为 SKU 可能跨多主体）" };
      }
      const req = { accounts: p.target.split(",").filter(Boolean) };
      const deny = gate(p, req);
      if (deny) return { kind: "error", text: deny };

      const args = [`--accounts=${p.target}`];
      if (p.subject) args.push(`--subject=${p.subject}`);
      if (p.dry) args.push("--dry");

      const { code, out, err } = await runScript("clear-slot-1.0-fast.mjs", args);
      const body = summarize(out, err);
      if (code !== 0) return { kind: "error", text: `执行失败（exit ${code}）\n` + body };
      return { kind: "success", text: (p.dry ? "【预演，未写入】\n" : "") + body };
    } catch (e) {
      return { kind: "error", text: "插件异常：" + ((e && e.message) || String(e)) };
    }
  };

  const reg = (cmdName, description, hint, handler, label) =>
    ctx.effect(
      () => ctx.commands.register({ name: cmdName, description, input: { hint }, handler }),
      label
    );

  reg("timeslot", "B站三连推广 2.0：批量设置投放时段（需本机已激活）", "AI绘画 hours=6-18 ｜ fp 查指纹 ｜ activate=许可证", timeslotHandler, "bili-timeslot: /timeslot");
  reg("拉时段", "B站三连推广 2.0：批量设置投放时段（需本机已激活）", "AI绘画 hours=6-18 ｜ fp ｜ activate=许可证", timeslotHandler, "bili-timeslot: /拉时段");
  reg("clearslot", "B站三连推广 1.0：批量拉空投放时段（需本机已激活）", "4620390,4564097 ｜ fp ｜ activate=许可证", clearslotHandler, "bili-timeslot: /clearslot");
  reg("拉空", "B站三连推广 1.0：批量拉空投放时段（需本机已激活）", "4620390,4564097 ｜ fp ｜ activate=许可证", clearslotHandler, "bili-timeslot: /拉空");
}
