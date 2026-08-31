export const MATCH_PERFORMANCE_DIMENSIONS = Object.freeze([
  "firepower",
  "support",
  "activity",
  "skill",
  "control",
  "contribution"
]);

export const MATCH_PERFORMANCE_LABELS = Object.freeze({
  firepower: "火力",
  support: "支援",
  activity: "行动",
  skill: "技能",
  control: "控制",
  contribution: "贡献"
});

export const MATCH_PERFORMANCE_POLICY = Object.freeze({
  killBonus: 5,
  rescueMultiplier: 2,
  aliveVictoryMultiplier: 1.2,
  clutchVictoryMultipliersByTeamSize: Object.freeze({
    2: Object.freeze({ 2: 1.3, 3: 1.5 }),
    3: Object.freeze({ 1: 1.5, 2: 2.0 })
  }),
  roundMultiplierByEffectiveRound: Object.freeze({
    1: 0.30,
    2: 0.40,
    3: 0.50,
    4: 0.55,
    5: 0.60,
    6: 0.65,
    7: 0.70,
    8: 0.75,
    9: 0.80,
    10: 0.85,
    11: 0.90,
    12: 0.95,
    13: 1.00
  }),
  incrementalRoundMultiplierFrom: 14,
  roundMultiplierIncrement: 0.01,
  thresholdsByTeamSize: Object.freeze({
    2: Object.freeze({
      firepower: 2.0,
      support: 0.6,
      activity: 3.2,
      skill: 1.1,
      control: 0.8,
      contribution: 0.7
    }),
    3: Object.freeze({
      firepower: 1.2,
      support: 0.5,
      activity: 2.6,
      skill: 1.0,
      control: 0.6,
      contribution: 0.5
    })
  }),
  controlCardIds: Object.freeze(["scout", "transfer", "plunder", "destroy", "seal"])
});
