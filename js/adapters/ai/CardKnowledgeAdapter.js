/*
模块职责
维护真实对局中按卡牌实体 ID 记录的合法私密知识，并提供指定 viewer 的知识查询。

上游
资源移动、私密查看与公开牌池 workflows。

下游
无。

状态边界
只写 Player.aiMemory.knownCardsByPlayer；不写手牌、牌区或 Domain state。

信息边界
只有显式传入的 viewer/owner/card 才能建立知识；离开原手牌时按实体 ID 失效。

架构约束
不得读取未知敌方牌来推断知识，不得拥有 Belief/World。
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
  从所有观察者记忆中移除离开原手牌的实体牌知识。

  调用方
  ResourceWorkflow 的牌区移动能力。

  输入
  卡牌实体 ID 与原 owner ID。

  输出
  无返回值。

  读取状态
  getPlayers 返回的各玩家 aiMemory。

  写入状态
  删除 knownCardsByPlayer[ownerId][cardId]。

  调用函数
  getPlayers。

  边界与不变量
  只按实体 ID 失效，不能按 definitionId 误删同名牌知识。
  */
  const invalidate = (cardId, ownerId) => {
    for (const player of getPlayers()) {
      const known = player.aiMemory?.knownCardsByPlayer?.[ownerId];
      if (known) delete known[cardId];
    }
  };
  /*
  功能
  记录某观察者已合法看见 owner 的指定实体牌。

  调用方
  私密查看、公开牌池与判定观察 workflows。

  输入
  viewer、owner 与已被合法揭示的 Card 实体。

  输出
  该实体定义此前未知时返回 true；已经知道时返回 false。

  读取状态
  viewer.aiMemory 与 card.definitionId。

  写入状态
  knownCardsByPlayer[owner.id][card.id]。

  调用函数
  无。

  边界与不变量
  只有调用方显式提供的合法观察可建立知识，不能推断未见牌。
  */
  const remember = (viewer, owner, card) => {
    const bucket = viewer.aiMemory.knownCardsByPlayer[owner.id] ??= {};
    const definitionId = card.definitionId;
    const newlyKnown = bucket[card.id] !== definitionId;
    bucket[card.id] = definitionId;
    return newlyKnown;
  };
  /*
  功能
  判断指定观察者是否仍合法知道某实体牌定义。

  调用方
  ResourceWorkflow、MatchLogAdapter 与 ResponseWorkflow。

  输入
  viewer、owner 与待判断 Card 实体。

  输出
  当前知识与实体定义一致时返回 true。

  读取状态
  owner.hand 与 viewer.aiMemory.knownCardsByPlayer。

  写入状态
  无。

  调用函数
  Array.includes。

  边界与不变量
  自己只对仍在手牌的实体天然已知；记忆必须同时匹配 card.id 和当前 definitionId。
  */
  const isKnownTo = (viewer, owner, card) => {
    if (!viewer || !owner || !card) return false;
    if (viewer.id === owner.id && owner.hand.includes(card)) return true;
    return viewer.aiMemory?.knownCardsByPlayer?.[owner.id]?.[card.id] === card.definitionId;
  };
  return Object.freeze({ invalidate, remember, isKnownTo });
}
