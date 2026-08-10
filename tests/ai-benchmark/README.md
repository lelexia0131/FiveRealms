# FiveRealms AI Benchmark

独立的 AI 能力 Benchmark，用于评价 FiveRealms AI 对规则、卡牌、角色技能、
数值资源、连招、局面、概率、规划深度与稳定性的掌握程度，输出 0~1000 分报告。

它与 `npm run test:balance` 的定位不同：

- `test:balance`：大规模完整对局统计（胜率、角色平衡、卡牌价值实验）；
- `test:ai`：可控微局面（Micro Scenario）下的 AI 行为评分。

## 运行命令

```powershell
npm run test:ai
```

默认命令开箱即用，结束后直接在终端输出完整报告，不产生结果文件。

可选参数：

```powershell
npm run test:ai -- --seed 12345
npm run test:ai -- --node-budget 1200
npm run test:ai -- --category combos
npm run test:ai -- --verbose
npm run test:ai -- --full          # 额外运行少量完整对局诊断（不计分）
npm run test:ai -- --calibration   # 输出完整三 Agent 标定表（默认已包含，此参数用于显式强调）
npm run test:ai -- --chance-audit  # 输出 Chance Floor 详细审计
npm run test:ai -- --planner-audit # 输出 Planner Effectiveness 详细审计
npm run test:ai -- --output reports\ai-benchmark.json
```

默认正式运行使用固定 seed，保证 AI 修改前后分数可比较。
`--seed N` 会混入每个 Scenario 的随机种子，用于比较不同随机样本；
`--full` 额外运行少量完整对局（使用减半的搜索预算），仅观察胜率/轮数/失败动作等辅助指标。

## Chance-Corrected Scoring（v0.4）

Raw Score 会因"随机猜中"而虚高。v0.4 引入每个 Scenario 的
**Random Legal Expected（Chance Floor）**：

```text
C = (P - R) / (1 - R)
```

其中 P = Agent raw quality，R = Random Legal Expected quality。
含义：0 = 仅达到随机合法选择期望，1 = 达到该场景最优。

- Random Legal Expected 通过**精确枚举生产合法动作**并逐动作评分取平均得到，
  与 seed 无关（当前 131 个计分 Scenario 全部可精确枚举，无需 Monte Carlo）；
- R >= 0.99 的场景无能力区分度，不参与 corrected 计分（仍参与 raw）；
- P < R（低于随机期望）的场景单独列为 Below Random Expectation 诊断，
  corrected 贡献按 0 计，不制造负总分；
- 总分同时输出 Raw 与 Chance-Corrected 两套，Raw 用于与历史版本比较。

## 跨回合资源（AiPlanner Phase 1）修复记录

曾出现两条"Planner Regression"（Greedy=100 / Production=10）：

- `hard.cross-turn-energy`
- `adv.save-energy-next-turn`

根因审计结论：**不是 Planner 缺陷，而是 Benchmark 场景构造错误**。
`tests/ai-benchmark/helpers.mjs` 的 `makeGame` 在填充 `state.players` 之前
调用 `teamRules.getMaxEnergy`，导致全部场景的 maxEnergy 错误回退为 3
（生产规则中 2 人小队的 maxEnergy=4）。在该错误状态下：

- 场景判定的"正确"答案（突袭保留能量）基于不存在的规则；
- Planner 搜索在错误规则下选择聚能→焚场，被误判为严重错误。

修复：

1. `makeGame` 先填充 `state.players` 再按生产 `TeamRuleService` 计算 maxEnergy；
2. 受影响场景（`hard.cross-turn-energy`、`adv.save-energy-next-turn`、
   `planning.d4-energy-save-next-turn`、`cf.charge-at-threshold`）的评分基准
   改为反映真实规则：这些局面下"先聚能/先突袭"终态等价，均为合理行动。

修复后：

