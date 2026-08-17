/*
模块职责
拥有隐藏手牌选择的短期 opaque-token/session 数据契约；不保存 Card/Player 实体，只保存 ID 与版本事实。

上游
Application hidden-card workflow 与 UI adapter。

下游
无。

状态边界
只写自身 session/token Map；不写 Domain state。

信息边界
不读取 controllerType/aiMemory/AI/UI 或真实手牌内容。

架构约束
不得依赖 Game runtime、Player/Card entity、DOM、EventDispatcher 或 concrete adapters。
*/

/*
功能
创建 application-owned hidden selection store。

调用方
HiddenCardSelectionAdapter。

输入
注入的 createId 能力。

输出
冻结 store API。

读取状态
无。

写入状态
内部 session/token Map。

调用函数
createId。

边界与不变量
token 只在 selectionId/ownerId/handVersion scope 内有意义。
*/
export function createHiddenCardSelectionStore({ createId }) {
  if (typeof createId !== "function") throw new TypeError("HiddenCardSelectionStore 需要 createId");
  const sessions = new Map();
  const tokenRecords = new Map();

  return Object.freeze({
    sessions,
    tokenRecords,
    /*
    功能
    创建隐藏选择会话与 opaque token records。

    调用方
    HiddenCardSelectionAdapter.createHiddenSelection。

    输入
    ownerId、handVersion 与 cardRecords。

    输出
    { selectionId, ownerId, handVersion, tokens }。

    读取状态
    内部 Maps。

    写入状态
    session 与 token records。

    调用函数
    createId。

    边界与不变量
    不读取或保存 Card entity。
    */
    createSelection({ ownerId, handVersion, cardRecords = [] }) {
      const selectionId = createId("hidden-selection");
      sessions.set(selectionId, { ownerId, version: handVersion });
      const tokens = cardRecords.map((record, index) => {
        const token = createId("opaque");
        tokenRecords.set(token, {
          selectionId,
          ownerId,
          cardId: record.cardId,
          version: handVersion
        });
        return Object.freeze({ token, position: Number(record.position) || index + 1 });
      });
      return Object.freeze({
        selectionId,
        ownerId,
        handVersion,
        tokens: Object.freeze(tokens)
      });
    },

    /*
    功能
    返回 token 记录或 null。

    调用方
    HiddenCardSelectionAdapter.resolveToken。

    输入
    token。

    输出
    冻结记录或 null。

    读取状态
    内部 tokenRecords。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    不含 Card entity。
    */
    getTokenRecord(token) {
      const record = tokenRecords.get(token);
      return record ? Object.freeze({ ...record }) : null;
    },

    /*
    功能
    解析已确认 token 列表为去重 cardId。

    调用方
    HiddenCardSelectionAdapter.resolveConfirmedTokens。

    输入
    tokens、selectionId、ownerId 与 maximum。

    输出
    去重 cardId 数组。

    读取状态
    内部 tokenRecords 与 sessions。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    不检查 handVersion；实体复核由 Application hidden-card workflow 执行。
    */
    resolveConfirmedCardIds(tokens, selectionId, ownerId, maximum) {
      const session = sessions.get(selectionId);
      if (!session || session.ownerId !== ownerId) return [];
      const uniqueTokens = [...new Set(tokens ?? [])].slice(0, Math.max(0, maximum));
      const cardIds = uniqueTokens.map((token) => tokenRecords.get(token))
        .filter((record) => record?.selectionId === selectionId && record.ownerId === ownerId)
        .map((record) => record.cardId);
      return [...new Set(cardIds)];
    },

    /*
    功能
    判断 selection session 是否仍 active。

    调用方
    HiddenCardSelectionAdapter.isSelectionActive。

    输入
    selectionId、ownerId 与 handVersion。

    输出
    布尔值。

    读取状态
    内部 sessions。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    handVersion 变化立即失效。
    */
    getSession(selectionId) {
      const session = sessions.get(selectionId);
      return session ? Object.freeze({ ...session }) : null;
    },

    /*
    功能
    判断 selection session 是否仍 active。

    调用方
    HiddenCardSelectionAdapter.isSelectionActive。

    输入
    selectionId、可选 ownerId 与 handVersion。

    输出
    布尔值。

    读取状态
    内部 sessions。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    handVersion 变化立即失效；ownerId 可选。
    */
    isSessionActive(selectionId, ownerId, handVersion) {
      const session = sessions.get(selectionId);
      return Boolean(session && session.version === handVersion
        && (ownerId === undefined || ownerId === null || session.ownerId === ownerId));
    },

    /*
    功能
    清理一个 selection session 及其全部 token。

    调用方
    HiddenCardSelectionAdapter.clearSelection。

    输入
    selectionId。

    输出
    无。

    读取状态
    内部 Maps。

    写入状态
    删除 session 与 token records。

    调用函数
    无。

    边界与不变量
    只按 selectionId scope 清理。
    */
    clearSelection(selectionId) {
      for (const [token, record] of tokenRecords) {
        if (record.selectionId === selectionId) tokenRecords.delete(token);
      }
      sessions.delete(selectionId);
    },

    /*
    功能
    清理全部 sessions 与 token records。

    调用方
    HiddenCardSelectionAdapter.cleanup。

    输入
    无。

    输出
    无。

    读取状态
    内部 Maps。

    写入状态
    清空内部 Maps。

    调用函数
    无。

    边界与不变量
    对局 dispose/重新征召时使用。
    */
    cleanup() {
      sessions.clear();
      tokenRecords.clear();
    }
  });
}
