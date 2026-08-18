/**
 * 公共判定展示。只渲染核心已公开的判定牌；牌区移动和判定结果由
 * JudgmentWorkflow 负责，重开时 UIManager 会清空本视图。
 */
import { escapeHtml } from "./templates.js";
import { presentCard } from "../adapters/ui/CardPresentationDefinitions.js";
export class JudgmentView {
  constructor(element) { this.element = element; }
  /*
  功能
  生成或展示 show 对应的 JudgmentView 视图。

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
  show(player, card, context = {}) {
    card = presentCard(card);
    const delayedStatus = context.delayedStatusContext;
    const heading = delayedStatus
      ? `${delayedStatus.ownerName}的「${delayedStatus.statusName}」正在判定`
      : `防御判定 · ${player.name}`;
    this.element.innerHTML = `<span>${escapeHtml(heading)}</span><img src="${escapeHtml(card.art)}" alt="${escapeHtml(card.name)}"><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.categoryName)}</small>`;
    this.element.classList.remove("is-hidden");
  }
  hide() { this.element.classList.add("is-hidden"); this.element.innerHTML = ""; }
}
