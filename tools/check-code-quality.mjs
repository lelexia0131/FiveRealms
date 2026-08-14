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
const LAYERED_AI_PATTERN = /^js\/ai\/(?:state|search|simulation|value|policy|domain)\//i;
const STATE_AI_PATTERN = /^js\/ai\/state\//i;
const VALUE_AI_PATTERN = /^js\/ai\/value\//i;
const POLICY_AI_PATTERN = /^js\/ai\/policy\//i;
const DOMAIN_AI_PATTERN = /^js\/ai\/domain\//i;
const TRANSITION_VALUE_PATTERN = /^js\/ai\/search\/TransitionValue\.js$/i;

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
对单份源码执行 Function Header 和首版 Architecture Guard。

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
findFunctions、missingHeaderFields、missingModuleFields、maskComments。

边界与不变量
Guard 只使用路径、import 和明确回指语法；AI 内部回指扫描覆盖完整文件，其余函数头仍按变更范围执行。
*/
function inspectSource(file, source, changed) {
  const lines = source.split(/\r?\n/);
  const importSource = maskComments(source);
  const maskedLines = maskNonCode(source).split(/\r?\n/);
  const errors = [];
  for (const fn of findFunctions(source)) {
    if (!functionWasChanged(fn, changed, lines)) continue;
    const missing = missingHeaderFields(lines, fn.startLine);
    if (missing.length) errors.push({ file, functionName: fn.name, line: fn.startLine, missing });
  }

  if (LAYERED_AI_PATTERN.test(file)) {
    const uiImport = importSource.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:\/ui\/|\/ui\.|\.\.\/ui\/)/i);
    if (uiImport) errors.push({ file, functionName: "<module>", line: source.slice(0, uiImport.index).split(/\r?\n/).length, missing: ["架构约束：AI 分层目录禁止 UI import"] });
    const missing = missingModuleFields(source);
    if (missing.length) errors.push({ file, functionName: "<module>", line: 1, missing });
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

  if (/^js\/ai\//i.test(file)) maskedLines.forEach((line, index) => {
    if (/\b(?:this\.)?game\.aiController\b/.test(line)) {
      errors.push({ file, functionName: "<architecture>", line: index + 1, missing: ["架构约束：AI 内部禁止 game.aiController 回指"] });
    }
  });
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
夹具必须覆盖头格式、注释遮罩、UI/state 方向、value/policy/domain purity 与 TransitionValue 依赖边界。
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
    "js/ai/AiCommentFixture.js",
    pass.replace("return value;", "/* game.aiController 只是架构说明。 */\n  return value;"),
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
  process.stdout.write("code-quality self-test passed: headers, modules, backreferences, ignored comments, UI/state direction, value/policy/domain purity, and TransitionValue boundaries\n");
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
  const allowed = new Set(["--changed", "--all", "--self-test"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length || (args.includes("--all") && args.includes("--changed"))) {
    process.stderr.write(`Usage: node tools/check-code-quality.mjs [--changed|--all|--self-test]\n`);
    process.exitCode = 2;
    return;
  }
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const mode = args.includes("--all") ? "all" : "changed";
  const files = mode === "all" ? allProductionFiles() : changedProductionFiles();
  if (!files.length) {
    process.stdout.write(`code-quality passed (--${mode}): no production JavaScript files to inspect\n`);
    return;
  }
  const errors = files.flatMap((file) => inspectFile(file, mode));
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
