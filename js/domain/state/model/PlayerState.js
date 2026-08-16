/*
模块职责
唯一拥有 Player runtime 中已证明属于 Domain 的核心玩家状态初始化 shape。

上游
Player constructor 的 legacy composition 与未来 domain/rules consumer。

下游
无。

状态边界
工厂只创建初始 shape，不读取或写入任何既有 Player 实例。

信息边界
不含 controllerType、aiMemory、statistics 或 AI/UI 信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；turnFlags/roundFlags/gameFlags 的规则归属延后处理，不在此声明。
*/
import { RULESET_DEFINITION } from "../../definitions/ruleset/RulesetDefinition.js?build=20260815-shadow-agent-p1-slot";

/*
功能
创建 Domain PlayerState 的初始字段集合。

调用方
Player constructor 按旧 key order 逐字段赋值。

输入
玩家 id、seatIndex 与 battleTeam。

输出
冻结的 Domain PlayerState 初始字段对象。

读取状态
RULESET_DEFINITION.defaultMaxEnergy/defaultAttackRange。

写入状态
无。

调用函数
无。

边界与不变量
hand/statuses 等可变容器由调用方继续持有原身份；本工厂不得复制或重建 runtime entity。
*/
export function createPlayerState({ id, seatIndex, battleTeam }) {
  return Object.freeze({
    id,
    seatIndex,
    battleTeam,
    generalId: null,
    name: "待选择",
    loreFaction: "未知",
    general: null,
    hp: 0,
    maxHp: 0,
    shield: 0,
    energy: 0,
    maxEnergy: RULESET_DEFINITION.defaultMaxEnergy,
    attackRange: RULESET_DEFINITION.defaultAttackRange,
    hand: [],
    handVersion: 0,
    equipment: null,
    statuses: {},
    alive: true
  });
}
