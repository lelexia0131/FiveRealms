/*
模块职责
拥有一次 AI 搜索的 data-only、structured-clone-safe 请求契约；不含 Game/Player/Card/函数/UI 或 mutable runtime reference。

上游
AIController 与未来 Worker boundary。

下游
Planner/SearchPolicy/SearchBudget 通过显式拆包消费。

状态边界
只保存冻结普通值；不写 GameState 或 SearchState。

信息边界
searchState 必须已经是合法 Visible/Knowledge/Belief 投影；不得携带敌方真实 hand definition。

架构约束
不得 import Game/Application/Domain transitions；不得把 runtime capability 塞进本契约。
*/

/*
功能
冻结浅层数组与对象，阻止请求构造后的普通数组引用修改。

调用方
createSearchRequest。

输入
任意值。

输出
冻结后的值；对象只冻结当前层。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
搜索状态本身必须已经冻结；本函数不负责深层安全。
*/
function freezeValue(value) {
  if (Array.isArray(value)) return Object.freeze([...value]);
  if (value && typeof value === "object") return Object.freeze({ ...value });
  return value;
}

/*
功能
创建一次 AI search request。

调用方
AIController.selectAction 与 SearchRequest 契约测试。

输入
requestId、gameId、stateVersion、actorId、phase、currentRound、searchState、searchConfig、rng 与 rootActionDescriptors。

输出
冻结 data-only SearchRequest。

读取状态
只读输入。

写入状态
无。

调用函数
freezeValue、Object.freeze。

边界与不变量
不接受函数；rootActionDescriptors 只能是 ActionDescriptor data-only 投影；不保存运行时实体。
*/
export function createSearchRequest({
  requestId,
  gameId,
  stateVersion,
  actorId,
  phase,
  currentRound,
  searchState,
  searchConfig,
  rng,
  rootActionDescriptors
}) {
  if (typeof requestId !== "string" || !requestId) throw new TypeError("SearchRequest 需要 requestId");
  if (typeof gameId !== "string" || !gameId) throw new TypeError("SearchRequest 需要 gameId");
  if (!Number.isInteger(stateVersion) || stateVersion < 0) throw new TypeError("SearchRequest 需要非负整数 stateVersion");
  if (typeof actorId !== "string" || !actorId) throw new TypeError("SearchRequest 需要 actorId");
  if (!searchState || typeof searchState !== "object") throw new TypeError("SearchRequest 需要 searchState");
  if (!searchConfig || typeof searchConfig !== "object") throw new TypeError("SearchRequest 需要 searchConfig");
  if (!rng || typeof rng !== "object" || typeof rng.seed !== "number") {
    throw new TypeError("SearchRequest 需要 rng seed 事实");
  }
  if (!Array.isArray(rootActionDescriptors)) throw new TypeError("SearchRequest 需要 rootActionDescriptors");
  return Object.freeze({
    requestId,
    gameId,
    stateVersion,
    actorId,
    phase,
    currentRound,
    searchState:freezeValue(searchState),
    searchConfig:freezeValue(searchConfig),
    rng:freezeValue(rng),
    rootActionDescriptors:Object.freeze(rootActionDescriptors.map(freezeValue))
  });
}

/*
功能
检查请求 clone 后不存在函数、Game/Player/Card entity、UI 或 mutable runtime reference。

调用方
SearchRequest 序列化测试与 boundary assertion。

输入
待检查请求。

输出
违反项数组；合法请求为空。

读取状态
只读普通对象图。

写入状态
无。

调用函数
Object.keys。

边界与不变量
只检查直接字段和显式 runtime 标记；Game/Player/Card 以原型或标记名识别。
*/
export function searchRequestViolations(request) {
  const violations = [];
  const queue = [request];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") {
      if (typeof value === "function") violations.push("function");
      continue;
    }
    if (typeof value.next === "function" || typeof value.plan === "function") {
      violations.push("runtime capability object");
    }
    if (value.constructor?.name === "Game" || value.constructor?.name === "Player" || value.constructor?.name === "Card") {
      violations.push(`${value.constructor.name} entity`);
    }
    if (value.document || value.window || value instanceof Map || value instanceof Set) {
      violations.push("DOM/Map/Set runtime object");
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "function") violations.push(`function field:${key}`);
      else if (child && typeof child === "object") queue.push(child);
    }
  }
  return [...new Set(violations)];
}
