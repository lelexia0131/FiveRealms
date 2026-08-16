import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADER_FIELDS = Object.freeze([
  "功能",
  "调用方",
  "输入",
  "输出",
  "读取状态",
  "写入状态",
  "调用函数",
  "边界与不变量",
]);
const MODULE_FIELDS = Object.freeze([
  "模块职责",
  "上游",
  "下游",
  "状态边界",
  "信息边界",
  "架构约束",
]);
const SOURCE_PATTERN = /^js\/.*\.(?:js|mjs|cjs)$/i;
const AI_PATTERN = /^js\/ai\/.*\.(?:js|mjs|cjs)$/i;
const LAYERED_AI_PATTERN = /^js\/ai\/(?:state|search|simulation|value|policy|domain)\//i;
const STATE_AI_PATTERN = /^js\/ai\/state\//i;
const VALUE_AI_PATTERN = /^js\/ai\/value\//i;
const POLICY_AI_PATTERN = /^js\/ai\/policy\//i;
const DOMAIN_AI_PATTERN = /^js\/ai\/domain\//i;
const FUTURE_DOMAIN_PATTERN = /^js\/domain\//i;
const FUTURE_APPLICATION_PATTERN = /^js\/application\//i;
const APPLICATION_PORTS_PATTERN = /^js\/application\/ports\//i;
const APPLICATION_CHOICE_PATTERN = /^js\/application\/choice\//i;
const APPLICATION_RESPONSE_PATTERN = /^js\/application\/response\//i;
const APPLICATION_COMBAT_PATTERN = /^js\/application\/combat\//i;
const APPLICATION_JUDGMENT_PATTERN = /^js\/application\/judgment\//i;
const APPLICATION_MATCH_PATTERN = /^js\/application\/match\//i;
const APPLICATION_TURN_PATTERN = /^js\/application\/turn\//i;
const APPLICATION_ACTION_PATTERN = /^js\/application\/action\//i;
const APPLICATION_TRIGGER_PATTERN = /^js\/application\/trigger\//i;
const APPLICATION_MESSAGING_PATTERN = /^js\/application\/messaging\//i;
const DOMAIN_EVENTS_PATTERN = /^js\/domain\/events\//i;
const LEGACY_WORKFLOW_FACADE_PATTERN = /^js\/core\/(?:DyingSystem|JudgmentSystem|HpLossSystem)\.js$/i;
const FUTURE_ADAPTERS_PATTERN = /^js\/adapters\//i;
const DOMAIN_TRANSITIONS_PATTERN = /^js\/domain\/state\/transitions\//i;
const DOMAIN_RULES_PATTERN = /^js\/domain\/rules\//i;
const LEGACY_UTILS_PATTERN = /^js\/utils(?:\/|$)/i;
const FORBIDDEN_ROOT_BUCKET_PATTERN = /^js\/(?:common|helpers|misc|shared|legacy|compat)(?:\/|$)/i;
const FUTURE_LAYER_BUCKET_PATTERN = /^js\/(?:domain|application|adapters)\/(?:.*\/)?(?:utils|common|helpers|misc|shared|legacy|compat)(?:\/|$)/i;
const TRANSITION_VALUE_PATTERN = /^js\/ai\/search\/TransitionValue\.js$/i;
const SEARCH_PLANNER_PATTERN = /^js\/ai\/search\/Planner\.js$/i;
const SEARCH_PRIOR_PATTERN = /^js\/ai\/search\/SearchPrior\.js$/i;
const SEARCH_AI_PATTERN = /^js\/ai\/search\//i;
const SIMULATION_AI_PATTERN = /^js\/ai\/simulation\//i;
const AI_LEGACY_RULE_GUARD_PATTERN = /^(?:js\/ai\/(?:search|simulation|domain)\/)/i;
const CARD_EFFECT_RULES_FILE = "js/domain/rules/card/CardEffectRules.js";
const SKILL_RULES_FILE = "js/domain/rules/skill/SkillRules.js";
const TRANSFER_EXECUTION_ADAPTER_FILE = "js/adapters/ai/TransferExecutionPolicyAdapter.js";
const WORKER_PATTERN = /^js\/adapters\/ai\/worker\//i;
const CARD_EFFECT_SIMULATION_FILE = "js/ai/simulation/CardEffectSimulation.js";
const COMBAT_SIMULATION_FILE = "js/ai/simulation/CombatSimulation.js";
const SKILL_EFFECT_SIMULATION_FILE = "js/ai/simulation/SkillEffectSimulation.js";
const STATUS_SIMULATION_FILE = "js/ai/simulation/StatusSimulation.js";
const AI_ROOT_PATTERN = /^js\/ai\/[^/]+\.js$/i;
const AI_ROOT_ALLOWLIST = new Set(["js/ai/AiController.js"]);
const ACCIDENTAL_ROOT_ARTIFACTS = Object.freeze(new Set(["AI", "application", "transitions"]));
const REMOVED_COMPATIBILITY_NAMES = Object.freeze([
  "AiSimulator",
  "AiEvaluator",
  "AiStateValue",
  "AiVisibleState",
  "AiKnowledge",
  "AiProbabilityBranches",
  "AiEconomics",
  "ThreatCalculator",
  "roleCardValue",
  "discardScoring",
  "resourceSelectionValue",
  "transferScoring",
  "sealScoring",
  "lightningScoring",
  "AiGlobalBenefit",
  "AiPlanner",
  "AiActionGenerator",
  "AiCardSelector",
  "AiResponsePolicy",
  "AiValueSimulationQuery",
]);

/*
功能
执行只读 Git 命令并返回标准输出。

调用方
changedProductionFiles、changedLines。

输入
Git 参数数组。

输出
成功时返回 UTF-8 文本，命令失败时返回空字符串。

读取状态
当前仓库 Git 索引与工作区。

写入状态
无。

调用函数
execFileSync。

边界与不变量
只允许调用本文件写死的只读 Git 子命令。
*/
function gitOutput(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  } catch {
    return "";
  }
}

/*
功能
把平台路径统一为仓库内使用的正斜杠路径。

调用方
文件发现、错误报告和架构检查。

输入
任意路径字符串。

输出
使用正斜杠的路径字符串。

读取状态
无。

写入状态
无。

调用函数
String.replaceAll。

边界与不变量
不解析或访问路径，只做分隔符归一化。
*/
function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

/*
功能
判断仓库根目录是否重新出现已知 accidental root artifact 文件。

调用方
main 与 runSelfTest。

输入
待检查的根目录相对文件路径列表。

输出
返回命中的路径数组。

读取状态
无；不访问文件系统。

写入状态
无。

调用函数
Set.has。

边界与不变量
只精确匹配已知三个残片名称，不建立宽泛 root allowlist。
*/
function accidentalRootArtifacts(files) {
  return files.filter((file) => ACCIDENTAL_ROOT_ARTIFACTS.has(file));
}

/*
功能
列出相对 HEAD 已修改或未跟踪的生产 JavaScript 文件。

调用方
main。

输入
无。

输出
排序、去重后的仓库相对路径数组。

读取状态
Git HEAD、索引、工作区与 ignore 规则。

写入状态
无。

调用函数
gitOutput。

边界与不变量
只检查 js 目录；删除文件不会进入结果。
*/
function changedProductionFiles() {
  const tracked = gitOutput(["diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--", "js"]);
  const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "--", "js"]);
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean).map(normalizePath))]
    .filter((name) => SOURCE_PATTERN.test(name) && fs.existsSync(path.join(ROOT, name)))
    .sort();
}

/*
功能
列出 js 目录下全部生产 JavaScript 文件，用于历史欠债盘点。

调用方
main 的 --all 模式。

输入
起始目录，默认仓库 js 目录。

输出
排序后的仓库相对路径数组。

读取状态
工作区 js 目录树。

写入状态
无。

调用函数
fs.readdirSync、allProductionFiles。

边界与不变量
不跟随目录符号链接，不读取 js 目录之外的文件。
*/
function allProductionFiles(directory = path.join(ROOT, "js")) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...allProductionFiles(absolute));
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/i.test(entry.name)) {
      files.push(normalizePath(path.relative(ROOT, absolute)));
    }
  }
  return files.sort();
}

/*
功能
判断文件是否已由 Git 跟踪。

调用方
changedLines。

输入
仓库相对路径。

输出
已跟踪返回 true，否则返回 false。

读取状态
Git 索引。

写入状态
无。

调用函数
execFileSync。

边界与不变量
失败只表示未跟踪，不改变索引。
*/
function isTracked(file) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/*
功能
提取文件相对 HEAD 的新增或修改行号。

调用方
inspectFile。

输入
仓库相对路径与当前行数。

输出
一基行号 Set；未跟踪文件包含全部行。

读取状态
Git HEAD 与工作区文件。

写入状态
无。

调用函数
isTracked、gitOutput。

边界与不变量
删除行没有新行号；零长度 hunk 不制造伪变更。
*/
function changedLines(file, lineCount) {
  if (!isTracked(file)) return new Set(Array.from({ length: lineCount }, (_, index) => index + 1));
  const diff = gitOutput(["diff", "--unified=0", "--no-ext-diff", "HEAD", "--", file]);
  const lines = new Set();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
  }
  return lines;
}

/*
功能
把字符串和注释替换为空格，同时保留换行与代码花括号位置。

调用方
functionRange。

输入
JavaScript 源码。

输出
与输入等长的轻量词法遮罩文本。

读取状态
无。

写入状态
局部扫描状态。

调用函数
无。

边界与不变量
这是范围定位器而非完整 parser；模板字符串整体视为字符串。
*/
function maskNonCode(source) {
  const chars = [...source];
  let mode = "code";
  let quote = null;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (mode === "line-comment") {
      if (current === "\n") mode = "code";
      else chars[index] = " ";
      continue;
    }
    if (mode === "block-comment") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        mode = "code";
      } else if (current !== "\n") chars[index] = " ";
      continue;
    }
    if (mode === "string") {
      if (current === "\\") {
        chars[index] = " ";
        if (chars[index + 1] !== "\n") chars[index + 1] = " ";
        index += 1;
      } else if (current === quote) {
        chars[index] = " ";
        mode = "code";
      } else if (current !== "\n") chars[index] = " ";
      continue;
    }
    if (current === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      mode = "line-comment";
    } else if (current === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      mode = "block-comment";
    } else if (current === "\"" || current === "'" || current === "`") {
      quote = current;
      chars[index] = " ";
      mode = "string";
    }
  }
  return chars.join("");
}

/*
功能
把注释替换为空格但保留字符串内容，供真实 import 语法守卫使用。

调用方
inspectSource。

输入
JavaScript 源码。

输出
与输入等长、保留换行和字符串的注释遮罩文本。

读取状态
无。

写入状态
局部词法扫描状态。

调用函数
无。

边界与不变量
字符串中的 import/Simulator 文本不会被当成语法，注释中的伪 import 也不会触发规则。
*/
function maskComments(source) {
  const chars = [...source];
  let mode = "code";
  let quote = null;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (mode === "line-comment") {
      if (current === "\n") mode = "code";
      else chars[index] = " ";
      continue;
    }
    if (mode === "block-comment") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        mode = "code";
      } else if (current !== "\n") chars[index] = " ";
      continue;
    }
    if (mode === "string") {
      if (current === "\\") index += 1;
      else if (current === quote) mode = "code";
      continue;
    }
    if (current === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      mode = "line-comment";
    } else if (current === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      mode = "block-comment";
    } else if (current === "\"" || current === "'" || current === "`") {
      quote = current;
      mode = "string";
    }
  }
  return chars.join("");
}

