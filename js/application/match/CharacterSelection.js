/**
 * 本文件封装真人候选与电脑角色分配，依赖角色配置和随机工具。
 * 它不进入对局循环，也不改变阵营；角色与 battleTeam 始终保持独立。
 */
import { CHARACTER_DEFINITIONS } from "../../domain/definitions/characters/CharacterDefinitions.js";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import { shuffled } from "../../utils/helpers.js";
import { CHARACTER_SELECTION_TAGS, SMALL_TEAM_CHARACTER_PRIORITY } from "./CharacterSelectionMetadata.js";

export class CharacterSelection {
  /*
  功能
  创建使用指定随机源的角色选择器。

  调用方
  composition root 与测试。

  输入
  random，返回 [0, 1) 数值的随机函数。

  输出
  初始化完成的 CharacterSelection 实例。

  读取状态
  无。

  写入状态
  this.random。

  调用函数
  无。

  边界与不变量
  不自行消费随机数；缺省随机源保持 Math.random。
  */
  constructor(random = Math.random) {
    this.random = random;
  }

  /** 随机生成不重复候选；若允许重复仍优先展示不同角色。 */
  /*
  功能
  随机生成真人可选的角色候选。

  调用方
  MatchWorkflow 角色选择阶段与测试。

  输入
  无。

  输出
  不超过规则候选数的角色定义数组。

  读取状态
  CHARACTER_DEFINITIONS、RULESET_DEFINITION.characterCandidateCount 与 this.random。

  写入状态
  无。

  调用函数
  shuffled。

  边界与不变量
  只返回打乱后的前 N 个定义，不修改定义集合。
  */
  createCandidates() {
    return shuffled(CHARACTER_DEFINITIONS, this.random).slice(0, RULESET_DEFINITION.characterCandidateCount);
  }

  /**
   * 为四名电脑分配剩余角色。采用简单标签多样性权重，避免同队全为同类定位。
   * @param {Array<Player>} aiPlayers 电脑座位。
   * @param {string} selectedCharacterId 真人已选角色 ID。
   * @returns {Array<Object>} 按 aiPlayers 顺序排列的角色配置。
   */
  /*
  功能
  按队伍标签多样性为 AI 座位分配角色。

  调用方
  MatchWorkflow 确认真人角色后的 AI 分配阶段与测试。

  输入
  AI Player entity 数组、真人角色 ID 与可选小队 ID。

  输出
  与 aiPlayers 顺序一致的角色定义数组。

  读取状态
  角色定义、选择标签、规则重复开关、玩家 battleTeam 与 this.random。

  写入状态
  无；仅修改本方法局部候选池与分配记录。

  调用函数
  shuffled、Array filter/map/sort/splice。

  边界与不变量
  不修改 Player entity；禁止重复角色时每次选择后从局部池移除同一定义。
  */
  assignAiCharacters(aiPlayers, selectedCharacterId, smallTeamId = null) {
    const pool = shuffled(CHARACTER_DEFINITIONS.filter((character) => RULESET_DEFINITION.allowDuplicateCharacters || character.id !== selectedCharacterId), this.random);
    const assigned = [];
    for (const player of aiPlayers) {
      const teammateTags = assigned
        .filter((entry) => entry.player.battleTeam === player.battleTeam)
        .flatMap((entry) => CHARACTER_SELECTION_TAGS[entry.character.id] ?? []);
      const ranked = pool.map((character, index) => ({
        character,
        index,
        diversity: (CHARACTER_SELECTION_TAGS[character.id] ?? []).filter((tag) => !teammateTags.includes(tag)).length
          + (player.battleTeam === smallTeamId ? (SMALL_TEAM_CHARACTER_PRIORITY[character.id] ?? 0) : 0)
          + this.random() * 0.5
      })).sort((a, b) => b.diversity - a.diversity);
      const choice = ranked[0];
      assigned.push({ player, character: choice.character });
      if (!RULESET_DEFINITION.allowDuplicateCharacters) pool.splice(choice.index, 1);
    }
    return assigned.map((entry) => entry.character);
  }
}
