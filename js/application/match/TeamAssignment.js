import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import { getTeamSize } from "../../domain/rules/team/TeamRules.js";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js";
import { TEAM_ASSIGNMENT_MODE, TEAM_ASSIGNMENT_MODES } from "./TeamAssignmentMode.js";

const SMALL_TEAM_ID = "dawn";
const LARGE_TEAM_ID = "dusk";

export class TeamAssignment {
  /*
  功能
  按编队方式生成满足 2V3 规则的逐座位阵营数组。

  调用方
  MatchWorkflow 初始化与测试。

  输入
  random，返回 [0, 1) 数值的座次随机函数；mode 为 two、three 或 random。

  输出
  与座位索引一一对应的 dawn/dusk 数组，其中 dawn 固定两人、dusk 固定三人。

  读取状态
  RULESET_DEFINITION 的玩家数与两队人数。

  写入状态
  无。

  调用函数
  random、Array.reverse、Array.map。

  边界与不变量
  人数配置必须闭合且两名晨星成员始终隔座；阵营 ID 只由人数绑定，随机数只能改变合法座次。
  */
  static assignTeams(random = Math.random, mode) {
    if (RULESET_DEFINITION.smallTeamSize + RULESET_DEFINITION.largeTeamSize !== RULESET_DEFINITION.playerCount) {
      throw new Error("阵营人数配置之和必须等于玩家总数");
    }
    if (!TEAM_ASSIGNMENT_MODES.includes(mode)) throw new TypeError(`未知编队方式：${mode}`);

    if (mode !== TEAM_ASSIGNMENT_MODE.RANDOM) {
      if (mode === TEAM_ASSIGNMENT_MODE.TWO) {
        const teammateSeats = [2, 3];
        const teammateSeat = teammateSeats[Math.floor(random() * teammateSeats.length)];
        return Array.from(
          { length: RULESET_DEFINITION.playerCount },
          (_, seatIndex) => seatIndex === 0 || seatIndex === teammateSeat ? SMALL_TEAM_ID : LARGE_TEAM_ID
        );
      }
      const opposingSeatPairs = [[1, 3], [1, 4], [2, 4]];
      const opposingSeats = opposingSeatPairs[Math.floor(random() * opposingSeatPairs.length)];
      return Array.from(
        { length: RULESET_DEFINITION.playerCount },
        (_, seatIndex) => opposingSeats.includes(seatIndex) ? SMALL_TEAM_ID : LARGE_TEAM_ID
      );
    }

    // 两名小队成员固定隔座，再随机旋转与翻转；因此永不相邻且真人仍可能进入任一队。
    let seats = [SMALL_TEAM_ID, LARGE_TEAM_ID, SMALL_TEAM_ID, LARGE_TEAM_ID, LARGE_TEAM_ID];
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