- 原两条 Regression 消除（Greedy 与 Production 决策一致）；
- Cross-turn 题集 Regression 0%、净提升 0pp；
- Setup/Combo Planner Lift 保持 +32.1pp（未把 Planner 退化成 Greedy）；
- Expert Planner Lift 从 -3.0pp 改善为 +15.0pp。

本轮未修改任何生产 AI 代码；该修复属于 Benchmark 场景正确性修正。

## Planner Effectiveness Audit（v0.4）

逐 Scenario 比较 Production 与 Greedy/D1 的质量：

- Planner Win：P > G；
- No Lift：P == G；
- Planner Regression：P < G。

报告输出 Win / No Lift / Regression 比例、净提升（pp）、按题集（planning /
adversarial / cross-turn / response-bait / setup）与按难度（basic~expert）
的细分，以及 Top Wins / Top Regressions 清单，供后续优化 Planner 使用。

## 多级 Agent 标定（v0.3）

Benchmark 在完全相同的 Scenario 集上运行三个 Agent：

| Agent | 允许的能力 | 禁止的能力 |
| --- | --- | --- |
| Random Legal | 读取生产合法动作集合、均匀随机选择（deterministic seed） | 任何 evaluator / simulator / planner / 估值 |
| Greedy / D1 | 生产 AiEvaluator + AiSimulator 的一步评估 | AiPlanner / AIController.selectAction（无搜索、无前瞻） |
| Production AI | AIController → AiPlanner → AiSimulator → AiEvaluator 原样 | 无（这是被测对象） |

三个 Agent 使用完全相同的局面、完全相同的可见信息与完全相同的评分函数。
报告输出：

- Agent Calibration（三 Agent 总分）；
- Capability Lift（Random→Greedy、Greedy→Production、Random→Production）；
- Module Comparison（每模块三 Agent 分数）；
- Greedy Saturation（Greedy/Production，>80% 的模块列为 discrimination warning）；
- Decision Quality（Optimal/Strong/Acceptable/Poor/Severe/Catastrophic 分布，
  含 Severe+Catastrophic 错误率）；
- Planning Lift over D1（all / planning / adversarial planning 三个题集）；
- Difficulty Pass Rate（basic/intermediate/advanced/expert 各 Agent 通过率）；
- Adversarial Performance（Immediate Reward / Resource / Buff Waste / Response Bait /
  Target / Healing / Cross-turn / Setup 分类通过率）。

## Difficulty / Discrimination 标签

每个 Scenario 带诊断字段：

```js
difficulty: "basic" | "intermediate" | "advanced" | "expert"
discrimination: "legality" | "static-value" | "tactical" | "planning" | "probability" | "counterfactual"
adversarial: null | "immediate-reward" | "resource" | "buff-waste" | "response-bait" | "target" | "healing" | "cross-turn" | "setup"
```

标签只用于报告分层统计，不直接参与计分。

## 评分结构（总分 1000）

基础能力与智能能力分离：只会"合法行动、知道卡牌基础用途、会发动技能"
的脚本级 AI 只可能拿到基础模块的约 135/140 分，总分上限被刻意压低。

| 模块 | 满分 | 定位 |
| --- | ---: | --- |
| Basic Rules & Legality | 40 | 基础：合法性 |
| Basic Card Knowledge | 50 | 基础：卡牌基础用途 |
| Basic Skill Knowledge | 50 | 基础：技能基础规则 |
| Numerical & Resource Reasoning | 110 | 智能：数值/资源 |
| Board / Threat Reasoning | 120 | 智能：威胁与局面 |
| Card-Skill Synergy | 140 | 智能：卡牌×技能协同 |
| Tactics & Action Ordering | 170 | 智能：牌序与连招 |
| Hidden Info & Probability | 110 | 智能：概率推理 |
| Multi-step Planning | 180 | 智能：多步规划 |
| Counterfactual Adaptation | 30 | 智能：反事实适应 |

每个 Scenario 产出 0.00 ~ 1.00 的质量分：

