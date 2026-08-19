/**
 * 仅真人可见的临时情报层。关闭时立即清空牌面 DOM；本模块不写公开日志、
 * 不保存 AI 记忆，也不修改任何游戏状态。
 */
import { escapeHtml, privateCardTemplate } from "./templates.js";

export class PrivateRevealView {
  /*
  功能
  绑定仅真人可见的私密展示容器。

  调用方
  UIManager 构造函数。

  输入
  私密展示 DOM 元素。

  输出
  PrivateRevealView 实例。

  读取状态
  无。

  写入状态
  保存 element 并初始化 pending。

  调用函数
  无。

  边界与不变量
  同一视图至多持有一个待关闭 Promise。
  */
  constructor(element) { this.element = element; this.pending = null; }
  /*
  功能
  展示私密牌面并在用户关闭后完成等待。

  调用方
  UIManager.showPrivateReveal、GamePresentationAdapter。

  输入
  私密标题与只允许真人查看的牌实体数组。

  输出
  有牌时返回关闭后完成的 Promise；无牌时立即完成。

  读取状态
  传入牌的 presentation 字段。

  写入状态
  element 内容、可见类与 pending resolve。

  调用函数
  privateCardTemplate、escapeHtml、hide。

  边界与不变量
  不写日志或游戏状态；牌面 DOM 必须在关闭时清空。
  */
  show(title, cards = []) {
    if (!cards.length) { this.element.textContent = title; this.element.classList.remove("is-hidden"); return Promise.resolve(); }
    return new Promise((resolve) => {
      this.pending = resolve;
      this.element.innerHTML = `<div class="response-title"><strong>${escapeHtml(title)}</strong><span>仅你可见</span></div><div class="private-card-grid">${cards.map(privateCardTemplate).join("")}</div><button class="primary-button" type="button" data-close-private>收起情报</button>`;
      this.element.classList.remove("is-hidden");
      this.element.querySelector("[data-close-private]").addEventListener("click", () => this.hide(), { once:true });
    });
  }
  /*
  功能
  关闭私密展示并释放等待中的 workflow。

  调用方
  私密展示关闭按钮与 UIManager.cancelPendingInteractions。

  输入
  无。

  输出
  无返回值。

  读取状态
  pending resolve 与 element。

  写入状态
  清空 pending、DOM 内容与可见类。

  调用函数
  待处理 resolve。

  边界与不变量
  重复关闭安全；一个 pending 只能结算一次。
  */
  hide() { const resolve = this.pending; this.pending = null; this.element.classList.add("is-hidden"); this.element.innerHTML = ""; resolve?.(); }
}
