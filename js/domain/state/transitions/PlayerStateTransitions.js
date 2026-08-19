/*
模块职责
拥有 PlayerState primitive 字段的 root-aware 通用原子写操作；不拥有角色选择、character 兼容引用、规则或 workflow 决定。

上游
Player 的 method boundary 与直接测试。

下游
无。

状态边界
只修改传入 state.stateVersion 与 Player primitive state 字段。

信息边界
不读取 controllerType、aiMemory、AI 或隐藏信息。

架构约束
不得依赖 Game/EventDispatcher/UI/AI/application/adapters；不得实现技能/回合规则。
*/
import { bumpStateVersion } from "./StateVersion.js";

/*
功能
将已决定的角色定义应用到 PlayerState。

调用方
MatchWorkflow.confirmCharacter、Player.applyCharacter 与直接测试。

输入
state、Player 与 character definition。

输出
实际变化字段数量。

读取状态
state.stateVersion、Player Domain 字段与 character 定义。

写入状态
Player 的角色身份与资源初始字段；实际变化时只 bump 一次。

调用函数
bumpStateVersion。

边界与不变量
不写 character 引用，不决定选择哪名角色。
*/
export function applyCharacterDefinition(state, player, character) {
  const before = [
    player.characterId,
    player.name,
    player.loreFaction,
    player.maxHp,
    player.hp,
    player.energy
  ];
  player.characterId = character.id;
  player.name = character.name;
  player.loreFaction = character.loreFaction;
  player.maxHp = character.maxHp;
  player.hp = character.maxHp;
  player.energy = character.initialEnergy ?? 0;
  const after = [
    player.characterId,
    player.name,
    player.loreFaction,
    player.maxHp,
    player.hp,
    player.energy
  ];
  if (before.some((value, index) => value !== after[index])) bumpStateVersion(state);
  return after.filter((value, index) => before[index] !== value).length;
}

/*
功能
递增手牌版本并返回新版本。

调用方
ResourceWorkflow、JudgmentWorkflow、Player boundary 与 HiddenCardChoiceWorkflow。

输入
state 与 Player。

输出
新 handVersion。

读取状态
state.stateVersion、player.handVersion。

写入状态
player.handVersion；bump stateVersion 一次。

调用函数
bumpStateVersion。

边界与不变量
handVersion 与 stateVersion 语义分离，但真实 hand 变化属于 Domain commit。
*/
export function bumpHandVersion(state, player) {
  player.handVersion += 1;
  bumpStateVersion(state);
  return player.handVersion;
}

/*
功能
写入存活标记。

调用方
DyingWorkflow 与直接测试。

输入
state、Player 与布尔值。

输出
写入后的布尔值。

读取状态
state.stateVersion、player.alive。

写入状态
player.alive；变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
不触发 dying/death 流程。
*/
export function setAlive(state, player, alive) {
  if (player.alive === alive) return alive;
  player.alive = alive;
  bumpStateVersion(state);
  return alive;
}

/*
功能
写入装备槽 Card 引用。

调用方
ResourceWorkflow equipment movement 与直接测试。

输入
state、Player 与 Card 或 null。

输出
写入后的装备引用。

读取状态
state.stateVersion、player.equipment。

写入状态
player.equipment；引用变化时 bump。

调用函数
bumpStateVersion。

边界与不变量
保持 Card 身份；不处理旧装备去向。
*/
export function setEquipment(state, player, card) {
  if (player.equipment === card) return card;
  player.equipment = card;
  bumpStateVersion(state);
  return card;
}
