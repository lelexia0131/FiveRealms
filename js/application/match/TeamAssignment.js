/**
 * 本文件负责 2V3 阵营生成与阵营查询，依赖游戏配置和洗牌工具。
 * 它不根据角色、名字或座位推断阵营；battleTeam 是唯一判断来源。
 */
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import { getTeamSize } from "../../domain/rules/team/TeamRules.js";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js";

export class TeamAssignment {
  /**
   * 随机返回每个座位的阵营 ID，严格保证 2V3。
   * @param {()=>number} random 随机源。
   * @returns {Array<"dawn"|"dusk">} 与座位索引一一对应的阵营。
   */
  /*
  功能
  执行 assignTeams 对应的 TeamAssignment 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
  */
  static assignTeams(random = Math.random) {
    if (RULESET_DEFINITION.smallTeamSize + RULESET_DEFINITION.largeTeamSize !== RULESET_DEFINITION.playerCount) {
      throw new Error("阵营人数配置之和必须等于玩家总数");
    }
    const smallTeam = random() < 0.5 ? "dawn" : "dusk";
    const largeTeam = smallTeam === "dawn" ? "dusk" : "dawn";
    // 两名小队成员固定隔座，再随机旋转与翻转；因此永不相邻且真人仍可能进入任一队。
    let seats = [smallTeam, largeTeam, smallTeam, largeTeam, largeTeam];
    if (random() < 0.5) seats = [...seats].reverse();
    const rotation = Math.floor(random() * seats.length);
    return seats.map((_, index) => seats[(index + rotation) % seats.length]);
  }

  /*
  功能
  返回某阵营的总座位数。

  调用方
  match application 初始化日志与 consumers。

  输入
  players 数组与 teamId。

  输出
  阵营人数。

  读取状态
  players.battleTeam。

  写入状态
  无。

  调用函数
  getTeamSize。

  边界与不变量
  只转发 Domain Team Rule。
  */
  static teamSize(players, teamId) {
    return getTeamSize({ players:createRuleStateView({ players }).players() }, teamId);
  }
}
