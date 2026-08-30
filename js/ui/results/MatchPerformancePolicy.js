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
  survivalMultiplier: 1.2,
  roundDecayByEffectiveRound: Object.freeze({
    1: 0.50,
    2: 0.55,
    3: 0.60,
    4: 0.65,
    5: 0.70,
    6: 0.75,
    7: 0.80,
    8: 0.85,
    9: 0.90,
    10: 0.95
  }),
  fullRoundDecayFrom: 11,
  thresholdsByTeamSize: Object.freeze({
    2: Object.freeze({
      firepower: 2.0,
      support: 0.6,
      activity: 3.2,
      skill: 1.2,
      control: 0.8,
      contribution: 0.8
    }),
    3: Object.freeze({
      firepower: 1.2,
      support: 0.5,
      activity: 2.6,
      skill: 1.1,
      control: 0.6,
      contribution: 0.6
    })
  }),
  controlCardIds: Object.freeze(["scout", "transfer", "plunder", "destroy", "seal"])
});
