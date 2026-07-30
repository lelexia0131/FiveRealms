/**
 * 统一卡牌选择状态。maximum=1 时采用标准单选切换；多选仍保留追加/取消行为。
 * 返回新 Set，避免视图之间共享并污染上一次选择。
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

export function isCardSelectionValid(selected, count, exact = true) {
  const size = selected?.size ?? 0;
  return exact ? size === count : size >= 1 && size <= count;
}
