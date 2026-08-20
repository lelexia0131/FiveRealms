/*
功能
把横向卡牌容器恢复到本次重绘前的位置，并限制在新的有效滚动范围内。

调用方
UIManager 的主手牌/敌方手牌 renderer、PublicPoolView.show 与 UI 回归测试。

输入
重绘后的横向容器与重绘前 scrollLeft。

输出
实际写入的合法 scrollLeft。

读取状态
容器 scrollWidth、clientWidth。

写入状态
容器 scrollLeft。

调用函数
Number、Math.max、Math.min。

边界与不变量
缺少容器时返回0；非法旧值按0处理；不得超过新的 maxScrollLeft。
*/
export function restoreHorizontalCardScroll(container, previousScrollLeft) {
  if (!container) return 0;
  const maxScrollLeft = Math.max(0, Number(container.scrollWidth) - Number(container.clientWidth));
  const requestedScrollLeft = Math.max(0, Number(previousScrollLeft) || 0);
  const nextScrollLeft = Math.min(requestedScrollLeft, maxScrollLeft);
  container.scrollLeft = nextScrollLeft;
  return nextScrollLeft;
}
