/*
模块职责
拥有一次 AI 搜索的 data-only、structured-clone-safe 请求契约；不含 Game/Player/Card/函数/UI 或 mutable runtime reference。

上游
AIController 与 Worker transport boundary。

下游
Worker SearchEngineFactory/Searcher/SearchBudget 通过显式拆包消费。

状态边界
只保存冻结普通值；不写 GameState 或 World。

信息边界
World 必须已经是合法 Fact/Probability 投影；不得携带敌方真实 hand definition。

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
requestId、gameId、stateVersion、actorId、phase、currentRound、canonical World、searchConfig、rng 与 rootActions。

输出
冻结 data-only SearchRequest。

读取状态
只读输入。

写入状态
无。

调用函数
freezeValue、Object.freeze。

边界与不变量
不接受函数；world 与 rootActions 必须直接使用 canonical frozen World/Action，不做 DTO materialization。
*/
export function createSearchRequest({
  requestId,
  gameId,
  stateVersion,
  actorId,
  phase,
  currentRound,
  world,
  searchConfig,
  rng,
  rootActions
}) {
  if (typeof requestId !== "string" || !requestId) throw new TypeError("SearchRequest 需要 requestId");
  if (typeof gameId !== "string" || !gameId) throw new TypeError("SearchRequest 需要 gameId");
  if (!Number.isInteger(stateVersion) || stateVersion < 0) throw new TypeError("SearchRequest 需要非负整数 stateVersion");
  if (typeof actorId !== "string" || !actorId) throw new TypeError("SearchRequest 需要 actorId");
  if (!world || typeof world !== "object") throw new TypeError("SearchRequest 需要 world");
  if (!Object.isFrozen(world)) throw new TypeError("SearchRequest 需要 canonical frozen World");
  if (!searchConfig || typeof searchConfig !== "object") throw new TypeError("SearchRequest 需要 searchConfig");
  if (!rng || typeof rng !== "object" || typeof rng.seed !== "number"
    || typeof rng.state !== "number" || rng.algorithm !== "lcg") {
    throw new TypeError("SearchRequest 需要 lcg rng continuation（seed/state/draws）");
  }
  if (!Array.isArray(rootActions)) throw new TypeError("SearchRequest 需要 rootActions");
  if (rootActions.some((action) => !action || !Object.isFrozen(action))) {
    throw new TypeError("SearchRequest 需要 canonical frozen Actions");
  }
  return Object.freeze({
    requestId,
    gameId,
    stateVersion,
    actorId,
    phase,
    currentRound,
    world,
    searchConfig:freezeValue(searchConfig),
    rng:freezeValue(rng),
    rootActions:Object.freeze([...rootActions])
  });
}