/*
功能
识别一行中可维护函数声明的名称与签名位置。

调用方
findFunctions。

输入
单行源码。

输出
识别成功时返回名称与列偏移，否则返回 null。

读取状态
无。

写入状态
无。

调用函数
RegExp.match。

边界与不变量
排除控制流；单行匿名 lambda 豁免，具名箭头函数不豁免。
*/
function functionSignature(line) {
  const declaration = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (declaration) return { name: declaration[1], column: declaration.index ?? 0, kind: "declaration" };
  const arrow = line.match(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
  if (arrow) return { name: arrow[1], column: arrow.index ?? 0, kind: "arrow" };
  const method = line.match(/^\s*(?:static\s+)?(?:async\s+)?(?:(?:get|set)\s+)?([A-Za-z_$][\w$]*)\s*\(/);
  if (method && !/^(?:if|for|while|switch|catch|with)$/.test(method[1])) {
    return { name: method[1], column: method.index ?? 0, kind: "method" };
  }
  return null;
}

/*
功能
计算函数从签名行到匹配闭括号的近似范围。

调用方
findFunctions。

输入
源码行、遮罩行、函数起始行。

输出
包含 startLine 和 endLine 的一基范围。

读取状态
无。

写入状态
局部花括号深度。

调用函数
无。

边界与不变量
无块体的具名箭头函数范围仅为签名行。
*/
function functionRange(lines, maskedLines, startIndex, kind) {
  const tail = maskedLines.slice(startIndex).join("\n");
  let bodyStart = -1;
  if (kind === "arrow") {
    const arrowIndex = tail.indexOf("=>");
    if (arrowIndex < 0) return null;
    let cursor = arrowIndex + 2;
    while (/\s/.test(tail[cursor] ?? "")) cursor += 1;
    if (tail[cursor] !== "{") return { startLine: startIndex + 1, endLine: startIndex + 1 };
    bodyStart = cursor;
  } else {
    const parametersStart = tail.indexOf("(");
    if (parametersStart < 0) return null;
    let parameterDepth = 0;
    let parametersEnd = -1;
    for (let cursor = parametersStart; cursor < tail.length; cursor += 1) {
      if (tail[cursor] === "(") parameterDepth += 1;
      else if (tail[cursor] === ")") {
        parameterDepth -= 1;
        if (parameterDepth === 0) {
          parametersEnd = cursor;
          break;
        }
      }
    }
    if (parametersEnd < 0) return null;
    let cursor = parametersEnd + 1;
    while (/\s/.test(tail[cursor] ?? "")) cursor += 1;
    if (tail[cursor] !== "{") return null;
    bodyStart = cursor;
  }

  let bodyDepth = 0;
  for (let cursor = bodyStart; cursor < tail.length; cursor += 1) {
    if (tail[cursor] === "{") bodyDepth += 1;
    else if (tail[cursor] === "}") {
      bodyDepth -= 1;
      if (bodyDepth === 0) {
        const endOffset = tail.slice(0, cursor).split("\n").length - 1;
        return { startLine: startIndex + 1, endLine: startIndex + endOffset + 1 };
      }
    }
  }
  return null;
}

/*
功能
找出文件中的函数名称和近似源代码范围。

调用方
inspectSource。

输入
JavaScript 源码。

输出
函数记录数组。

读取状态
无。

写入状态
无。

调用函数
maskNonCode、functionSignature、functionRange。

边界与不变量
同一签名行只产生一个记录；不把一行匿名回调当独立函数。
*/
function findFunctions(source) {
  const lines = source.split(/\r?\n/);
  const maskedLines = maskNonCode(source).split(/\r?\n/);
  const functions = [];
  lines.forEach((line, index) => {
    const signature = functionSignature(line);
    if (!signature) return;
    const range = functionRange(lines, maskedLines, index, signature.kind);
    if (range) functions.push({ ...signature, ...range });
  });
  return functions;
}

/*
功能
读取函数正上方与文件开头的相邻块注释。

调用方
missingHeaderFields、missingModuleFields。

输入
源码行、向前搜索的独占结束索引；文件头校验可省略结束索引。

输出
包含起止行的块注释行数组；不存在完整相邻块时返回 null。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
函数头允许与签名之间有空行，但不得越过代码；模块头必须是文件第一个非空内容。
*/
function adjacentHeaderBlock(lines, exclusiveEnd = null) {
  if (exclusiveEnd === null) {
    let start = 0;
    while (start < lines.length && !lines[start].trim()) start += 1;
    if (lines[start]?.trim() !== "/*" && !lines[start]?.trim().startsWith("/**")) return null;
    let end = start;
    while (end < lines.length && lines[end].trim() !== "*/") end += 1;
    return end < lines.length ? lines.slice(start, end + 1) : null;
  }
  let end = exclusiveEnd - 1;
  while (end >= 0 && !lines[end].trim()) end -= 1;
  if (end < 0 || lines[end].trim() !== "*/") return null;
  let start = end;
  while (start >= 0 && lines[start].trim() !== "/*" && !lines[start].trim().startsWith("/**")) start -= 1;
  return start >= 0 ? lines.slice(start, end + 1) : null;
}

/*
功能
校验普通块头是否严格采用无星号、标题独占行和固定顺序格式。

调用方
missingHeaderFields、missingModuleFields。

输入
完整块注释行与期望字段标题数组。

输出
缺失字段和格式问题数组。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
每个字段必须恰好出现一次且正文非空；缩进合法，但星号、JSDoc、冒号标题均非法。
*/
function headerFormatIssues(block, fields) {
  if (!block) return [...fields];
  const issues = [];
  if (block[0].trim() !== "/*") issues.push("普通块注释（禁止 JSDoc）");
  const body = block.slice(1, -1);
  if (body.some((line) => /^\s*\*/.test(line))) issues.push("无星号前缀格式（禁止旧式 *）");
  const positions = fields.map((field) => body.reduce((found, line, index) => (
    line.trim() === field ? [...found, index] : found
  ), []));
  fields.forEach((field, index) => {
    if (positions[index].length !== 1) issues.push(field);
  });
  const ordered = positions.every((matches, index) => (
    matches.length === 1 && (index === 0 || positions[index - 1].length !== 1 || positions[index - 1][0] < matches[0])
  ));
  if (!ordered && positions.every((matches) => matches.length === 1)) issues.push("字段顺序");
  positions.forEach((matches, index) => {
    if (matches.length !== 1) return;
    const next = index + 1 < positions.length && positions[index + 1].length === 1
      ? positions[index + 1][0]
      : body.length;
    if (!body.slice(matches[0] + 1, next).some((line) => line.trim())) {
      issues.push(`${fields[index]}正文`);
    }
  });
  return [...new Set(issues)];
}

/*
功能
读取函数正上方的普通块注释并校验 Function Header v1。

调用方
inspectSource。

输入
源码行与函数起始行。

输出
缺失字段和严格格式问题数组。

读取状态
无。

写入状态
无。

调用函数
adjacentHeaderBlock、headerFormatIssues。

边界与不变量
允许函数头与签名之间有空行，不越过其他代码寻找注释。
*/
function missingHeaderFields(lines, startLine) {
  return headerFormatIssues(adjacentHeaderBlock(lines, startLine - 1), HEADER_FIELDS);
}

/*
功能
校验目标分层模块的 Module Header v1。

调用方
inspectSource。

输入
完整源码。

输出
缺失字段和严格格式问题数组。

读取状态
无。

写入状态
无。

调用函数
adjacentHeaderBlock、headerFormatIssues。

边界与不变量
模块头必须是文件第一个非空内容，且不允许用后续函数头补齐字段。
*/
function missingModuleFields(source) {
  const lines = source.split(/\r?\n/);
  return headerFormatIssues(adjacentHeaderBlock(lines), MODULE_FIELDS);
}

/*
功能
判断函数范围是否与本次变更行相交。

调用方
inspectSource。

输入
函数记录、变更行 Set 与源码行。

输出
相交返回 true。

读取状态
无。

写入状态
无。

调用函数
Set.has。

边界与不变量
--all 使用 null 表示所有函数都需检查。
*/
function functionWasChanged(fn, changed, lines) {
  if (changed === null) return true;
  for (let line = fn.startLine; line <= fn.endLine; line += 1) {
    if (changed.has(line)) return true;
  }
  let headerEnd = fn.startLine - 2;
  while (headerEnd >= 0 && !lines[headerEnd].trim()) headerEnd -= 1;
  if (lines[headerEnd]?.trim() !== "*/") return false;
  let headerStart = headerEnd;
  while (headerStart >= 0 && lines[headerStart].trim() !== "/*" && !lines[headerStart].trim().startsWith("/**")) {
    headerStart -= 1;
  }
  for (let line = headerStart + 1; line <= headerEnd + 1; line += 1) {
    if (changed.has(line)) return true;
  }
  return false;
}

/*
功能
返回源码中某绝对偏移对应的首行号。

调用方
targetArchitectureErrors。

输入
源码与零基字符偏移。

输出
一基行号。

读取状态
无。

写入状态
无。

调用函数
String.slice、String.split。

边界与不变量
偏移按掩码后与源等长文本传入，不得截断换行。
*/
function sourceLineAt(source, offset) {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

/*
功能
执行 FR-ARCH 冻结三层架构的 migration-aware import 与语法 guard。

调用方
inspectSource。

输入
仓库路径、注释掩码源码、非代码掩码源码与原始源码。

输出
结构化错误数组。

读取状态
无。

写入状态
无。

调用函数
sourceLineAt、RegExp.match。

边界与不变量
只对未来 domain/application/adapters 目录启用；当前 js/utils 作为历史 baseline 不判失败；未来新兜底目录立即拒绝。
*/
function targetArchitectureErrors(file, importSource, maskedSource, source) {
  const errors = [];
  const pushImportError = (match, message) => {
    if (!match) return;
    errors.push({
      file,
      functionName: "<architecture>",
      line: sourceLineAt(source, match.index),
      missing: [message]
    });
  };
  const pushPatternError = (match, message) => {
    if (!match) return;
    errors.push({
      file,
      functionName: "<architecture>",
      line: sourceLineAt(source, match.index),
      missing: [message]
    });
  };

  if (FUTURE_DOMAIN_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:\/application\/|\/adapters\/|\/ui\/|\/audio\/|\/ai\/|\/core\/Game\.js|UIManager\.js|SoundManager\.js)[^"']*(?:\?[^"']*)?["']/i),
      "架构约束：domain 禁止依赖 application/adapters/ui/audio/ai/Game/UIManager/SoundManager"
    );
    pushPatternError(
      maskedSource.match(/\bthis\.game\b/),
      "架构约束：domain 禁止 Game 实例回指"
    );
    pushPatternError(
      maskedSource.match(/Array\.isArray\(\s*(?:player\.)?statuses\s*\)/),
      "架构约束：domain 禁止 Real Player/SearchState statuses 双 schema 兼容分支"
    );
  }

  if (FUTURE_APPLICATION_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:\/adapters\/|\/ui\/|\/audio\/|\/ai\/|UIManager\.js|SoundManager\.js|AiController\.js|AIController\.js)[^"']*(?:\?[^"']*)?["']/i),
      "架构约束：application 禁止 concrete UI/Audio/AI adapter import，外部能力必须走 Port"
    );
  }

  if (APPLICATION_PORTS_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/Game\.js|core\/ResponseSystem\.js|state\/transitions\/|\/ui\/|\/ai\/|UIManager\.js|AiController\.js)[^"']*(?:\?[^"']*)?["']/i),
      "架构约束：application/ports 禁止 Game runtime、UI/AI implementation 与 Domain transition import"
    );
    pushPatternError(
      maskedSource.match(/\bstate\.stateVersion\s*(?:\+\+|\+=|=)|\bbumpStateVersion\s*\(/),
      "架构约束：application/ports 禁止 Domain mutation"
    );
  }

  if (APPLICATION_RESPONSE_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/|\/ui\/|\/ai\/|UIManager\.js|AiController\.js|SoundManager\.js|state\/transitions\/)[^"']*(?:\?[^"']*)?["']/i),
      "架构约束：application/response 禁止 Game/UI/AI/Audio runtime 与 Domain transition import"
    );
    pushPatternError(
      maskedSource.match(/\bthis\.game\b|\bEventBus\b|\beventBus\b|\bdocument\b|\bwindow\b|\b[Ss]earchState\b|\bVisibleState\b|\bBeliefState\b/),
      "架构约束：application/response 禁止 Game 回指、EventBus、DOM 与 AI SearchState"
    );
  }

  if (APPLICATION_COMBAT_PATTERN.test(file) || APPLICATION_JUDGMENT_PATTERN.test(file)) {
    const layerName = APPLICATION_COMBAT_PATTERN.test(file) ? "combat" : "judgment";
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/|\/adapters\/|\/ui\/|\/audio\/|\/ai\/|UIManager\.js|AiController\.js|AIController\.js|SoundManager\.js|cards\/cardRegistry|generals\/skillRegistry|config\/)[^"']*(?:\?[^"']*)?["']/i),
      `架构约束：application/${layerName} 禁止 Game/core runtime、concrete UI/Audio/AI adapter 与 legacy card/skill/config 依赖`
    );
    pushPatternError(
      maskedSource.match(/\b(?:player|target|source|holder|responder|defender|rescuer)\.(?:statistics|aiMemory|recentAggressors)\b|\b(?:target|player|source|holder)\.(?:hp|shield|alive|statuses|phase)\s*(?:\+\+|--|\+=|-=|=)/),
      `架构约束：application/${layerName} 禁止直接写 statistics/aiMemory 或 Domain primitive 字段，全部经 Port/Transition`
    );
    pushPatternError(
      maskedSource.match(/\bEventBus\b|\beventBus\b|\bdocument\b|\bwindow\b|\b[Ss]earchState\b|\bVisibleState\b|\bBeliefState\b/),
      `架构约束：application/${layerName} 禁止 Game 回指、EventBus、DOM 与 AI SearchState`
    );
  }

  if (LEGACY_WORKFLOW_FACADE_PATTERN.test(file)) {
    const facadeName = file.split("/").pop().replace(/\.js$/i, "");
    pushPatternError(
      maskedSource.match(/\b(?:queue\.push\(\s*\{\s*target|setHp\(|setAlive\(|clearStatuses\(|changeHp\(|isDying\()|\basync\s+(?:enter|resolve|kill|lose|judgeDefense|judgeDelayedStatus|resolveSeal|resolveLightning)\s*\(/),
      `架构约束：${facadeName} legacy façade 不得继续包含 workflow body；请转发 Application workflow`
    );
  }

  if (APPLICATION_MATCH_PATTERN.test(file) || APPLICATION_TURN_PATTERN.test(file) || APPLICATION_ACTION_PATTERN.test(file) || APPLICATION_TRIGGER_PATTERN.test(file)) {
    const layerName = APPLICATION_MATCH_PATTERN.test(file)
      ? "match"
      : APPLICATION_TURN_PATTERN.test(file)
        ? "turn"
        : APPLICATION_ACTION_PATTERN.test(file)
          ? "action"
          : "trigger";
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/|\/adapters\/|\/ui\/|\/audio\/|\/ai\/|UIManager\.js|AiController\.js|AIController\.js|SoundManager\.js|cards\/cardRegistry|generals\/skillRegistry|config\/|utils\/debug)[^"']*(?:\?[^"']*)?["']/i),
      `架构约束：application/${layerName} 禁止 Game/core runtime、concrete UI/AI/Debug、legacy card/skill/config 依赖`
    );
    pushPatternError(
      maskedSource.match(/\b(?:player|target|source|holder|responder|defender|rescuer)\.(?:statistics|aiMemory|recentAggressors)\b|\b(?:target|player|source|holder)\.(?:hp|shield|alive|statuses|phase)\s*(?:\+\+|--|\+=|-=|=)/),
      `架构约束：application/${layerName} 禁止直接写 statistics/aiMemory 或 Domain primitive 字段`
    );
    pushPatternError(
      maskedSource.match(/\bEventBus\b|\beventBus\b|\bdocument\b|\bwindow\b|\b[Ss]earchState\b|\bVisibleState\b|\bBeliefState\b|\bPlanner\b/),
      `架构约束：application/${layerName} 禁止 Game 回指、EventBus、DOM 与 AI SearchState/Planner`
    );
  }

  if (DOMAIN_EVENTS_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/EventBus|\/application\/|\/adapters\/|\/ai\/|\/ui\/|Game\.js|UIManager\.js)[^"']*(?:\?[^"']*)?["']/i),
      "架构约束：domain/events 禁止依赖 EventBus/application/adapters/Game"
    );
    pushPatternError(
      maskedSource.match(/\bawait\b|\bemit\b|\bsubscribe\b|\blisteners\b|\bnew Map\b/),
      "架构约束：domain/events 只允许 frozen data-only fact builder"
    );
  }

  if (APPLICATION_MESSAGING_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/Game|\/ui\/|\/ai\/|UIManager\.js|AIController\.js|SoundManager\.js|utils\/debug)[^"']*(?:\?[^"']*)?["']/i),
      "架构约束：application/messaging 禁止 Game/UI/AI/Debug 依赖"
    );
    pushPatternError(
      maskedSource.match(/\bstate\.stateVersion\s*(?:\+\+|\+=)|\bbumpStateVersion\s*\(/),
      "架构约束：application/messaging 禁止 Domain mutation"
    );
  }

  if (/^js\/core\/EventBus\.js$/i.test(file)) {
    pushPatternError(
      source.match(/listeners\s*=\s*new Map|this\.depth\s*=|maxDepth\s*=|this\.generation\s*=/),
      "架构约束：core/EventBus 必须是 thin façade，不得重新拥有 listener registry"
    );
  }

  if (/^js\/application\/action\/ActionWorkflow\.js$/i.test(file)) {
    pushPatternError(
      source.match(/\b(?:transfer|leverage|scout|plunder|destroy|mutualBenefit)\b/),
      "架构约束：generic ActionWorkflow 禁止 specific card definitionId semantic branch"
    );
    pushPatternError(
      maskedSource.match(/state:\s*actionRuntime|resolutionOwners:\s*actionRuntime\.resolutionOwners/),
      "架构约束：ActionWorkflow 禁止暴露 mutable internal runtime state"
    );
  }

  if (/^js\/core\/Game\.js$/i.test(file)) {
    pushPatternError(
      maskedSource.match(/\bconsecutiveTurnFailures\b|setMatchPhase\(\s*this\.state|const\s+preparedTransfer\s*=|const\s+energyCost\s*=\s*getActiveSkillCost|const\s+dawnAlive\s*=|this\.state\.players\s*=\s*teams\.map/),
      "架构约束：Game workflow regression guard — Match/Turn/Action/Combat implementation 不得重新长回 core/Game.js"
    );
  }

  if (APPLICATION_CHOICE_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/|\/ui\/|\/ai\/|UIManager\.js|AiController\.js|SoundManager\.js|state\/transitions\/)[^"']*(?:\?[^"']*)?["']/i),
      "架构约束：application/choice 禁止 Game/UI/AI/Audio runtime 与 Domain transition import"
    );
    pushPatternError(
      maskedSource.match(/\bthis\.game\b|\bEventBus\b|\beventBus\b/),
      "架构约束：application/choice 禁止 Game 回指与 EventBus runtime"
    );
    pushPatternError(
      maskedSource.match(/\bdocument\b|\bwindow\b/),
      "架构约束：application/choice 禁止 DOM 依赖"
    );
    pushPatternError(
      maskedSource.match(/\b(?:player|card)\.[A-Za-z_$][A-Za-z0-9_$]*/),
      "架构约束：application/choice 禁止直接读取 Player/Card entity 字段"
    );
  }

  if (FUTURE_ADAPTERS_PATTERN.test(file)) {
    const currentAdapter = file.split("/")[2] ?? null;
    const importPattern = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/gi;
    for (const match of importSource.matchAll(importPattern)) {
      const specifier = match[1].split("?")[0];
      const crossImport = specifier.match(/(?:^|\/)\.\.\/(ai|ui|audio|diagnostics)\//i);
      if (crossImport && currentAdapter && crossImport[1].toLowerCase() !== currentAdapter.toLowerCase()) {
        pushImportError(match, "架构约束：adapters 禁止跨 concrete adapter 直接耦合");
        break;
      }
    }
    if (/^js\/adapters\/(?:ui|ai)\//i.test(file)) {
      pushImportError(
        importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/Game\.js|core\/ResponseSystem\.js|UiChoiceAdapter\.js|AiChoiceAdapter\.js|UIManager\.js|AiController\.js)[^"']*(?:\?[^"']*)?["']/i),
        "架构约束：choice adapter 禁止 concrete Game/ResponseSystem/peer adapter 依赖"
      );
    }
  }

  if (DOMAIN_TRANSITIONS_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:cards\/cardRegistry\.js|generals\/skillRegistry\.js|core\/(?:ResponseSystem|DyingSystem|JudgmentSystem)\.js)(?:\?[^"']*)?["']/i),
      "架构约束：state/transitions 禁止依赖 cardRegistry/skillRegistry/ResponseSystem/DyingSystem/JudgmentSystem"
    );
    pushPatternError(
      maskedSource.match(/\b(?:definitionId|cardId|skillId)\s*===/),
      "架构约束：state/transitions 禁止 cardId/skillId-specific 规则分支"
    );
  }

  if (DOMAIN_RULES_PATTERN.test(file)) {
    pushImportError(
      importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:cards\/cardRegistry\.js|generals\/skillRegistry\.js|core\/(?:Game|RuleEngine|ResponseSystem|DyingSystem|JudgmentSystem)\.js|state\/transitions\/[^"']*|config\/[^"']*)(?:\?[^"']*)?["']/i),
      "架构约束：domain/rules 禁止依赖 Game/RuleEngine/ResponseSystem/DyingSystem/JudgmentSystem/cardRegistry/skillRegistry/state transitions/config runtime"
    );
    pushPatternError(
      maskedSource.match(/\bawait\b/),
      "架构约束：domain/rules 必须是纯规则，禁止 await"
    );
    pushPatternError(
      maskedSource.match(/\bEventBus\b|\beventBus\b/),
      "架构约束：domain/rules 禁止 EventBus"
    );
    pushPatternError(
      maskedSource.match(/\bMath\.random\s*\(|\.random\s*\(/),
      "架构约束：domain/rules 禁止随机采样"
    );
    pushPatternError(
      maskedSource.match(/\bhand\s*\?\?\s*handCount|\bequipment\s*\?\?\s*equipmentDefinitionId|\bArray\.isArray\([^)]*statuses\)/),
      "架构约束：domain/rules 禁止 Real Player/SearchState 双 schema 兼容分支"
    );
    pushPatternError(
      maskedSource.match(/\b(?:controllerType|aiMemory|aiProfile|portrait|roleTags|equipmentRetentionProbability|SearchState|VisibleState|BeliefState)\b/),
      "架构约束：domain/rules 禁止 AI/UI/legacy metadata 泄漏"
    );
  }

  const isTransitionImplementation = /^js\/domain\/state\/transitions\//i.test(file);
  if (!isTransitionImplementation) {
    pushPatternError(
      maskedSource.match(/\bstate\.stateVersion\s*\+\+|\bstate\.stateVersion\s*\+=/),
      "架构约束：只有 Domain transition implementation 可以直接写 state.stateVersion"
    );
  }

  pushPatternError(
    maskedSource.match(/\bstate\s*\?\?\s*\(?\{\s*stateVersion\s*:/),
    "架构约束：production mutation façade 不得用 fake root state 旁路 authoritative stateVersion"
  );
  if (/^js\/core\/(?:Player|Deck)\.js$/i.test(file)) {
    pushPatternError(
      maskedSource.match(/\bstate\s*=\s*null/),
      "架构约束：Player/Deck production mutation façade 的 state 参数必须为必填 authoritative root"
    );
  }

  if (
    (!LEGACY_UTILS_PATTERN.test(file) && FORBIDDEN_ROOT_BUCKET_PATTERN.test(file))
    || FUTURE_LAYER_BUCKET_PATTERN.test(file)
  ) {
    pushPatternError(
      maskedSource.match(/./s),
      "架构约束：禁止新增 utils/common/helpers/misc/shared/legacy/compat 兜底目录"
    );
  }

  return errors;
}

/*
功能
对单份源码执行 Function Header 与 FR-ARCH 分层 Architecture Guard。

调用方
inspectFile、runSelfTest。

输入
仓库路径、源码、变更行 Set 或 null。

输出
结构化错误数组。

读取状态
无。

写入状态
无。

调用函数
findFunctions、missingHeaderFields、missingModuleFields、maskComments、targetArchitectureErrors。

边界与不变量
Guard 只使用路径、import 和明确回指语法；新三层规则仅对未来 domain/application/adapters 目录启用；AI 内部回指扫描覆盖完整文件，其余函数头仍按变更范围执行。
*/
function inspectSource(file, source, changed) {
  const lines = source.split(/\r?\n/);
  const importSource = maskComments(source);
  const maskedSource = maskNonCode(source);
  const maskedLines = maskedSource.split(/\r?\n/);
  const errors = [];
  for (const fn of findFunctions(source)) {
    if (!functionWasChanged(fn, changed, lines)) continue;
    const missing = missingHeaderFields(lines, fn.startLine);
    if (missing.length) errors.push({ file, functionName: fn.name, line: fn.startLine, missing });
  }

  if (AI_PATTERN.test(file)) {
    const uiImport = importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:\/ui\/|\/ui\.|\.\.\/ui\/)/i);
    if (uiImport) errors.push({ file, functionName: "<module>", line: source.slice(0, uiImport.index).split(/\r?\n/).length, missing: ["架构约束：AI 分层目录禁止 UI import"] });
    const gameImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/core\/Game\.js(?:\?[^"']*)?["']/i,
    );
    if (gameImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, gameImport.index).split(/\r?\n/).length,
        missing: ["架构约束：js/ai 禁止 raw Game ownership/import"]
      });
    }
    const applicationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/application\/(?:action|combat|response|judgment|turn|match|choice|trigger|messaging)\//i,
    );
    if (applicationImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, applicationImport.index).split(/\r?\n/).length,
        missing: ["架构约束：js/ai 禁止 import Application workflow"]
      });
    }
    const transitionImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/domain\/state\/transitions\//i,
    );
    if (transitionImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, transitionImport.index).split(/\r?\n/).length,
        missing: ["架构约束：js/ai 禁止 Domain Transition 修改 SearchState"]
      });
    }
    const workerUsage = maskNonCode(source).match(/\bnew\s+Worker\s*\(|\bpostMessage\s*\(/);
    if (workerUsage) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, workerUsage.index).split(/\r?\n/).length,
        missing: ["架构约束：FR-ARCH-13 不创建 Worker/postMessage"]
      });
    }
    const missing = missingModuleFields(source);
    if (missing.length) errors.push({ file, functionName: "<module>", line: 1, missing });
    if (changed === null) {
      const jsdoc = source.indexOf("/**");
      if (jsdoc >= 0) {
        errors.push({
          file,
          functionName:"<comments>",
          line:source.slice(0, jsdoc).split(/\r?\n/).length,
          missing:["注释规范：AI 全量模式禁止 JSDoc / ** 混用"],
        });
      }
    }
  }

  if (AI_ROOT_PATTERN.test(file) && !AI_ROOT_ALLOWLIST.has(file)) {
    errors.push({
      file,
      functionName:"<architecture>",
      line:1,
      missing:["架构约束：AI 根目录只允许 composition root AiController.js"],
    });
  }

  errors.push(...targetArchitectureErrors(file, importSource, maskedSource, source));

  if (AI_LEGACY_RULE_GUARD_PATTERN.test(file)) {
    const legacyRuleImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/(?:RuleEngine|DistanceSystem)\.js)(?:\?[^"']*)?["']/i,
    );
    if (legacyRuleImport) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, legacyRuleImport.index).split(/\r?\n/).length,
        missing: ["架构约束：AI search/simulation/domain 禁止依赖 legacy RuleEngine/DistanceSystem authority"]
      });
    }
  }

  if (WORKER_PATTERN.test(file)) {
    const forbiddenWorkerImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*(?:core\/Game\.js|\/application\/|\/ui\/|\/audio\/|domain\/state\/transitions\/)[^"']*(?:\?[^"']*)?["']/i,
    );
    if (forbiddenWorkerImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, forbiddenWorkerImport.index).split(/\r?\n/).length,
        missing: ["架构约束：Worker 禁止 import core/Game、Application、UI/Audio 或 Domain transitions"]
      });
    }
    const workerRandom = maskNonCode(source).match(/\bMath\.random\s*\(/);
    if (workerRandom) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, workerRandom.index).split(/\r?\n/).length,
        missing: ["架构约束：Worker search 禁止 Math.random"]
      });
    }
  }

  if (file === CARD_EFFECT_RULES_FILE) {
    const staticCardFactLiteral = maskedSource.match(
      /\bexport\s+function\s+get(?:AssaultBaseDamage|RecoverHealAmount|ChargeEnergyAmount|ShieldAmount|ShockwaveDamage|ProvokeDamage|HarvestDrawCount|DuelDamage|SymbiosisHealAmount)\s*\([^)]*\)\s*\{\s*return\s+\d+/,
    );
    if (staticCardFactLiteral) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, staticCardFactLiteral.index).split(/\r?\n/).length,
        missing: ["架构约束：CardEffectRules 固定效果数值必须消费 CardDefinitions"]
      });
    }
  }

  if (file === SKILL_RULES_FILE) {
    const staticSkillFactLiteral = importSource.match(
      /\bif\s*\(\s*skill\.id\s*===\s*"(?:breakArmy|barrier|symbiosis|burningField|hunt|resonance)"[\s\S]{0,140}?\b(?:attackLimitBonus|shieldAmount|healAmount|damageAmount|blockedRewardDraw|drawCount)\s*:\s*\d+/,
    );
    if (staticSkillFactLiteral) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, staticSkillFactLiteral.index).split(/\r?\n/).length,
        missing: ["架构约束：SkillRules 固定技能效果数值必须消费 SkillDefinitions"]
      });
    }
  }

  if (file === TRANSFER_EXECUTION_ADAPTER_FILE) {
    const duplicatedTransferFormula = maskedSource.match(
      /\b(?:from|receiver)\.battleTeam\s*(?:===|!==)\s*(?:source\.battleTeam|from\.battleTeam)/,
    );
    if (duplicatedTransferFormula) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, duplicatedTransferFormula.index).split(/\r?\n/).length,
        missing: ["架构约束：TransferExecutionPolicyAdapter 只 delegate TransferPolicy，不得重新解释 ally/enemy 方向"]
      });
    }
  }

  if (file === CARD_EFFECT_SIMULATION_FILE) {
    const migratedCardFactMirror = maskedSource.match(
      /\b(?:healFrom\(next,\s*actor,\s*actor,\s*1\b|changeEnergy\(next,\s*actor,\s*1\b|changeShield\(next,\s*target,\s*1\b|gainUnknownCardsWithCounterState\(next,\s*actor,\s*2\b|Math\.min\(\s*2\s*,|applyDamage\(next,\s*actor,\s*player,\s*1\b)/,
    );
    if (migratedCardFactMirror) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, migratedCardFactMirror.index).split(/\r?\n/).length,
        missing: ["架构约束：CardEffectSimulation 已迁移固定卡牌效果不得重新硬编码 1/2 literal"]
      });
    }
  }

  if (file === COMBAT_SIMULATION_FILE) {
    const combatRuleMirror = maskedSource.match(
      /\b(?:baseDamage\s*=\s*1\s*\+|applyDamage\(state,\s*target,\s*actor,\s*1\b|applyDamage\(state,\s*actor,\s*target,\s*1\b|Math\.min\(target\.maxHp,\s*target\.hp\s*\+\s*amount\))/,
    );
    if (combatRuleMirror) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, combatRuleMirror.index).split(/\r?\n/).length,
        missing: ["架构约束：CombatSimulation 确定性伤害/治疗 arithmetic 必须消费 Domain CombatRules"]
      });
    }
  }

  if (file === SKILL_EFFECT_SIMULATION_FILE) {
    const skillEffectMirror = maskedSource.match(
      /\b(?:branch\.energyAmount\s*-\s*1\b|branch\.energyAmount\s*\*\s*\.25\b|changeShield\(state,\s*target,\s*1\b|healFrom\(state,\s*actor,\s*target,\s*chance\)|applyDamage\(state,\s*actor,\s*target,\s*2\b)/,
    );
    if (skillEffectMirror) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, skillEffectMirror.index).split(/\r?\n/).length,
        missing: ["架构约束：SkillEffectSimulation 固定技能效果/孤注公式必须消费 Domain Skill Definitions/Rules"]
      });
    }
  }

  if (file === STATUS_SIMULATION_FILE) {
    const lightningDamageMirror = maskedSource.match(
      /\bapplyDamage\(next,\s*null,\s*target,\s*3\s*,/,
    );
    if (lightningDamageMirror) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, lightningDamageMirror.index).split(/\r?\n/).length,
        missing: ["架构约束：StatusSimulation 闪电命中伤害必须消费 Domain CardDefinitions"]
      });
    }
  }

  const removedCompatibilityPattern = new RegExp(
    `(?:from\\s*|import\\s*\\()\\s*["'][^"']*(?:${REMOVED_COMPATIBILITY_NAMES.join("|")})\\.js(?:\\?[^"']*)?["']`,
    "i",
  );
  const removedCompatibilityImport = importSource.match(removedCompatibilityPattern);
  if (removedCompatibilityImport) {
    errors.push({
      file,
      functionName:"<architecture>",
      line:source.slice(0, removedCompatibilityImport.index).split(/\r?\n/).length,
      missing:["架构约束：禁止恢复已删除的 compatibility 路径"],
    });
  }

  if (STATE_AI_PATTERN.test(file)) {
    const orchestrationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/(?:AiController|AiPlanner|AiSimulator|AiEvaluator)\.js(?:\?[^"']*)?["']/i,
    );
    if (orchestrationImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, orchestrationImport.index).split(/\r?\n/).length,
        missing: ["架构约束：state 禁止依赖 Controller/Planner/Simulator/Evaluator"],
      });
    }
  }

  if (VALUE_AI_PATTERN.test(file)) {
    const orchestrationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/(?:AiController|AiPlanner|AiSimulator)\.js(?:\?[^"']*)?["']/i,
    );
    if (orchestrationImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, orchestrationImport.index).split(/\r?\n/).length,
        missing: ["架构约束：value 禁止依赖 Controller/Planner/concrete Simulator"],
      });
    }
    const concreteConstruction = maskNonCode(source).match(/\bnew\s+AiSimulator\s*\(/);
    if (concreteConstruction) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, concreteConstruction.index).split(/\r?\n/).length,
        missing: ["架构约束：value 禁止构造 concrete Simulator"],
      });
    }
  }

  if (POLICY_AI_PATTERN.test(file)) {
    const orchestrationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/(?:AiController|AIController|AiPlanner|Planner|AiSimulator)\.js(?:\?[^"']*)?["']/i,
    );
    if (orchestrationImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, orchestrationImport.index).split(/\r?\n/).length,
        missing: ["架构约束：policy 禁止依赖 Controller/Planner/concrete Simulator"],
      });
    }
    const concreteConstruction = maskNonCode(source).match(/\bnew\s+AiSimulator\s*\(/);
    if (concreteConstruction) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, concreteConstruction.index).split(/\r?\n/).length,
        missing: ["架构约束：policy 禁止构造 concrete Simulator"],
      });
    }
  }

  if (DOMAIN_AI_PATTERN.test(file)) {
    const orchestrationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*(?:\/value\/|\/(?:AiController|AIController|AiPlanner|Planner|AiSimulator|AiEvaluator|Evaluator)\.js)(?:\?[^"']*)?["']/i,
    );
    if (orchestrationImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, orchestrationImport.index).split(/\r?\n/).length,
        missing: ["架构约束：domain 禁止依赖 value/Controller/Planner/Simulator/Evaluator"],
      });
    }
    const concreteConstruction = maskNonCode(source).match(/\bnew\s+AiSimulator\s*\(/);
    if (concreteConstruction) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, concreteConstruction.index).split(/\r?\n/).length,
        missing: ["架构约束：domain 禁止构造 concrete Simulator"],
      });
    }
  }

  if (TRANSITION_VALUE_PATTERN.test(file)) {
    const orchestrationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/(?:Game|AiController|AIController)\.js(?:\?[^"']*)?["']/i,
    );
    if (orchestrationImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, orchestrationImport.index).split(/\r?\n/).length,
        missing: ["架构约束：TransitionValue 禁止依赖 Game/AIController"],
      });
    }
    const gameBackreference = maskNonCode(source).match(/\bthis\.game\b/);
    if (gameBackreference) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, gameBackreference.index).split(/\r?\n/).length,
        missing: ["架构约束：TransitionValue 禁止 Game 回指"],
      });
    }
  }

  if (SEARCH_PLANNER_PATTERN.test(file)) {
    const forbiddenImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*(?:\/core\/(?:Game|RuleEngine)\.js|\/config\/(?:cardConfig|gameConfig|generalConfig)\.js|\/generals\/skillRegistry\.js|\/policy\/|\/domain\/|\/simulation\/(?:Simulator|CombatSimulation|ResponseSimulation|CardEffectSimulation|SkillEffectSimulation|StatusSimulation)\.js|\/(?:AiController|AIController)\.js)(?:\?[^"']*)?["']/i,
    );
    if (forbiddenImport) {
      errors.push({
        file,
        functionName: "<module>",
        line: source.slice(0, forbiddenImport.index).split(/\r?\n/).length,
        missing: ["架构约束：Planner 禁止依赖 Game/Rule/Config/Policy/Domain/concrete Simulation"],
      });
    }
    const concreteConstruction = maskNonCode(source).match(/\bnew\s+(?:Ai)?Simulator\s*\(/);
    if (concreteConstruction) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, concreteConstruction.index).split(/\r?\n/).length,
        missing: ["架构约束：Planner 禁止构造 concrete Simulator"],
      });
    }
  }

  if (SEARCH_PRIOR_PATTERN.test(file)) {
    const implicitStateCallback = maskNonCode(source).match(/\bgetCurrentState\b/);
    if (implicitStateCallback) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, implicitStateCallback.index).split(/\r?\n/).length,
        missing: ["架构约束：SearchPrior 禁止隐式 GameState callback"],
      });
    }
  }

  if (SEARCH_AI_PATTERN.test(file)) {
    const concreteSimulationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*\/simulation\/(?:Simulator|CombatSimulation|ResponseSimulation|CardEffectSimulation|SkillEffectSimulation|StatusSimulation)\.js(?:\?[^"']*)?["']/i,
    );
    if (concreteSimulationImport) {
      errors.push({
        file,
        functionName:"<module>",
        line:source.slice(0, concreteSimulationImport.index).split(/\r?\n/).length,
        missing:["架构约束：search 禁止依赖 concrete Simulation"],
      });
    }
  }

  if (SIMULATION_AI_PATTERN.test(file)) {
    const orchestrationImport = importSource.match(
      /(?:from\s*|import\s*\()\s*["'][^"']*(?:\/core\/Game\.js|\/(?:AiController|AIController)\.js|\/search\/(?:Planner|SearchPolicy)\.js)(?:\?[^"']*)?["']/i,
    );
    if (orchestrationImport) {
      errors.push({
        file,
        functionName:"<module>",
        line:source.slice(0, orchestrationImport.index).split(/\r?\n/).length,
        missing:["架构约束：simulation 禁止依赖 Game/Controller/Planner/SearchPolicy"],
      });
    }
    const finalComposition = maskNonCode(source).match(/\b(?:composeCandidateValue|TransitionValue)\b/);
    if (finalComposition) {
      errors.push({
        file,
        functionName:"<architecture>",
        line:source.slice(0, finalComposition.index).split(/\r?\n/).length,
        missing:["架构约束：simulation 禁止拥有 final value composition"],
      });
    }
  }

  if (/^js\/ai\//i.test(file)) maskedLines.forEach((line, index) => {
    if (/\b(?:this\.)?game\.aiController\b/.test(line)) {
      errors.push({ file, functionName: "<architecture>", line: index + 1, missing: ["架构约束：AI 内部禁止 game.aiController 回指"] });
    }
    if (/\bthis\.game\b/.test(line)) {
      errors.push({ file, functionName: "<architecture>", line: index + 1, missing: ["架构约束：js/ai 禁止 raw Game ownership（this.game）"] });
    }
  });

  if (/^js\/core\/GameChoiceRouter\.js$/i.test(file)) {
    const serviceLocator = maskNonCode(source).match(/\bgame\.aiController\b|\bgame\.ui\b|\bgame\.cleanupManager\b/);
    if (serviceLocator) {
      errors.push({
        file,
        functionName: "<architecture>",
        line: source.slice(0, serviceLocator.index).split(/\r?\n/).length,
        missing: ["架构约束：GameChoiceRouter 不得 service-locate Game 子组件"]
      });
    }
  }
  return errors;
}

