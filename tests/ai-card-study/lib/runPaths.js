/**
 * 运行目录解析（tests/ai-card-study 各入口共享）。
 *
 * 未设置 runDir 时返回 null，各入口保持原有的“引擎目录相对路径”行为；
 * 设置后所有数据与输出重定向到指定运行目录（例如 temp/ai-card-study-runs/<run-name>/）。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

export function runDirFromEnv() {
  return process.env.FIVE_REALMS_STUDY_RUN_DIR || null;
}

export function runDirUrl(runDir) {
  if (!runDir) return null;
  const resolved = path.resolve(process.cwd(), runDir);
  const href = pathToFileURL(resolved).href;
  return new URL(href.endsWith("/") ? href : href + "/");
}
