/**
 * 授权：Ed25519 签名 + 机器指纹绑定
 *
 * 两种模式：
 *  ① 许可证（license）—— 按人按机器激活，一次授权后直接可用（推荐，符合「授权一次」）
 *  ② 一次性授权码（code）—— 适合临时给某人跑一次
 *
 * 插件内只有公钥；私钥只在管理员机器上。别人拿到整个插件包也伪造不出许可证，
 * 把许可证文件拷到另一台机器也会因为机器指纹不符而失效。
 *
 * 许可证 payload: { v:1, iat, exp, fp:"机器指纹", name, skus?, accounts?, days?, hours? }
 * 编码：<payloadBase64Url>.<sigBase64Url>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB_PATH = path.join(here, "auth-public.pem");
const STATE_DIR = path.join(os.homedir(), ".dsh", "bili-timeslot");
const LICENSE_PATH = path.join(STATE_DIR, "license.json");
const USED_PATH = path.join(STATE_DIR, "used-nonces.json");

/* ---------------- 机器指纹 ---------------- */

export function machineFingerprint() {
  const parts = [os.hostname(), os.platform(), os.arch(), (() => { try { return os.userInfo().username; } catch { return "?"; } })()];
  if (process.platform === "win32") {
    try {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = /MachineGuid\s+REG_SZ\s+([\w-]+)/.exec(out);
      if (m) parts.push(m[1]);
    } catch { /* 读不到就退化到 主机名+用户名 */ }
  }
  const h = crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16).toUpperCase();
  return h.match(/.{1,4}/g).join("-");
}

/* ---------------- 公钥 / 签名 ---------------- */

function readPublicKey() {
  try {
    const pem = fs.readFileSync(PUB_PATH, "utf8");
    return pem.includes("BEGIN PUBLIC KEY") ? crypto.createPublicKey(pem) : null;
  } catch {
    return null;
  }
}

export function hasPublicKey() {
  return !!readPublicKey();
}

function decodeAndVerify(token, pubKey) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 2) return { ok: false, reason: "授权内容格式不对" };
  let payloadBuf, sigBuf;
  try {
    payloadBuf = Buffer.from(parts[0], "base64url");
    sigBuf = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, reason: "授权内容编码错误" };
  }
  let valid = false;
  try { valid = crypto.verify(null, payloadBuf, pubKey, sigBuf); } catch { valid = false; }
  if (!valid) return { ok: false, reason: "签名无效（不是管理员签发的）" };
  let p;
  try { p = JSON.parse(payloadBuf.toString("utf8")); } catch { return { ok: false, reason: "授权内容损坏" }; }
  if (!p || p.v !== 1) return { ok: false, reason: "授权版本不支持" };
  if (p.exp && Date.now() > p.exp) return { ok: false, reason: `已过期（${new Date(p.exp).toLocaleString("zh-CN")}）` };
  return { ok: true, payload: p };
}

/* ---------------- 许可证 ---------------- */

export function readLicenseToken() {
  try {
    const j = JSON.parse(fs.readFileSync(LICENSE_PATH, "utf8"));
    return j && j.license ? String(j.license) : null;
  } catch {
    return null;
  }
}

export function writeLicense(token) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LICENSE_PATH, JSON.stringify({ license: token, installedAt: Date.now() }, null, 2), "utf8");
  return LICENSE_PATH;
}

export function verifyLicense() {
  const token = readLicenseToken();
  if (!token) return { ok: false, reason: "本机未激活" };
  return verifyLicenseToken(token);
}

/** 校验一枚许可证字符串（不落盘）；激活时应先调这个，通过后再 writeLicense */
export function verifyLicenseToken(token) {
  const pub = readPublicKey();
  if (!pub) return { ok: false, reason: "本机未配置授权公钥（需管理员重新分发插件）" };
  if (!token) return { ok: false, reason: "本机未激活" };
  const r = decodeAndVerify(token, pub);
  if (!r.ok) return { ok: false, reason: "许可证无效：" + r.reason };
  const p = r.payload;
  if (!p.fp) return { ok: false, reason: "许可证未绑定机器，请向管理员重新申请" };
  const local = machineFingerprint();
  if (p.fp.toUpperCase() !== local.toUpperCase()) {
    return { ok: false, reason: `许可证与当前机器不符（许可证 ${p.fp} / 本机 ${local}）` };
  }
  return { ok: true, payload: p };
}

/* ---------------- 一次性授权码 ---------------- */

function readUsed() { try { return JSON.parse(fs.readFileSync(USED_PATH, "utf8")); } catch { return {}; } }
function writeUsed(o) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(USED_PATH, JSON.stringify(o, null, 2), "utf8"); } catch {} }

export function verifyAuth(code) {
  if (!code) return { ok: false, reason: "缺少授权码" };
  const pub = readPublicKey();
  if (!pub) return { ok: false, reason: "本机未配置授权公钥" };
  const r = decodeAndVerify(code, pub);
  if (!r.ok) return { ok: false, reason: "授权码无效：" + r.reason };
  const p = r.payload;
  if (p.nonce) {
    const used = readUsed();
    if (used[p.nonce]) return { ok: false, reason: "授权码已被使用过" };
    used[p.nonce] = { at: Date.now() };
    writeUsed(used);
  }
  return { ok: true, payload: p };
}

/* ---------------- 范围校验 ---------------- */

export function checkScope(payload, req) {
  const p = payload || {};
  if (Array.isArray(p.skus) && p.skus.length && req.sku && !p.skus.includes(req.sku)) {
    return `仅限 SKU：${p.skus.join(" / ")}，不含「${req.sku}」`;
  }
  if (Array.isArray(p.accounts) && p.accounts.length && req.accounts && req.accounts.length) {
    const bad = req.accounts.filter((a) => !p.accounts.includes(a));
    if (bad.length) return `授权不含这些账户：${bad.join(",")}`;
  }
  if (Array.isArray(p.days) && p.days.length && req.days && req.days.length) {
    const bad = req.days.filter((d) => !p.days.includes(d));
    if (bad.length) return `授权不允许这些星期：${bad.join(",")}（授权 ${p.days.join(",")}）`;
  }
  if (Array.isArray(p.hours) && p.hours.length && req.hours && req.hours.length) {
    const bad = req.hours.filter((h) => !p.hours.includes(h));
    if (bad.length) return `授权不允许这些小时：${bad.join(",")}`;
  }
  return null;
}
