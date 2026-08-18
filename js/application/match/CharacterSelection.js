/**
 * 本文件封装真人候选与电脑角色分配，依赖角色配置和随机工具。
 * 它不进入对局循环，也不改变阵营；角色与 battleTeam 始终保持独立。
 */
import { CHARACTER_DEFINITIONS } from "../../domain/definitions/characters/CharacterDefinitions.js?build=20260818-skill-rules-locality-refactor";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js?build=20260818-skill-rules-locality-refactor";
import { shuffled } from "../../utils/helpers.js?build=20260818-skill-rules-locality-refactor";
import { CHARACTER_SELECTION_TAGS, SMALL_TEAM_CHARACTER_PRIORITY } from "./CharacterSelectionMetadata.js?build=20260818-skill-rules-locality-refactor";

export class CharacterSelection {
  /*
  功能
  创建并初始化 CharacterSelection 实例。

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
  constructor(random = Math.random) {
    this.random = random;
  }

  /** 随机生成不重复候选；若允许重复仍优先展示不同角色。 */
  /*
  功能
  执行 createCandidates 对应的 CharacterSelection 职责。

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
  执行 assignAiCharacters 对应的 CharacterSelection 职责。

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
