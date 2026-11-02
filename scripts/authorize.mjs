// 管理员工具：初始化密钥 / 查看本机指纹 / 签发许可证（按机器绑定）
//
// 首启用：
//   node authorize.mjs --init
//
// 给别人的机器激活（对方先把指纹发你）：
//   node authorize.mjs --issue --fp=AB12-CD34-EF56-7890 --name="启职-小王" --skus=AI绘画 --expires=2026-12-31
//
// 本机自用（直接装到本机）：
//   node authorize.mjs --self --name="我的机器" --expires=2026-12-31
//
// 临时一次性码：
//   node authorize.mjs --code --name="临时" --ttl-hours=2
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { machineFingerprint, writeLicense, verifyLicense } from "../lib/auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, "..");
const PUB_PATH = path.join(pluginRoot, "lib", "auth-public.pem");
const STATE_DIR = path.join(os.homedir(), ".dsh", "bili-timeslot");
const PRIV_PATH = path.join(STATE_DIR, "owner-private.pem");

const args = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith("--")) continue;
  const [k, v] = a.slice(2).split("=");
  args[k] = v === undefined ? true : v;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function expandNums(spec, { halfOpen = false, min = 0, max = 7 } = {}) {
  if (!spec) return [];
  const out = [];
  for (const part of String(spec).split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const end = halfOpen ? b : b + 1;
      for (let v = a; v < end; v++) if (v >= min && v <= max) out.push(v);
    } else {
      const v = Number(p);
      if (Number.isFinite(v) && v >= min && v <= max) out.push(v);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function fingerprintOf(pem) {
  try {
    const der = crypto.createPublicKey(pem).export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  } catch { return "（无法计算）"; }
}

function expFromArgs() {
  if (args.expires) {
    const s = String(args.expires);
    const iso = s.length === 10 ? s + "T23:59:59" : s;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) { console.error("--expires 格式不对，例：2026-12-31"); process.exit(1); }
    return t;
  }
  if (args["ttl-hours"]) return Date.now() + Number(args["ttl-hours"]) * 3600 * 1000;
  return Date.now() + 30 * 24 * 3600 * 1000; // 默认 30 天
}

function buildPayload(extra = {}) {
  const payload = { v: 1, iat: Date.now(), exp: expFromArgs(), nonce: crypto.randomBytes(9).toString("hex") };
  if (args.name) payload.name = String(args.name);
  const skus = args.skus ? String(args.skus).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (skus.length) payload.skus = skus;
  const accounts = args.accounts ? String(args.accounts).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (accounts.length) payload.accounts = accounts;
  const days = expandNums(args.days, { halfOpen: false, min: 1, max: 7 });
  if (days.length) payload.days = days;
  const hours = expandNums(args.hours, { halfOpen: true, min: 0, max: 23 });
  if (hours.length) payload.hours = hours;
  return Object.assign(payload, extra);
}

function sign(payload) {
  if (!fs.existsSync(PRIV_PATH)) {
    console.error("没有私钥，先执行：node authorize.mjs --init");
    process.exit(1);
  }
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = crypto.sign(null, buf, crypto.createPrivateKey(fs.readFileSync(PRIV_PATH, "utf8")));
  return `${b64url(buf)}.${b64url(sig)}`;
}

function printScope(p) {
  console.log("  过期：", new Date(p.exp).toLocaleString("zh-CN"));
  if (p.name) console.log("  授权对象：", p.name);
  if (p.fp) console.log("  绑定机器：", p.fp);
  console.log("  SKU：", (p.skus || ["（不限）"]).join(" / "));
  if (p.accounts) console.log("  账户：", p.accounts.join(","));
  if (p.days) console.log("  星期：", p.days.join(","));
  if (p.hours) console.log("  小时：", p.hours.join(","));
}

function cmdInit() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(PRIV_PATH) && !args.force) {
    console.log("私钥已存在：", PRIV_PATH);
    console.log("重新生成会让所有已发许可证/授权码失效，确实要换加 --force");
    return;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(PRIV_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(PUB_PATH), { recursive: true });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(PUB_PATH, pubPem, "utf8");
  console.log("已生成密钥对");
  console.log("  私钥（只在管理员机器）：", PRIV_PATH);
  console.log("  公钥（写进插件随包分发）：", PUB_PATH);
  console.log("  公钥指纹：", fingerprintOf(pubPem));
  console.log("");
  console.log("本机指纹：", machineFingerprint());
}

function cmdIssue(target) {
  const fp = args.fp ? String(args.fp) : null;
  if (!fp && target !== "self") {
    console.error("需要 --fp=<对方机器指纹>（让对方运行 node authorize.mjs --fingerprint 拿给你），或用 --self");
    process.exit(1);
  }
  const useFp = target === "self" ? machineFingerprint() : fp;
  const payload = buildPayload({ fp: String(useFp).toUpperCase() });
  const token = sign(payload);
  console.log("许可证（发给对方粘贴，或本机已自动安装）：");
  console.log(token);
  console.log("");
  printScope(payload);
  if (target === "self") {
    verifyAndInstall(token);
  }
}

function verifyAndInstall(token) {
  writeLicense(token);
  const r = verifyLicense();
  if (r.ok) console.log("\n✅ 已安装到本机并校验通过：", path.join(STATE_DIR, "license.json"));
  else console.log("\n⚠️ 已写入但校验未通过：", r.reason);
}

function cmdSelf() { cmdIssue("self"); }

function cmdInstall() {
  const token = args.install || args.license;
  if (!token) { console.error("用法：node authorize.mjs --install=<许可证内容>"); process.exit(1); }
  verifyAndInstall(String(token));
}

function cmdMoneyCode() {
  const payload = buildPayload({});
  const token = sign(payload);
  console.log("一次性授权码（用后作废）：");
  console.log(token);
  console.log("");
  printScope(payload);
}

if (args.init) cmdInit();
else if (args.fingerprint) console.log(machineFingerprint());
else if (args.self) cmdSelf();
else if (args.install) cmdInstall();
else if (args.code) cmdMoneyCode();
else if (args.issue) cmdIssue("other");
else {
  console.log("用法：");
  console.log("  node authorize.mjs --init");
  console.log("  node authorize.mjs --fingerprint");
  console.log("  node authorize.mjs --self --name=\"我的机器\" --expires=2026-12-31");
  console.log("  node authorize.mjs --issue --fp=<对方指纹> --name=\"启职-小王\" --skus=AI绘画 --expires=2026-12-31");
  console.log("  node authorize.mjs --install=<许可证内容>");
  console.log("  node authorize.mjs --code --name=\"临时\" --ttl-hours=2");
}
