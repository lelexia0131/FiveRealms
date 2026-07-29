import { Game } from "../js/core/Game.js";

const GAME_COUNT = Number(process.env.FIVE_REALMS_GAMES ?? 200);
const makeRandom = (seedValue) => {
  let seed = seedValue >>> 0;
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
};
const ui = () => ({
  render(){}, appendLog(){}, cancelPendingInteractions(){}, async requestResponse(){return false;},
  async requestDiscard(player,count){return player.hand.slice(0,count);}, async requestPublicCard(_player,cards){return cards[0]??null;},
  setCurrentCard(){}, setPrompt(){}, setThinking(){}, showGameOver(){}, queueFeedback(){}, showDying(){}, hideDying(){},
  showPublicPool(){}, hidePublicPool(){}, showJudgment(){}, showDuel(){}, hideDuel(){}, showPrivateReveal(){}, setFastMode(){}
});

const totals = { smallWins:0, largeWins:0, stalled:0, deathCleanupViolations:0, rounds:0, reshuffles:0, equipmentUses:0, equipmentByType:{ energyDevice:0, recycleDevice:0, defenseDevice:0, battleDevice:0 }, attacks:0, dyingEntries:0, rescues:0, smallDamage:0, largeDamage:0, smallHealing:0, largeHealing:0, smallAttacks:0, largeAttacks:0 };
const stallSnapshots = [];
const SEED_BASE = Number(process.env.FIVE_REALMS_SEED_BASE ?? 0x9e3779b9);
const START_INDEX = Number(process.env.FIVE_REALMS_START_INDEX ?? 0);
for (let offset = 0; offset < GAME_COUNT; offset += 1) {
  const index = START_INDEX + offset;
  const game = new Game(ui(), makeRandom(SEED_BASE ^ (index * 2654435761)));
  game.simulationMode = true;
  game.animationFastMode = true;
  game.aiSearchBudgetOverrideMs = Number(process.env.FIVE_REALMS_SEARCH_BUDGET ?? 900);
  game.cleanupManager.delay = async () => !game.state.isDisposed;
  const candidates = game.startSelection();
  game.state.players[0].controllerType = "ai";
  game.eventBus.on("afterCardMove", `balance:equip:${index}`, (event) => { if (event.to === "equipment") { totals.equipmentUses += 1; totals.equipmentByType[event.card.definitionId] += 1; } });
  game.eventBus.on("playerDying", `balance:dying:${index}`, () => { totals.dyingEntries += 1; });
  game.eventBus.on("playerRescued", `balance:rescue:${index}`, () => { totals.rescues += 1; });
  game.eventBus.on("playerDead", `balance:dead:${index}`, (event) => { if (event.target.hand.length || event.target.equipment) totals.deathCleanupViolations += 1; });
  game.eventBus.on("roundStart", `balance:round-cap:${index}`, (event) => {
    if (event.round > 250) { game.state.isGameOver = true; game.state.phase = "gameOver"; }
  });
  await game.confirmGeneral(candidates[index % candidates.length].id);
  await game.loopPromise;
  const smallTeam = ["dawn","dusk"].find((team) => game.state.players.filter((player) => player.battleTeam === team).length === 2);
  if (!game.state.winnerTeam) {
    totals.stalled += 1;
    if (stallSnapshots.length < 3) stallSnapshots.push({ index, players:game.state.players.map((player) => ({ team:player.battleTeam, seat:player.seatIndex, alive:player.alive, hp:player.hp, hand:player.hand.map((card)=>card.definitionId), equipment:player.equipment?.definitionId ?? null })) });
  }
  else if (game.state.winnerTeam === smallTeam) totals.smallWins += 1;
  else totals.largeWins += 1;
  totals.rounds += game.state.currentRound;
  totals.reshuffles += game.state.deck.reshuffleCount;
  totals.attacks += game.state.players.reduce((sum, player) => sum + player.statistics.assaultsUsed, 0);
  for (const player of game.state.players) {
    const prefix = player.battleTeam === smallTeam ? "small" : "large";
    totals[`${prefix}Damage`] += player.statistics.damageDealt;
    totals[`${prefix}Healing`] += player.statistics.healingDone;
    totals[`${prefix}Attacks`] += player.statistics.assaultsUsed;
  }
  game.dispose();
}

const completed = Math.max(1, GAME_COUNT - totals.stalled);
const report = {
  games:GAME_COUNT,
  completedGames:GAME_COUNT - totals.stalled,
  stalledGames:totals.stalled,
  deathCleanupViolations:totals.deathCleanupViolations,
  stalledSamples:stallSnapshots,
  smallTeamWinRate:Number((totals.smallWins / completed * 100).toFixed(1)),
  largeTeamWinRate:Number((totals.largeWins / completed * 100).toFixed(1)),
  averageRounds:Number((totals.rounds / GAME_COUNT).toFixed(2)),
  averageReshuffles:Number((totals.reshuffles / GAME_COUNT).toFixed(2)),
  averageEquipmentUses:Number((totals.equipmentUses / GAME_COUNT).toFixed(2)),
  equipmentUsesByType:totals.equipmentByType,
  averageAssaults:Number((totals.attacks / GAME_COUNT).toFixed(2)),
  rescueRate:totals.dyingEntries ? Number((totals.rescues / totals.dyingEntries * 100).toFixed(1)) : 0
  ,averageSmallTeamDamage:Number((totals.smallDamage / GAME_COUNT).toFixed(2))
  ,averageLargeTeamDamage:Number((totals.largeDamage / GAME_COUNT).toFixed(2))
  ,averageSmallTeamHealing:Number((totals.smallHealing / GAME_COUNT).toFixed(2))
  ,averageLargeTeamHealing:Number((totals.largeHealing / GAME_COUNT).toFixed(2))
  ,averageSmallTeamAssaults:Number((totals.smallAttacks / GAME_COUNT).toFixed(2))
  ,averageLargeTeamAssaults:Number((totals.largeAttacks / GAME_COUNT).toFixed(2))
};
console.log(JSON.stringify(report, null, 2));
if (report.stalledGames > 0) {
  console.error(`平衡警告：${report.stalledGames} 局超过250轮仍未结束。`);
  process.exitCode = 1;
}
if (report.smallTeamWinRate < 40 || report.smallTeamWinRate > 60) {
  console.error(`平衡警告：小队胜率 ${report.smallTeamWinRate}% 超出目标 40%–60%。`);
  process.exitCode = 1;
}