/*
功能
读取并检查一个工作区生产文件。

调用方
main。

输入
仓库相对路径与检查模式。

输出
结构化错误数组。

读取状态
工作区文件与 Git 变更行。

写入状态
无。

调用函数
changedLines、inspectSource。

边界与不变量
--changed 只约束实际变更函数；--all 约束全部历史函数。
*/
function inspectFile(file, mode) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const lineCount = source.split(/\r?\n/).length;
  const changed = mode === "all" ? null : changedLines(file, lineCount);
  return inspectSource(file, source, changed);
}

/*
功能
运行内置通过/失败夹具，防止检查器静默失效。

调用方
main 的 --self-test 模式。

输入
无。

输出
断言失败时抛错，成功时打印摘要。

读取状态
无。

写入状态
标准输出。

调用函数
inspectSource。

边界与不变量
夹具必须覆盖头格式、注释遮罩、分层 purity、未来 domain/application/adapter/transition/garbage/dual-schema 边界、TransitionValue、Planner 与 SearchPrior 边界。
*/
function runSelfTest() {
  const pass = `/*
功能
返回输入。

调用方
自测。

输入
数值。

输出
原数值。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
保持输入不变。
*/
function identity(value) { return value; }`;
  const moduleHeader = `/*
模块职责
提供质量检查夹具。

上游
检查器自测。

下游
无。

状态边界
无。

信息边界
无隐藏信息。

架构约束
不得依赖 UI 或编排层。
*/`;
  const passErrors = inspectSource("js/fixture-pass.js", pass, null);
  if (passErrors.length) throw new Error(`valid no-star fixture failed: ${JSON.stringify(passErrors)}`);

  const missing = pass.replace("\n输入\n数值。\n", "\n");
  const missingErrors = inspectSource("js/fixture-missing.js", missing, null);
  if (!missingErrors.some((error) => error.functionName === "identity" && error.missing.includes("输入"))) {
    throw new Error("missing-field fixture did not detect absent Function Header field");
  }

  const oldStar = `/*
 * 功能：返回输入。
 * 调用方：自测。
 * 输入：数值。
 * 输出：原数值。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：无。
 * 边界与不变量：保持输入不变。
 */
function identity(value) { return value; }`;
  const oldStarErrors = inspectSource("js/fixture-old-star.js", oldStar, null);
  if (!oldStarErrors.some((error) => error.missing.some((item) => item.includes("星号")))) {
    throw new Error("old-star fixture was not rejected");
  }

  const jsdoc = pass.replace("/*\n", "/**\n");
  const jsdocErrors = inspectSource("js/fixture-jsdoc.js", jsdoc, null);
  if (!jsdocErrors.some((error) => error.missing.some((item) => item.includes("JSDoc")))) {
    throw new Error("JSDoc fixture was not rejected");
  }

  const sameLine = pass.replace("功能\n返回输入。", "功能：返回输入。");
  const sameLineErrors = inspectSource("js/fixture-same-line.js", sameLine, null);
  if (!sameLineErrors.some((error) => error.functionName === "identity" && error.missing.includes("功能"))) {
    throw new Error("same-line title fixture was not rejected");
  }

  const validModuleErrors = inspectSource(
    "js/ai/state/GoodState.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (validModuleErrors.length) {
    throw new Error(`valid Module Header fixture failed: ${JSON.stringify(validModuleErrors)}`);
  }

  const controllerErrors = inspectSource(
    "js/ai/AiFixture.js",
    pass.replace("return value;", "return game.aiController;"),
    null,
  );
  if (!controllerErrors.some((error) => error.functionName === "<architecture>")) {
    throw new Error("controller fixture did not detect game.aiController backreference");
  }
  const controllerCommentErrors = inspectSource(
    "js/ai/search/CommentFixture.js",
    `${moduleHeader}\n${pass.replace("return value;", "/* game.aiController 只是架构说明。 */\n  return value;")}`,
    null,
  );
  if (controllerCommentErrors.some((error) => error.functionName === "<architecture>")) {
    throw new Error("controller guard incorrectly scanned comment text");
  }
  const uiErrors = inspectSource(
    "js/ai/search/BadSearch.js",
    `${moduleHeader}\nimport { UI } from "../../ui/UI.js";\n${pass}`,
    null,
  );
  if (!uiErrors.some((error) => error.missing.some((item) => item.includes("UI import")))) {
    throw new Error("failing fixture did not detect layered UI import");
  }
  const stateErrors = inspectSource(
    "js/ai/state/BadState.js",
    `${moduleHeader}\nimport { AiPlanner } from "../AiPlanner.js";\n${pass}`,
    null,
  );
  if (!stateErrors.some((error) => error.missing.some((item) => item.includes("state 禁止依赖")))) {
    throw new Error("failing fixture did not detect state orchestration import");
  }
  const validValueErrors = inspectSource(
    "js/ai/value/GoodValue.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (validValueErrors.length) {
    throw new Error(`valid value fixture failed: ${JSON.stringify(validValueErrors)}`);
  }
  const valueImportErrors = inspectSource(
    "js/ai/value/BadValueImport.js",
    `${moduleHeader}\nimport { AiSimulator } from "../AiSimulator.js";\n${pass}`,
    null,
  );
  if (!valueImportErrors.some((error) => error.missing.some((item) => item.includes("concrete Simulator")))) {
    throw new Error("value fixture did not detect concrete Simulator import");
  }
  const valueConstructionErrors = inspectSource(
    "js/ai/value/BadValueConstruction.js",
    `${moduleHeader}\n${pass.replace("return value;", "return new AiSimulator(value);")}`,
    null,
  );
  if (!valueConstructionErrors.some((error) => error.missing.some((item) => item.includes("构造 concrete Simulator")))) {
    throw new Error("value fixture did not detect concrete Simulator construction");
  }
  const valueCommentErrors = inspectSource(
    "js/ai/value/ValueComment.js",
    `${moduleHeader}\n/* import { AiSimulator } from "../AiSimulator.js"; new AiSimulator(); */\n${pass}`,
    null,
  );
  if (valueCommentErrors.some((error) => error.missing.some((item) => item.includes("Simulator")))) {
    throw new Error("value guard incorrectly scanned comment text");
  }
  const validPolicyErrors = inspectSource(
    "js/ai/policy/GoodPolicy.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (validPolicyErrors.length) {
    throw new Error(`valid policy fixture failed: ${JSON.stringify(validPolicyErrors)}`);
  }
  const policyPlannerErrors = inspectSource(
    "js/ai/policy/BadPlannerPolicy.js",
    `${moduleHeader}\nimport { AiPlanner } from "../AiPlanner.js";\n${pass}`,
    null,
  );
  if (!policyPlannerErrors.some((error) => error.missing.some((item) => item.includes("policy 禁止依赖")))) {
    throw new Error("policy fixture did not detect Planner import");
  }
  const policySimulatorErrors = inspectSource(
    "js/ai/policy/BadSimulatorPolicy.js",
    `${moduleHeader}\n${pass.replace("return value;", "return new AiSimulator(value);")}`,
    null,
  );
  if (!policySimulatorErrors.some((error) => error.missing.some((item) => item.includes("policy 禁止构造")))) {
    throw new Error("policy fixture did not detect concrete Simulator construction");
  }
  const validDomainErrors = inspectSource(
    "js/ai/domain/GoodDomain.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (validDomainErrors.length) {
    throw new Error(`valid domain fixture failed: ${JSON.stringify(validDomainErrors)}`);
  }
  const domainValueErrors = inspectSource(
    "js/ai/domain/BadValueDomain.js",
    `${moduleHeader}\nimport { Evaluator } from "../value/Evaluator.js";\n${pass}`,
    null,
  );
  if (!domainValueErrors.some((error) => error.missing.some((item) => item.includes("domain 禁止依赖")))) {
    throw new Error("domain fixture did not detect value import");
  }
  const domainPlannerErrors = inspectSource(
    "js/ai/domain/BadPlannerDomain.js",
    `${moduleHeader}\nimport { AiPlanner } from "../AiPlanner.js";\n${pass}`,
    null,
  );
  if (!domainPlannerErrors.some((error) => error.missing.some((item) => item.includes("domain 禁止依赖")))) {
    throw new Error("domain fixture did not detect Planner import");
  }
  const domainSimulatorErrors = inspectSource(
    "js/ai/domain/BadSimulatorDomain.js",
    `${moduleHeader}\n${pass.replace("return value;", "return new AiSimulator(value);")}`,
    null,
  );
  if (!domainSimulatorErrors.some((error) => error.missing.some((item) => item.includes("domain 禁止构造")))) {
    throw new Error("domain fixture did not detect concrete Simulator construction");
  }
  const transitionGameErrors = inspectSource(
    "js/ai/search/TransitionValue.js",
    `${moduleHeader}\nimport { Game } from "../../core/Game.js";\n${pass}`,
    null,
  );
  if (!transitionGameErrors.some((error) => error.missing.some((item) => item.includes("Game/AIController")))) {
    throw new Error("TransitionValue fixture did not detect Game import");
  }
  const transitionControllerErrors = inspectSource(
    "js/ai/search/TransitionValue.js",
    `${moduleHeader}\nimport { AIController } from "../AiController.js";\n${pass}`,
    null,
  );
  if (!transitionControllerErrors.some((error) => error.missing.some((item) => item.includes("Game/AIController")))) {
    throw new Error("TransitionValue fixture did not detect AIController import");
  }
  const validPlannerErrors = inspectSource(
    "js/ai/search/Planner.js",
    `${moduleHeader}\nimport { SearchBudget } from "./SearchBudget.js";\n${pass}`,
    null,
  );
  if (validPlannerErrors.length) {
    throw new Error(`valid Planner fixture failed: ${JSON.stringify(validPlannerErrors)}`);
  }
  const plannerSimulatorErrors = inspectSource(
    "js/ai/search/Planner.js",
    `${moduleHeader}\nimport { Simulator } from "../simulation/Simulator.js";\n${pass}`,
    null,
  );
  if (!plannerSimulatorErrors.some((error) => error.missing.some((item) => item.includes("Planner 禁止依赖")))) {
    throw new Error("Planner fixture did not detect concrete Simulator import");
  }
  const plannerConstructionErrors = inspectSource(
    "js/ai/search/Planner.js",
    `${moduleHeader}\n${pass.replace("return value;", "return new Simulator(value);")}`,
    null,
  );
  if (!plannerConstructionErrors.some((error) => error.missing.some((item) => item.includes("Planner 禁止构造")))) {
    throw new Error("Planner fixture did not detect concrete Simulator construction");
  }
  const plannerCommentErrors = inspectSource(
    "js/ai/search/Planner.js",
    `${moduleHeader}\n/* import { Simulator } from "../simulation/Simulator.js"; new Simulator(); */\n${pass}`,
    null,
  );
  if (plannerCommentErrors.some((error) => error.missing.some((item) => item.includes("Planner 禁止")))) {
    throw new Error("Planner guard incorrectly scanned comment text");
  }
  const searchPriorCallbackErrors = inspectSource(
    "js/ai/search/SearchPrior.js",
    `${moduleHeader}\n${pass.replace("return value;", "return getCurrentState();")}`,
    null,
  );
  if (!searchPriorCallbackErrors.some((error) => error.missing.some((item) => item.includes("GameState callback")))) {
    throw new Error("SearchPrior fixture did not detect implicit GameState callback");
  }
  const simulationPlannerErrors = inspectSource(
    "js/ai/simulation/BadSimulation.js",
    `${moduleHeader}\nimport { SearchPolicy } from "../search/SearchPolicy.js";\n${pass}`,
    null,
  );
  if (!simulationPlannerErrors.some((error) => error.missing.some((item) => item.includes("simulation 禁止依赖")))) {
    throw new Error("simulation fixture did not detect SearchPolicy import");
  }
  const simulationCompositionErrors = inspectSource(
    "js/ai/simulation/BadComposition.js",
    `${moduleHeader}\n${pass.replace("return value;", "return composeCandidateValue(value);")}`,
    null,
  );
  if (!simulationCompositionErrors.some((error) => error.missing.some((item) => item.includes("final value composition")))) {
    throw new Error("simulation fixture did not detect final value composition");
  }
  const simulationCommentErrors = inspectSource(
    "js/ai/simulation/CommentSimulation.js",
    `${moduleHeader}\n/* composeCandidateValue and TransitionValue are forbidden here. */\n${pass}`,
    null,
  );
  if (simulationCommentErrors.some((error) => error.missing.some((item) => item.includes("final value composition")))) {
    throw new Error("simulation guard incorrectly scanned comment text");
  }
  const validDomainTargetErrors = inspectSource(
    "js/domain/rules/distance/GoodDistance.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (validDomainTargetErrors.length) {
    throw new Error(`valid future domain fixture failed: ${JSON.stringify(validDomainTargetErrors)}`);
  }
  const domainApplicationImportErrors = inspectSource(
    "js/domain/rules/BadApplicationDomain.js",
    `${moduleHeader}\nimport { ChoicePort } from "../../application/ports/ChoicePort.js";\n${pass}`,
    null,
  );
  if (!domainApplicationImportErrors.some((error) => error.missing.some((item) => item.includes("domain 禁止依赖")))) {
    throw new Error("future domain fixture did not detect application import");
  }
  const domainUiImportErrors = inspectSource(
    "js/domain/rules/BadUiDomain.js",
    `${moduleHeader}\nimport { UIManager } from "../../ui/UIManager.js";\n${pass}`,
    null,
  );
  if (!domainUiImportErrors.some((error) => error.missing.some((item) => item.includes("domain 禁止依赖")))) {
    throw new Error("future domain fixture did not detect legacy UI import");
  }
  const domainGameBackreferenceErrors = inspectSource(
    "js/domain/rules/BadGameDomain.js",
    `${moduleHeader}\n${pass.replace("return value;", "return this.game;")}`,
    null,
  );
  if (!domainGameBackreferenceErrors.some((error) => error.missing.some((item) => item.includes("Game 实例回指")))) {
    throw new Error("future domain fixture did not detect Game instance backreference");
  }
  const domainDualSchemaErrors = inspectSource(
    "js/domain/rules/BadDualSchemaDomain.js",
    `${moduleHeader}\n${pass.replace("return value;", "if (Array.isArray(player.statuses)) return value;")}`,
    null,
  );
  if (!domainDualSchemaErrors.some((error) => error.missing.some((item) => item.includes("statuses 双 schema")))) {
    throw new Error("future domain fixture did not detect dual-schema statuses branch");
  }
  const domainRuntimeImportErrors = inspectSource(
    "js/domain/rules/BadRuntimeDomain.js",
    `${moduleHeader}\nimport { Game } from "../../core/Game.js";\n${pass}`,
    null,
  );
  if (!domainRuntimeImportErrors.some((error) => error.missing.some((item) => item.includes("domain/rules 禁止依赖")))) {
    throw new Error("future domain/rules fixture did not detect core runtime import");
  }
  const domainTransitionsImportErrors = inspectSource(
    "js/domain/rules/BadTransitionDomain.js",
    `${moduleHeader}\nimport { bumpStateVersion } from "../../state/transitions/StateVersion.js";\n${pass}`,
    null,
  );
  if (!domainTransitionsImportErrors.some((error) => error.missing.some((item) => item.includes("domain/rules 禁止依赖")))) {
    throw new Error("future domain/rules fixture did not detect transition import");
  }
  const domainAwaitErrors = inspectSource(
    "js/domain/rules/BadAwaitDomain.js",
    `${moduleHeader}\n${pass.replace("return value;", "await value; return value;")}`,
    null,
  );
  if (!domainAwaitErrors.some((error) => error.missing.some((item) => item.includes("禁止 await")))) {
    throw new Error("future domain/rules fixture did not detect await");
  }
  const domainRandomErrors = inspectSource(
    "js/domain/rules/BadRandomDomain.js",
    `${moduleHeader}\n${pass.replace("return value;", "return Math.random();")}`,
    null,
  );
  if (!domainRandomErrors.some((error) => error.missing.some((item) => item.includes("禁止随机采样")))) {
    throw new Error("future domain/rules fixture did not detect random sampling");
  }
  const domainMetadataErrors = inspectSource(
    "js/domain/rules/BadMetadataDomain.js",
    `${moduleHeader}\n${pass.replace("return value;", "return player.aiMemory;")}`,
    null,
  );
  if (!domainMetadataErrors.some((error) => error.missing.some((item) => item.includes("metadata 泄漏")))) {
    throw new Error("future domain/rules fixture did not detect AI metadata leakage");
  }

  const validApplicationTargetErrors = inspectSource(
    "js/application/action/GoodAction.js",
    `${moduleHeader}\nimport { DamageRule } from "../../domain/rules/combat/DamageRule.js";\n${pass}`,
    null,
  );
  if (validApplicationTargetErrors.length) {
    throw new Error(`valid future application fixture failed: ${JSON.stringify(validApplicationTargetErrors)}`);
  }
  const applicationConcreteUiErrors = inspectSource(
    "js/application/action/BadUiApplication.js",
    `${moduleHeader}\nimport { UIManager } from "../../ui/UIManager.js";\n${pass}`,
    null,
  );
  if (!applicationConcreteUiErrors.some((error) => error.missing.some((item) => item.includes("concrete UI/Audio/AI")))) {
    throw new Error("future application fixture did not detect concrete UI import");
  }
  const applicationConcreteAiErrors = inspectSource(
    "js/application/action/BadAiApplication.js",
    `${moduleHeader}\nimport { AIController } from "../../ai/AiController.js";\n${pass}`,
    null,
  );
  if (!applicationConcreteAiErrors.some((error) => error.missing.some((item) => item.includes("concrete UI/Audio/AI")))) {
    throw new Error("future application fixture did not detect concrete AI import");
  }

  const validChoiceTargetErrors = inspectSource(
    "js/application/choice/GoodChoice.js",
    `${moduleHeader}\nimport { createChoiceResult } from "../ports/ChoicePort.js";\n${pass}`,
    null,
  );
  if (validChoiceTargetErrors.length) {
    throw new Error(`valid application/choice fixture failed: ${JSON.stringify(validChoiceTargetErrors)}`);
  }
  const choiceGameImportErrors = inspectSource(
    "js/application/choice/BadGameChoice.js",
    `${moduleHeader}\nimport { Game } from "../../core/Game.js";\n${pass}`,
    null,
  );
  if (!choiceGameImportErrors.some((error) => error.missing.some((item) => item.includes("application/choice 禁止")))) {
    throw new Error("application/choice fixture did not detect Game runtime import");
  }
  const choiceEntityErrors = inspectSource(
    "js/application/choice/BadEntityChoice.js",
    `${moduleHeader}\n${pass.replace("return value;", "return player.hand;")}`,
    null,
  );
  if (!choiceEntityErrors.some((error) => error.missing.some((item) => item.includes("entity 字段")))) {
    throw new Error("application/choice fixture did not detect Player entity field access");
  }
  const validResponseTargetErrors = inspectSource(
    "js/application/response/GoodResponse.js",
    `${moduleHeader}\nimport { isBlockResponseAvailable } from "../../domain/rules/response/ResponseRules.js";\n${pass}`,
    null,
  );
  if (validResponseTargetErrors.length) {
    throw new Error(`valid application/response fixture failed: ${JSON.stringify(validResponseTargetErrors)}`);
  }
  const responseGameImportErrors = inspectSource(
    "js/application/response/BadGameResponse.js",
    `${moduleHeader}\nimport { Game } from "../../core/Game.js";\n${pass}`,
    null,
  );
  if (!responseGameImportErrors.some((error) => error.missing.some((item) => item.includes("application/response 禁止")))) {
    throw new Error("application/response fixture did not detect Game runtime import");
  }
  const responseSearchStateErrors = inspectSource(
    "js/application/response/BadSearchResponse.js",
    `${moduleHeader}\n${pass.replace("return value;", "return state.searchState;")}`,
    null,
  );
  if (!responseSearchStateErrors.some((error) => error.missing.some((item) => item.includes("SearchState")))) {
    throw new Error("application/response fixture did not detect SearchState dependency");
  }

  const validCombatTargetErrors = inspectSource(
    "js/application/combat/GoodCombat.js",
    `${moduleHeader}\nimport { calculateDamageResult } from "../../domain/rules/combat/CombatRules.js";\n${pass}`,
    null,
  );
  if (validCombatTargetErrors.length) {
    throw new Error(`valid application/combat fixture failed: ${JSON.stringify(validCombatTargetErrors)}`);
  }
  const combatRuntimeErrors = inspectSource(
    "js/application/combat/BadRuntimeCombat.js",
    `${moduleHeader}\nimport { Game } from "../../core/Game.js";\n${pass}`,
    null,
  );
  if (!combatRuntimeErrors.some((error) => error.missing.some((item) => item.includes("application/combat 禁止")))) {
    throw new Error("application/combat fixture did not detect Game runtime import");
  }
  const combatStateErrors = inspectSource(
    "js/application/combat/BadStateCombat.js",
    `${moduleHeader}\n${pass.replace("return value;", "target.statistics.damageTaken += value; return value;")}`,
    null,
  );
  if (!combatStateErrors.some((error) => error.missing.some((item) => item.includes("statistics/aiMemory")))) {
    throw new Error("application/combat fixture did not detect direct statistics mutation");
  }
  const validMatchTargetErrors = inspectSource(
    "js/application/match/GoodMatch.js",
    `${moduleHeader}\nimport { getWinningTeam } from "../../domain/rules/team/TeamRules.js";\n${pass}`,
    null,
  );
  if (validMatchTargetErrors.length) {
    throw new Error(`valid application/match fixture failed: ${JSON.stringify(validMatchTargetErrors)}`);
  }
  const matchRuntimeErrors = inspectSource(
    "js/application/match/BadRuntimeMatch.js",
    `${moduleHeader}\nimport { Game } from "../../core/Game.js";\n${pass}`,
    null,
  );
  if (!matchRuntimeErrors.some((error) => error.missing.some((item) => item.includes("application/match 禁止")))) {
    throw new Error("application/match fixture did not detect Game runtime import");
  }
  const validTurnTargetErrors = inspectSource(
    "js/application/turn/GoodTurn.js",
    `${moduleHeader}\nimport { shouldSkipActionPhase } from "../../domain/rules/turn/TurnRules.js";\n${pass}`,
    null,
  );
  if (validTurnTargetErrors.length) {
    throw new Error(`valid application/turn fixture failed: ${JSON.stringify(validTurnTargetErrors)}`);
  }
  const turnAiErrors = inspectSource(
    "js/application/turn/BadAiTurn.js",
    `${moduleHeader}\n${pass.replace("return value;", "return state.searchState; return value;")}`,
    null,
  );
  if (!turnAiErrors.some((error) => error.missing.some((item) => item.includes("SearchState")))) {
    throw new Error("application/turn fixture did not detect SearchState dependency");
  }
  const validActionTargetErrors = inspectSource(
    "js/application/action/GoodAction.js",
    `${moduleHeader}\nimport { recordActiveSkillUse } from "../../domain/state/transitions/RuleUsageTransitions.js";\n${pass}`,
    null,
  );
  if (validActionTargetErrors.length) {
    throw new Error(`valid application/action fixture failed: ${JSON.stringify(validActionTargetErrors)}`);
  }
  const actionRuntimeErrors = inspectSource(
    "js/application/action/BadRuntimeAction.js",
    `${moduleHeader}\n${pass.replace("return value;", "target.statistics.cardsPlayed += value; return value;")}`,
    null,
  );
  if (!actionRuntimeErrors.some((error) => error.missing.some((item) => item.includes("statistics")))) {
    throw new Error("application/action fixture did not detect direct statistics mutation");
  }
  const validGenericActionErrors = inspectSource(
    "js/application/action/ActionWorkflow.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (validGenericActionErrors.length) {
    throw new Error(`valid generic ActionWorkflow fixture failed: ${JSON.stringify(validGenericActionErrors)}`);
  }
  const cardSpecificActionErrors = inspectSource(
    "js/application/action/ActionWorkflow.js",
    `${moduleHeader}\n${pass.replace("return value;", "if (card.definitionId === \"transfer\") return value;")}`,
    null,
  );
  if (!cardSpecificActionErrors.some((error) => error.missing.some((item) => item.includes("specific card")))) {
    throw new Error("generic ActionWorkflow fixture did not detect cardId branch");
  }
  const mutableActionErrors = inspectSource(
    "js/application/action/ActionWorkflow.js",
    `${moduleHeader}\n${pass.replace("return value;", "return { state: actionRuntime, playCard };")}`,
    null,
  );
  if (!mutableActionErrors.some((error) => error.missing.some((item) => item.includes("mutable internal runtime")))) {
    throw new Error("ActionWorkflow fixture did not detect mutable runtime exposure");
  }

  const validSlimGameErrors = inspectSource(
    "js/core/Game.js",
    `${moduleHeader}\nexport class Game { runGameLoop() { return this.turnWorkflow.runGameLoop(); } }`,
    null,
  );
  if (validSlimGameErrors.length) {
    throw new Error(`valid slim Game fixture failed: ${JSON.stringify(validSlimGameErrors)}`);
  }
  const badSlimGameErrors = inspectSource(
    "js/core/Game.js",
    `${moduleHeader}\nexport class Game { async runGameLoop() { let consecutiveTurnFailures = 0; } }`,
    null,
  );
  if (!badSlimGameErrors.some((error) => error.missing.some((item) => item.includes("Game workflow regression guard")))) {
    throw new Error("Game regression fixture did not detect workflow body growth");
  }

  const validJudgmentTargetErrors = inspectSource(
    "js/application/judgment/GoodJudgment.js",
    `${moduleHeader}\nimport { decideDefenseJudgmentOutcome } from "../../domain/rules/judgment/JudgmentRules.js";\n${pass}`,
    null,
  );
  if (validJudgmentTargetErrors.length) {
    throw new Error(`valid application/judgment fixture failed: ${JSON.stringify(validJudgmentTargetErrors)}`);
  }
  const judgmentRuntimeErrors = inspectSource(
    "js/application/judgment/BadRuntimeJudgment.js",
    `${moduleHeader}\nimport { UIManager } from "../../ui/UIManager.js";\n${pass}`,
    null,
  );
  if (!judgmentRuntimeErrors.some((error) => error.missing.some((item) => item.includes("application/judgment 禁止")))) {
    throw new Error("application/judgment fixture did not detect concrete UI import");
  }
  const judgmentAiMemoryErrors = inspectSource(
    "js/application/judgment/BadAiMemoryJudgment.js",
    `${moduleHeader}\n${pass.replace("return value;", "holder.aiMemory.recentAggressors.x = value; return value;")}`,
    null,
  );
  if (!judgmentAiMemoryErrors.some((error) => error.missing.some((item) => item.includes("statistics/aiMemory")))) {
    throw new Error("application/judgment fixture did not detect direct aiMemory write");
  }
  const validDyingFacadeErrors = inspectSource(
    "js/core/DyingSystem.js",
    `${moduleHeader}\nexport class DyingSystem { constructor(game) { this.game = game; this.workflow = game.combatWorkflow; } enter(...args) { return this.workflow.enter(...args); } }`,
    null,
  );
  if (validDyingFacadeErrors.length) {
    throw new Error(`valid dying facade fixture failed: ${JSON.stringify(validDyingFacadeErrors)}`);
  }
  const badDyingFacadeErrors = inspectSource(
    "js/core/DyingSystem.js",
    `${moduleHeader}\nexport class DyingSystem { async resolve(target) { setHp(null, target, 0); } }`,
    null,
  );
  if (!badDyingFacadeErrors.some((error) => error.missing.some((item) => item.includes("legacy façade")))) {
    throw new Error("dying facade fixture did not detect workflow body growth");
  }


  const validPortsTargetErrors = inspectSource(
    "js/application/ports/GoodPort.js",
    `${moduleHeader}\nimport { createChoiceResult } from "./ChoicePort.js";\n${pass}`,
    null,
  );
  if (validPortsTargetErrors.length) {
    throw new Error(`valid application/ports fixture failed: ${JSON.stringify(validPortsTargetErrors)}`);
  }
  const portsTransitionErrors = inspectSource(
    "js/application/ports/BadTransitionPort.js",
    `${moduleHeader}\nimport { bumpStateVersion } from "../../domain/state/transitions/StateVersion.js";\n${pass}`,
    null,
  );
  if (!portsTransitionErrors.some((error) => error.missing.some((item) => item.includes("application/ports 禁止")))) {
    throw new Error("application/ports fixture did not detect Domain transition import");
  }
  const validUiAdapterErrors = inspectSource(
    "js/adapters/ui/GoodUiAdapter.js",
    `${moduleHeader}\nimport { createChoiceResult } from "../../application/ports/ChoicePort.js";\n${pass}`,
    null,
  );
  if (validUiAdapterErrors.length) {
    throw new Error(`valid ui adapter fixture failed: ${JSON.stringify(validUiAdapterErrors)}`);
  }
  const uiAiPeerErrors = inspectSource(
    "js/adapters/ui/BadUiAiPeer.js",
    `${moduleHeader}\nimport { AIController } from "../../ai/AiController.js";\n${pass}`,
    null,
  );
  if (!uiAiPeerErrors.some((error) => error.missing.some((item) => item.includes("跨 concrete adapter")))) {
    throw new Error("ui adapter fixture did not detect ai peer import");
  }

  const validAdapterTargetErrors = inspectSource(
    "js/adapters/ui/GoodUiAdapter.js",
    `${moduleHeader}\nimport { PlayCard } from "../../application/action/PlayCard.js";\nimport { CardState } from "../../domain/state/model/CardState.js";\n${pass}`,
    null,
  );
  if (validAdapterTargetErrors.length) {
    throw new Error(`valid future adapter fixture failed: ${JSON.stringify(validAdapterTargetErrors)}`);
  }
  const adapterCrossCouplingErrors = inspectSource(
    "js/adapters/ui/BadCrossAdapter.js",
    `${moduleHeader}\nimport { SoundManager } from "../audio/SoundManager.js";\n${pass}`,
    null,
  );
  if (!adapterCrossCouplingErrors.some((error) => error.missing.some((item) => item.includes("跨 concrete adapter")))) {
    throw new Error("future adapter fixture did not detect cross-adapter concrete coupling");
  }

  const validTransitionTargetErrors = inspectSource(
    "js/domain/state/transitions/GoodTransition.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (validTransitionTargetErrors.length) {
    throw new Error(`valid future transition fixture failed: ${JSON.stringify(validTransitionTargetErrors)}`);
  }
  const transitionRegistryImportErrors = inspectSource(
    "js/domain/state/transitions/BadTransition.js",
    `${moduleHeader}\nimport { resolveCardEffect } from "../../../cards/cardRegistry.js";\n${pass}`,
    null,
  );
  if (!transitionRegistryImportErrors.some((error) => error.missing.some((item) => item.includes("transitions 禁止依赖")))) {
    throw new Error("future transition fixture did not detect cardRegistry import");
  }
  const transitionSpecificRuleErrors = inspectSource(
    "js/domain/state/transitions/BadSpecificTransition.js",
    `${moduleHeader}\n${pass.replace("return value;", "if (definitionId === \"assault\") return value;")}`,
    null,
  );
  if (!transitionSpecificRuleErrors.some((error) => error.missing.some((item) => item.includes("cardId/skillId-specific")))) {
    throw new Error("future transition fixture did not detect cardId-specific rule branch");
  }

  const garbageRootErrors = inspectSource(
    "js/common/GodBucket.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (!garbageRootErrors.some((error) => error.missing.some((item) => item.includes("兜底目录")))) {
    throw new Error("garbage-bucket fixture did not detect future root bucket directory");
  }
  const garbageLayerErrors = inspectSource(
    "js/domain/shared/GodBucket.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (!garbageLayerErrors.some((error) => error.missing.some((item) => item.includes("兜底目录")))) {
    throw new Error("garbage-bucket fixture did not detect future layer bucket directory");
  }

  const validStateVersionTransitionErrors = inspectSource(
    "js/domain/state/transitions/GoodVersionTransition.js",
    `${moduleHeader}\n${pass.replace("return value;", "state.stateVersion += 1; return value;")}`,
    null,
  );
  if (validStateVersionTransitionErrors.length) {
    throw new Error(`valid stateVersion transition fixture failed: ${JSON.stringify(validStateVersionTransitionErrors)}`);
  }
  const stateVersionWriteGuardErrors = inspectSource(
    "js/core/BadVersionWrite.js",
    `${moduleHeader}\n${pass.replace("return value;", "state.stateVersion += 1; return value;")}`,
    null,
  );
  if (!stateVersionWriteGuardErrors.some((error) => error.missing.some((item) => item.includes("state.stateVersion")))) {
    throw new Error("stateVersion write guard did not reject non-transition write");
  }

  const validCoreMutationErrors = inspectSource(
    "js/core/Player.js",
    pass.replace("function identity(value)", "function mutate(state)").replace("return value;", "return state;"),
    null,
  );
  if (validCoreMutationErrors.length) {
    throw new Error(`valid core mutation fixture failed: ${JSON.stringify(validCoreMutationErrors)}`);
  }
  const optionalStateMutationErrors = inspectSource(
    "js/core/Player.js",
    pass.replace("function identity(value)", "function mutate(state = null)").replace("return value;", "return state;"),
    null,
  );
  if (!optionalStateMutationErrors.some((error) => error.missing.some((item) => item.includes("state 参数必须为必填")))) {
    throw new Error("core mutation guard did not reject optional state parameter");
  }
  const fakeRootStateErrors = inspectSource(
    "js/core/Player.js",
    pass.replace("function identity(value)", "function mutate(state)").replace("return value;", "return state ?? { stateVersion: 0 };"),
    null,
  );
  if (!fakeRootStateErrors.some((error) => error.missing.some((item) => item.includes("fake root state")))) {
    throw new Error("core mutation guard did not reject fake root state fallback");
  }

  const compatibilityErrors = inspectSource(
    "js/ai/search/BadCompatibility.js",
    `${moduleHeader}\nimport { AiSimulator } from "../AiSimulator.js";\n${pass}`,
    null,
  );
  if (!compatibilityErrors.some((error) => error.missing.some((item) => item.includes("compatibility 路径")))) {
    throw new Error("compatibility fixture did not detect removed path");
  }
  const rootLayoutErrors = inspectSource(
    "js/ai/Misc.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (!rootLayoutErrors.some((error) => error.missing.some((item) => item.includes("AI 根目录")))) {
    throw new Error("root layout fixture did not detect non-allowlisted root file");
  }
  const goodLegacyRuleGuard = inspectSource(
    "js/ai/search/GoodLegacyRule.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodLegacyRuleGuard.some((error) => error.missing.some((item) => item.includes("legacy RuleEngine/DistanceSystem")))) {
    throw new Error("legacy rule guard incorrectly rejected canonical search fixture");
  }
  const badLegacyRuleGuard = inspectSource(
    "js/ai/search/BadLegacyRule.js",
    `${moduleHeader}\nimport { RuleEngine } from "../../core/RuleEngine.js";\n${pass}`,
    null,
  );
  if (!badLegacyRuleGuard.some((error) => error.missing.some((item) => item.includes("legacy RuleEngine/DistanceSystem")))) {
    throw new Error("legacy rule guard did not reject core/RuleEngine import");
  }

  const goodCardFactGuard = inspectSource(
    "js/domain/rules/card/CardEffectRules.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodCardFactGuard.some((error) => error.missing.some((item) => item.includes("CardEffectRules")))) {
    throw new Error(`valid CardEffectRules fixture failed: ${JSON.stringify(goodCardFactGuard)}`);
  }
  const badCardFactGuard = inspectSource(
    "js/domain/rules/card/CardEffectRules.js",
    `${moduleHeader}\n${pass.replace("function identity(value)", "export function getAssaultBaseDamage()").replace("return value;", "return 1;")}`,
    null,
  );
  if (!badCardFactGuard.some((error) => error.missing.some((item) => item.includes("CardEffectRules")))) {
    throw new Error("CardEffectRules guard did not reject fixed literal getter");
  }

  const goodSkillFactGuard = inspectSource(
    "js/domain/rules/skill/SkillRules.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodSkillFactGuard.some((error) => error.missing.some((item) => item.includes("SkillRules")))) {
    throw new Error(`valid SkillRules fixture failed: ${JSON.stringify(goodSkillFactGuard)}`);
  }
  const badSkillFactGuard = inspectSource(
    "js/domain/rules/skill/SkillRules.js",
    `${moduleHeader}\n${pass.replace("return value;", "if (skill.id === \"barrier\") return { shieldAmount: 1 }; return value;")}`,
    null,
  );
  if (!badSkillFactGuard.some((error) => error.missing.some((item) => item.includes("SkillRules")))) {
    throw new Error("SkillRules guard did not reject hardcoded fixed effect fact");
  }

  const goodTransferAdapterGuard = inspectSource(
    "js/adapters/ai/TransferExecutionPolicyAdapter.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodTransferAdapterGuard.some((error) => error.missing.some((item) => item.includes("TransferExecutionPolicyAdapter")))) {
    throw new Error(`valid TransferExecutionPolicyAdapter fixture failed: ${JSON.stringify(goodTransferAdapterGuard)}`);
  }
  const badTransferAdapterGuard = inspectSource(
    "js/adapters/ai/TransferExecutionPolicyAdapter.js",
    `${moduleHeader}\n${pass.replace("return value;", "return !(source.controllerType === \"ai\" && from.battleTeam === source.battleTeam && receiver.battleTeam !== source.battleTeam);")}`,
    null,
  );
  if (!badTransferAdapterGuard.some((error) => error.missing.some((item) => item.includes("TransferExecutionPolicyAdapter")))) {
    throw new Error("TransferExecutionPolicyAdapter guard did not reject duplicated direction formula");
  }

  const goodCardSimulationMirror = inspectSource(
    "js/ai/simulation/CardEffectSimulation.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodCardSimulationMirror.some((error) => error.missing.some((item) => item.includes("CardEffectSimulation")))) {
    throw new Error(`valid CardEffectSimulation fixture failed: ${JSON.stringify(goodCardSimulationMirror)}`);
  }
  const badCardSimulationMirror = inspectSource(
    "js/ai/simulation/CardEffectSimulation.js",
    `${moduleHeader}\n${pass.replace("return value;", "this.healFrom(next, actor, actor, 1); return value;")}`,
    null,
  );
  if (!badCardSimulationMirror.some((error) => error.missing.some((item) => item.includes("CardEffectSimulation")))) {
    throw new Error("CardEffectSimulation mirror guard did not reject recover literal");
  }

  const goodCombatSimulationMirror = inspectSource(
    "js/ai/simulation/CombatSimulation.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodCombatSimulationMirror.some((error) => error.missing.some((item) => item.includes("CombatSimulation")))) {
    throw new Error(`valid CombatSimulation fixture failed: ${JSON.stringify(goodCombatSimulationMirror)}`);
  }
  const badCombatSimulationMirror = inspectSource(
    "js/ai/simulation/CombatSimulation.js",
    `${moduleHeader}\n${pass.replace("return value;", "const baseDamage = 1 + source.exposeWeaknessStacks; return value;")}`,
    null,
  );
  if (!badCombatSimulationMirror.some((error) => error.missing.some((item) => item.includes("CombatSimulation")))) {
    throw new Error("CombatSimulation mirror guard did not reject assault base literal");
  }

  const goodSkillSimulationMirror = inspectSource(
    "js/ai/simulation/SkillEffectSimulation.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodSkillSimulationMirror.some((error) => error.missing.some((item) => item.includes("SkillEffectSimulation")))) {
    throw new Error(`valid SkillEffectSimulation fixture failed: ${JSON.stringify(goodSkillSimulationMirror)}`);
  }
  const badSkillSimulationMirror = inspectSource(
    "js/ai/simulation/SkillEffectSimulation.js",
    `${moduleHeader}\n${pass.replace("return value;", "return branch.energyAmount - 1;")}`,
    null,
  );
  if (!badSkillSimulationMirror.some((error) => error.missing.some((item) => item.includes("SkillEffectSimulation")))) {
    throw new Error("SkillEffectSimulation mirror guard did not reject allIn draw formula");
  }

  const goodStatusSimulationMirror = inspectSource(
    "js/ai/simulation/StatusSimulation.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodStatusSimulationMirror.some((error) => error.missing.some((item) => item.includes("StatusSimulation")))) {
    throw new Error(`valid StatusSimulation fixture failed: ${JSON.stringify(goodStatusSimulationMirror)}`);
  }
  const badStatusSimulationMirror = inspectSource(
    "js/ai/simulation/StatusSimulation.js",
    `${moduleHeader}\n${pass.replace("return value;", "this.applyDamage(next, null, target, 3, { canBlock:false }); return value;")}`,
    null,
  );
  if (!badStatusSimulationMirror.some((error) => error.missing.some((item) => item.includes("StatusSimulation")))) {
    throw new Error("StatusSimulation mirror guard did not reject lightning damage literal");
  }

  const rootArtifactPositive = accidentalRootArtifacts(["AI", "js/core/Game.js"]);
  if (rootArtifactPositive.length !== 1 || rootArtifactPositive[0] !== "AI") {
    throw new Error("root artifact guard did not detect accidental AI file");
  }
  const rootArtifactNegative = accidentalRootArtifacts(["js/ai/AiController.js", "js/core/Game.js"]);
  if (rootArtifactNegative.length !== 0) {
    throw new Error("root artifact guard incorrectly rejected valid root files");
  }

  const goodAiGameBoundary = inspectSource(
    "js/ai/search/GoodBoundary.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodAiGameBoundary.some((error) => error.missing.some((item) => item.includes("raw Game")))) {
    throw new Error("AI Game-boundary guard incorrectly rejected canonical fixture");
  }
  const badAiGameImport = inspectSource(
    "js/ai/search/BadGameBoundary.js",
    `${moduleHeader}\nimport { Game } from "../../core/Game.js";\n${pass}`,
    null,
  );
  if (!badAiGameImport.some((error) => error.missing.some((item) => item.includes("raw Game")))) {
    throw new Error("AI Game-boundary guard did not reject core/Game import");
  }
  const badAiThisGame = inspectSource(
    "js/ai/search/BadThisGame.js",
    `${moduleHeader}\n${pass.replace("return value;", "return this.game;")}`,
    null,
  );
  if (!badAiThisGame.some((error) => error.missing.some((item) => item.includes("this.game")))) {
    throw new Error("AI Game-boundary guard did not reject this.game");
  }
  const badAiApplication = inspectSource(
    "js/ai/search/BadApplicationBoundary.js",
    `${moduleHeader}\nimport { createTurnWorkflow } from "../../application/turn/TurnWorkflow.js";\n${pass}`,
    null,
  );
  if (!badAiApplication.some((error) => error.missing.some((item) => item.includes("Application workflow")))) {
    throw new Error("AI Application guard did not reject workflow import");
  }
  const badAiTransition = inspectSource(
    "js/ai/search/BadTransitionBoundary.js",
    `${moduleHeader}\nimport { bumpStateVersion } from "../../domain/state/transitions/StateVersion.js";\n${pass}`,
    null,
  );
  if (!badAiTransition.some((error) => error.missing.some((item) => item.includes("Domain Transition")))) {
    throw new Error("AI Transition guard did not reject Domain transitions import");
  }
  const badWorker = inspectSource(
    "js/ai/search/BadWorkerBoundary.js",
    `${moduleHeader}\n${pass.replace("return value;", "postMessage(value); return value;")}`,
    null,
  );
  if (!badWorker.some((error) => error.missing.some((item) => item.includes("Worker/postMessage")))) {
    throw new Error("Worker guard did not reject postMessage");
  }
  const goodChoiceRouter = inspectSource(
    "js/core/GameChoiceRouter.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodChoiceRouter.some((error) => error.missing.some((item) => item.includes("service-locate")))) {
    throw new Error("GameChoiceRouter guard incorrectly rejected canonical fixture");
  }
  const badChoiceRouter = inspectSource(
    "js/core/GameChoiceRouter.js",
    `${moduleHeader}\n${pass.replace("return value;", "return game.aiController;")}`,
    null,
  );
  if (!badChoiceRouter.some((error) => error.missing.some((item) => item.includes("service-locate")))) {
    throw new Error("GameChoiceRouter guard did not reject aiController lookup");
  }

  const goodWorkerBoundary = inspectSource(
    "js/adapters/ai/worker/GoodWorker.js",
    `${moduleHeader}\n${pass}`,
    null,
  );
  if (goodWorkerBoundary.some((error) => error.missing.some((item) => item.includes("Worker 禁止")))) {
    throw new Error("Worker guard incorrectly rejected canonical worker fixture");
  }
  const badWorkerImport = inspectSource(
    "js/adapters/ai/worker/BadWorkerImport.js",
    `${moduleHeader}\nimport { Game } from "../../../core/Game.js";\n${pass}`,
    null,
  );
  if (!badWorkerImport.some((error) => error.missing.some((item) => item.includes("Worker 禁止")))) {
    throw new Error("Worker guard did not reject core/Game import");
  }
  const badWorkerRandom = inspectSource(
    "js/adapters/ai/worker/BadWorkerRandom.js",
    `${moduleHeader}\n${pass.replace("return value;", "return Math.random();")}`,
    null,
  );
  if (!badWorkerRandom.some((error) => error.missing.some((item) => item.includes("Math.random")))) {
    throw new Error("Worker guard did not reject Math.random");
  }

  process.stdout.write("code-quality self-test passed: headers, modules, JSDoc rejection, comment masking, layered purity, future domain/application/choice/ports/response/combat/judgment/match/turn/action/trigger/messaging/events/slim-game/facade/adapter/transition/rules-purity/garbage/dual-schema/stateVersion-write/fake-root-state/core-mutation-state guards, Simulation/Search boundaries, legacy RuleEngine/DistanceSystem guard, static Definition/Rule fact guards, TransferExecutionPolicyAdapter guard, simulation mirror guards, accidental root artifact guard, AI raw-Game/Application/Transition/Worker guards, GameChoiceRouter service-locator guard, Dedicated Worker boundary/random guards, compatibility removal, and root layout\n");
}

