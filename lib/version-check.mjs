/**
 * 版本检查：查 npm 上是否有新版本（只提示，不自动安装）
 *
 * 设计原则：
 *  - 不自动更新：自动覆盖自身代码风险太高（拉错文件会导致 DSH 起不来）
 *  - 非阻塞：3 秒超时，失败静默忽略，绝不影响命令执行
 *  - 带缓存：1 小时内只查一次，避免每条命令都打网络
 */
import fs from "node:fs";
import path from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL = 60 * 60 * 1000; // 1 小时
let cache = { at: 0, latest: null, name: null };

export function readLocalVersion(pluginRoot) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
    return { name: j.name, version: j.version };
  } catch {
    return { name: null, version: null };
  }
}

/** 语义化版本比较：a > b 返回 1，相等 0，小于 -1 */
export function compareVersion(a, b) {
  const pa = String(a || "0").split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b || "0").split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 返回 { local, latest, hasUpdate }
 * 网络失败时 latest 为 null、hasUpdate 为 false，不抛异常
 */
export async function checkUpdate(pluginRoot, { timeoutMs = 3000, force = false } = {}) {
  const local = readLocalVersion(pluginRoot);
  if (!local.name || !local.version) return { local: null, latest: null, hasUpdate: false };

  if (!force && cache.name === local.name && Date.now() - cache.at < CACHE_TTL) {
    return { local: local.version, latest: cache.latest, hasUpdate: !!cache.latest && compareVersion(cache.latest, local.version) > 0 };
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${REGISTRY}/${local.name}/latest`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!r.ok) return { local: local.version, latest: null, hasUpdate: false };
    const j = await r.json();
    cache = { at: Date.now(), latest: j.version, name: local.name };
    return { local: local.version, latest: j.version, hasUpdate: compareVersion(j.version, local.version) > 0 };
  } catch {
    cache = { at: Date.now(), latest: null, name: local.name };
    return { local: local.version, latest: null, hasUpdate: false };
  }
}

/** 生成给命令输出追加的提示行；没有更新返回空串 */
export async function updateHint(pluginRoot) {
  const r = await checkUpdate(pluginRoot);
  if (!r.hasUpdate) return "";
  return `\n⬆️ 有新版本 ${r.latest}（当前 ${r.local}）：pnpm add ${readLocalVersion(pluginRoot).name}@latest`;
}
