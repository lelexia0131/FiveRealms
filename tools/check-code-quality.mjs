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
  "上游调用方",
  "下游依赖",
  "状态边界",
  "信息边界",
  "架构约束",
]);
const SOURCE_PATTERN = /^js\/.*\.(?:js|mjs|cjs)$/i;
const LAYERED_AI_PATTERN = /^js\/ai\/(?:state|search|simulation|value)\//i;
const STATE_AI_PATTERN = /^js\/ai\/state\//i;

/*
 * 功能：执行只读 Git 命令并返回标准输出。
 * 调用方：changedProductionFiles、changedLines。
 * 输入：Git 参数数组。
 * 输出：成功时返回 UTF-8 文本，命令失败时返回空字符串。
 * 读取状态：当前仓库 Git 索引与工作区。
 * 写入状态：无。
 * 调用函数：execFileSync。
 * 边界与不变量：只允许调用本文件写死的只读 Git 子命令。
 */
function gitOutput(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  } catch {
    return "";
  }
}

/*
 * 功能：把平台路径统一为仓库内使用的正斜杠路径。
 * 调用方：文件发现、错误报告和架构检查。
 * 输入：任意路径字符串。
 * 输出：使用正斜杠的路径字符串。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：String.replaceAll。
 * 边界与不变量：不解析或访问路径，只做分隔符归一化。
 */
function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

/*
 * 功能：列出相对 HEAD 已修改或未跟踪的生产 JavaScript 文件。
 * 调用方：main。
 * 输入：无。
 * 输出：排序、去重后的仓库相对路径数组。
 * 读取状态：Git HEAD、索引、工作区与 ignore 规则。
 * 写入状态：无。
 * 调用函数：gitOutput。
 * 边界与不变量：只检查 js 目录；删除文件不会进入结果。
 */
function changedProductionFiles() {
  const tracked = gitOutput(["diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--", "js"]);
  const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "--", "js"]);
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean).map(normalizePath))]
    .filter((name) => SOURCE_PATTERN.test(name) && fs.existsSync(path.join(ROOT, name)))
    .sort();
}

/*
 * 功能：列出 js 目录下全部生产 JavaScript 文件，用于历史欠债盘点。
 * 调用方：main 的 --all 模式。
 * 输入：起始目录，默认仓库 js 目录。
 * 输出：排序后的仓库相对路径数组。
 * 读取状态：工作区 js 目录树。
 * 写入状态：无。
 * 调用函数：fs.readdirSync、allProductionFiles。
 * 边界与不变量：不跟随目录符号链接，不读取 js 目录之外的文件。
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
 * 功能：判断文件是否已由 Git 跟踪。
 * 调用方：changedLines。
 * 输入：仓库相对路径。
 * 输出：已跟踪返回 true，否则返回 false。
 * 读取状态：Git 索引。
 * 写入状态：无。
 * 调用函数：execFileSync。
 * 边界与不变量：失败只表示未跟踪，不改变索引。
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
 * 功能：提取文件相对 HEAD 的新增或修改行号。
 * 调用方：inspectFile。
 * 输入：仓库相对路径与当前行数。
 * 输出：一基行号 Set；未跟踪文件包含全部行。
 * 读取状态：Git HEAD 与工作区文件。
 * 写入状态：无。
 * 调用函数：isTracked、gitOutput。
 * 边界与不变量：删除行没有新行号；零长度 hunk 不制造伪变更。
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
 * 功能：把字符串和注释替换为空格，同时保留换行与代码花括号位置。
 * 调用方：functionRange。
 * 输入：JavaScript 源码。
 * 输出：与输入等长的轻量词法遮罩文本。
 * 读取状态：无。
 * 写入状态：局部扫描状态。
 * 调用函数：无。
 * 边界与不变量：这是范围定位器而非完整 parser；模板字符串整体视为字符串。
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
 * 功能：识别一行中可维护函数声明的名称与签名位置。
 * 调用方：findFunctions。
 * 输入：单行源码。
 * 输出：识别成功时返回名称与列偏移，否则返回 null。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：RegExp.match。
 * 边界与不变量：排除控制流；单行匿名 lambda 豁免，具名箭头函数不豁免。
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
 * 功能：计算函数从签名行到匹配闭括号的近似范围。
 * 调用方：findFunctions。
 * 输入：源码行、遮罩行、函数起始行。
 * 输出：包含 startLine 和 endLine 的一基范围。
 * 读取状态：无。
 * 写入状态：局部花括号深度。
 * 调用函数：无。
 * 边界与不变量：无块体的具名箭头函数范围仅为签名行。
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
 * 功能：找出文件中的函数名称和近似源代码范围。
 * 调用方：inspectSource。
 * 输入：JavaScript 源码。
 * 输出：函数记录数组。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：maskNonCode、functionSignature、functionRange。
 * 边界与不变量：同一签名行只产生一个记录；不把一行匿名回调当独立函数。
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
 * 功能：读取函数正上方的普通块注释并校验固定字段。
 * 调用方：inspectSource。
 * 输入：源码行与函数起始行。
 * 输出：缺失字段数组；JSDoc 另报普通块注释格式缺失。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：RegExp.test。
 * 边界与不变量：允许函数头与签名之间有空行，不越过其他代码寻找注释。
 */
