/*
模块职责
定义 Application 的真实随机边界：暴露 next() 与严格嵌套的 Action transaction replay；Domain 不得依赖本 port。

上游
match application composition root 与 random consumers。

下游
concrete random source（当前为 MatchApplication constructor 注入的函数）。

状态边界
只保存未提交 Action 的随机读取与 rollback replay 队列；不解释随机规则。

信息边界
不解释随机用途。

架构约束
不得依赖 UI/AI/Audio/Diagnostics、Game runtime 或 Domain transitions。
*/

/*
功能
创建并验证可事务回放的 RandomPort。

调用方
MatchApplication constructor。

输入
注入的 next 能力。

输出
冻结 { next, beginTransaction, commitTransaction, rollbackTransaction } port。

读取状态
内部 replay queue 与 transaction stack。

写入状态
内部 replay queue 与 transaction stack。

调用函数
Object.freeze。

边界与不变量
正常提交时每次 next 直接对应旧 random() 调用；rollback 后先按原顺序重放已观察值，不重复推进底层随机源。
*/
export function createRandomPort({ next }) {
  if (typeof next !== "function") throw new TypeError("RandomPort 需要 next()");
  const replay = [];
  const transactions = [];
  let serial = 0;

  /*
  功能
  返回下一个真实游戏随机值，并登记到当前最内层 Action transaction。

  调用方
  Deck、卡牌、技能与被动效果随机入口。

  输入
  无。

  输出
  底层随机源或 rollback replay queue 的下一个值。

  读取状态
  replay queue、transaction stack 与注入 next source。

  写入状态
  消费 replay 值或记录当前 frame 的已观察值。

  调用函数
  注入 next。

  边界与不变量
  replay 值与底层值对调用方不可区分；嵌套 frame 只由最内层记录，避免父 rollback 重复回放。
  */
  function readNext() {
    const value = replay.length ? replay.shift() : next();
    if (transactions.length) transactions.at(-1).values.push(value);
    return value;
  }

  /*
  功能
  开始一个严格嵌套的随机读取 transaction。

  调用方
  ActionTransaction。

  输入
  无。

  输出
  opaque transaction token。

  读取状态
  serial。

  写入状态
  transaction stack。

  调用函数
  Object.freeze。

  边界与不变量
  token 只允许由同一 RandomPort 的栈顶 commit/rollback。
  */
  function beginTransaction() {
    const token = Object.freeze({ id:++serial });
    transactions.push({ token, values:[] });
    return token;
  }

  /*
  功能
  提交栈顶随机 transaction。

  调用方
  ActionTransaction.commit。

  输入
  beginTransaction 返回的 token。

  输出
  true。

  读取状态
  transaction stack。

  写入状态
  弹出当前 frame；若存在父 frame则把已提交读取合并进去。

  调用函数
  Array.pop/push。

  边界与不变量
  必须严格后进先出；嵌套成功属于父 Action 的随机消费。
  */
  function commitTransaction(token) {
    const frame = transactions.at(-1);
    if (!frame || frame.token !== token) throw new Error("RandomPort transaction 提交顺序非法");
    transactions.pop();
    if (transactions.length) transactions.at(-1).values.push(...frame.values);
    return true;
  }

  /*
  功能
  回滚栈顶随机 transaction 并重放本次已观察值。

  调用方
  ActionTransaction.rollback。

  输入
  beginTransaction 返回的 token。

  输出
  true。

  读取状态
  transaction stack 与 replay queue。

  写入状态
  弹出当前 frame，并把读取值按原顺序放回 replay queue 前端。

  调用函数
  Array.pop/unshift。

  边界与不变量
  回滚值不合并到父 frame；父 Action 后续若再次读取，会把 replay 值只登记一次。
  */
  function rollbackTransaction(token) {
    const frame = transactions.at(-1);
    if (!frame || frame.token !== token) throw new Error("RandomPort transaction 回滚顺序非法");
    transactions.pop();
    replay.unshift(...frame.values);
    return true;
  }

  return Object.freeze({
    next:readNext,
    beginTransaction,
    commitTransaction,
    rollbackTransaction
  });
}
