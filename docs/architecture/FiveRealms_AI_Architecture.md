# FiveRealms AI Engine — Architecture Contract

## Before / After Absorption + Final 18-File Contract

> 目的：作为 FiveRealms AI Engine 的正式架构指南与 Step 5 最终 Architecture Contract，记录「吸收前」与「吸收后」文件架构、旧模块向最终 18 文件架构的职责归属，以及后续所有重构必须遵守的 authority / data / dependency 边界。
>
> 核心原则：
>
> - ARCHITECTURE：职责单一、数据结构唯一、无跨层越权、无重复 authority
> - SEMANTICS：合法动作、模拟规则、概率判断、价值知识、Pattern/战略知识均不得丢失
> - COMPLEXITY：消灭跨 transition branch genealogy、无界乘法扩张，降低局部 N×M，减少 clone / materialization / DTO conversion
> - PERFORMANCE：同预算提高 node throughput / root coverage，减少 TIME fallback，并降低 latency / memory
> - INTELLIGENCE：关键行为 contract 不回归，同等 SearchBudget 下决策质量不得低于旧版
>
> **Contract 优先级：** 本文中各 canonical owner 的职责定义高于历史文件名、旧调用路径和第 7 节吸收表。任何旧函数都必须按真实 semantic 重新分类，不得因为“旧文件曾属于某模块”就整体搬迁。
>
> **当前状态：** Final Semantic Authority Closure COMPLETE；18-file AI architecture FROZEN。

---

# 1. 吸收前 AI 系统

吸收前 `js/ai/` 约为 **51 个 JS 文件**。

```text
js/ai/
│
├─ AiController.js
│
├─ domain/
│  ├─ GlobalBenefitModel.js
│  ├─ LightningModel.js
│  ├─ RadarModel.js
│  └─ SealModel.js
│
├─ policy/
│  ├─ AiRuntimePolicy.js
│  ├─ CardSelectionBoundary.js
│  ├─ CardSelectionPolicy.js
│  ├─ CharacterRoleMetadata.js
│  ├─ ResourceSelectionPolicy.js
│  ├─ ResponseBoundary.js
│  ├─ ResponsePolicy.js
│  └─ TransferPolicy.js
│
├─ search/
│  ├─ Action.js
│  ├─ ActionGenerator.js
│  ├─ Searcher.js
│  ├─ SearchRng.js
│  ├─ PatternMatcher.js
│  ├─ ProductionPatterns.js
│  ├─ SealPrior.js
│  ├─ SearchPrior.js
│  ├─ SearchBudget.js
│  ├─ SearchRequest.js
│  ├─ WorkerSearchOutcome.js
│  ├─ TacticResolutionQuery.js
│  └─ CounterfactualTerms.js
│
├─ simulation/
│  ├─ CardEffectSimulation.js
│  ├─ CombatSimulation.js
│  ├─ ResourceValueQuery.js
│  ├─ ResponseSimulation.js
│  ├─ RootResolutionQuery.js
│  ├─ Simulator.js
│  ├─ SkillEffectSimulation.js
│  ├─ StatusSimulation.js
│  └─ ValueSimulationQuery.js
│
├─ state/
│  ├─ DistanceProbabilityBranches.js
│  ├─ Fact.js
│  ├─ RuleProjection.js
│  ├─ StateContracts.js
│  ├─ World.js
│  └─ Probability/
│     ├─ Probability.js
│     ├─ Branch.js
│     └─ Pool.js
│
└─ value/
   ├─ CardValue.js
   ├─ Economics.js
   ├─ Evaluator.js
   ├─ GlobalBenefitValue.js
   ├─ SealValue.js
   ├─ StateValue.js
   ├─ ThreatValue.js
   └─ ValueLedger.js
```

## 1.1 吸收前主要问题

### 架构层