function missingHeaderFields(lines, startLine) {
  let end = startLine - 2;
  while (end >= 0 && !lines[end].trim()) end -= 1;
  if (end < 0 || !lines[end].includes("*/")) return [...HEADER_FIELDS];
  let start = end;
  while (start >= 0 && !lines[start].includes("/*")) start -= 1;
  if (start < 0) return [...HEADER_FIELDS];
  const header = lines.slice(start, end + 1).join("\n");
  const missing = HEADER_FIELDS.filter((field) => {
    const pattern = new RegExp(`^\\s*\\*?\\s*${field}\\s*[：:]\\s*\\S`, "m");
    return !pattern.test(header);
  });
  if (/^\s*\/\*\*/.test(lines[start])) missing.unshift("普通块注释（禁止 JSDoc）");
  return missing;
}

/*
 * 功能：校验目标分层模块的模块头字段。
 * 调用方：inspectSource。
 * 输入：完整源码。
 * 输出：缺失模块头字段数组。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：RegExp.test。
 * 边界与不变量：只校验文件首个 import 之前的普通块注释。
 */
function missingModuleFields(source) {
  const beforeImport = source.split(/^\s*import\b/m, 1)[0];
  return MODULE_FIELDS.filter((field) => {
    const pattern = new RegExp(`^\\s*\\*?\\s*${field}\\s*[：:]\\s*\\S`, "m");
    return !pattern.test(beforeImport);
  });
}

/*
 * 功能：判断函数范围是否与本次变更行相交。
 * 调用方：inspectSource。
 * 输入：函数记录和变更行 Set。
 * 输出：相交返回 true。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：Set.has。
 * 边界与不变量：--all 使用 null 表示所有函数都需检查。
 */
function functionWasChanged(fn, changed) {
  if (changed === null) return true;
  for (let line = fn.startLine; line <= fn.endLine; line += 1) {
    if (changed.has(line)) return true;
  }
  return false;
}

/*
 * 功能：对单份源码执行 Function Header 和首版 Architecture Guard。
 * 调用方：inspectFile、runSelfTest。
 * 输入：仓库路径、源码、变更行 Set 或 null、是否为新文件。
 * 输出：结构化错误数组。
 * 读取状态：无。
 * 写入状态：无。
 * 调用函数：findFunctions、missingHeaderFields、missingModuleFields。
 * 边界与不变量：Guard 只使用路径、import 和明确回指语法，避免扫描注释关键词。
 */
