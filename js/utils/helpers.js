/**
 * 本文件提供无业务状态的随机、ID 与格式化工具，不依赖游戏模块。
 * 它不应读取 DOM 或直接修改玩家；需要可复现随机时可替换 randomChoice 的随机源。
 */

let serial = 0;

/** 生成本页面生命周期内唯一的可读 ID；会递增模块内计数器。 */
export function createId(prefix = "id") {
  serial += 1;
  return `${prefix}-${Date.now().toString(36)}-${serial.toString(36)}`;
}

/** 使用 Fisher-Yates 算法返回新数组，不修改传入数组。 */
export function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/** 从数组随机选择一项；空数组返回 null，避免调用者因 undefined 继续结算。 */
export function randomChoice(items, random = Math.random) {
  return items.length ? items[Math.floor(random() * items.length)] : null;
}

/** 将数字限制在闭区间内，常用于生命、能量和伤害修正。 */
export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 获取阵营的另一方 ID。 */
export function opposingTeam(teamId) {
  return teamId === "dawn" ? "dusk" : "dawn";
}
