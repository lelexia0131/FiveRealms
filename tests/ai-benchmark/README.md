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
npm run test:ai -- --output reports\ai-benchmark.json
```

默认正式运行使用固定 seed，保证 AI 修改前后分数可比较。
`--seed N` 会混入每个 Scenario 的随机种子，用于比较不同随机样本；
`--full` 额外运行少量完整对局（使用减半的搜索预算），仅观察胜率/轮数/失败动作等辅助指标。

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

报告中的 "~800 / ~850 / ~900" 是目标标尺（Reference Scale），
目前不是人类实测数据。尚未进行真实 Human Calibration，未来可扩展。

## 已知边界

- 完整对局（`--full`）只作为辅助诊断，不计入总分；
- Decision Regret 的通用实现依赖独立最优估值，当前以"专家 Scenario + 质量权重"
  代替，见项目内相关说明；
- 规划深度以行为达标率（D1~D4）输出；该统计按全部 Scenario 的 depth 标签聚合
  （不限于 planning 模块），不做虚假的连续深度精度。
- 默认运行不产生任何结果文件；`--output` 为可选显式导出。
- 完整对局（`--full`）只作为辅助诊断，不计入总分。
