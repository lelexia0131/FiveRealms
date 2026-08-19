/**
 * 本文件提供无业务状态的随机、ID 与格式化工具，不依赖游戏模块。
 * 它不应读取 DOM 或直接修改玩家；需要可复现随机时可替换 randomChoice 的随机源。
 */

let serial = 0;

/*
功能
生成当前页面生命周期内唯一且可读的标识符。

调用方
对局实体、请求、事件、日志与隐藏选择的创建入口。

输入
ID 的语义前缀。

输出
由前缀、当前时间和递增序号组成的字符串。

读取状态
模块级 serial 与当前时间。

写入状态
模块级 serial 递增一次。

调用函数
Date.now。

边界与不变量
只保证当前页面生命周期内唯一；不得用于可复现 RNG 或安全令牌。
*/
export function createId(prefix = "id") {
  serial += 1;
  return `${prefix}-${Date.now().toString(36)}-${serial.toString(36)}`;
}

/*
功能
使用 Fisher-Yates 算法生成输入序列的随机排列副本。

调用方
发牌、角色候选与需要无偏随机顺序的对局流程。

输入
可迭代数组与返回 [0, 1) 数值的随机函数。

输出
包含相同元素的新数组。

读取状态
仅调用传入的 random 能力。

写入状态
无；只修改函数内副本。

调用函数
random。

边界与不变量
不得修改原数组；随机调用次数和 Fisher-Yates 顺序必须保持稳定。
*/
export function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/*
功能
从数组中等概率选择一项。

调用方
角色分配、规则随机目标与 AI 非搜索随机选择。

输入
候选数组与返回 [0, 1) 数值的随机函数。

输出
命中的数组元素；空数组返回 null。

读取状态
仅调用传入的 random 能力。

写入状态
无。

调用函数
random。

边界与不变量
空候选不得返回 undefined；不得额外消费随机数。
*/
export function randomChoice(items, random = Math.random) {
  return items.length ? items[Math.floor(random() * items.length)] : null;
}

/*
功能
把数值限制在给定闭区间内。

调用方
生命、能量、伤害与 AI 数值投影。

输入
待限制数值以及最小值、最大值。

输出
位于 [minimum, maximum] 的数值。

读取状态
无。

写入状态
无。

调用函数
Math.min、Math.max。

边界与不变量
调用方负责保证 minimum 不大于 maximum。
*/
export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/*
功能
返回两阵营规则中与给定阵营相对的一方。

调用方
组队规则、角色分配与测试 fixture。

输入
阵营 ID。

输出
dawn 对应 dusk；其余输入对应 dawn。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
仅适用于当前 dawn/dusk 双阵营契约；合法性由调用方保证。
*/
export function opposingTeam(teamId) {
  return teamId === "dawn" ? "dusk" : "dawn";
}