- `policy/` 同时承担候选生成、选择、执行边界、局部价值等不同职责。
- `search/` 中存在大量 `Prior / Query / Request / Outcome` 中间层。
- `simulation/` 中存在多套 `*Simulation` 与 `*ValueQuery`，Simulation 与 Evaluation 边界不够纯。
- `value/` 中存在 `Economics / ThreatValue / SealValue / GlobalBenefitValue / ValueLedger` 等多个部分重叠的价值 authority。
- `state/` 中存在 `StateContracts / RuleProjection / DistanceProbabilityBranches` 等中间数据/投影层。
- `ai/domain/` 又建立了一层 AI 专属 Domain Model，与正式 Domain Rule authority 容易重复。

### 数据层

历史上容易形成：

```text
Game State
→ Visible/Belief/Search State
→ Request DTO
→ Simulation DTO
→ Evaluation DTO
→ Result DTO
```

重构目标是取消多套状态/动作表示，统一为 canonical contract。

### 搜索层

历史搜索链容易形成：

```text
Searcher
→ SearchPolicy
→ SearchPrior
→ CandidateMaterializer
→ TransitionValue
→ FrontierValue
→ SiblingTerms
→ SearchResult
```

导致搜索语义被拆散到多个中间模块。

### 概率层

旧概率模型的主要复杂度风险：

```text
transition branches
× transition branches
× transition branches
→ branch genealogy / Cartesian expansion
```

容易出现跨 transition 历史分支累积、N×M 扩张和 materialization。

---

# 2. 吸收后最终 AI 系统

最终目标收缩为 **18 个 JS 文件**

```text
js/ai/
│
├─ Controller.js
│
├─ Generator/
│  ├─ Generator.js
│  └─ Action.js
│
├─ Searcher/
│  ├─ Searcher.js
│  ├─ Rng.js
│  └─ Pattern.js
│
├─ Event/
│  ├─ Fact.js
│  └─ Probability/
│     ├─ Probability.js
│     ├─ Branch.js
│     └─ Pool.js
│
├─ Simulator/
│  ├─ Simulator.js
│  ├─ World.js
│  ├─ Damage.js
│  ├─ Resource.js
│  └─ Response.js
│
└─ Evaluator/
   ├─ Evaluator.js
   ├─ StateValue.js
   └─ CardValue.js
```

这 18 个物理文件不等于 18 个业务 authority。核心 authority 仍然只有少量 canonical owner；`Branch / Pool / Damage / Resource / Response / StateValue / CardValue / Rng / Pattern` 等文件是受其 facade 约束的 implementation module。

---

# 3. 最终 18 文件职责

## 3.1 `Controller.js`

唯一职责：

> 真实 Game 与 AI Engine 的边界。

```text
REAL GAME
   ↓
Controller
   ↓
Generator
   ↓
Searcher
   ↓
canonical Action
   ↓
Controller
   ↓
REAL GAME
```

不得拥有：

- 搜索算法
- 概率算法
- 模拟规则
- 价值公式
- Pattern 战略知识

Controller 是唯一 runtime/composition public boundary：`createRuntimeComposition`、
`createSearchEngine`、`executeSearchRequest` 与 Search RNG 初始化都从这里公开。
真实响应边界可以请求 Simulator 预物化 paired/outcome Worlds，再把 data-only
`DecisionContext` 交给 Evaluator；不得在 Controller 内枚举、模拟、评价并重选战略候选。

---

## 3.2 `Generator/`

```text
Generator/
├─ Generator.js
└─ Action.js
```

### `Generator.js`

唯一回答：

> 当前 canonical World 中有哪些合法 Action？

负责：

- 动作枚举
- target 枚举
- selection 枚举
- 合法性过滤
- 生成 canonical Action

不负责：

- 价值判断
- 搜索排序
- 模拟结果
- 最终选择

### `Action.js`

整个 AI 唯一 canonical Action contract。

Action 只保存 executable intent。root counterfactual replay 的 `restoreActorHand`、
`ignoreCounter` 等控制只属于 Simulator 局部参数，不得进入 Action、search key 或 Worker payload。

不得再产生：

```text
SearchAction
SimulationAction
EvaluationAction
PatternAction
RootSearchAction
ActionDescriptor
```

---

## 3.3 `Searcher/`

