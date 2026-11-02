/**
 * 把插件自带的 SKILL.md 同步成 DSH 技能（~/.dsh/skills/bili-timeslot/SKILL.md）
 *
 * 目的：让装了插件的推广人，其 AI 助手也能读到这套 SOP（而不只是有 /timeslot 命令）。
 * 策略：内容有变化才覆盖，避免每次启动都写盘；写入用 UTF-8 无 BOM（BOM 会让 JSON/YAML 解析失败）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_NAME = "bili-timeslot";

export function skillTargetDir() {
  return path.join(os.homedir(), ".dsh", "skills", SKILL_NAME);
}

/** 返回 { ok, action: 'unchanged'|'installed'|'updated'|'error', path?, reason? } */
export function syncSkill(pluginRoot) {
  const src = path.join(pluginRoot, "SKILL.md");
  const dir = skillTargetDir();
  const dest = path.join(dir, "SKILL.md");

  try {
    if (!fs.existsSync(src)) return { ok: false, action: "error", reason: "插件目录里没有 SKILL.md" };
    const content = fs.readFileSync(src, "utf8");

    let existing = null;
    try { existing = fs.readFileSync(dest, "utf8"); } catch { existing = null; }

    if (existing === content) return { ok: true, action: "unchanged", path: dest };

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, content, "utf8");
    return { ok: true, action: existing === null ? "installed" : "updated", path: dest };
  } catch (e) {
    return { ok: false, action: "error", reason: String((e && e.message) || e) };
  }
}
