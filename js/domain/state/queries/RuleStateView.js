/*
模块职责
为 Domain Rules 提供不含 controllerType/aiMemory/character/AI probability 的最小只读玩家投影。

上游
domain/rules/** 与 tests。

下游
无。

状态边界
只读 state.players 的已明确 Domain 字段；每次访问重新投影，不缓存可变快照。

信息边界
不暴露 controllerType、aiMemory、portrait、aiProfile、AI Probability/World 或装备概率。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；不得复制整个 Player 或 Card entity。

投影契约
players() 永远返回按 seatIndex 物理排序的完整 canonical seat roster（含阵亡座位）；currentActor()/playerById() 返回 Rule Player projection；alliesOf/enemiesOf/seatOrderFrom 的 player/source 参数只接受本模块生成的 Rule Player projection，不接受真实 Player 或 SearchState。playerById 是唯一的 ID 查询入口。seat-order Domain Rule 只接受 players() 这类 full roster，不得传入 filtered candidates。
*/
const RULE_PLAYER_PROJECTION = Symbol("rulePlayerProjection");


/*
功能
把真实 Player 投影为 Domain Rule 可读的最小事实对象。

调用方
createRuleStateView。

输入
真实 Player。

输出
冻结的 Domain 玩家事实。

读取状态
Player 的 id/seat/battleTeam/characterId/resources/alive/handCount/equipment/status keys。

写入状态
无。

调用函数
Object.keys。

边界与不变量
不返回真实 Player 引用；不读取 character 对象或 aiMemory。
*/
function projectRulePlayer(player) {
  const projection = {
    id: player.id,
    seatIndex: player.seatIndex,
    battleTeam: player.battleTeam,
    characterId: player.characterId,
    hp: player.hp,
    maxHp: player.maxHp,
    shield: player.shield,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    attackRange: player.attackRange,
    alive: player.alive,
    handCount: player.hand.length,
    equipmentDefinitionId: player.equipment?.definitionId ?? null,
    statusIds: Object.freeze(Object.keys(player.statuses))
  };
  Object.defineProperty(projection, RULE_PLAYER_PROJECTION, { value: true });
  return Object.freeze(projection);
}

/*
功能
校验输入必须是本模块生成的 Rule Player projection。

调用方
createRuleStateView 的 alliesOf/enemiesOf/seatOrderFrom。

输入
player 或 source。

输出
校验失败时抛出 TypeError，否则返回原投影。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
不读取 player.hand/statuses 等真实 Player 字段，不做 dual-schema 兼容。
*/
function requireRulePlayerProjection(player) {
  if (!player || player[RULE_PLAYER_PROJECTION] !== true) {
    throw new TypeError("RuleStateView source 必须是本模块返回的 Rule Player projection");
  }
  return player;
}