```text
Searcher/
├─ Searcher.js
├─ Rng.js
└─ Pattern.js
```

### `Searcher.js`

唯一搜索编排器。

负责：

- root scheduling
- node expansion
- frontier
- depth
- beam
- pruning
- SearchBudget invariant
- root coverage
- incumbent
- TIME / NODE / COMPLETE
- final candidate comparison orchestration

搜索本身不得重新定义 value。

Searcher 可以读取 Action identity 以完成合法搜索机械和诊断，但不得根据具体
`cardId` / `characterId` 定义 prior、utility、information value 或 marginal value。

### `Rng.js`

唯一搜索随机源。

负责：

- seed
- deterministic RNG
- reproducible search
- tie/sample/random scheduling 所需随机序列

### `Pattern.js`

唯一 Pattern / 定式 owner。

负责：

- Pattern definition
- Pattern match
- continuation
- scheduling proposal
- 战略探索知识

Pattern 不得：

- 生成非法 Action
- 修改最终 winner
- 调 Simulator
- 调 Evaluator
- 调 Probability
- 自己定义价值

---

# 4. `Event/`

```text
Event/
├─ Fact.js
└─ Probability/
   ├─ Probability.js
   ├─ Branch.js
   └─ Pool.js
```

## `Fact.js`

唯一确定事实 owner。

负责：

- 当前已知事实
- memory/public knowledge
- 已知牌
- 已知装备
- 已知 condition
- 公开池计数

不负责概率。

## `Probability.js`

Probability façade。

唯一对外概率入口。

重导出 `Branch.js` 唯一定义的 `clampProbability` / `cardAvailability` canonical primitive；
Simulator、StateValue 与 CardValue 不得复制 availability normalization。

负责协调：

```text
Branch
Pool
```

## `Branch.js`

通用概率 branch algebra。

负责：

- normalize
- merge
- marginalize
- filter
- compatible intersection
- branch compression
- `clampProbability`
- `cardAvailability`

不得拥有具体卡牌 / Seal / Radar / Lightning 业务语义。

## `Pool.js`

有限池概率与组合算法。

负责：

- finite pool
- without replacement
- count
- combination
- dynamic programming

`Branch.js` 与 `Pool.js` 互不依赖；两者都是 `Probability.js` 的 internal implementation module，不得被业务代码当作独立 probability authority。

---

# 5. `Simulator/`

```text
Simulator/
├─ Simulator.js
├─ World.js
├─ Damage.js
├─ Resource.js
└─ Response.js
```

## `Simulator.js`

唯一模拟编排器。

回答：

> 执行 Action 后，World 会怎样变化？

可以编排：

```text
Damage
Resource
Response
Probability
```

不得计算 Action 好不好。

## `World.js`

整个 AI 唯一 canonical World contract。

不得再出现：

```text
SearchState
SimulationState
EvaluationState
VisibleState
BeliefState
```

各层统一读取同一个 World。

## `Damage.js`

只负责 **HP / damage lifecycle transition**。

负责：

- raw damage
- before/after damage modifier application
- 已解析 mitigation result
- shield
- HP loss
- heal
- fatal
- death / kill result

`Damage.js` **不拥有 Guardian response 本身**。Guardian 是否发生、由谁响应、支付什么资源属于 `Response.js`；`Damage.js` 只消费 `Simulator.js` 已经编排完成的 response / mitigation result。

## `Resource.js`

只负责资源 transition：

- draw
- discard
- consume
- transfer
- energy
- equipment
- slot
- payment
- hand/resource mutation

## `Response.js`

只负责 **已解析 response choice 的 transition state machine**。

负责：

- response window transition
- response order
- resolved Counter
- resolved Block
- resolved Guardian
- response payment / consumption request-result
- response termination

明确不负责：

- response 是否值得（→ `Evaluator.js`）
- response utility / willingness（→ `Evaluator.js`）
- hidden response capacity / availability probability（→ `Probability.js`）
- legal response Action generation（→ `Generator.js` / 正式 Domain Rules）

