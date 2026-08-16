/**
 * Application Combat HP-loss workflow 的 legacy compatibility façade。
 * “失去生命” sequencing authority 已迁至 js/application/combat/CombatWorkflow.js；
 * 本文件只转发，不包含第二份 workflow。
 */
export class HpLossSystem {
  /*
  功能
  创建 legacy HpLossSystem façade。

  调用方
  Game constructor。

  输入
  game。

  输出
  HpLossSystem façade。

  读取状态
  无。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只保存 workflow 引用；Game.damage 与 loseHp 不合并。
  */
  constructor(game) {
    this.game = game;
    this.workflow = game.combatWorkflow;
  }

  /*
  功能
  转发 Application CombatWorkflow.loseHp。

  调用方
  legacy tests 与 future effects。

  输入
  player、amount 与 context。

  输出
  实际失去生命量。

  读取状态
  无。

  写入状态
  无。

  调用函数
  this.workflow.loseHp。

  边界与不变量
  继续绕过护盾/格挡/雷达；不复制 workflow。
  */
  lose(...args) { return this.workflow.loseHp(...args); }
}
