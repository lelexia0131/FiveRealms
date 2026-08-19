/**
 * 公共判定展示。只渲染核心已公开的判定牌；牌区移动和判定结果由
 * JudgmentWorkflow 负责，重开时 UIManager 会清空本视图。
 */
import { escapeHtml } from "./templates.js";
import { presentCard } from "../adapters/ui/CardPresentationDefinitions.js";
export class JudgmentView {
  /*
  功能
  绑定公共判定牌展示容器。

  调用方
  UIManager 构造函数。

  输入
  判定视图 DOM 元素。

  输出
  JudgmentView 实例。

  读取状态
  无。

  写入状态
  保存 element 引用。

  调用函数
  无。

  边界与不变量
  本视图只展示已公开判定结果，不拥有牌区移动或判定规则。
  */
  constructor(element) { this.element = element; }
  /*
  功能
  展示已公开的判定牌及判定上下文。

  调用方
  UIManager.showJudgment。

  输入
  判定角色、公开牌实体与可选延迟状态展示上下文。

  输出
  无返回值。

  读取状态
  传入的公开展示字段。

  写入状态
  element 的 HTML 与可见类。

  调用函数
  presentCard、escapeHtml。

  边界与不变量
  不移动卡牌、不计算判定结果；所有插入 DOM 的文本和资源地址必须转义。
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
  /*
  功能
  清空并隐藏公共判定视图。

  调用方
  UIManager.hideJudgment 与 cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  element。

  写入状态
  element 的 HTML 与可见类。

  调用函数
  DOM classList。

  边界与不变量
  隐藏后不得保留上一局的牌面 DOM。
  */
  hide() { this.element.classList.add("is-hidden"); this.element.innerHTML = ""; }
}