因此 `Response.js` 不能成为 `ResponsePolicy` 的换名版本。

三个 sibling：

```text
Damage
Resource
Response
```

原则上互不 import。

由 `Simulator.js` 统一编排。

---

# 6. `Evaluator/`

```text
Evaluator/
├─ Evaluator.js
├─ StateValue.js
└─ CardValue.js
```

## `Evaluator.js`

唯一价值编排和比较 authority。

负责：

- aggregate
- transition utility
- final utility
- candidate comparison semantics
- evaluation terms

Searcher 只消费 Evaluator 的结果，不自己建立第二套价值公式。

## `StateValue.js`

唯一 **non-card World-state valuation primitive owner**。

负责：

- HP
- survival
- shield
- energy
- position / distance
- threat
- board / strategic state
- status
- alive / dead
- team state
- seal burden
- global board-state benefit

`StateValue.js` 不直接给 hand card / equipment asset / resource card 本身计价。若装备造成了非卡牌局面结果（例如状态、距离、威胁变化），只评价这些 **state consequence**，不得重复计算装备资产价值。

## `CardValue.js`

唯一 **card / equipment / resource valuation primitive owner**。

负责：

- hand card value
- equipment asset value
- card retention
- discard cost
- consume cost
- draw / acquisition benefit
- transfer opportunity cost
- resource-card exchange value
- card-role marginal value

`CardValue.js` 不输出最终 AI utility，不拥有 World threat / team-state / board-state valuation，也不选择最终 Action winner。

`StateValue.js` 与 `CardValue.js` 互不调用。两者只输出 valuation primitives；所有最终聚合、权重、response willingness、candidate comparison 和 winner semantics 都只能回到 `Evaluator.js`。同一语义只能由一侧计价，禁止 double counting。

---

# 7. 旧文件 → 最终 owner 吸收表

> **重要：本表是 semantic migration map**
>
> - 旧文件不得整体复制到表中列出的 owner。
> - 每个旧函数必须按真实职责重新分类为 legality / fact / probability / transition / value / search / runtime boundary / dead。
> - 如果本表中的历史映射与第 3–6 节 canonical owner contract 冲突，以 canonical owner contract 为最高 authority。
> - 旧文件中属于多个职责的 semantic 必须拆开；不得为了“完成吸收”把错误职责塞进目标文件。