function inspectSource(file, source, changed, isNewFile = false) {
  const lines = source.split(/\r?\n/);
  const errors = [];
  for (const fn of findFunctions(source)) {
    if (!functionWasChanged(fn, changed)) continue;
    const missing = missingHeaderFields(lines, fn.startLine);
    if (missing.length) errors.push({ file, functionName: fn.name, line: fn.startLine, missing });
  }

  if (LAYERED_AI_PATTERN.test(file)) {
    const uiImport = source.match(/(?:from\s*|import\s*\()\s*["'][^"']*(?:\/ui\/|\/ui\.|\.\.\/ui\/)/i);
    if (uiImport) errors.push({ file, functionName: "<module>", line: source.slice(0, uiImport.index).split(/\r?\n/).length, missing: ["架构约束：search/simulation/value 禁止 UI import"] });
    if (isNewFile) {
      const missing = missingModuleFields(source);
      if (missing.length) errors.push({ file, functionName: "<module>", line: 1, missing });
    }
  }

  if (STATE_AI_PATTERN.test(file)) {
    const orchestrationImport = source.match(
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

  lines.forEach((line, index) => {
    if (changed !== null && !changed.has(index + 1)) return;
    const code = line.replace(/\/\/.*$/, "");
    if (/\b(?:this\.)?game\.aiController\b/.test(code)) {
      errors.push({ file, functionName: "<architecture>", line: index + 1, missing: ["架构约束：禁止新增 game.aiController 回指"] });
    }
  });
  return errors;
}

/*
 * 功能：读取并检查一个工作区生产文件。
 * 调用方：main。
 * 输入：仓库相对路径与检查模式。
 * 输出：结构化错误数组。
 * 读取状态：工作区文件与 Git 变更行。
 * 写入状态：无。
 * 调用函数：changedLines、inspectSource。
 * 边界与不变量：--changed 只约束实际变更函数；--all 约束全部历史函数。
 */
function inspectFile(file, mode) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const lineCount = source.split(/\r?\n/).length;
  const changed = mode === "all" ? null : changedLines(file, lineCount);
  return inspectSource(file, source, changed, !isTracked(file));
}

/*
 * 功能：运行内置通过/失败夹具，防止检查器静默失效。
 * 调用方：main 的 --self-test 模式。
 * 输入：无。
 * 输出：断言失败时抛错，成功时打印摘要。
 * 读取状态：无。
 * 写入状态：标准输出。
 * 调用函数：inspectSource。
 * 边界与不变量：夹具必须同时覆盖完整头、缺字段、JSDoc、UI import、state 逆向 import 和控制器回指。
 */
function runSelfTest() {
  const pass = `/*
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
  const fail = `/**
 * 功能：错误夹具。
 */
function broken() { return game.aiController; }`;
  const passErrors = inspectSource("js/fixture-pass.js", pass, null, true);
  if (passErrors.length) throw new Error(`passing fixture failed: ${JSON.stringify(passErrors)}`);
  const failErrors = inspectSource("js/fixture-fail.js", fail, null, true);
  if (!failErrors.some((error) => error.functionName === "broken" && error.missing.includes("输入"))) {
    throw new Error("failing fixture did not detect missing Function Header fields");
  }
  if (!failErrors.some((error) => error.missing.some((item) => item.includes("JSDoc")))) {
    throw new Error("failing fixture did not reject JSDoc");
  }
  if (!failErrors.some((error) => error.functionName === "<architecture>")) {
    throw new Error("failing fixture did not detect game.aiController backreference");
  }
  const uiErrors = inspectSource(
    "js/ai/search/BadSearch.js",
    `import { UI } from "../../ui/UI.js";\n${pass}`,
    null,
    true,
  );
  if (!uiErrors.some((error) => error.missing.some((item) => item.includes("UI import")))) {
    throw new Error("failing fixture did not detect layered UI import");
  }
  const stateErrors = inspectSource(
    "js/ai/state/BadState.js",
    `import { AiPlanner } from "../AiPlanner.js";\n${pass}`,
    null,
    true,
  );
  if (!stateErrors.some((error) => error.missing.some((item) => item.includes("state 禁止依赖")))) {
    throw new Error("failing fixture did not detect state orchestration import");
  }
  process.stdout.write("code-quality self-test passed: complete header, missing fields, JSDoc, controller backreference, layered UI import, and state dependency direction\n");
}

/*
 * 功能：解析命令行模式、运行检查并设置进程退出码。
 * 调用方：Node.js 入口。
 * 输入：process.argv 中的 --changed、--all 或 --self-test。
 * 输出：标准输出/错误与退出码。
 * 读取状态：生产源码和只读 Git 状态。
 * 写入状态：process.exitCode。
 * 调用函数：changedProductionFiles、allProductionFiles、inspectFile、runSelfTest。
 * 边界与不变量：默认模式永远是 --changed；未知参数立即失败。
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
