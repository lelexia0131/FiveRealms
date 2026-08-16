/*
模块职责
为未来 Domain Rules 提供不含 controllerType/aiMemory/legacy general/AI probability 的最小只读玩家投影。

上游
domain/rules/** 与 tests。

下游
无。

状态边界
只读 state.players 的已明确 Domain 字段；每次访问重新投影，不缓存可变快照。

信息边界
不暴露 controllerType、aiMemory、portrait、aiProfile、SearchState/VisibleState/BeliefState 或装备概率。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；不得复制整个 Player 或 Card entity。
*/

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
Player 的 id/seat/battleTeam/generalId/resources/alive/handCount/equipment/status keys。

写入状态
无。

调用函数
Object.keys。

边界与不变量
不返回真实 Player 引用；不读取 legacy general 对象或 aiMemory。
*/
function projectRulePlayer(player) {
  return Object.freeze({
    id: player.id,
    seatIndex: player.seatIndex,
    battleTeam: player.battleTeam,
    generalId: player.generalId,
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
  });
}

/*
功能
创建 Domain Rule 专用的最小只读玩家/座次投影视图。

调用方
未来 domain/rules 与 architecture tests。

输入
真实 Game.state 或同形只读 state。

输出
冻结的 rule-facing read view。

读取状态
state.players 与 currentPlayerIndex。

写入状态
无。

调用函数
projectRulePlayer。

边界与不变量
每次 players() 都重新投影；allies/enemies 语义与 legacy StateView 相同但只返回投影。
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
  const players = () => state.players.map(projectRulePlayer);
  /*
  功能
  返回指定玩家含自身在内的存活同阵营投影。

  调用方
  createRuleStateView 内部能力。

  输入
  Rule Player 投影。

  输出
  冻结投影数组。

  读取状态
  players()。

  写入状态
  无。

  调用函数
  Array.filter。

  边界与不变量
  语义与 legacy StateView alliesOf 一致。
  */
  const alliesOf = (player) => players().filter((other) => other.alive && other.battleTeam === player.battleTeam);
  /*
  功能
  返回指定玩家的存活敌对阵营投影。

  调用方
  createRuleStateView 内部能力。

  输入
  Rule Player 投影。

  输出
  冻结投影数组。

  读取状态
  players()。

  写入状态
  无。

  调用函数
  Array.filter。

  边界与不变量
  语义与 legacy StateView enemiesOf 一致。
  */
  const enemiesOf = (player) => players().filter((other) => other.alive && other.battleTeam !== player.battleTeam);
  return Object.freeze({
    players,
    currentActor: () => {
      const current = state.players[state.currentPlayerIndex];
      return current ? projectRulePlayer(current) : null;
    },
    livingPlayers: () => players().filter((player) => player.alive),
    alliesOf,
    enemiesOf,
    seatOrderFrom: (source, includeSource = false) => {
      const ordered = includeSource ? [projectRulePlayer(source)] : [];
      for (let offset = 1; offset < state.players.length; offset += 1) {
        ordered.push(projectRulePlayer(state.players[(source.seatIndex + offset) % state.players.length]));
      }
      return ordered;
    }
  });
}