| 吸收前文件 | 最终 owner / 处理 |
|---|---|
| `AiController.js` | → `Controller.js` |
| `domain/GlobalBenefitModel.js` | 确定/概率查询按语义进入 `Fact.js` / `Probability.js`；non-card state benefit → `StateValue.js`；card/resource projection → `CardValue.js`；旧文件删除。不得把业务语义直接塞入 generic `Pool.js` |
| `domain/LightningModel.js` | 概率语义 → `Probability.js`；真实 transition / propagation → `Simulator.js`，damage result → `Damage.js`；旧文件删除 |
| `domain/RadarModel.js` | judgment probability → `Probability.js`；真实 judgment / transition 编排 → `Simulator.js`；只有非卡牌 state consequence 才可进入 `StateValue.js`；旧文件删除 |
| `domain/SealModel.js` | probability → `Probability.js`；真实 lifecycle transition → `Simulator.js`；仅 exploration-scheduling knowledge → `Pattern.js`；非卡牌 state burden → `StateValue.js`；旧文件删除 |
| `policy/AiRuntimePolicy.js` | search 配置 → `Searcher.js`；random → `Rng.js`；其他归对应 owner；旧文件删除 |
| `policy/CardSelectionBoundary.js` | → `Controller.js` / `Generator.js`；旧文件删除 |
| `policy/CardSelectionPolicy.js` | 合法候选 → `Generator.js`；价值 → `CardValue.js`；旧文件删除 |
| `policy/CharacterRoleMetadata.js` | 能由正式 Domain 推导则删除；必要 value projection → `CardValue.js` / `StateValue.js` |
| `policy/ResourceSelectionPolicy.js` | 候选 → `Generator.js`；transition → `Resource.js`；价值 → `CardValue.js` |
| `policy/ResponseBoundary.js` | → `Controller.js` / `Response.js` |
| `policy/ResponsePolicy.js` | legal response enumeration → `Generator.js` / Domain；capacity → `Probability.js`；response willingness → `Evaluator.js`；resolved transition → `Response.js` |
| `policy/TransferPolicy.js` | legal candidates → `Generator.js`；physical transfer → `Resource.js`；card/resource primitive → `CardValue.js`；World/context/final comparison → `Evaluator.js`；不得把 AI preference 当 Domain legality |
| `search/Action.js` | → `Generator/Action.js` |
| `search/ActionGenerator.js` | → `Generator/Generator.js` |
| `search/Searcher.js` | → `Searcher/Searcher.js` |
| `search/SearchRng.js` | → `Searcher/Rng.js` |
| `search/PatternMatcher.js` | → `Searcher/Pattern.js` |
| `search/ProductionPatterns.js` | → `Searcher/Pattern.js` |
| `search/SealPrior.js` | → `Pattern.js` |
| `search/SearchPrior.js` | → `Searcher.js` |
| `search/SearchBudget.js` | invariant 保留，文件吸收进 `Searcher.js` |
| `search/SearchRequest.js` | → `Controller.js` |
| `search/WorkerSearchOutcome.js` | → `Controller.js` |
| `search/TacticResolutionQuery.js` | response transition → `Response.js`；概率 → `Probability.js` |
| `search/CounterfactualTerms.js` | 分拆入 `Searcher.js` / `Simulator.js` / `Evaluator.js` |
| `simulation/Simulator.js` | → `Simulator/Simulator.js` |
| `simulation/CombatSimulation.js` | damage 语义 → `Damage.js`；编排 → `Simulator.js` |
| `simulation/ResponseSimulation.js` | → `Response.js` |
| `simulation/CardEffectSimulation.js` | 按职责拆入 `Simulator.js` / `Damage.js` / `Resource.js` / `Response.js` |
| `simulation/SkillEffectSimulation.js` | 按职责拆入 `Simulator.js` / `Damage.js` / `Resource.js` / `Response.js` |
| `simulation/StatusSimulation.js` | 按实际 transition 归 `Simulator.js` / `Damage.js` / `Resource.js` / `Response.js` / `Probability.js` |
| `simulation/ResourceValueQuery.js` | transition → `Resource.js`；value → `Evaluator.js` / `CardValue.js` |
| `simulation/RootResolutionQuery.js` | transition → `Simulator.js`；value → `Evaluator.js` |
| `simulation/ValueSimulationQuery.js` | transition → `Simulator.js`；value → `Evaluator.js` |
| `state/Fact.js` | → `Event/Fact.js` |
| `state/Probability/Probability.js` | → `Event/Probability/Probability.js` |
| `state/Probability/Branch.js` | → `Event/Probability/Branch.js` |
| `state/Probability/Pool.js` | → `Event/Probability/Pool.js` |
| `state/World.js` | → `Simulator/World.js` |
| `state/DistanceProbabilityBranches.js` | → `Probability.js` / `Branch.js` |
| `state/StateContracts.js` | Game→AI boundary → `Controller.js`；World contract → `World.js` |
| `state/RuleProjection.js` | 必要 World projection → `World.js`；合法性 projection → `Generator.js`；其余删除 |
| `value/Evaluator.js` | → `Evaluator/Evaluator.js` |
| `value/StateValue.js` | → `Evaluator/StateValue.js`，成为真正 state-value owner |
| `value/CardValue.js` | → `Evaluator/CardValue.js` |
| `value/Economics.js` | aggregation/unit → `Evaluator.js`；state scale → `StateValue.js`；card opportunity cost → `CardValue.js` |
| `value/ThreatValue.js` | → `StateValue.js` |
| `value/SealValue.js` | → `StateValue.js` |
| `value/GlobalBenefitValue.js` | state benefit → `StateValue.js`；card projection → `CardValue.js` |
| `value/ValueLedger.js` | 独立文件删除；诊断改为 `Evaluator.evaluate()` 返回 `terms` |

