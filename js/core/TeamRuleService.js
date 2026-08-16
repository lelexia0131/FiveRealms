/**
 * 阵营补偿查询 legacy façade；公式 authority 已迁至 domain/rules/team/TeamRules.js。
 */
import {
  getAttackLimitFromRules, getDrawCountFromRules, getInitialHandCountFromRules,
  getMaxEnergyFromRules, getRecoverLimitFromRules, getTeamRules, getTeamSize,
  getTurnEnergyBreakdownFromRules, getTurnEnergyGainFromRules, isSmallTeam
} from "../domain/rules/team/TeamRules.js?build=20260816-legacy-recovery";
import { createRuleStateView } from "../domain/state/queries/RuleStateView.js?build=20260816-legacy-recovery";

export class TeamRuleService {
  constructor(game) { this.game = game; }

  /*
  功能
  返回阵营人数。

  调用方
  Game 与 legacy consumers。

  输入
  player 或 team id。

  输出
  人数。

  读取状态
  state.players。

  写入状态
  无。

  调用函数
  getTeamSize。

  边界与不变量
  只转发 Domain Rule。
  */
  getTeamSize(playerOrTeam) {
    return getTeamSize(this.#ruleState(), playerOrTeam);
  }

  /*
  功能
  判断是否二人小队。

  调用方
  legacy consumers。

  输入
  player 或 team。

  输出
  布尔值。

  读取状态
  state。

  写入状态
  无。

  调用函数
  isSmallTeam。

  边界与不变量
  只转发 Domain Rule。
  */
  isSmallTeam(playerOrTeam) {
    return isSmallTeam(this.#ruleState(), playerOrTeam);
  }

  /*
  功能
  返回阵营补偿规则对象。

  调用方
  Game 与 AI projection。

  输入
  player。

  输出
  冻结规则对象。

  读取状态
  state。

  写入状态
  无。

  调用函数
  getTeamRules。

  边界与不变量
  只转发 Domain Rule。
  */
  getRules(player) {
    return getTeamRules(this.#ruleState(), this.#playerFact(player));
  }

  /*
  功能
  返回开局手牌数。

  调用方
  Game setup。

  输入
  player。

  输出
  整数。

  读取状态
  state。

  写入状态
  无。

  调用函数
  getInitialHandCount。

  边界与不变量
  只转发 Domain Rule。
  */
  getInitialHandCount(player) {
    return getInitialHandCountFromRules(this.getRules(player));
  }
  /*
  功能
  返回每回合摸牌数。

  调用方
  Game.takeTurn。

  输入
  player。

  输出
  整数。

  读取状态
  state。

  写入状态
  无。

  调用函数
  getDrawCount。

  边界与不变量
  只转发 Domain Rule。
  */
  getDrawCount(player) {
    return getDrawCountFromRules(this.getRules(player));
  }
  /*
  功能
  返回突袭上限。

  调用方
  Player reset 与 legality。

  输入
  player。

  输出
  整数。

  读取状态
  state。

  写入状态
  无。

  调用函数
  getAttackLimit。

  边界与不变量
  只转发 Domain Rule。
  */
  getAttackLimit(player) { return getAttackLimitFromRules(this.getRules(player)); }
  /*
  功能
  返回调息上限。

  调用方
  reset 与 legality。

  输入
  player。

  输出
  整数或 null。

  读取状态
  state。

  写入状态
  无。

  调用函数
  getRecoverLimit。

  边界与不变量
  只转发 Domain Rule。
  */
  getRecoverLimit(player) { return getRecoverLimitFromRules(this.getRules(player)); }
  /*
  功能
  返回能量上限。

  调用方
  setup/reset 与 AI。

  输入
  player。

  输出
  整数。

  读取状态
  state。

  写入状态
  无。

  调用函数
  getMaxEnergy。

  边界与不变量
  只转发 Domain Rule。
  */
  getMaxEnergy(player) {
    return getMaxEnergyFromRules(this.getRules(player));
  }
  /*
  功能
  返回玩家回合总能量获取。

  调用方
  Game.takeTurn 与 legacy consumers。

  输入
  player。

  输出
  整数。

  读取状态
  state 与已决定 team rules。

  写入状态
  无。

  调用函数
  getRules、getTurnEnergyGainFromRules、#playerFact。

  边界与不变量
  公式由 Domain Team Rule 唯一拥有。
  */
  getTurnEnergyGain(player) {
    return getTurnEnergyGainFromRules(
      this.getRules(player),
      this.#playerFact(player)?.equipmentDefinitionId ?? null
    );
  }
  /*
  功能
  返回回合能量分项。

  调用方
  Game.takeTurn 与 AI projection。

  输入
  player。

  输出
  breakdown。

  读取状态
  state。

  写入状态
  无。

  调用函数
  getTurnEnergyBreakdown。

  边界与不变量
  只转发 Domain Rule。
  */
  getTurnEnergyBreakdown(player) {
    return getTurnEnergyBreakdownFromRules(
      this.getRules(player),
      this.#playerFact(player)?.equipmentDefinitionId ?? null
    );
  }

  #ruleState() {
    return { players: createRuleStateView(this.game.state).players() };
  }

  #playerFact(player) {
    if (!player || typeof player === "string") return player;
    return {
      battleTeam: player.battleTeam,
      equipmentDefinitionId: player.equipmentDefinitionId ?? player.equipment?.definitionId ?? null
    };
  }
}
