/*
模块职责
唯一拥有真实对局中已证明属于 Domain 的 MatchState 初始化 shape；application/session/presentation 扩展字段不在此维护。

上游
match application constructor 的 composition 与当前 application/match consumer。

下游
无。

状态边界
工厂只创建初始 shape，不读取或写入任何既有 GameState；application match setup 字段不在此维护。

信息边界
纯公开领域状态 shape，无 AI 记忆或隐藏信息策略。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；不得维护 Game.state 的 application-only 字段。
*/
import { RULESET_DEFINITION } from "../../definitions/ruleset/RulesetDefinition.js?build=20260818-skill-rules-locality-refactor";

/*
功能
创建 Domain MatchState 的初始字段集合。

调用方
match application constructor 通过 spread 组合 state。

输入
新对局的 Deck 实例。

输出
冻结的 Domain MatchState 初始字段对象。

读取状态
RULESET_DEFINITION.initialRound。

写入状态
无。

调用函数
无。

边界与不变量
stateVersion 初始为 0，authoritative Domain mutation 经 StateVersion authority 单调递增；gameId/isDisposed/logs/pendingResponses 等非 Domain 字段不得进入本工厂。
*/
export function createMatchState({ deck }) {
  return Object.freeze({
    players: [],
    deck,
    currentPlayerIndex: -1,
    startingPlayerIndex: -1,
    currentRound: RULESET_DEFINITION.initialRound,
    phase: "idle",
    winnerTeam: null,
    publicCardPool: [],
    isGameOver: false,
    stateVersion: 0
  });
}