---

# 8. 吸收后的依赖原则

## Generator

```text
Generator
   ↓
Action
```

`Action.js` 不反向依赖 Generator。

---

## Searcher

```text
                 Searcher
          ┌─────────┴─────────┐
          ▼                   ▼
         Rng                Pattern

Searcher
   ├→ Generator
   ├→ Simulator
   └→ Evaluator
```

Searcher 负责流程、incumbent/frontier mechanics 和最终搜索选择，但不拥有 comparison/value semantics；所有候选好坏语义必须来自 Evaluator。

---

## Probability

```text
             Probability
              /        \
             ▼          ▼
          Branch       Pool
```

禁止：

```text
Branch → Pool
Pool   → Branch
```

---

## Simulator

```text
                 Simulator
          ┌────────┼────────┐
          ▼        ▼        ▼
       Damage   Resource  Response
          │        │        │
          └────────┼────────┘
                   ▼
                 World
```

禁止 sibling 互相编排：

```text
Damage   -X→ Resource
Damage   -X→ Response
Resource -X→ Damage
Resource -X→ Response
Response -X→ Damage
Response -X→ Resource
```

---

## Evaluator

```text
             Evaluator
              /      \
             ▼        ▼
       StateValue   CardValue
```

禁止：

```text
StateValue → CardValue
CardValue  → StateValue
```

同一价值语义只能有一个 owner，禁止 double counting。

Evaluator 只能消费 World、paired/outcome Worlds、普通数据与标量；不得接收能够
构造 Simulator、clone/apply World 或回调 Controller/Searcher 的 function capability。
Block、Counter、Guardian、Rescue 的 planning/runtime 判断必须复用同一 canonical
willingness primitive；有界 planning approximation 只能改变输入精度，不能复制阈值。

---

# 9. Cross-Authority Import Rule

18 个文件不等于 18 个 authority。跨 authority 依赖必须优先通过 facade / canonical contract。

## 9.1 允许作为主要 cross-authority 入口的模块

```text
Controller.js

Generator/Generator.js
Generator/Action.js

Searcher/Searcher.js

Event/Fact.js
Event/Probability/Probability.js

Simulator/Simulator.js
Simulator/World.js

Evaluator/Evaluator.js
```

## 9.2 默认 internal implementation modules

```text
Searcher/Rng.js
Searcher/Pattern.js

Event/Probability/Branch.js
Event/Probability/Pool.js

Simulator/Damage.js
Simulator/Resource.js
Simulator/Response.js

Evaluator/StateValue.js
Evaluator/CardValue.js
```

默认规则：外部 authority **不得绕过 facade** 直接依赖 internal module。

`Controller.js` 是 `Rng.js` / runtime composition 的唯一外部 facade；Worker、application
与其他 composition module 不得直接 import `Searcher/Rng.js` 或构造第二套 search graph。

例如禁止：

```text
Searcher   → Damage.js
Controller → CardValue.js
Generator  → StateValue.js
Simulator  → Pool.js
```

推荐依赖：

```text
Searcher   → Simulator.js / Evaluator.js
Controller → Evaluator.js / Simulator.js
Simulator  → Probability.js
Evaluator  → Probability.js
```

例外必须同时满足：

1. 是明确的 canonical contract；
2. 不产生第二 authority；
3. 不产生循环依赖；
4. 有独立测试证明该依赖是必要且稳定的。

## 9.3 Internal sibling gate

以下 sibling 必须保持单向独立：

```text
Branch     -X→ Pool
Pool       -X→ Branch

Damage     -X→ Resource
Damage     -X→ Response
Resource   -X→ Damage
Resource   -X→ Response
Response   -X→ Damage
Response   -X→ Resource

StateValue -X→ CardValue
CardValue  -X→ StateValue
```

跨 sibling 的组合只能回到各自 facade：

```text
Probability.js
Simulator.js
Evaluator.js
```

---

# 10. 最终数据结构原则

整个 AI 的核心 canonical contract 只保留：