/*
功能
解析命令行模式、运行检查并设置进程退出码。

调用方
Node.js 入口。

输入
process.argv 中的 --changed、--all 或 --self-test。

输出
标准输出/错误与退出码。

读取状态
生产源码和只读 Git 状态。

写入状态
process.exitCode。

调用函数
changedProductionFiles、allProductionFiles、inspectFile、runSelfTest。

边界与不变量
默认模式永远是 --changed；未知参数立即失败。
*/
function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--changed", "--all", "--ai-all", "--self-test"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  const selectedModes = ["--changed", "--all", "--ai-all"].filter((mode) => args.includes(mode));
  if (unknown.length || selectedModes.length > 1) {
    process.stderr.write(`Usage: node tools/check-code-quality.mjs [--changed|--all|--ai-all|--self-test]\n`);
    process.exitCode = 2;
    return;
  }
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const rootArtifacts = accidentalRootArtifacts(
    ["AI", "application", "transitions"].filter((name) => fs.existsSync(path.join(ROOT, name)))
  );
  if (rootArtifacts.length) {
    for (const artifact of rootArtifacts) {
      process.stderr.write(`${artifact}:1 <architecture> missing: 架构约束：根目录 accidental artifact ${artifact} 不得重新出现\n`);
    }
    process.stderr.write(`code-quality failed: ${rootArtifacts.length} accidental root artifact(s)\n`);
    process.exitCode = 1;
    return;
  }

  const mode = args.includes("--all") ? "all"
    : args.includes("--ai-all") ? "ai-all"
      : "changed";
  const files = mode === "all" ? allProductionFiles()
    : mode === "ai-all" ? allProductionFiles().filter((file) => AI_PATTERN.test(file))
      : changedProductionFiles();
  if (!files.length) {
    process.stdout.write(`code-quality passed (--${mode}): no production JavaScript files to inspect\n`);
    return;
  }
  const errors = files.flatMap((file) => inspectFile(file, mode === "changed" ? mode : "all"));
  if (errors.length) {
    for (const error of errors) {
      process.stderr.write(`${error.file}:${error.line} ${error.functionName} missing: ${error.missing.join(", ")}\n`);
    }
    process.stderr.write(`code-quality failed (--${mode}): ${errors.length} issue(s) in ${files.length} file(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`code-quality passed (--${mode}): ${files.length} production file(s) inspected\n`);
}

main();