/*
功能
创建 Domain Rule 专用的最小只读玩家/座次投影视图。

调用方
未来 domain/rules 与 architecture tests。

输入
真实 MatchState 或同形只读 state。

输出
冻结的 rule-facing read view。

读取状态
state.players 与 currentPlayerIndex。

写入状态
无。

调用函数
projectRulePlayer。

边界与不变量
每次 players() 都重新投影；allies/enemies 语义与 StateView 相同但只返回投影。
*/
export function createRuleStateView(state) {
  /*
  功能
  返回全部玩家的新 Domain Rule 投影数组。

  调用方
  createRuleStateView 内部能力。

  输入
  无。

  输出
  冻结的投影数组。

  读取状态
  state.players 的 Domain 字段。

  写入状态
  无。

  调用函数
  projectRulePlayer。

  边界与不变量
  每次调用重新投影，不返回真实 Player。
  */
  const players = () => state.players
    .map(projectRulePlayer)
    .sort((left, right) => left.seatIndex - right.seatIndex);
  /*
  功能
  返回指定玩家含自身在内的存活同阵营投影。

  调用方
  createRuleStateView 内部能力。

  输入
  Rule Player projection。

  输出
  冻结投影数组。

  读取状态
  players()。

  写入状态
  无。

  调用函数
  Array.filter。

  边界与不变量
  语义与 StateView alliesOf 一致。
  */
  const alliesOf = (player) => {
    requireRulePlayerProjection(player);
    return players().filter((other) => other.alive && other.battleTeam === player.battleTeam);
  };
  /*
  功能
  返回指定玩家的存活敌对阵营投影。

  调用方
  createRuleStateView 内部能力。

  输入
  Rule Player projection。

  输出
  冻结投影数组。

  读取状态
  players()。

  写入状态
  无。

  调用函数
  Array.filter。

  边界与不变量
  语义与 StateView enemiesOf 一致。
  */
  const enemiesOf = (player) => {
    requireRulePlayerProjection(player);
    return players().filter((other) => other.alive && other.battleTeam !== player.battleTeam);
  };
  /*
  功能
  按玩家 ID 返回 Rule Player 投影。

  调用方
  TeamRules 与 Domain Rules。

  输入
  player id。

  输出
  冻结投影或 null。

  读取状态
  state.players。

  写入状态
  无。

  调用函数
  projectRulePlayer。

  边界与不变量
  不返回真实 Player。
  */
  const playerById = (id) => {
    const current = state.players.find((player) => player.id === id);
    return current ? projectRulePlayer(current) : null;
  };
  /*
  功能
  按状态 ID 返回指定投影的状态详情副本或 null。

  调用方
  Status Rules 与 tests。

  输入
  Rule Player projection 与 statusId。

  输出
  冻结状态详情副本、原始 primitive 或 null。

  读取状态
  state.players 的指定 statuses 条目。

  写入状态
  无。

  调用函数
  requireRulePlayerProjection。

  边界与不变量
  不返回整个 statuses 对象；不暴露真实 Player。
  */
  const status = (player, statusId) => {
    requireRulePlayerProjection(player);
    const current = state.players.find((entry) => entry.id === player.id);
    const value = current?.statuses?.[statusId];
    if (value === undefined) return null;
    if (value === null || typeof value !== "object") return value;
    return Object.freeze({ ...value });
  };
  /*
  功能
  返回指定投影的本回合使用计数事实。

  调用方
  Turn Rules 与 tests。

  输入
  Rule Player projection。

  输出
  冻结 usage 事实。

  读取状态
  state.players 的 turnFlags 使用字段。

  写入状态
  无。

  调用函数
  requireRulePlayerProjection。

  边界与不变量
  只暴露四个明确计数，不暴露整个 turnFlags。
  */
  const usage = (player) => {
    requireRulePlayerProjection(player);
    const current = state.players.find((entry) => entry.id === player.id);
    return Object.freeze({
      attackUsed: Number(current?.turnFlags?.attackUsed ?? 0),
      attackLimit: Number(current?.turnFlags?.attackLimit ?? 0),
      recoverUsed: Number(current?.turnFlags?.recoverUsed ?? 0),
      recoverLimit: current?.turnFlags?.recoverLimit ?? null
    });
  };
  /*
  功能
  返回指定投影的连势值。

  调用方
  Turn Rules 与 tests。

  输入
  Rule Player projection。

  输出
  非负整数。

  读取状态
  state.players 的 turnFlags.momentum。

  写入状态
  无。

  调用函数
  requireRulePlayerProjection。

  边界与不变量
  只暴露单一明确字段。
  */
  const momentum = (player) => {
    requireRulePlayerProjection(player);
    const current = state.players.find((entry) => entry.id === player.id);
    return Math.max(0, Number(current?.turnFlags?.momentum ?? 0) || 0);
  };
  return Object.freeze({
    players,
    playerById,
    currentActor: () => {
      const current = state.players[state.currentPlayerIndex];
      return current ? projectRulePlayer(current) : null;
    },
    livingPlayers: () => players().filter((player) => player.alive),
    status,
    usage,
    momentum,
    alliesOf,
    enemiesOf,
    seatOrderFrom: (source, includeSource = false) => {
      requireRulePlayerProjection(source);
      const ordered = includeSource ? [source] : [];
      for (let offset = 1; offset < state.players.length; offset += 1) {
        ordered.push(projectRulePlayer(state.players[(source.seatIndex + offset) % state.players.length]));
      }
      return ordered;
    }
  });
}
