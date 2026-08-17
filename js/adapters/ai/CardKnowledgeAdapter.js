/*
模块职责
维护真实对局中按卡牌实体 ID 记录的合法私密知识，并提供面向真人的脱敏牌名。

上游
资源移动、私密查看与公开牌池 workflows。

下游
无。

状态边界
只写 Player.aiMemory.knownCardsByPlayer；不写手牌、牌区或 Domain state。

信息边界
只有显式传入的 viewer/owner/card 才能建立知识；离开原手牌时按实体 ID 失效。

架构约束
不得读取未知敌方牌来推断知识，不得拥有 Belief/SearchState。
*/

/*
功能
创建绑定当前玩家列表的实体牌知识适配器。

调用方
composition root。

输入
getPlayers capability。

输出
冻结的知识操作集合。

读取状态
当前玩家与 aiMemory。

写入状态
knownCardsByPlayer buckets。

调用函数
数组查询。

边界与不变量
卡牌实体离开 owner 手牌后必须先 invalidate；真人自己的在手牌实体始终已知。
*/
export function createCardKnowledgeAdapter(getPlayers) {
  if (typeof getPlayers !== "function") throw new TypeError("CardKnowledgeAdapter 缺少 getPlayers capability");
  /*
  功能
  更新或清理 invalidate 对应的 CardKnowledgeAdapter 状态。

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
  const invalidate = (cardId, ownerId) => {
    for (const player of getPlayers()) {
      const known = player.aiMemory?.knownCardsByPlayer?.[ownerId];
      if (known) delete known[cardId];
    }
  };
  /*
  功能
  执行 remember 对应的 CardKnowledgeAdapter 职责。

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
  const remember = (viewer, owner, card) => {
    const bucket = viewer.aiMemory.knownCardsByPlayer[owner.id] ??= {};
    bucket[card.id] = card.definitionId;
  };
  /*
  功能
  判断 isKnownTo 对应的 CardKnowledgeAdapter 条件。

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
  const isKnownTo = (viewer, owner, card) => {
    if (!viewer || !owner || !card) return false;
    if (viewer.id === owner.id && owner.hand.includes(card)) return true;
    return viewer.aiMemory?.knownCardsByPlayer?.[owner.id]?.[card.id] === card.definitionId;
  };
  return Object.freeze({
    invalidate,
    remember,
    isKnownTo,
    /*
    功能
    执行 labelForHuman 对应的 CardKnowledgeAdapter 职责。

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
    labelForHuman(owner, card) {
      const players = getPlayers();
      const human = players.find((player) => player.controllerType === "human") ?? players[0];
      return isKnownTo(human, owner, card) ? `「${card.name}」` : "1张手牌";
    }
  });
}