- 1.00 Optimal 明确最优或等价最优；
- 0.70 Strong 强决策（小损失）；
- 0.50 Acceptable 可接受（明显但合理损失）；
- 0.25 Poor 次优/错误顺序；
- 0.10 Severe 严重误判（如必被反制仍打战术牌）；
- 0.00 Catastrophic 非法/灾难性。

模块分数 = 模块内 Scenario 平均质量 × 模块满分。总分严格为 1000。

稳定性（Stability）不再计入总分，只作为独立诊断输出：
决策稳定性 / 等价局面一致性 / 种子敏感度。
一致性本身不是智能，一个永远选同一张牌的 AI 也可以 100% 稳定。

## Counterfactual Families

Benchmark 以"Scenario Family"为主要结构：同一基础局面只变化一个关键变量
（目标 HP、护盾、格挡/反制概率、能量、队友血量、敌方装备等），
检查 AI 是否在合理阈值附近改变决策。每个变体带有 `family` 与 `expectedClass`，
报告会输出每个 Family 的变体数量、类别敏感度与平均质量。

## 区分度与深度消融

报告默认附带两组参考（均不计分）：

- Script Baseline：固定的无规划启发式 Agent，代表"会规则、会发动技能、
  但无战术规划"的脚本 AI；其总分用于说明真实 AI 的区分度。
- Depth-1 贪心消融：在生产 evaluator 上只取一步即时价值，不做前瞻；
  与真实 AI 的差距用于判断 Planning 场景是否真的需要深度搜索。

## Scenario 结构

每个 Scenario 由四部分组成：

```js
registerScenario({
  id: "cards.assault-marginal-kill",   // 唯一 ID，同时决定随机种子
  name: "必杀突袭的边际价值",
  category: "cards",                   // 九个模块之一
  depth: 1,                            // 规划深度级别 1~4（诊断用）
  runs: 1,                             // 重复运行次数（稳定性场景 > 1）
  setup: () => ({ players, options }), // 构造局面（使用生产 Game/Player/卡牌定义）
  grade: ({ action, legalActions, stats, game }) => ({ score, reason })
});
```

评分函数接收的是 AI 实际选择（`action`）、合法动作列表与搜索统计，
以专家答案表或规则判断给出 0~1 质量分。评分不读取 AI 内部估值函数的返回值，
避免自证循环。

## 如何添加新 Scenario

1. 按被测能力选择 `tests/ai-benchmark/scenarios/<模块>.mjs`；
2. 调用 `registerScenario` 添加一条；
3. `setup` 用 `helpers.js` 的 `makeGame` / `makeCard` 构造局面；
4. `grade` 根据 `describeActionShort(action)` 与目标/卡牌/技能判断给分；
5. 运行 `npm run test:ai` 验证。

局面构造禁止读取对手真实手牌内容；未知手牌只能以数量与剩余牌密度进入 AI 视角
（由生产 `AiVisibleState` / `AiKnowledge` 保证）。

## Human Target 说明

报告中的 "~800 / ~850 / ~900" 是 **Reference target —— NOT human calibrated**。
尚未进行真实 Human Calibration，不能据此推断"接近真人"。
Total Score 仅代表当前 Benchmark Scenario 集上的能力分。

## 已知边界

- 完整对局（`--full`）只作为辅助诊断，不计入总分；
- Decision Regret 的通用实现依赖独立最优估值，当前以"专家 Scenario + 质量权重"
  代替，见项目内相关说明；
- 规划深度以行为达标率（D1~D4）输出；该统计按全部 Scenario 的 depth 标签聚合
  （不限于 planning 模块），不做虚假的连续深度精度。
- 默认运行不产生任何结果文件；`--output` 为可选显式导出。
- 规划深度报告为不同难度/规划需求题集的达标率（D1-set ~ D4-set），
  不保证严格单调，也不代表统一深度能力曲线。
- 完整对局（`--full`）只作为辅助诊断，不计入总分。
