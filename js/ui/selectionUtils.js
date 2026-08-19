/*
功能
切换一个卡牌选项并返回独立的选择集合。

调用方
InteractionController、PublicPoolView 与 UIManager 的卡牌选择处理。

输入
当前选择集合、待切换值与允许选择的最大数量。

输出
包含切换结果的新 Set。

读取状态
无。

写入状态
无。

调用函数
Set 标准操作。

边界与不变量
不修改传入集合；maximum 为 1 时保持标准单选切换语义，多选不得超过上限。
*/
export function toggleCardSelection(current, value, maximum) {
  const selected = new Set(current ?? []);
  if (selected.has(value)) {
    selected.delete(value);
    return selected;
  }
  if (maximum === 1) {
    selected.clear();
    selected.add(value);
    return selected;
  }
  if (selected.size < maximum) selected.add(value);
  return selected;
}

/*
功能
判断当前选择数量是否满足精确或至多选择要求。

调用方
InteractionController 与 PublicPoolView 的确认按钮逻辑。

输入
选择集合、目标数量以及是否要求精确数量。

输出
选择数量合法时返回 true。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
非精确模式仍要求至少选择一项，且不得超过 count。
*/
export function isCardSelectionValid(selected, count, exact = true) {
  const size = selected?.size ?? 0;
  return exact ? size === count : size >= 1 && size <= count;
}