```text
Action
World
Fact
ProbabilityState / Branch（概率内部）
Evaluation result
```

禁止重新产生：

```text
SearchAction
ActionDescriptor
RootSearchAction
SearchState
VisibleState
BeliefState
SimulationState
EvaluationState
SearchResult DTO
Candidate DTO
```

原则：

> 数据结构能直接共享就共享；需要不同语义时增加只读 view/helper，而不是复制整套 DTO。

Response `DecisionContext` 是 data-only boundary object，并直接复用 canonical World player
representation；不得携带 lazy query、Simulator factory、counterfactual callback 或第二套 player DTO。
完整 World deep clone 只经 `Simulator/World.js#cloneWorld`，由同一路径执行预算、诊断和 normalization。

---

# 11. 最终架构总图

```text
                         REAL GAME
                            │
                            ▼
                       Controller
                            │
                            ▼
                       Generator
                            │
                      canonical Action[]
                            │
                            ▼
                        Searcher
                 ┌──────────┼──────────┐
                 │          │          │
                 ▼          ▼          ▼
              Pattern      Rng      Simulator
                                      │
                              ┌───────┼───────┐
                              ▼       ▼       ▼
                           Damage  Resource Response
                              │       │       │
                              └───────┼───────┘
                                      ▼
                                    World
                                      │
                                      ▼
                                  Evaluator
                                  /       \
                                 ▼         ▼
                           StateValue   CardValue

                         Event
                         ┌───────────────┐
                         │ Fact          │
                         │ Probability   │
                         │  ├─ Branch    │
                         │  └─ Pool      │
                         └───────────────┘
```

---

# 12. 最终验收标准

最终不能只验证：

```text
文件数 == 18
```

还必须同时成立：

## ARCHITECTURE

```text
职责单一
数据结构唯一
无跨层越权
无重复 authority
```

## SEMANTICS

```text
合法动作能力不丢
模拟规则不丢
概率判断能力不丢
价值知识不丢
Pattern / 战略知识不丢
```

## COMPLEXITY

```text
无跨 transition branch genealogy
无 generic Cartesian probability expansion
局部 N×M 有界
所有完整 World clone 统一计数，单次 specialization 只做一次 deep clone
减少 materialization
减少 DTO conversion
```

## PERFORMANCE

```text
相同 SearchBudget：
更高 node throughput
更高 root coverage
更少 TIME fallback
更低 latency
更低 memory
```

## INTELLIGENCE

```text
关键行为 contract 不回归
planning/runtime Block、Counter、Guardian、Rescue 不产生关键语义分叉
同等 SearchBudget 决策质量不低于旧版
性能收益真实转化为更充分搜索
```

---

# 13. Internal Module Creation Gate

最终 18 文件是当前 architecture target，但文件数量本身不是 KPI。任何新增 internal module 只有在真实代码已经同时证明以下条件时才允许创建：

```text
独立职责
+ 独立 invariant
+ 独立测试价值
+ 不是 wrapper / DTO / Service / Policy / Model 换皮
+ 不成为新的 cross-authority public API
+ 与同级 internal module 无双向或循环依赖
```

因此默认不预留：

```text
Enumeration.js
Budget.js
Effect.js
Condition.js
ResponseValue.js
Ledger.js
```

以后必须由真实复杂度证明其独立存在价值。

---

# 14. 最终目标

最终重构：

```text
删除重复 authority
删除中间 DTO
删除 Query/Policy/Boundary 壳
删除重复价值公式
删除重复 Domain Model
删除跨 transition genealogy
删除不必要 materialization

真实语义
→
归入唯一 owner
```

最终形成：

```text
51 个历史模块
        ↓
职责去重 / 数据统一 / 算法收口
        ↓
18 个 canonical AI modules
```

这 18 个文件按：

> **一个独立语义 + 一个独立 invariant + 一个唯一 authority = 一个模块。**
>
> 同时：**一个业务领域只能有一个对外 authority / facade；内部实现模块不能因为物理拆文件而升级成新的业务 authority。**
