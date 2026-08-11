/**
 * 无 DOM headless UI。所有真人等待路径返回 false / 空值；
 * 本研究全部座位均为 AI，因此不会阻塞。
 */
export function createHeadlessUi() {
  return {
    render() { },
    appendLog() { },
    cancelPendingInteractions() { },
    async requestResponse() { return false; },
    async requestDiscard(player, count) { return player.hand.slice(0, count); },
    async requestPublicCard(_player, cards) { return cards[0] ?? null; },
    async requestTarget() { return null; },
    async requestHiddenCards() { return []; },
    async requestZoneCard() { return null; },
    async requestCardFlow() { return null; },
    async waitForHumanPlayEnd() { return true; },
    resolveHumanPlayEnd() { },
    setCurrentCard() { },
    setPrompt() { },
    setThinking() { },
    showGameOver() { },
    queueFeedback() { },
    showDying() { },
    hideDying() { },
    showPublicPool() { },
    hidePublicPool() { },
    showJudgment() { },
    hideJudgment() { },
    showDuel() { },
    hideDuel() { },
    showPrivateReveal() { },
    setFastMode() { }
  };
}
