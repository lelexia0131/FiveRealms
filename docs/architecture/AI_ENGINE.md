# FiveRealms AI Engine 2.0

当前状态：AI-ARCH-0 至 AI-ARCH-10 COMPLETE。
架构结论：FiveRealms AI Engine 2.0 — MASTER ARCHITECTURE COMPLETE。
本轮整理基线：`7f73a03 ARCH-9.10`
当前浏览器构建标识：`20260815-card-estimate-parity-fix`
历史审计基线：`e16a429 fix: preserve end fallback against non-positive actions`
最新校验日期：2026-08-15
范围：`js/ai/**/*.js`、直接上游、规则权威源和相关测试；下方 Current Architecture Snapshot 与第 32 节描述当前架构，第 2 至 31 节保留阶段审计、迁移设计和落地证据。
仓库级三层目标架构以 `FR_ARCHITECTURE.md` 为唯一 authority；本文件只拥有 AI 内部架构与历史证据。

## 1. 文档职责

本文件是 AI 架构的长期事实来源，记录：

- 当前实现和真实运行依赖；
- 状态、隐藏信息、规则镜像与价值 owner；
- 已确认的耦合、重复计分和性能风险；
- 当前最终边界，以及 AI-ARCH-2 至 AI-ARCH-10 的历史迁移顺序；
- 每个阶段的行为冻结、验证和回滚契约。

代码风格与函数头只在 `CODE_STANDARD.md` 定义。Current Architecture Snapshot 与第 32 节是当前事实；第 2 至 31 节中的“当前”“目标”“后续”等词只描述对应阶段当时的状态，不覆盖最终架构。

## Current Architecture Snapshot

当前生产 AI 共 57 个 JavaScript 模块，最终责任边界如下：

| 层 | 当前正式 owner |
|---|---|
| Composition / Execution | `AiController` 是 main-thread AI 组合根；只保存显式 state/session/rule capability/search RNG/search executor/lifecycle/rebind 依赖，不保存 Game；生产 Planner execution 由 injected search executor 承担。 |
| State | `VisibleState`、`Knowledge`、`BeliefState`、`StateContracts`、`SearchState`、`Probability` 分别拥有公开投影、合法记忆、未知分布、组合、可克隆搜索世界与概率代数；`RuleProjection` 与 `DistanceProbabilityBranches` 是 AI→Domain 的 canonical projection 与距离概率分区。 |
| Search | `ActionGenerator` 根/深层分开消费 root context/SearchState；`SearchRequest`/`RootSearchAction`/`SearchResult`/`WorkerSearchOutcome` 是 data-only boundary contracts；`SearchRng` 是 AI search RNG；`SearchBudget`/`SearchPolicy` 管搜索边界；`CandidateMaterializer` 组合候选；`Planner` 只编排。 |
| Simulation | `Simulator` 管 clone、共享 runtime 与分派；Response、Combat、Card、Skill、Status 五个组件各自推进对应状态。 |
| Value | State Value、Transition Value、Search Prior、Policy Value 与 Diagnostic Ledger 分属正式 owner；只有 Transition Value 的最终组合进入候选 final value。 |
| Policy / Domain | Policy 只做 AI 过滤、选择与 valuation；`js/ai/domain/**` 是 AI probabilistic/search model，不拥有 Repository Domain 规则。 |
| Repository Domain Rules | `js/domain/rules/**` 是 Game Rule Authority；`js/domain/definitions/**` 是固定事实 Authority；`RuleEngine` 与 `DistanceSystem` 仅 legacy façade。 |

AI deterministic legality、目标、距离、伤害、响应与状态判定的 rule source 来自 `js/domain/rules/**`；AI 只通过窄投影把 SearchState/Visible facts 适配为 canonical rule facts。`ActionCandidatePolicy` 只决定 AI 是否考虑某个规则合法动作，`TransferPolicy` 唯一拥有 AI 转移方向策略。正式搜索不得读取敌方未知手牌的 `definitionId`，只能消费 Visible / Knowledge / Belief 提供的合法信息或概率分支。旧 compatibility 文件与旧 owner 路径已删除；checker 中保留的旧名称仅是防止回归的正式 guard。

FR-ARCH-12 current facts：
- `js/ai/search/**`、`js/ai/simulation/**`、`js/ai/domain/**` 的 production imports 对 `core/RuleEngine` 与 `core/DistanceSystem` 均为零；
- root/deep `ActionGenerator` 通过 `js/ai/state/RuleProjection.js` 共同消费 `domain/rules/card`、`domain/rules/skill`、`domain/rules/status` 与 Domain Definitions；
- 固定卡牌/技能效果数值 owner 为 `CardDefinitions` / `SkillDefinitions`；`CardEffectRules` 与 `SkillRules` 只保留动态决定；
- `TransferPolicy.isTransferDirectionAllowed` 是 ally→enemy AI strategic prohibition 的唯一公式，`TransferExecutionPolicyAdapter` 只做 Human/AI bridge；
- `js/ai/domain/**` 四个模块是 AI probabilistic/search model，不是 Repository Domain Rule authority；
- AI simulation 保留所有概率、Belief、反事实 SearchState 模型，不调用 Application workflow 或 Domain Transitions 修改 SearchState。

FR-ARCH-13 current facts：
- `AIController`、`Knowledge`、`ActionGenerator`、`CardSelectionBoundary`、`ResponseBoundary` 均不保存 raw Game；`js/ai/**` 的 `this.game` 与 `core/Game` import 为零；
- `AIController.selectAction` 构造 `SearchRequest`（requestId/gameId/stateVersion/actor/phase/round/SearchState/config/rng seed/rootActionDescriptors），并在返回前执行 session、game identity、stateVersion、actor、phase、descriptor rebind 与 Domain legality acceptance；
- queued planned sequence 的第二项不继承首项 requestVersion；`resolvePlannedAction` 继续 current-state rebind + Domain candidate revalidation；
- `SearchResult` 只保存 `ActionDescriptor`、计划描述与 stats；搜索边界不返回 real Card/Player/SearchState/Simulator；
- `SearchRng` 是 AI Search/Decision 专用 LCG；real Game RNG 不被纯 AI search 推进，固定 AI seed 可复现；
- `GameChoiceRouter` 已收窄为显式注入的 composition bridge；FR-ARCH-15 删除条件：Game 不再是 composition owner 且 main.js 接管全部 wiring；
- Worker、`postMessage`、SearchRequest 之外的 worker protocol 均未创建。

FR-ARCH-14 current facts：
- `js/adapters/ai/worker/` 拥有 Dedicated Worker entry、Worker client、headless local transport 与 `WorkerSearchRuntime`/`SearchEngineFactory` 唯一 search execution composition；
- 生产 `AIController.selectAction` 不直接调用 `planner.plan`；SearchRequest → search executor → WorkerSearchOutcome → main-thread acceptance → current entity rebind → Domain legality；
- `SearchRequest.rootSearchActions` 是 Worker 专用 root action 投影，`RootSearchAction.rehydrate` 从 SearchState/Definitions 恢复 search action；执行期 `ActionDescriptor` 保持窄 rebind 职责；
- `SearchRng.snapshot` 携带 seed/state/draws；Worker outcome 返回 `rngAfter`；main thread exactly-once commit，新 session 不继承旧 RNG；
- Fast profile `softTarget=500ms / deadline=900ms / watchdog=5000ms`；Normal profile `deadline=3000ms / watchdog=10000ms`；node-budget override 仍优先；
- fake AI thinking wait 与 `searchElapsed` compensation 已停用；`utils/aiTiming` 不再调用任何 RNG；
- production browser path 使用 `new Worker(url, { type:"module" })`；Node/headless 只使用同一 `runSearchRequest` 的 explicit local transport；
- browser Worker client 初始实例与 watchdog 重建实例共用同一 wiring；postMessage/messageerror 失败会清空 pending 并重建，不在下一次合法搜索上产生 false in-flight；
- AI 弃牌阶段有 runtime invariant guard：即使 ChoicePort 异常 cancelled/declined/selectedIds 不足，AI 回合结束仍收束到 `hand.length <= hp`；
- zero fake-thinking 下 gameplay SFX 不再受 `SoundManager` 墙钟节流，仅 UI `select` 保留防误触节流；
- FR-ARCH-14 正式状态为 BLOCKED，代码与 CLI/browser-equivalent 回归已关闭，最终 PASS 等待真实浏览器验收。

## Historical Baseline and Migration Record

以下第 2 至 31 节按时间保留最初审计、阶段约束、迁移表和验收证据。其阶段性路径、未来时态与 compatibility 描述属于历史记录；最终现状以本页顶部快照和第 32 节为准。

## 2. 基线与验证边界

- 工作分支：`deepseek-fixes`。
- 起始工作区：干净。
- AI 浏览器构建标识：`20260814-spirit-medic-heal-economics`。
- 当前生产 AI 文件：19 个，共约 8,300 行；其中 `AiSimulator.js` 约 3,800 行，是首要风险集中点。
- 上游生产入口：`Game` 创建一个 `AIController`；`Game`、`ResponseSystem`、`PublicCardPool`、`skillRegistry` 通过控制器或其公开子组件请求决策。
- 测试入口：`tests/run.mjs` 的 `AI 系统` 及真实规则区域、`tests/ai-benchmark`、`tests/ai-card-study`。
- 本阶段只读审计生产 AI；没有改规则、权重、搜索策略、模拟结果或浏览器模块图。

## 3. 当前模块清单与归属结论

处置标签含义：KEEP 原位稳定；MOVE 移到新层；SPLIT 拆分职责；MERGE 合并同一 owner；RENAME 明确语义；DEPRECATE 迁移后删除旧入口。

| 当前文件 | 当前角色、主要导出/函数 | 上游 / 下游 | 状态与信息边界 | 问题与目标 | 处置 |
|---|---|---|---|---|---|
| `AiController.js` | 组装门面；`getLegalActions`、`selectAction`、描述重绑与选择转发 | `Game` / Visible、Knowledge、Policy、Generator、Evaluator、Planner | 读 GameState，经可见投影进入 AI；自身不结算 | 构造依赖合理，但公开暴露子组件，成为服务定位器 | KEEP + 收窄 API |
| `AiVisibleState.js` | `createAiVisibleState` 同时做观察投影、Belief 初始化和 SearchState 填充 | Controller、ResponsePolicy、测试 / TeamRule、skill cost、CardValue | 读完整 GameState；只输出自己手牌、他人已知牌与计数 | 三种状态职责混合，外层冻结不等于独立 SearchState | SPLIT → state |
| `AiKnowledge.js` | 合法私有记忆、剩余牌计数、隐藏世界采样 | Controller、Planner / card config、Game 随机源 | 读 viewer 记忆和公开区；不读敌方未知牌面 | `sampleHiddenWorlds` 属 Belief，Planner 通过控制器回取 | SPLIT → Knowledge + BeliefState |
| `AiActionGenerator.js` | 根/深层动作枚举、次数槽、概率可用性、转移方案 | Controller、Planner / RuleEngine、domain、policy/value、Probability | 根节点读 GameState；深层读 SearchState | 合法枚举混入 3v1 禁雷、零收益过滤、转移策略；回指 CardSelector | SPLIT → search/ActionGenerator + policy/domain |
| `AiPlanner.js` | 有限深度 beam、候选账本、响应反事实、破势/封印边际 | Controller / Simulator、Evaluator、seal；运行时回指 Generator、Knowledge | 只应读 SearchState/Belief，当前持有 Game 引用 | 搜索算法混入牌域规则和价值合成；依赖服务定位器 | SPLIT → Planner + SearchPolicy + TransitionValue |
| `AiSimulator.js` | 克隆、动作分派、卡牌/技能/状态/响应/伤害/濒死全镜像 | Planner、Evaluator、ResponsePolicy、测试 / RuleEngine、skill、domain、policy/value | 写克隆后的 SearchState；不写 GameState | God Object；规则镜像面积大，规则漂移和重复消费风险最高 | SPLIT → simulation 子域 |
| `AiEvaluator.js` | 玩家/局面价值、owner ledger、机会成本、先验、经济、前沿残值、雷电生命周期 | Planner、ResponsePolicy、测试 / Simulator、domain、CardValue、Threat | 读 SearchState；不应结算 | Value 同时驱动模拟；Lightning 价值内建模拟；多个账本语义相邻 | SPLIT → value + domain |
| `AiResponsePolicy.js` | 格挡/反制/护援/濒死/状态响应 | ResponseSystem、Controller / Visible、Simulator、Evaluator、domain | 根响应读 GameState 后构造可见状态；不应改 GameState | Policy 自建模拟和状态投影，域公式混入 | SPLIT → policy/ResponsePolicy |
| `AiCardSelector.js` | 隐藏牌、区域、转移、公共牌、弃牌选择 | Controller、Game、PublicCardPool、skill / RuleEngine、policy/value | 执行边界可持真实实体；敌方未知定义仅按记忆/位置 | 多种资源策略聚合，合法实体解析与价值策略混合 | SPLIT → policy 子策略 |
| `AiProbabilityBranches.js` | 概率归一、合并、连接、投影和条件分区；另含雷达判定 | 多个 AI 模块 / card config | 纯分支值；无状态写入 | 通用概率层被雷达牌域污染 | SPLIT → state/Probability + domain/Radar |
| `AiEconomics.js` | `HP_VALUE`、`STATE_DELTA_SCALE` | Evaluator、Planner、Policy、Simulator | 常量 | Planner 从 Evaluator 重导入，owner 不清晰 | MOVE → value/Economics |
| `ThreatCalculator.js` | `calculate` 公共威胁值 | Evaluator、transfer / 无 | 只接受公开/过滤字段 | 职责清晰 | MOVE → value/ThreatValue |
| `roleCardValue.js` | 基础牌值、角色差量、装备保留差量及校验 | Generator、Selector、Evaluator、Simulator、policy/value | 配置派生，无隐藏信息 | 同时服务 prior、选择和模拟，需固定“静态 CardValue”语义 | MOVE → value/CardValue |
| `discardScoring.js` | 弃牌保留值、排序、选择 | Selector、Simulator / CardValue | 对自己/实际支付者的手牌操作 | Policy 与静态价值轻度混合 | MOVE → policy/ResourceSelectionPolicy |
| `resourceSelectionValue.js` | 资源用途效用与手牌/区域选择 | Selector、Simulator / CardValue、transfer | 已知实体或未知期望；不窥牌 | 文件名为 value，实际 owner 是选择策略 | MOVE + RENAME → policy/ResourceSelectionPolicy |
| `transferScoring.js` | 转移候选、组合评分、未知手牌期望、威胁视图 | Generator、Selector、resource / CardValue、Threat、Probability | 可见/合法记忆；未知牌用期望 | TransferPolicy、CardValue、ThreatValue、手牌上限域混合 | SPLIT → policy/TransferPolicy + value |
| `lightningScoring.js` | 雷电状态分支、判定概率、传递链、命中分布 | Generator、Evaluator、Policy、Simulator / RuleEngine、Probability | 读 SearchState/remaining counts | 已是域模型而非单纯 scoring，且部分规则镜像 | MOVE + RENAME → domain/LightningModel |
| `sealScoring.js` | 封印状态/反制/判定/时序/威胁/延迟价值 | Generator、Planner、Policy、Simulator、Evaluator / RuleEngine、Distance | 读 SearchState/remaining counts | Domain、ThreatValue、Search timing 混合 | SPLIT → domain/SealModel + value/search |
| `AiGlobalBenefit.js` | 互利/共生/全局牌收益、反制欲望、root flip 反事实 | Evaluator、Policy、Simulator / CardValue；模拟器由调用方注入 | 读 SearchState，函数式返回 | Domain、Policy、Economics 与模拟辅助混合；注入仅避免静态环 | SPLIT → domain/GlobalBenefitModel + policy |

### 当前测试与回归映射

| 责任域 | 当前证据入口 | 已覆盖重点 | ARCH-2 以后需补的契约 |
|---|---|---|---|
| Visible/Knowledge/Belief | `tests/run.mjs` 的 `AI·可见状态`、`AI·窥探`、未知牌互换场景 | 不含敌方真实手牌、remaining counts 只读、card ID 记忆失效 | Visible/Belief/Search 三对象 schema 与转换边界 |
| ActionGenerator | `AI·动作生成` 及每张牌/技能的根与深层生成测试 | 动态距离、目标阵营、次数槽、概率装备合法性 | `generateLegal` 与策略过滤分离后集合包含关系 |
| Planner/Value | 大量 `AI·搜索`、transition delta、ledger、frontier、end fallback 测试 | 固定节点、深度、state delta、响应互斥、frontier once、诊断等价 | 旧/新 trace 逐 term 对照与稳定 tie-break |
| Simulator | `AI·模拟器` 及突袭、借势、决斗、雷达、角色技能等场景 | clone 隔离、概率分支、伤害/响应/濒死、实体消费 | 与真实 Game/Response/Dying/Card/Skill authority 的表驱动差分 |
| Response/Selection Policy | 借势响应、护援、封印/闪电反制、窥探/转移/弃牌测试 | 不泄露、资源保留、状态响应和选择一致 | DecisionContext 不含 Game/Simulator concrete 的构造测试 |
| Domain models | `AI·封印`、`AI·闪电`、`AI·互利`、雷达判定测试 | remaining-count 概率、未来 RNG 隔离、座次和阵营投影 | Domain 输出 schema、概率质量和无反向依赖测试 |
| 端到端与性能 | `tests/ai-benchmark`、`tests/ai-card-study`、Balance harness | 生产 Controller、固定节点/seed、场景报告 | clone/apply/stateUtility/branch 计数基线与阶段对比 |

测试量很大，但当前更偏行为回归；“真实权威与模拟镜像对同一输入产生等价 Transition”的系统化差分层仍缺失。这是 ARCH-7/8 的前置验收项，不应在 ARCH-2 先行扩大。

## 4. 当前静态 import 图

以下省略 config/core 的叶子依赖，但保留 AI 内部方向：

```text
Game -> AIController
AIController -> VisibleState, Knowledge, CardSelector, ResponsePolicy,
                ActionGenerator, Evaluator, Planner

Planner -> Simulator, Evaluator, SealModel
Evaluator -> Simulator, Probability, Threat, GlobalBenefit,
             CardValue, LightningModel, SealModel, Economics
ResponsePolicy -> VisibleState, Simulator, Evaluator(injected), Knowledge(injected),
                  GlobalBenefit, LightningModel, SealModel, Economics
ActionGenerator -> RuleEngine, Probability, LightningModel, SealModel,
                   TransferScoring, skillRegistry, Distance
Simulator -> RuleEngine, Probability, LightningModel, SealModel,
             GlobalBenefit, Economics, resource/discard/CardValue, skillRegistry
CardSelector -> RuleEngine, TransferScoring, CardValue,
                discard/resource selection
VisibleState -> TeamRuleService, skillRegistry, CardValue
TransferScoring -> CardValue, Threat, Probability
ResourceSelection -> CardValue, TransferScoring
LightningModel -> RuleEngine, Probability
SealModel -> RuleEngine, Distance, Probability
GlobalBenefit -> CardValue
```

结论：当前 ES module 静态图未发现已闭合的 import cycle。`AiGlobalBenefit` 通过注入 simulator 避免了 `Simulator -> GlobalBenefit -> Simulator` 静态闭环，但该做法没有消除职责反向依赖。

## 5. 当前运行时依赖与回指

### 历史审计基线

AI-ARCH-1 审计时真实运行时存在以下服务定位器式环：

```text
Game -> AIController -> Planner
  ^          |            |
  |          |            +--> game.aiController.actionGenerator
  |          |            +--> game.aiController.knowledge
  |          |
  |          +--> ActionGenerator
  |                         +--> game.aiController.cardSelector
  |
  +-- ResponseSystem/PublicCardPool/skillRegistry -> game.aiController.*
```

已确认位置：

- Planner 深层展开两次回取 `actionGenerator.generateFromVisible`；根计划回取 `knowledge.sampleHiddenWorlds`。
- Planner 的破势边际计算再次回取 ActionGenerator。
- ActionGenerator 根转移选择回取 `cardSelector.chooseTransferCombination`。
- `Game`、`ResponseSystem`、`PublicCardPool` 和 `skillRegistry` 直接访问控制器子组件。

这不是语法层 import cycle，却形成 Controller → Planner/Generator → Controller 的运行时依赖环，导致组件无法独立构造、测试和替换。这一段保留为迁移前证据，不描述当前实现。

### AI-ARCH-3 当前运行图

```text
Game -> AIController (composition root / facade)
          |
          +--> Knowledge
          +--> Evaluator
          +--> CardSelector
          +--> ResponsePolicy
          +--> ActionGenerator(game, chooseTransferCombination)
          +--> Planner(
                 evaluator,
                 generateFromVisible,
                 sampleHiddenWorlds,
                 random,
                 search setting readers,
                 yieldControl
               )

Game/ResponseSystem/PublicCardPool/skillRegistry -> AIController facade methods
```

- `AiPlanner` 不再接收或保存 `Game`，也不持有 `AIController`；深层动作、隐藏世界、随机、预算与会话让步全部是构造时注入的窄能力。
- `AiActionGenerator` 为真实根动作保留 `Game` 规则上下文，但转移选择由 `chooseTransferCombination` 显式注入，不再从 `game.aiController` 查找 CardSelector。
- Controller 先构造 Knowledge/Evaluator/CardSelector/ResponsePolicy，再构造 ActionGenerator，最后构造 Planner；没有 post-construction patch，也没有搜索节点内组件构造。
- 生产 `js/ai/**` 已无 `game.aiController` 或 `this.game.aiController` 回指。上游通过 Controller 的稳定门面访问响应、公开选牌、隐藏选择、区域选择、转移选择和计划序列。
- `.knowledge`、`.evaluator`、`.cardSelector`、`.responsePolicy`、`.actionGenerator`、`.planner` 公共字段暂留一个兼容阶段，保证历史测试猴子补丁仍作用于同一实例；生产上游不再直接访问这些字段。

## 6. 依赖矩阵

下表是 AI-ARCH-1 的历史矩阵。`R` 为直接静态依赖，`I` 为构造注入，`B` 为当时的 `game.aiController` 回指，`—` 为无直接依赖。

| 调用方 | State/Knowledge | Search | Simulation | Value | Policy | Domain | Core rules | Controller |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Controller | R | R | — | R | R | — | — | — |
| VisibleState/Knowledge | — | — | — | R | — | — | R | — |
| ActionGenerator | — | — | — | R | R/B | R | R | B |
| Planner | B | — | R | R/I | — | R | — | B |
| Simulator | — | — | — | R | R | R | R | — |
| Evaluator | — | — | R | — | — | R | R | — |
| ResponsePolicy | R/I | — | R | I/R | — | R | — | — |
| CardSelector | I | — | — | R | R | — | R | — |
| Domain models | — | — | I（GlobalBenefit） | R | — | — | R | — |

目标是单向：Controller 组装；Search 依赖显式的 State、ActionGenerator、Simulator、Value 接口；Simulation 依赖 Rule Projection 与无副作用 domain helpers；Value 只能读取 State/Domain 派生值，不能启动 Simulation；Policy 可请求受限的 Simulation query，但不能构造整套 Controller。

AI-ARCH-3 已把矩阵中的三个 `B` 清零，当前注入映射为：

| 接收组件 | 显式构造依赖 | 仍持有 Game | Controller 回指 |
|---|---|---:|---:|
| `AiPlanner` | Evaluator、`generateFromVisible`、`sampleHiddenWorlds`、random、搜索配置读取、`yieldControl` | 否 | 否 |
| `AiActionGenerator` | Game 规则上下文、`chooseTransferCombination` | 是 | 否 |
| `AiCardSelector` | Game、Knowledge | 是 | 否 |
| `AiResponsePolicy` | Game、Evaluator、Knowledge | 是 | 否 |
| `AiEvaluator` | Game | 是 | 否 |
| `AiKnowledge` | Game | 是 | 否 |

Planner 去除 Game 是本阶段唯一完整 Game 解耦；其余组件的 Game 收窄属于后续既定阶段，不得在 AI-ARCH-3 顺带改写业务职责。

## 7. 规则权威、模拟镜像与派生模型

定义：

- **AUTHORITY**：真实对局最终合法性和结算的唯一权威。
- **SIMULATION MIRROR**：只作用于 SearchState 的预测实现，必须通过契约测试与权威对齐。
- **DERIVED MODEL**：基于合法可见信息的概率或效用近似，不承诺逐事件等价。

| 规则域 | AUTHORITY | 当前 SIMULATION MIRROR | DERIVED MODEL / 风险 |
|---|---|---|---|
| 伤害、护盾、before/afterDamage | `Game.damage` + EventBus 被动技能 | `AiSimulator.applyDamage`、`simulateAfterLifeDamage` | 暴露度、风险和 HP 价值；镜像需覆盖事件顺序 |
| 格挡/雷达防御判定 | `Game.damage`、`ResponseSystem.askForBlock`、`JudgmentSystem.judgeDefense` | `consumeBlockResponseWorlds`、`buildRadarOutcomePartition` | block 分布、radar 判定概率；不可当权威 |
| 战术反制链 | `ResponseSystem.askForCounter/askForStatusCounter` | scope/target counter response 与 counter distribution | `counterDesire`、dynamic flip gain；奇偶深度和资源消费易漂移 |
| 阵亡与濒死救援 | `DyingSystem.enter/resolve/kill`、`requestDyingRescue` | `resolveFatal` 及预计调息消费/击杀奖 | 存活概率和死亡价值；不得产生半血存活等非法中间态 |
| 护援 | `skillRegistry.guardianAid` 的 `beforeDamage` 监听 | `simulateGuardianAid` | 护援响应价值/弃牌成本；顺序、次数旗标需对齐 |
| 主动技能费用/次数 | `getActiveSkillCost`、`ACTIVE_SKILLS.canUse/execute`、`Game.useActiveSkill` | `syncActiveSkillCosts`、`applySkill`、skill slots | 未来 readiness/threat；镜像不可自行发明费用 |
| 目标合法性 | `RuleEngine.getCardTargets/targetLegality/getSkillTargets` | ActionGenerator 与 Simulator 的深层过滤 | 策略过滤不是合法性；零收益不能删掉必须保留的合法入口 |
| 卡牌可用性 | `RuleEngine.canPlayCard`、`Game.playCard`、`cardRegistry` | ActionGenerator、Simulator action dispatch | `cardAvailability` 概率；实体 ID 不得重复消费 |
| 延迟状态判定 | `Game` 回合判定流程 + `JudgmentSystem` | Lightning/Seal model + Simulator | remaining-count 概率、转移链；模型是预测而非权威 |
| 卡牌效果 | `cardRegistry` + Game 资源移动 API | `AiSimulator.apply` 大型分派 | 行动 prior/经济模型；镜像面积过大是主要维护风险 |

迁移原则：不尝试让 SearchState 调用异步 UI/事件总线权威；先把权威规则提炼为无副作用的共享判定/效果规格，再让真实执行和模拟分别适配。共享规格尚未存在前，镜像必须保留并由差分契约测试保护。

## 8. 状态 owner 与生命周期

| 状态 | 唯一 owner | 可写者 | 当前落点 | 约束 |
|---|---|---|---|---|
| GameState | `Game` 及 core systems | Game、Response/Dying/Judgment、card/skill authority | `game.state` | AI 决策层只读；Simulator 永不写入 |
| VisibleState | state/VisibleState 投影 | 创建函数一次性构造 | 当前 `createAiVisibleState` | 只含 LEGAL OBSERVATION 和 viewer 自身私有信息；完成后不可变 |
| Knowledge | viewer 的合法私有记忆 | Game 的记忆/失效 API | `aiMemory.knownCardsByPlayer` + `AiKnowledge` | 绑定 card ID 和 owner；离开原手牌立即失效 |
| BeliefState | state/BeliefState | Belief builder/sampler | 当前分散在 VisibleState、Knowledge、Probability | 只由 VisibleState+Knowledge+剩余牌推导；不得反查真实未知牌 |
| SearchState | simulation/state | Simulator 对独立克隆写入 | 当前 VisibleState 输出兼作 initial SearchState | 每个分支独立；实体/概率资源守恒；不得含 UI 或 Game 引用 |

当前主要问题：`createAiVisibleState` 同时构造 Visible、Belief 和 Search 字段，导致字段来源和可写生命周期不清晰；Object.freeze 只冻结外层与玩家对象，不能作为状态层已经正确分离的证据。

## 9. 隐藏信息审计

| 路径 | 标签 | 结论 |
|---|---|---|
| 自己手牌、所有公开区、生命/能量/装备/状态/手牌数量 | LEGAL OBSERVATION | 可直接进入 VisibleState |
| `aiMemory.knownCardsByPlayer` 中仍属于原 owner 的 card ID/definition | MEMORY | 合法；卡移动后由 Game 失效 |
| `remainingCounts`、expected card counts、block/counter/assault distributions、sampled worlds | BELIEF | 合法；只由观察+记忆推导，输入必须只读 |
| 选择系统执行时持有敌方真实 card 实体但不读取未知 definition | LEGAL OBSERVATION（opaque execution token） | 可用于位置/ID提交，策略不得按未知牌面排序 |
| Planner/Evaluator/Policy 读取敌方实际未知 `definitionId` | ILLEGAL | 本次 AI 主链未发现；未来 Guard/测试必须继续阻止 |
| 使用未来真实 RNG 结果评估互利、判定或抽牌 | ILLEGAL | 当前模型使用 remaining counts/期望；测试已有约束 |

风险边界：`AiCardSelector` 处于真实执行边界，能看见实体对象。其隐藏牌路径必须持续用 memory map 与 unknown position 选择，不能让通用 `expectedCardValue` 意外接触未知定义。

## 10. 价值 owner 与防重复计分

| 概念 | 当前 owner | 当前用途 | 目标 owner | 审计结论 |
|---|---|---|---|---|
| `actionUtility` / `actionSearchPrior` | Evaluator | 根/节点排序先验 | SearchPolicy + CardValue | 只能排序/裁剪，不能再作为最终收益相加 |
| `actionEconomicValue` | Evaluator | 即时经济项 | value/Economics | 仅记录未在 state delta 体现的流量；需逐项契约 |
| `stateUtility` | Evaluator | 单状态价值 | value/Evaluator | State Value 唯一 owner |
| `stateDelta` | Planner 计算 `after-before` | transition 主体 | value/TransitionValue | 只计算一次并明确缩放单位 |
| owner ledger | Evaluator | 诊断与响应反事实 | value/ValueLedger | 生产开关不得改变候选值和选择 |
| response ledger | Planner | 诊断/反事实拆分 | value/ValueLedger | 当前组合代数应互斥；迁移时先锁定等价测试 |
| `cardOpportunityCost` | Evaluator | 诊断 | value/CardValue/ValueLedger | 实际手牌损失已进入 state delta；不得二次扣除 |
| `frontierResidual` | Evaluator，Planner 终点合成 | 未展开未来存量 | search/FrontierValue | 只能在 frontier/terminal 计一次，不能每层累计 |
| seal delay/timing | sealScoring + Planner | 同层替代机会 | domain/SealModel + search/TransitionValue | 依赖 sibling，不能藏进通用 stateUtility |
| expose/assault marginal | Planner | 根技能反事实/旧层兑现 | domain + TransitionValue | 与 Simulator 已落地伤害互斥；只计额外层边际 |
| static card value | roleCardValue | prior、资源选择、未知期望 | value/CardValue | 明确是静态机会价值，不是完整行动价值 |

硬不变量：

1. 最终 transition value = 一次 state delta + 明确未落入状态的互斥流量 + 一次 frontier residual + 有证明的 domain marginal。
2. prior 不进入最终 value；diagnostic ledger 开关不能改变生产选择。
3. 同一张牌的实体价值、支付成本和状态损失不得以三个名字重复扣除。
4. 反事实 baseline 与 boosted world 只能改变被测因素，其余概率世界必须配对。

## 11. Simulator 函数所有权图

`AiSimulator` 当前函数按职责分组如下；这是拆分依据，不是建议机械一函数一文件。

| 函数组 | 代表函数 | 当前职责 | 目标 |
|---|---|---|---|
| SearchState 基础 | constructor、clone、initializers、sync summaries | 克隆与规范化 | `simulation/Simulator` + `state/SearchState` |
| 概率资源账 | block/counter distributions、event worlds、energy/shield worlds、slots | 概率守恒、容量消费 | `state/Probability` + `simulation/ResponseSimulation` |
| 牌身份/资源 | add/transfer/consume known/unknown cards、estimates、discard/resource selection | 实体与期望资源守恒 | `simulation/CardEffectSimulation`，Policy 只提供选择 |
| 动作分派 | `apply`、`applySkill` | 抽象动作到效果 | `simulation/Simulator` facade + Card/Skill adapters |
| 卡牌/技能效果 | assault、duel、tracking、gamble、coordination、plunder/destroy 等 | 具体模拟镜像 | CardEffect/SkillEffect/CombatSimulation |
| 响应/反制 | block/counter capacity、scope/target counter、desire/dynamic gain | 响应资源+策略混合 | ResponseSimulation；desire 移 Policy |
| 战斗生命周期 | guardian、after damage、`applyDamage`、`applyHpLoss`、`resolveFatal`、heal | 伤害、濒死、击杀镜像 | CombatSimulation + StatusSimulation |
| 延迟状态 | radar、lightning hit、seal/lightning branches | 状态域镜像 | StatusSimulation + domain models |

最危险的边界是：模拟器一边选择资源/响应，一边修改分布与状态。迁移时先固定 SearchState 不变量和效果契约，再拆 façade；不能先移动文件再解释概率守恒。

## 12. Evaluator、Planner 与 ActionGenerator 所有权

### Evaluator

- `playerValueTerms`、`ownerStateTerms`、`stateUtility`：KEEP 为 State Value 核心。
- `ownerStateLedger`、`projectOwnerLedger`：MOVE 到 ValueLedger。
- `cardOpportunityCost`、角色牌差量调用：MOVE 到 CardValue/Economics。
- `frontierResidual`：MOVE 到 FrontierValue，并限定终点一次性使用。
- `actionUtility`、`actionSearchPrior`：MOVE 到 SearchPolicy；只做排序。
- `actionEconomicValue`：MOVE 到 Economics，并逐项证明不在 state delta。
- lightning lifecycle 系列：MOVE 到 LightningModel/ThreatValue；Evaluator 不再构造 Simulator。
- exposure、radar mitigation、shield/HP risk：SPLIT 为 ThreatValue 与 State Value terms。

### Planner

- `plan` 的 beam/frontier/yield/budget：KEEP 为通用 Planner。
- `describeAction`、stable descriptor：MOVE 到 controller/action descriptor adapter。
- `evaluateExposeMarginal`、assault stack provenance：MOVE 到 domain/skill transition model。
- response counterfactual/ledger：MOVE 到 ValueLedger + ResponseSimulation query。
- `computeCandidateLedger`、`composeCandidateValue`：MOVE 到 TransitionValue。
- `chooseCandidate`、randomness/tie-break：MOVE 到 SearchPolicy。
- Generator、Knowledge 改为构造注入，删除所有 `game.aiController` 回指。

### ActionGenerator

- 根/深层的规则合法动作枚举：KEEP 为 ActionGenerator，但统一接收只读状态接口。
- 次数槽与执行世界：与 SearchState/Probability 契约对齐。
- 3v1 禁雷、零收益孤注/破势：MOVE 到 SearchPolicy/domain filter；合法动作集合与策略候选集合分离。
- 转移组合选择：MOVE 到 TransferPolicy，显式注入。
- 卡牌/技能合法性镜像：长期改为共享 Rule Projection；现阶段由契约测试保护。

## 13. Policy、State 与 Domain 深度审计

### AiResponsePolicy

- 濒死、格挡、护援、反制入口属于 ResponsePolicy。
- 状态构造移出 Policy，由 Controller/ResponseSystem 提供受限 DecisionContext。
- Simulator 构造移出 Policy，改为注入只读的 ResponseSimulation query。
- lightning、seal、global-benefit 公式移到 domain；Policy 只比较响应净值与机会成本。

### AiVisibleState

- GameState → VisibleState 只做合法投影。
- remaining-count、expected counts 和 distributions 转到 BeliefState builder。
- mutable search counters、概率槽、terminal 标记转到 SearchState factory。
- `TeamRuleService` 与 active skill cost 属合法公开规则投影；角色静态牌值不应污染 VisibleState。

### sealScoring / lightningScoring

- 二者都应 RENAME 为 Domain Model。
- 状态存在概率、判定类别、传播/结局属于 domain。
- 威胁/机会价值属于 value terms。
- seal delay 的 sibling comparison 属 search transition。
- RuleEngine/Distance 调用属于规则投影，必须明确是共享权威还是镜像。

### transferScoring

- 候选与组合选择属于 TransferPolicy。
- 静态卡牌情境价值归 CardValue。
- threat view 归 ThreatValue。
- unknown hand expectation 使用 BeliefState，不自行读取 remaining counts。

### AiGlobalBenefit

- 互利/共生结果模型归 GlobalBenefitModel。
- counter desire 与机会成本归 ResponsePolicy/Economics。
- root state 解析归 CardEffectSimulation。
- dynamic root flip 是受限 counterfactual query，不应让 domain 反向持有 Evaluator/Simulator。

## 14. 性能风险图

| 热点 | 当前证据 | 风险 | 迁移观测量 |
|---|---|---|---|
| SearchState clone | 每个 Simulator apply/分支克隆大量嵌套摘要 | 分配和 GC；身份字段复制错误 | clones/node、bytes/node、clone time |
| 重复 simulation | Evaluator lightning、Planner response/expose、Policy counterfactual 各自启动模拟 | 同一候选重复推演 | apply calls/root、counterfactual cache hit |
| diagnostics | owner/response/candidate ledger 可按候选生成 | 诊断开关影响热路径或语义 | diagnostics on/off 选择完全一致、耗时差 |
| 概率世界 | hidden samples × beam × block/counter/availability partitions | 组合爆炸 | worlds/root、merge ratio、pruned mass |
| repeated `stateUtility` | before/after、sibling、frontier 多次全量评估 | 大状态重复扫描 | stateUtility calls/node、memo hit |
| repeated RuleEngine/Distance | 根动作、深层动作、domain timing 重复合法性计算 | CPU 与镜像分歧 | legality calls/node、cache key correctness |
| dynamic counter/root flip | 每个 responder/target scope 构造反事实 | 战术多目标时爆发 | simulations/counter decision |
| probability diagnostics | 多个分布持续 normalize/merge | 小概率尾部和浮点开销 | branches before/after merge、lost mass |

性能优化不得先于语义 owner 分离。缓存键必须包含 SearchState 版本、viewer、actor、概率条件和实体身份；任何缓存都要用固定节点/固定 seed 的等价测试和 benchmark 证明。

## 15. 目标架构

目标依赖方向：

```text
core/Game + ResponseSystem
          |
          v
ai/controller/AIController  (composition root / stable facade)
          |
          +--> state/VisibleState -> state/Knowledge -> state/BeliefState
          |                                  |
          |                                  v
          +--> search/Planner -> search/ActionGenerator -> RuleProjection
          |          |            |
          |          v            v
          |     simulation/Simulator facade
          |          +--> CombatSimulation
          |          +--> ResponseSimulation
          |          +--> CardEffectSimulation
          |          +--> SkillEffectSimulation
          |          +--> StatusSimulation
          |
          +--> value/Evaluator -> ValueLedger, Economics, CardValue, ThreatValue
          +--> policy/ResponsePolicy, CardSelectionPolicy,
          |          ResourceSelectionPolicy, TransferPolicy
          +--> domain/LightningModel, SealModel, GlobalBenefitModel

state/SearchState + state/Probability are shared low-level value objects.
UI is outside every search/simulation/value dependency cone.
```

目标目录只是责任地图。只有在一个阶段能证明 owner、API、测试和回滚时才创建实际文件，禁止为“看起来分层”批量搬空旧模块。

## 16. 目标 API 约束

- Controller 是唯一 composition root；上游不再访问 `.planner`、`.evaluator`、`.cardSelector` 等可变内部对象，迁移期可保留只读兼容 façade。
- Planner 构造参数显式包含 `actionGenerator`、`simulatorFactory`、`evaluator`、`searchPolicy`、`beliefProvider`；不得持有 Game。
- ActionGenerator 接收 `RuleProjection` 和策略过滤器；`generateLegal` 与 `rank/filterCandidates` 分离。
- Simulator façade 接收 SearchState 和纯效果规格，返回新 SearchState/Transition；不接收 UI、Game 或 AIController。
- Evaluator 是纯读取；不得 `new Simulator`。
- Policy 接收 DecisionContext 与只读 query，不拥有状态投影或游戏结算。
- Domain model 返回概率结果或领域 terms，不反向依赖 Planner/Evaluator/Simulator concrete class。

## 17. Architecture Guard 路线

当前门禁只执行可可靠判定的规则：

1. `js/ai/state/**`、`search/**`、`simulation/**`、`value/**` 新增 UI import 时失败。
2. `js/ai/**` 任意文件出现 `game.aiController`/`this.game.aiController` 回指时失败；该项扫描整份文件，不限变更行。
3. 变更函数缺 Function Header v1 字段时失败。
4. `js/ai/state/**` 反向 import `AiController`、`AiPlanner`、`AiSimulator` 或 `AiEvaluator` 时失败。

后续在目录和 API 稳定后增加：

- Planner concrete import domain implementation；
- 跨层非法 import；
- Simulation 写 GameState 或读取 UI；
- Value 构造 Simulator；
- HiddenInfo 标注/fixture；
- 规则权威与镜像契约覆盖清单。

Guard 必须从解析到的 import、路径层和明确语法事实得出结论。禁止靠单词黑名单扫描注释或变量名制造假门禁。

## 18. 分阶段迁移计划

所有阶段共用冻结条件：保持 AI 决策行为，除阶段明确批准的 bug 外不改规则/平衡；浏览器 JS 变更统一 build；直接测试后跑完整入口、质量门禁、build 一致性和 diff 检查；每阶段可独立回滚。

### AI-ARCH-2：State Contract

- 来源 → 目标：`AiVisibleState`、`AiKnowledge`、`AiProbabilityBranches` → `state/{VisibleState,Knowledge,BeliefState,SearchState,Probability}`。
- 移动：观察投影、记忆、remaining counts、world samples、SearchState 初始化、通用分支代数。
- 不移动：雷达判定进入 Radar/Lightning domain；Simulator 的状态效果暂留。
- API/import：Controller 先构造 Visible+Belief，再由 SearchState factory 转换；保持旧 façade 兼容。
- 测试：隐藏牌互换不改变决策、记忆失效、输入只读、branch mass、clone isolation。
- 风险/回滚：字段遗漏和样本 seed 漂移；保留旧工厂并做双构造深比较后切换。

### AI-ARCH-3：Dependency Injection and Controller Boundary

状态：已完成。落地事实与验证证据见第 23 节；本节保留原迁移契约。

- 来源 → 目标：Planner/Generator 的 `game.aiController` 回指 → Controller 显式注入。
- 移动：descriptor resolver 与 composition；不移动搜索/评分逻辑。
- API/import：Planner 无 Game；Generator 注入 TransferPolicy；上游逐步使用稳定 façade。
- 测试：独立构造组件、现有搜索序列、descriptor 重绑、Supervisor Architecture Guard。
- 风险/回滚：测试 monkey patch 依赖公开子组件；保留兼容 getter 一个阶段。

### AI-ARCH-4：Value Ownership

- 来源 → 目标：Evaluator/Planner/domain scoring → `value/{Evaluator,ValueLedger,Economics,CardValue,ThreatValue}` 与 `search/TransitionValue`。
- 移动：ledger、prior、economic、frontier、transition composition；不移动 Simulator 效果。
- API/import：Evaluator 纯函数化并禁止构造 Simulator。
- 测试：state delta baseline invariance、response mutual exclusion、frontier once、diagnostic parity、opportunity-cost no double count。
- 风险/回滚：数值微差改变 tie-break；逐 term 快照和旧/新双算对比。

### AI-ARCH-5：Policy Extraction

- 来源 → 目标：CardSelector、ResponsePolicy、resource/discard/transfer helpers、Generator 策略过滤 → `policy/**`。
- 移动：选择与意愿；不移动合法性、实际实体结算、domain 结果模型。
- API/import：DecisionContext + typed query；Policy 不构造 VisibleState/Simulator。
- 测试：隐藏选择公平、转移一致、响应链、护援/救援、合法动作与策略候选分离。
- 风险/回滚：执行 token 与未知定义泄露；保留旧 Selector façade 委托新策略。

### AI-ARCH-6：Domain Models

- 来源 → 目标：lightning/seal/global-benefit 与雷达分支 → `domain/{LightningModel,SealModel,GlobalBenefitModel,RadarModel}`。
- 移动：概率结局与领域 terms；不移动 Search sibling timing、Response desire、真实 Judgment。
- API/import：domain 依赖 State/RuleProjection，不依赖 concrete Planner/Evaluator/Simulator。
- 测试：remaining-count 判定、传播、封印时序、互利座次、未来 RNG 隔离。
- 风险/回滚：概率尾差和 owner team 投影；旧函数转发并做分布容差比较。

### AI-ARCH-7：Simulation Facade and Response/Combat Split

- 来源 → 目标：Simulator 的伤害、格挡、反制、濒死、护援 → CombatSimulation/ResponseSimulation。
- 移动：概率资源消费与战斗生命周期；不移动卡牌/技能分派。
- API/import：Transition + effect worlds；Policy 仅提供 desire query。
- 测试：与 Game/Response/Dying 权威的表驱动差分、概率守恒、重复实体消费、击杀奖励。
- 风险/回滚：事件顺序/概率容量；Simulator façade 同时支持旧/新实现开关用于测试，不进生产配置。

### AI-ARCH-8：Card/Skill/Status Simulation Split

- 来源 → 目标：Simulator `apply` 的卡牌、技能、延迟状态分支 → CardEffect/SkillEffect/StatusSimulation。
- 移动：纯 SearchState 效果镜像；不移动 RuleEngine/cardRegistry/skillRegistry 权威。
- API/import：按 definition/skill adapter 注册，未知 ID 显式失败。
- 测试：每张牌、每角色技能、雷电/封印、取消/死亡/状态变化、真实权威差分。
- 风险/回滚：注册遗漏和调用顺序；按小批 definition 迁移并保留 fallback，全部覆盖后删除。

### AI-ARCH-9：Search Core

- 来源 → 目标：Planner beam、candidate composition、tie-break → `search/{Planner,SearchPolicy,TransitionValue}`。
- 移动：通用搜索；不移动 domain marginals，改为 hooks/terms。
- API/import：Planner 仅依赖接口和值对象；Architecture Guard 禁 concrete domain/service locator。
- 测试：固定节点/seed 序列、end fallback、预算、取消、frontier、隐藏样本一致。
- 风险/回滚：遍历顺序改变同分结果；锁定 stable action key 和旧/新 trace 对比。

### AI-ARCH-10：Remove Compatibility and Performance Pass

- 来源 → 目标：旧 façade、旧文件转发、重复镜像 helper → 正式分层 API。
- 移动：无；只删除已无调用的兼容层并在语义冻结后优化 clone/cache。
- API/import：上游只依赖 Controller 公共入口；启用更完整 Architecture Guard。
- 测试：完整功能、AI benchmark、适用时 Balance、quality `--all` 基线、性能报告。
- 风险/回滚：隐藏动态调用与缓存错误；删除前 `rg`+覆盖率证据，性能改动逐项独立提交。

## 19. 阶段验收与停止规则

每一阶段必须提交以下证据后才能进入下一阶段评审：

- source/target owner 表与未移动职责；
- current/target import diff 和新 API；
- 相关测试、完整测试、质量门禁、build 版本测试（浏览器资源变更时）；
- hidden-info fixture 与性能观测影响；
- `git diff --stat`、`git diff --check`、无关改动确认；
- 回滚点和仍存在的兼容层。

若无法唯一确定规则权威、价值 owner 或概率世界不变量，停止迁移并补证据，不以“先拆文件再说”推进。

## 20. AI-ARCH-1 结论

当前 AI 已具备可见状态过滤、隐藏世界采样、有限深度搜索、概率响应和较强的回归测试，但边界主要靠开发纪律而非结构保证。优先级最高的架构债务依次是：

1. Visible/Belief/Search 状态混合；
2. Planner/Generator 通过 `game.aiController` 回指；
3. Simulator 兼任状态、效果、响应、战斗与选择策略；
4. Evaluator 启动 Simulation，价值 owner 与 domain 反事实交织；
5. 规则镜像面积大但缺统一权威差分契约；
6. 概率世界与 repeated evaluation 的性能成本缺结构化观测。

因此 AI-ARCH-2 应从 State Contract 开始，而不是先拆 Simulator 或移动目录。状态和信息边界未稳定前，后续任何分层都会把同一混合对象传播到更多模块。

## 21. AI-ARCH-2 State Field Ownership Table

本表依据当前生产字段的实际生产者和消费者建立。`AiVisibleState` 目前输出的是兼容 SearchState，表中的目标 owner 描述语义所有权，而不是旧文件位置。

| Field | Current Producer | Current Consumers | Meaning | Target Owner | Mutability | Hidden-info classification | Migration decision |
|---|---|---|---|---|---|---|---|
| `gameId/currentRound/phase` | AiVisibleState ← GameState | Planner（gameId）；其余仅透传 | 已确定的对局与阶段事实 | VISIBLE | Visible 中不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState；SearchState 共享投影 |
| `deckCount/discardCount/discardDefinitionIds/judgmentDefinitionIds/publicPool` | AiVisibleState ← 公开牌区 | 当前 AI 无直接读取，测试/后续模型可读 | 已公开牌区事实 | VISIBLE | 数组与条目不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState，不复制完整牌对象 |
| `playPhaseEnded` | AiVisibleState 固定 false，Simulator 推进 | Generator、Planner、Simulator | 搜索路径终止标记 | SEARCH | 仅 Search clone 可写 | LEGAL OBSERVATION 派生 | MOVE 到 SearchState |
| `remainingCardCounts` | AiKnowledge 计算，AiVisibleState 复制 | Generator、Simulator、Evaluator、Knowledge、Lightning/Seal | 依据公开区、自己手牌和合法记忆得到的未知池 | BELIEF | 每个根状态不可变；分支克隆隔离 | BELIEF | MOVE 计算与快照到 BeliefState；Knowledge 保留兼容委托 |
| `players[].id/seatIndex/name/controllerType/battleTeam/generalId/tags/roleTags` | AiVisibleState ← Player/general | 几乎全部 AI 模块 | 公开身份、座次与阵营事实 | VISIBLE | 不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `Visible.players[].hp/maxHp/shield/energy/maxEnergy/alive` | AiVisibleState ← Player | Generator、Evaluator、Planner、Policy、Simulator、Domain | 根节点确定资源与生存事实 | VISIBLE | 不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `Search.players[].hp/shield/energy/alive` | SearchState 初始化，Simulator 推进 | Generator、Evaluator、Planner、Simulator | 分支中的模拟资源与生存状态 | SEARCH | Search clone 可写，兄弟节点隔离 | 不得回读 GameState | MOVE 初始化/clone contract；效果更新暂留 Simulator |
| `attackRange/attackUsed/attackLimit/recoverUsed/recoverLimit` | AiVisibleState ← turn flags/rules | Generator、Evaluator、Simulator、Transfer/Seal | 根节点确定的本回合规则事实 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | Visible 保存初值，SearchState 建立可变镜像 |
| `attackUseSlots` | AiVisibleState，Simulator 消费 | Generator、Evaluator、Simulator | 概率世界中的攻击次数资源 | SEARCH | Search clone 可写 | BELIEF/SEARCH 条件世界 | MOVE 初始化到 SearchState |
| `momentum/categoriesUsed/gambleTriggered/coordinationTriggered/rejuvenationTriggerCount` | AiVisibleState ← turn flags | Simulator、Evaluator、Policy | 根节点已确定的技能/回合事实 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 确定事实到 VisibleState |
| `momentumBranches/categoryUsedProbabilities/categoryUsedStateBranchesByCategory` | AiVisibleState，Simulator 规范化/消费 | Simulator | 分支相关的连势与类别使用状态 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `guardianAidUsedProbability/spyGapTriggeredProbability/gambleTriggeredProbability/coordinationTriggeredProbability` | AiVisibleState，Simulator 更新 | Simulator | 技能触发额度在概率分支中的剩余质量 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `exposeWeaknessStacks/assaultBonus` 根事实 | AiVisibleState ← statuses | Planner、Evaluator、Generator、Policy、Simulator | 公开状态的确定初值 | VISIBLE | Visible 不可变 | LEGAL OBSERVATION | MOVE 初值到 VisibleState；后续分支值属于 Search |
| `activeSkillId/activeSkillUses/activeSkillLimit/activeSkillUsed` | AiVisibleState ← general/turn flags | Generator、Evaluator、Simulator、Seal/Transfer | 确定技能身份与当前使用次数 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `activeSkillAvailabilityBranches/activeSkillUseSlots` | AiVisibleState，Simulator 消费 | Generator、Simulator | 技能次数在概率世界中的资源槽 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `activeSkillCost/nextTurnBaseAttackLimit/turnEnergyGainWithoutEquipment/energyDeviceTurnEnergyGain` | AiVisibleState 调用 Rule/Team services | Generator、Evaluator、Simulator、Seal/Transfer | 公共规则的确定派生结果 | DOMAIN | 根快照不可变；Simulator 可按模拟装备重新同步 cost | LEGAL OBSERVATION 派生 | 暂由兼容 façade 计算并注入 SearchState；不伪装成 Visible owner |
| `recycleDeviceUses/trackingTargetIds/trackingUses/huntMarkSourceId` | AiVisibleState ← turn flags/status | Evaluator、Generator、Simulator | 确定的公开装备/技能状态 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 初值到 VisibleState |
| `huntMarkProbability/huntMarkProbabilities/huntMarkStateBranchesBySource` | AiVisibleState，Simulator 更新 | Generator、Evaluator、Simulator | 猎印在条件世界中的存在质量 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `handCount` | AiVisibleState 只读取长度 | Generator、Evaluator、Planner、Simulator、Domain | 所有玩家公开手牌数量 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `hand`（仅 viewer 的 `{id, definitionId}`） | AiVisibleState ← viewer.hand | Generator、Evaluator、Planner、Simulator | 观察者合法知道的自己手牌 | VISIBLE | Visible 中不可变；Search clone 消费 | LEGAL OBSERVATION | MOVE 确定身份到 VisibleState；availability 分支由 SearchState 添加 |
| `knownCards` | AiVisibleState ← viewer.aiMemory | Simulator、Seal、Transfer、Belief sampling | 合法窥探所得 card ID/definition | KNOWLEDGE | Knowledge snapshot 不可变；真实记忆由 Game 失效 | MEMORY | MOVE 到 KnowledgeState；仅在兼容 SearchState 中投影 |
| `equipmentDefinitionId/statuses` | AiVisibleState ← 公开装备/状态 | Generator、Evaluator、Policy、Simulator、Domain | 公开装备和状态事实 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `equipmentRetentionProbability` | AiVisibleState 固定 0/1，Simulator 更新 | Generator、Selector、Evaluator、Simulator、Domain | 模拟世界中装备仍存在的概率质量 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `expectedRecoverCount` | AiVisibleState 的未知牌估计，Simulator 更新 | Planner、Simulator | 已知调息数加未知手牌期望 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState |
| `blockProbability/twoBlockProbability/blockCountDistribution` | AiVisibleState 的未知牌估计，Simulator 更新 | Planner、Simulator | 格挡数量分布及派生概率 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState；概率代数不变 |
| `counterProbability/counterCountDistribution` | AiVisibleState 的未知牌估计，Simulator 更新 | Planner、Simulator、GlobalBenefit、Seal | 反制数量分布及派生概率 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState |
| `expectedAssaultCount/assaultResponseProbability/assaultCountDistribution` | AiVisibleState 的未知牌估计，Simulator 更新 | Evaluator、Simulator、Seal | 突袭数量分布及派生概率 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState |
| `shieldBranches/energyBranches` | AiVisibleState 固定确定分支，Simulator 更新 | Simulator | 资源在条件世界中的状态分区 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| 手牌/known card `availabilityBranches/availabilityStateBranches` | AiVisibleState 固定可用，Simulator 消费 | Generator、Simulator | 同一实体在条件世界中的可用质量 | SEARCH | Search clone 可写 | SEARCH；身份来源仍为 VISIBLE/KNOWLEDGE | MOVE 初始化到 SearchState，保持 card ID 不重复消费 |
| `initialEquipmentValue/initialEquipmentRoleDelta` | AiVisibleState/AiSimulator | Evaluator、Simulator | 价值比较的根装备基线 | VALUE | 根基线固定 | LEGAL OBSERVATION 派生 | 暂由 compatibility façade 注入；ARCH-4 迁入 Value |
| `expectedEquipmentGain/expectedEquipmentRoleDelta/expectedInformationGain` | AiVisibleState 固定 0，Simulator 更新 | Evaluator、Simulator | 搜索转移产生的价值账字段 | VALUE | Search clone 中可写 | SEARCH 派生，不含隐藏牌定义 | 暂由 SearchState 承载兼容字段；owner 留给 ARCH-4 |

### Contract 结论

- VisibleState 只保存确定事实，不保存 `remainingCardCounts`、牌概率、搜索分支或价值分数。
- KnowledgeState 只保存 viewer 的合法 card-ID 记忆；remaining counts 与 hidden worlds 属 Belief。
- BeliefState 只保存由 VisibleState、KnowledgeState 和 remaining counts 推导的根不确定性，不承载模拟生命周期。
- SearchState 组合上述不可变投影并创建可写的搜索资源镜像；Simulator 只克隆和推进 SearchState，不能回读 GameState。
- DOMAIN/VALUE 字段本阶段通过显式 derived input 保持兼容，不为迁移整洁而提前进入 ARCH-4/6。

## 22. AI-ARCH-2 落地结果

### 运行时契约

当前状态组合路径为：

`GameState -> VisibleState + KnowledgeState -> BeliefState -> SearchState`

- `state/VisibleState.js` 是公开事实和观察者本人手牌投影的唯一 owner；输出普通不可变对象，不保留 `Game`/`Player` 引用。
- `state/Knowledge.js` 是观察者合法 card-ID 记忆快照的唯一 owner；历史 `AiKnowledge` 路径只重导出兼容类。
- `state/BeliefState.js` 拥有 remaining counts、隐藏牌分布与 hidden worlds；推导只使用公开牌区、观察者手牌、合法记忆和未知槽位数。
- `state/SearchState.js` 只组合已经过滤的三个契约和显式注入的 DOMAIN/VALUE 结果；`cloneSearchState` 只深克隆 SearchState，不接受或回读 GameState。
- `state/Probability.js` 拥有领域无关的概率分支代数；`AiProbabilityBranches.js` 仅保留雷达判定领域模型并重导出旧通用 API。

AI-ARCH-2 当时暂留 `createAiVisibleState` 历史命名，并将其收窄为 `createAiStateContracts(...).searchState` 的单行 compatibility façade。该入口随后已删除；正式 State owner 不再保留第二套投影或概率实现。

### 未移动职责

- Simulator 的卡牌、技能、战斗、响应、延迟状态与概率效果推进保持原位。
- expose/seal/response ledger、Transition Value、Evaluator 与 Controller 回指保持原位，分别留给后续既定阶段。
- `activeSkillCost`、下回合攻击次数、能量派生与初始装备价值仍由现有 Rule/Team/Value 权威计算，再作为 `derivedPlayersById` 注入 SearchState；这不代表 State 获得领域或价值所有权。

### 自动边界

Architecture Guard 现已覆盖 `state/**` 的模块头与 UI import 禁令，并禁止 State 反向 import Controller、Planner、Simulator 或 Evaluator。该规则只检查静态 import 路径，不扫描注释或变量关键词。

### 行为与性能基线

- 同一五人夹具下，HEAD 旧工厂和新 compatibility façade 的 SearchState 深比较完全一致，序列化大小均为 14,720 bytes；Visible/Knowledge/Belief 是小型分层投影，只有 SearchState 进行一次最终扁平组合，没有再复制三个完整大状态。
- 同一进程五轮中位数下，1,000 次状态组合：HEAD 旧工厂 19.883 ms，新四层组合 27.494 ms；根状态每次组合增加约 7.611 微秒。该入口每次 AI 决策只执行一次，新增成本来自显式创建小型分层契约。
- 同一进程五轮中位数下，1,000 次 `AiSimulator.clone()`：HEAD 旧实现 110.411 ms，新实现 108.526 ms；搜索热点克隆未退化。直接深克隆中位数为旧 67.480 ms、新 73.233 ms，差异属于相同 `structuredClone` 外增加一层稳定入口的观测成本。
- State/Knowledge/动态密度关键回归：改造前 56 项耗时 190 ms；改造后同组加 6 项 State Contract 共 62 项耗时 166 ms。

## 23. AI-ARCH-3 落地结果

### Source / target 与构造顺序

| 迁移前来源 | 当前目标 | 移动内容 | 明确保留原位 |
|---|---|---|---|
| `AiPlanner -> game.aiController.actionGenerator` | Controller 注入 `generateFromVisible` | 深层展开和破势边际所需动作生成能力 | 动作枚举、beam、评分与遍历顺序 |
| `AiPlanner -> game.aiController.knowledge` | Controller 注入 `sampleHiddenWorlds` | 合法隐藏世界采样能力 | 采样实现、样本数量、时机和随机调用顺序 |
| `AiPlanner -> Game` | random、配置 getter、`yieldControl` 窄能力 | 随机、预算覆盖和可取消让步 | 时间/节点预算语义、会话取消与 tie-break |
| `AiActionGenerator -> game.aiController.cardSelector` | Controller 注入 `chooseTransferCombination` | 根转移动作所需选择能力 | TransferPolicy/评分、合法动作集合和实体复核 |
| 上游直接取 Controller 子组件 | Controller 稳定门面 | 响应、公开/隐藏/区域/转移选择、计划序列读取 | 兼容子组件字段与历史测试替换点 |

构造顺序固定为 `Knowledge -> Evaluator -> CardSelector -> ResponsePolicy -> ActionGenerator -> Planner`。ActionGenerator 注入闭包捕获具体 CardSelector，Planner 注入闭包捕获具体 ActionGenerator/Knowledge 与 Game 的窄运行能力；任何子组件都不接收 Controller。必要能力在构造阶段按名称校验，缺失即抛 `TypeError`，不存在半装配对象或事后回填。

### Controller 边界

- 生产上游只使用 `getLegalActions`、`selectAction`、`resolvePlannedAction`、`getPlannedSequence`、`chooseDiscards`、`chooseTransferCombination`、`chooseHiddenCards`、`chooseZoneCard`、`choosePublicCard`、`shouldRespond`。
- Descriptor resolver 保留在 Controller 的真实执行边界：它必须读取“当前合法动作”并按实体 ID、目标顺序和选择字段重绑，不属于纯 Planner。
- 兼容子组件字段当时只服务历史测试与诊断工具，并非推荐 API；AI-ARCH-10 已在消费者审计后移除不再需要的入口。

### 行为冻结证据

- 新增直接构造测试证明 Planner 实例没有 `game`/`aiController` 字段，ActionGenerator 在 `game.aiController = null` 时仍通过注入能力生成转移动作，缺依赖在构造时明确失败。
- 固定种子 `20260814` 的生产装配与直接注入 Planner 对照：根动作 descriptor、10 个隐藏世界、每层深层动作 descriptor 集合和完整计划序列一致。
- 转移选择门面、ActionGenerator 注入闭包和 descriptor 重绑使用同一当前 CardSelector/合法动作集合；兼容方法替换继续动态生效。
- 功能测试在新增 4 项依赖注入测试后为 `1362/1362`；未修改规则、权重、搜索深度、束宽、hidden sample 数、prior、最终评分或 tie-break。

### Architecture Guard

质量门禁现对 `js/ai/**` 的每份被检查源码扫描完整文件，只要出现 `game.aiController` 或 `this.game.aiController` 即失败，不再仅检查变更行。Guard 自测同时覆盖合法无星号 Function/Module Header、缺字段、旧星号、JSDoc、标题同行、State 逆向 import、Controller 回指和 UI import。

### 性能观察

同一进程、同一固定局面、seed `20260814`、node budget 50 的单次改造前后观测：

| 项目 | 改造前 | 改造后 | 结构结论 |
|---|---:|---:|---|
| `Planner.plan` 20 次均值 | 9.854 ms | 10.711 ms | 都扩展 31 节点、深度 4；无算法或节点对象变化 |
| `AIController` 构造 2,000 次均值 | 0.232 μs | 1.143 μs | 增加固定闭包与依赖校验；只在 Game 构造时发生一次 |
| 10-world 隐藏采样 2,000 次均值 | 27.683 μs | 33.126 μs | 采样实现未改；差值作为单次进程噪声记录，不据此优化 |

固定 benchmark `seed=20260814`、`node-budget=200`、`category=planning` 在改造前后完全一致：Production raw `126/1000`、corrected `106/1000`，32 次决策平均扩展 `41.4` 节点、平均深度 `2.8`、报告决策耗时约 `0.9s`。本阶段没有在搜索节点中构造组件或 dependency object，也没有基于微基准做优化。

### 构建与后续边界

浏览器模块图从 `20260814-ai-state-contract` 统一更新为 `20260814-ai-controller-di`。AI-ARCH-3 没有拆 TransferPolicy、Value owner、Simulator、Response DecisionContext 或目录；这些仍按 AI-ARCH-4 之后的既定顺序处理。

以上观测用于发现结构迁移造成的明显退化，不构成跨机器性能承诺，也没有在本阶段引入缓存或主动性能优化。

### 当前回滚与兼容边界

AI-ARCH-3 当时可独立回滚的物理边界是 `state/**`、`AiVisibleState` composition façade、`AiKnowledge` 重导出、通用 Probability 重导出和 Simulator clone 委托。当时记录的旧命名、扁平状态依赖、派生注入和 Simulator 初始化兼容债务，均已在后续既定阶段关闭。

## 24. AI-ARCH-4 Value Ownership 落地结果

### Value Ownership Freeze Table

下表中的“冻结时”指 AI-ARCH-4 修改前的 `68f51d7 ARCH-3`。分类和 final 资格均按消费目的冻结；共享 primitive 若服务不同目的，以独立目的行表示，避免“有时 prior、有时 final”的模糊归属。

| Name | Current Producer（冻结时） | Current Consumers | Current Formula | Current Scale | Current Timing | Current Perspective / Owner | Current Destination | Target Owner | Final-value classification / Final | Migration Decision |
|---|---|---|---|---|---|---|---|---|---|---|
| `actionUtility` | `AiEvaluator` | Planner root/depth pruning、兼容测试 | 卡牌/技能/目标/身份/装备等既有启发式之和 | 原始 prior 分；深层除以 depth | apply 前，用于候选排序和 beam 裁剪 | actor 的可见策略视角 | `pruneScore` | `search/SearchPrior` | `SEARCH_PRIOR` / 否 | 公式原样迁移；不进入 `valueScore` |
| `actionSearchPrior` | `AiEvaluator` | Planner pruning | `burningField ? 8 : 0` | 8 分；深层除以 depth | apply 前、同层排序 | actor | `pruneScore` | `search/SearchPrior` | `SEARCH_PRIOR` / 否 | 原样迁移，与 final algebra 断开 |
| `actionEconomicValue` | `AiEvaluator` | Planner transition | 聚能跨主动技能门槛 `+4`；旧 end 入口为有剩余牌 `-0.8`，刃行者有连势例外 | economic 先乘结算概率和执行概率；随后随 transition 除 depth | transition apply 后组合；end 生产路径使用正收益 sibling 机会成本并封顶 `0.8` | actor | `immediate` / `baseTransition` | `value/Economics` | `TRANSITION_FINAL` / 是 | 无损迁移并标记 **LEGACY FINAL FLOW**；未重解释数值 |
| `stateUtility` | `AiEvaluator` | Planner、响应反事实、ledger、策略兼容调用 | 逐玩家 `sign × (death + state terms) - seal burden`，再按 holder 顺序加闪电纯值 | 原始 state value；transition 中仅 delta 乘 `0.08` | before/after、反事实与状态查询 | viewer 团队；owner primitive 先保持未签名 | state value | `value/Evaluator`，运行时由 `AiStateValue` 注入闪电纯值 | `STATE_VALUE` / 仅经 delta | 唯一公式迁移；纯 Evaluator 不再模拟 |
| `stateDelta` | `AiPlanner` | Planner final candidate algebra | `stateUtility(after, viewer) - stateUtility(before, viewer)` | `× STATE_DELTA_SCALE(0.08)`；base 再除 depth | 每次 transition 恰好一次 | viewer 团队 | `baseTransition` | `search/TransitionValue` | `TRANSITION_FINAL` / 是 | 公式和运算顺序整体迁移；Planner 删除实现 |
| owner ledger | `AiEvaluator` | Planner diagnostics、测试 | 同一 owner 的 before/after state terms、death、seal、lightning 差值 | 未缩放 owner-local 数值 | 显式 diagnostics 的根候选 | owner-local；投影时才施加 self/ally/enemy 符号 | `lastSearchStats.rootLedgers` | `value/ValueLedger` | `DIAGNOSTIC_ONLY` / 否 | schema 与投影迁移；复用 Evaluator primitive |
| response ledger | `AiPlanner` | root diagnostics、测试 | actual world 与只移除 block/counter/recover 的配对世界之差 | 未缩放；记录 resource/gross/owner/net | diagnostics 开启时的根候选 | responder owner + viewer projection | diagnostic responses | `value/ValueLedger`；模拟查询在 `AiValueSimulationQuery` | `DIAGNOSTIC_ONLY` / 否 | attribution 迁移；`responseNet` 明确不再加进 final，因为已含于 state delta |
| candidate ledger | `AiPlanner` | diagnostics | `{ ownerLedger, projected, responses }` | 表示层，不缩放 | diagnostics 开启时 | viewer + owners | root diagnostics | `value/ValueLedger` | `DIAGNOSTIC_ONLY` / 否 | schema/构造迁移；关闭 diagnostics 时不计算 |
| `cardOpportunityCost` | `AiEvaluator` | 价值归属诊断、测试 | generic `1.1`、role delta、recover/recycle future option、block/counter/recover capacity | 原始诊断分量 | 卡牌消费解释时 | 当前持有者 | diagnostic decomposition | `value/CardValue` | `DIAGNOSTIC_ONLY` / 否 | 原样迁移；手牌减少只由 state delta 进入 final |
| frontier future inventory | `AiEvaluator` + Planner | frontier diagnostics | `futureInventory + energyPressure` | 原始 threat value | frontier/terminal 表示 | viewer | residual diagnostic | `search/FrontierValue` | `DIAGNOSTIC_ONLY` / 否 | 保留表示但不加 final，因已在 State Value 暴露项中 |
| frontier held recover/recycle | `AiEvaluator` + Planner | terminal candidate | recover 可兑现治疗 + recycle 剩余次数与战术牌机会 | held 总和 `×0.08` | 仅 `playPhaseEnded` terminal 一次 | viewer | `frontierValue` | `search/FrontierValue` | `TRANSITION_FINAL` / 是 | 独立 owner；非 terminal 为零且路径中不累计 |
| seal delay / timing | `sealScoring` + Planner | final transition | 最佳非 seal sibling 的延迟成本，经既有 `sealDelayCost` / `sealEarlyUsePenalty` | 既有 penalty；不再乘 state scale | 同一 parent 全部候选 materialize 后 | actor/viewer | final candidate | producer 暂留 domain/Planner；composition 在 `TransitionValue` | `DOMAIN_TERM` / 是 | producer 不动，避免提前 ARCH-6；final composition 已迁移 |
| expose marginal | Planner + Simulator | final transition | baseline 与仅新增一层破势的配对反事实 state-value 差 | 根为原值；深层先除 depth；组合再 `×0.08` | expose transition | actor/viewer | final candidate | producer 暂留 Planner；composition 在 `TransitionValue` | `DOMAIN_TERM` / 是 | 只迁移组合；反事实 producer 留待 ARCH-6/9 |
| assault stack marginal | Planner + Simulator | final transition | baseline 与只改变可兑现旧破势层的配对反事实差，按 remaining provenance 推进 | 根为原值；深层先除 depth；组合再 `×0.08` | assault transition | actor/viewer | final candidate | producer暂留 Planner；composition 在 `TransitionValue` | `DOMAIN_TERM` / 是 | 只迁移组合；保持 telescoping 与一次消费 |
| static base card value | `roleCardValue` / card config | discard、resource、unknown expectation、Search Prior | `CARD_DEFINITIONS[id].aiValue` | 配置原值 | 选择/保留/排序时 | card owner/actor | policy/prior 输入 | `value/CardValue` | `POLICY_VALUE` / 否 | 单份公式迁移；不得直接成为 final action value |
| role card delta / equipment keep | `roleCardValue` | Evaluator state terms、discard/resource/prior | 稀疏角色差量；装备替换为旧装备值×保留概率，同装备再 `+4` | state 中 role/equipment delta 保持既有 `0.25` 缩放 | state 读取或资源保留决策 | card/equipment owner | State Value primitive 或 policy input | `value/CardValue` | `DOMAIN_TERM` / 仅经 State Value | 单份公式迁移；不作为额外打牌奖励 |
| target threat priority | `ThreatCalculator` | AiEvaluator action prior、transfer scoring | 缺血、手牌数、能量、角色标签、致死线、状态与近期攻击者加权 | 原始策略分 | 目标选择/排序 | viewer 对敌方 | policy/prior input | `value/ThreatValue` | `POLICY_VALUE` / 否 | 安全移动 + 旧路径重导出；公式唯一 |
| exposure / radar | `AiEvaluator` | State Value、frontier diagnostics、响应策略 | 按距离概率拆 current/future/energy exposure；雷达以保留概率×战术判定概率抵扣 | `HP_VALUE=5` 的威胁尺度 | 单状态估值 | 被评估 owner；最终由 viewer 投影 | State Value terms | `value/ThreatValue` primitive + `value/Evaluator` composition | `STATE_VALUE` / 仅经 delta | primitive 迁移；单次玩家估值只分解一次 |
| shield / HP risk | `AiEvaluator` | State Value | 第一盾储备 `2`、受威胁保护 `0.5`、HP=2 风险 `0.05×danger`，保持既有上界 | state value 原始尺度 | 单状态估值 | 被评估 owner | State Value terms | `value/ThreatValue` primitive + `value/Evaluator` composition | `STATE_VALUE` / 仅经 delta | 原样迁移；不另加伤害避免奖励 |
| lightning lifecycle state value | `AiEvaluator` 内构造 `AiSimulator` | `stateUtility`、ledger | 按合法判定/传播分布模拟最终 holder，累计 owner material delta | 概率质量×owner delta；transition 仅随 state delta `×0.08` | 单状态估值的延迟状态生命周期 | holder owner，随后 viewer 团队投影 | State Value/domain burden | query 在 `AiValueSimulationQuery`，纯值由 `value/Evaluator` 消费 | `DOMAIN_TERM` / 经 State Value | 模拟上移；Evaluator 只接收纯数值数组，未提前拆 LightningModel |
| lightning policy/prior value | `AiEvaluator` + `lightningScoring` | Search Prior、ResponsePolicy | 同一生命周期值/负担及转移后负担 | 既有 prior/policy 尺度 | 主动使用、状态反制决策 | actor/viewer | prior/policy | query 在 `AiValueSimulationQuery`；domain helper 暂留 | `POLICY_VALUE` / 否 | 与 final State Value 入口分离，保留后续 ARCH-6 债务 |
| GlobalBenefit value | `AiGlobalBenefit` | Search Prior、ResponsePolicy、Simulator | `assessGlobalBenefit` 的座次/阵营 net 与 counter desire/root flip helper | 既有模块内缩放；symbiosis prior `×4` | policy、prior 或 simulation 结果建模 | actor/team | policy/domain result，不直接进 transition | domain producer 暂留 `AiGlobalBenefit` | `DOMAIN_TERM` / 不直接 final | 生产 CardValue import 指向正式 owner；不提前执行 ARCH-6 |
| resource keep value | `discardScoring` / `resourceSelectionValue` / `transferScoring` | CardSelector、Simulator | 静态卡值、角色差量、装备折损、未知期望与具体用途组合 | 既有 policy 权重 | 支付、弃置、转移选择 | 资源 owner | selection policy | policy 文件暂留；稳定静态输入改用 `value/CardValue` | `POLICY_VALUE` / 否 | 仅收敛价值依赖；Policy Extraction 留给 ARCH-5 |

### Physical Value Architecture

正式物理 owner 为：

- `value/Economics.js`：`HP_VALUE`、`STATE_DELTA_SCALE`、能量/技能门槛尺度与 `actionEconomicValue`。
- `value/CardValue.js`：静态卡值、角色差量、装备保留、availability 与诊断机会成本。
- `value/ThreatValue.js`：目标威胁以及 exposure/radar/shield/HP-risk primitives。
- `value/Evaluator.js`：纯 State Value、owner state terms 与 owner material value。
- `value/ValueLedger.js`：owner/response/candidate 的诊断 schema 与投影。
- `search/TransitionValue.js`：唯一 final transition algebra。
- `search/FrontierValue.js`：frontier representation 与 terminal held value。
- `search/SearchPrior.js`：`actionUtility`、`actionSearchPrior` 与 target prior。
- `AiValueSimulationQuery.js`：价值上游仍需的闪电生命周期和响应配对模拟查询；它不属于纯 value 层。
- `AiStateValue.js`：把闪电纯值送入 Evaluator 的薄运行时适配器，不复制公式。

Controller 的构造顺序固定为 `Knowledge -> Evaluator -> ValueSimulationQuery -> AiStateValue -> ValueLedger/FrontierValue/SearchPrior/TransitionValue -> AiEvaluator façade -> Policy/Generator -> Planner`。每个正式 owner 只构造一次，再显式注入消费者；搜索节点不构造 owner object。

AI-ARCH-4 当时的 `AiEconomics.js`、`ThreatCalculator.js`、`roleCardValue.js` 只重导出正式 owner，`AiEvaluator.js` 也只动态绑定正式 owner 方法。它们作为迁移期测试与上游兼容入口，最终已在 AI-ARCH-10 通过调用证据删除。

### Evaluator、TransitionValue 与 Ledger 边界

`value/Evaluator.stateUtility(state, viewerId, lightningValues)` 是 State Value 的唯一正式公式入口。它只依赖稳定卡牌配置、合法概率/封印 helper、CardValue、ThreatValue、Economics 和显式注入的团队能量规则函数；没有 Game、Controller、Planner 或 concrete Simulator import，也没有上述对象的运行时回指。闪电模拟在上游完成后只以纯数值数组进入。

Final transition 的既有运算顺序冻结为：

```text
stateDelta = stateUtility(after, viewer) - stateUtility(before, viewer)
immediate = economic * resolutionScale * executionProbability
baseTransition = (immediate + stateDelta * 0.08) / depth
finalTransition = baseTransition
                + terminalFrontierHeldValue
                - sealTimingPenalty
                + (exposeMarginal + assaultStacksCredit) * 0.08
```

`responseNet` 仍可作为显式诊断输入进入 schema，但 `TransitionValue` 不把它加到 final；实际响应结果已经在 after-state 中，二次相加会重复计价。根/深层 end 的正收益 sibling 机会成本仍由 Planner 产生，最终组合必须经过 TransitionValue。TransitionValue 不读取 Game/Controller，不生成动作、不模拟、不搜索、不决定 beam/tie-break，也不依赖 SearchPrior。

ValueLedger 的生产语义是“解释同一 State Value 世界”，不是第二套分数。owner schema 包含 `generic`、`material`、`threat`、`specific`、`outcome`、`teamBurden`；projection 包含 `self/ally/enemy/total`；response schema 包含 `kind/responderId/protectedId/resourceSpent/grossAvoided/ownerValue/netValue`。以上全部为 `DIAGNOSTIC_ONLY`，只在 `collectAiDecisionDiagnostics=true` 的根候选生成。

### Search Prior、Frontier 与 domain marginal

根节点 `pruneScore = valueScore + hiddenAdjustment + actionUtility + actionSearchPrior`，深层 prior 仍按既有 depth 除法进入 `pruneScore`。最终 beam 重排、root choice、end fallback 与 `bestValueScore` 只比较 `valueScore`；TransitionValue 没有 SearchPrior 依赖。

FrontierValue 始终生成可解释 residual，但 `futureInventory` 已在 State Value 的 exposure 中，只作诊断；只有 held recover/recycle 在 terminal 一次乘 `0.08` 进入 final。非 terminal 返回零，路径节点不会累计 residual。

Expose、assault-stack 与 seal timing 的领域 producer 暂留 Planner/既有 domain helper；它们只把命名数值交给 TransitionValue 组合。闪电 probability/lifecycle helper 和 GlobalBenefit producer 也保留原位。这样完成 Value Ownership，又没有提前实施 ARCH-6 Domain Models、ARCH-7 Simulation Split 或 ARCH-9 Search Core。

### 防重复计分不变量

- HP、死亡、盾、能量、手牌数、装备和实际响应消费：只通过 after-before State Value 进入 final。
- 静态卡值用于选择/prior；角色手牌/装备差量若是状态存量，只经 State Value 变化进入 final。
- `cardOpportunityCost` 和 response ledger 只诊断，不能重复扣除同一实体或响应资源。
- `actionEconomicValue` 只保留 after-state 不表达的历史 end/技能门槛 flow，并以 **LEGACY FINAL FLOW** 记录；ARCH-4 未借机修正或重新平衡。
- frontier future inventory 不进入 final；held option 仅 terminal 一次。
- expose/assault/seal 只在 TransitionValue 的显式 domain slots 进入一次；配对反事实只改变被测层数或响应能力。

### 行为、数值与性能证据

逐 term legacy/new 测试锁定 `economic`、`resolutionScale`、`executionProbability`、`immediate`、`stateDelta`、`stateDeltaValue`、`depth`、`baseTransition` 和 final composition。现有 value snapshots 继续覆盖普通/确定突袭、格挡、反制、濒死救援、击杀、调息、装备、破势新增/消费、封印 timing、frontier recover/recycle、end fallback、闪电与 GlobalBenefit。Diagnostics off/on 的 root action、计划序列、节点、深度、hidden samples、final value 和 tie-break 相同。

固定 D4 场景 `planning.d4-seal-then-kill`、seed `20260814`、node budget `200`，改造前后均选择 `seal -> c`，计划为 `seal c -> stealSkill c -> assault b -> end`，扩展 `102` 节点、深度 `4`、hidden samples `10`、`bestValueScore=0.04919669968375734`。

同一进程各 10 次的结构观测如下；时间只用于发现数量级退化，不作为跨机器承诺。Simulator 构造数按已审计构造路径计数：每次 plan 一个，diagnostics 中每次 response counterfactual 两个；该 D4 场景没有 lightning query。

| Diagnostics | 阶段 | Planner 均值 | `Simulator.apply` | `new Simulator` | 活跃 Simulator | `stateUtility` | final composition | response query |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| off | 改造前 | 64.790 ms | 103 | 1 | 1 | 204 | 102 | 0 |
| off | 改造后 | 61.801 ms | 103 | 1 | 1 | 204 | 103 | 0 |
| on | 改造前 | 57.639 ms | 109 | 13 | 7 | 228 | 102 | 6 |
| on | 改造后 | 61.163 ms | 109 | 13 | 7 | 228 | 103 | 6 |

完整 simulation、stateUtility 与响应反事实次数没有增加。Final composition 增加一次是 end fallback 从 Planner 内联代数改为经过唯一 TransitionValue owner；它是不模拟、不读取状态的常数次纯数值组合。Diagnostics 的额外 6 次 apply、12 次 stateUtility 和 12 个响应反事实 Simulator 构造仅在开关开启时发生，生产关闭路径保持原计数。

固定 benchmark `seed=20260814`、`node-budget=200`、`category=planning` 在改造前后均为 raw `126/1000`、corrected `106/1000`，32 次决策平均扩展 `41.4` 节点、平均深度 `2.8`；报告决策耗时由约 `0.9s` 观测为约 `0.8s`，总耗时均约 `1.0s`。没有引入缓存或主动性能优化。

最终验证为 Value/依赖/搜索专项 `142/142`、炎术师与反制补充专项 `46/46`、完整功能入口 `1367/1367`、浏览器 build 一致性 `1/1`；10 个新增核心模块通过 `node --check`，quality self-test 与 `--changed`（57 个生产文件）通过，`git diff --check` 通过。

### Architecture Guard、构建与 Remaining Debt

质量门禁使用去注释后的真实 import/new 语法检查 `value/**`，禁止 UI、Controller、Planner 和 concrete Simulator 依赖或 `new AiSimulator`；注释中的相同文本不会误报。`search/TransitionValue.js` 额外禁止 Game/AIController import 与 `this.game`。Guard self-test 覆盖合法 value、非法 import/new、注释忽略和 TransitionValue 边界。

浏览器模块图从 `20260814-ai-controller-di` 统一更新为 `20260814-ai-value-ownership`。AI-ARCH-4 当时记录的 Remaining Debt 为：

- `AiEvaluator`、`AiStateValue` 和旧 Card/Economics/Threat compatibility façade 后来在 AI-ARCH-10 删除。
- resource/discard/transfer 与 ResponsePolicy 的正式 Policy 目录迁移后来在 AI-ARCH-5 完成。
- expose/assault/seal/Lightning/GlobalBenefit 的 Domain producer 迁移后来在 AI-ARCH-6 完成。
- response counterfactual 与 ResponseSimulation 的正式拆分后来在 AI-ARCH-7/8 完成。
- Planner 的 candidate materialization（把动作完整转换成搜索节点）、end sibling 与 Search Core 清理后来在 AI-ARCH-9/10 完成。

AI-ARCH-4 没有修改权重、规则、策略、搜索参数、概率常量或隐藏信息边界，也没有提前进入 AI-ARCH-5。

## 25. AI-ARCH-5/6 Policy / Domain Responsibility Freeze

本表冻结于 `8e1dfb0 ARCH-4`。分类按函数的实际输出用途确定，而不是按旧文件名确定；同一旧文件中的不同函数可以有不同 owner。`Migration Decision` 只授权 AI-ARCH-5/6 的物理迁移，未列为 MOVE 的职责必须保持原位。

| Current File / Function | Current Responsibility | State / Input | Output | Current Consumers | Target Classification | Target Owner | Migration Decision |
|---|---|---|---|---|---|---|---|
| `AiCardSelector.constructor` | 持有 Game、Knowledge 与随机源 | Game、Knowledge | 选择门面实例 | AIController、测试 | EXECUTION_BOUNDARY | `AiCardSelector` façade | KEEP；Controller 改为注入正式 Policy，门面继续解析真实实体 |
| `AiCardSelector.chooseHiddenCards` | 混合合法实体过滤、合法记忆、未知位置随机和用途选择 | Player 实体、排除 ID、purpose、remaining counts | 真实 Card 实体数组 | AIController、Game/技能 | EXECUTION_BOUNDARY + POLICY | façade + `policy/CardSelectionPolicy` | SPLIT；过滤/实体返回留门面，已知/未知候选与位置策略迁 Policy |
| `AiCardSelector.peekIndex/extremeIndex` | 已知/未知位置的稳定选择和受控随机 | known map、候选位置、方向 | 数组下标 | `chooseHiddenCards`、测试 | POLICY | `policy/CardSelectionPolicy` | MOVE；随机次数与同分顺序冻结 |
| `AiCardSelector.chooseZoneCard` | 混合真实区域实体检查与资源区域偏好 | actor/owner 实体、purpose、排除 ID | `{card, zone}` | AIController、Game | EXECUTION_BOUNDARY + POLICY | façade + `policy/ResourceSelectionPolicy` | SPLIT；实体存在/返回留门面，hand/equipment 比较归 Policy |
| `AiCardSelector.expectedCardValue/choosePublicCard` | 合法已知牌与公开池的局部价值选择 | 合法记忆或公开卡、CardValue | 数值或 Card | 测试、PublicCardPool | POLICY | `policy/CardSelectionPolicy` | MOVE；CardValue 仍是 VALUE owner |
| `AiCardSelector.chooseTransferSource/Receiver/Combination` | 取得 RuleEngine 合法集合并选最佳转移描述 | Game、合法 source/receiver、Belief counts | transfer selection | AIController、ActionGenerator、测试 | EXECUTION_BOUNDARY + POLICY | façade + `policy/TransferPolicy` | SPLIT；RuleEngine 合法集合留边界，组合评分/选择迁 Policy |
| `AiCardSelector.chooseDiscards` | 计算真实距离上下文并选择弃牌 | Game、Player.hand | Card 数组 | AIController、角色规则 | EXECUTION_BOUNDARY + POLICY | façade + `policy/ResourceSelectionPolicy` | SPLIT；距离事实由门面提供，保留价值排序归 Policy |
| `AiResponsePolicy.assessDyingRescue` | 救援资源、后续救援密度与角色价值意愿 | 响应者/目标、救援顺序、Belief | assessment object | `shouldRespond`、测试 | POLICY | `policy/ResponsePolicy` | MOVE；救援顺序与玩家快照通过 DecisionContext 提供 |
| `AiResponsePolicy.knownPendingAssaultBonus` | 只读公开突袭加伤预览 | response context | bonus | `shouldRespond` | POLICY | `policy/ResponsePolicy` | MOVE；不触发真实监听器 |
| `AiResponsePolicy.shouldRespond` | block/counter/dying/leverage/guardian 的局部响应选择 | 合法响应窗口、Cards、DecisionContext | boolean | ResponseSystem、AIController | POLICY | `policy/ResponsePolicy` | MOVE；不得投影 State 或构造 Simulator |
| `AiResponsePolicy.shouldUseGuardianAid` | 混合合法前置、State 投影、配对模拟和值比较 | GameState、Knowledge、damage context | boolean | `shouldRespond` | POLICY + SIMULATION + STATE | `policy/ResponsePolicy` + `AiValueSimulationQuery` + Controller | SPLIT；合法事实/快照由 composition boundary 提供，配对模拟经窄 query，Policy 只比较结果 |
| `AiResponsePolicy.shouldCounterLightning/Seal` | 状态反制意愿 | holder、Domain facts、Value query、counter cost | boolean | `shouldRespond` | POLICY | `policy/ResponsePolicy` | MOVE；Lightning/Seal facts 改从 Domain 消费 |
| `AiResponsePolicy.dynamicRootCounterDecision` | 混合 State 投影、root-effect simulation 与反制成本比较 | 当前 response state、root context | boolean | `shouldRespond` | POLICY + SIMULATION + STATE | `policy/ResponsePolicy` + `AiValueSimulationQuery` + Controller | SPLIT；root simulation 保持窄 query，不建立 ARCH-7 ResponseSimulation |
| `AiActionGenerator.expectedAvailableAssaults/expectedAvailableAttackUses/canBenefitFromBreakArmy/isZeroBenefitAllIn` | 零收益技能候选过滤 | SearchState actor | boolean/number | 根/深层动作生成 | POLICY | `policy/ActionCandidatePolicy` | MOVE；不改变合法性，只过滤 AI 候选 |
| `AiActionGenerator.isLightningStrategicallyForbidden` | 3v1 主动闪电硬禁令 | 存活玩家、actor team | boolean | 根/深层动作生成 | POLICY | `policy/ActionCandidatePolicy` | MOVE；唯一 owner，保持 hard constraint，绝不降为 penalty |
| `AiActionGenerator.chooseVisibleTransferPlan` | 在调用方提供的合法 source/receiver 中选转移计划 | SearchState、RuleEngine 合法集合 | transfer selection | 深层动作生成 | LEGALITY + POLICY | Generator + `policy/TransferPolicy` | SPLIT；合法集合由 Generator/RuleEngine，选择归 TransferPolicy |
| `AiActionGenerator.generate/generateFromVisible` | 混合 RuleEngine 合法枚举与 AI 候选过滤 | GameState 或 SearchState | policy-filtered action set | AIController、Planner | LEGALITY + POLICY | Generator + `policy/ActionCandidatePolicy` | KEEP/SPLIT；Generator 仍枚举，策略判断委托；历史 `getLegalActions` 名称暂为兼容债务 |
| `AiActionGenerator.getActionConditionPartition/attachProbabilityBranches` 等 | 深层执行概率与资源条件世界 | SearchState、Probability algebra | annotated candidate | Planner | STATE | ActionGenerator（ARCH-8/9 前） | KEEP；不属于局部选择迁移 |
| `discardScoring.*` | 自主弃牌保留价值、排序与选择 | player/cards/context、CardValue | score/ranked/cards | CardSelector、Simulator、测试 | POLICY | `policy/ResourceSelectionPolicy` | MOVE；旧文件只重导出，Simulator 继续复用同一 owner |
| `resourceSelectionValue.*` | destroy/plunder 的已知/未知资源效用与区域选择 | actor/owner、Belief counts、CardValue | utility/candidate/zone | CardSelector、Simulator、测试 | POLICY | `policy/ResourceSelectionPolicy` | MOVE；不复制 CardValue 或 Belief probability |
| `transferScoring.cardAvailability/handCount/known*` | 把合法观察、记忆和概率身份整理为转移候选摘要 | actor/owner、排除 ID | counts/known entries | transfer functions | POLICY | `policy/TransferPolicy` | MOVE；未知牌绝不携带真实 definitionId |
| `transferScoring.cardSituationValue/expectedUnknownSituationValue` | 转移用途的 CardValue 情境解释 | player、definition/counts | policy value | transfer scoring/tests | POLICY | `policy/TransferPolicy` | MOVE；基础/角色值仍由 `value/CardValue` 提供 |
| `transferScoring.chooseTransferHandCandidate/evaluate/score/build/chooseBest` | 合法转移组合的评分、稳定排序与正收益门槛 | legal source/receiver/zone、Belief | candidate/score/selection | CardSelector、Generator、测试 | POLICY | `policy/TransferPolicy` | MOVE；RuleEngine 合法性与真实移动不进入 Policy |
| `lightningScoring.has/status/presence` | 闪电状态的确定/概率存在事实 | filtered player | boolean/branches/probability | Generator、Simulator、Value query | DOMAIN | `domain/LightningModel` | MOVE；状态写入仍由 Simulator |
| `lightningScoring.equipmentJudgmentProbability` | 剩余未知池的装备判定概率 | remaining counts/card config | probability | tests/domain query | DOMAIN | `domain/LightningModel` | MOVE；通用概率代数仍由 State Probability |
| `lightningScoring.nextReceiver/propagationChain/hitDistribution` | 存活座位环、跳过已有闪电、无放回命中分布 | players/state/holder | holder ring/distribution | Value simulation query、测试 | DOMAIN | `domain/LightningModel` | MOVE；RuleEngine 是 seat receiver authority，模型为 AI DERIVED MODEL |
| `sealScoring.has/status/presence/tacticJudgmentProbability/sealCounterProbability/sealOutcomeProbabilities` | 封印状态、判定与先反制后判定生命周期摘要 | filtered state/holder/remaining counts | status branches/probability schema | Generator、Simulator、Response、Value | DOMAIN | `domain/SealModel` | MOVE；输入只读、输出独立 |
| `sealScoring.turnOrderGap/turnTimingFactor/futureSkill*/assault*/turnOpportunityValue/sealUseValue` | 目标时机、未来行动威胁与主动使用先验 | SearchState player/actor/target | policy/prior value | Response、SearchPrior、测试 | POLICY + VALUE | 旧 `sealScoring`（迁移期） | KEEP；不得因文件名提前移入 Domain |
| `sealScoring.sealTeamBurden` | 把 Domain skip probability 解释为团队价值 | state/holder/viewer team | signed burden | Evaluator、ValueLedger | VALUE | 旧 `sealScoring`（后续可收敛 Value） | KEEP；Domain 不反向依赖 Value |
| `sealScoring.sealDelayCost/sealEarlyUsePenalty` | sibling opportunity 的 depth timing penalty | alternative transition/depth | search penalty | AiPlanner/Transition composition | SEARCH | Planner producer / TransitionValue consumer | KEEP；明确不进 SealModel |
| `AiGlobalBenefit.mutualBenefitSeatOrder` | 互利真实公开池选择座次 | players/source | living seat order | draft model | DOMAIN | `domain/GlobalBenefitModel` | MOVE；顺序保持 source-first clockwise |
| `AiGlobalBenefit.mutualBenefitDraftValues/assessGlobalBenefit` | 混合公开池顺序、recipient outcome 与 CardValue | players/team/counts/value | per-player value/team outcome | Simulator、SearchPrior、Response、测试 | DOMAIN + VALUE adapter | Domain model + compatibility façade | SPLIT；Domain 接受窄 `definitionValue` 查询，旧 façade 注入 CardValue；保持原逐候选调用次数且 Domain 不反向 import Value |
| `AiGlobalBenefit.globalBenefitCounterDesire/counterOpportunityCost` | root parity 与反制机会成本的局部意愿 | domain outcome、counter depth | desire/cost | ResponsePolicy、Simulator | POLICY | `policy/ResponsePolicy` | MOVE；旧文件重导出，不进入 Domain |
| `AiGlobalBenefit.buildTargetScopedBase/buildRootSelection/resolveRootState/dynamicRootFlipGain` | root-effect 配对状态构造与模拟 | SearchState、Simulator、Evaluator、root | cloned/resolved state/gain | ResponsePolicy、测试 | SIMULATION | `AiValueSimulationQuery` / 兼容入口 | MOVE query 入口但不拆 Simulator；ARCH-7 前不建 ResponseSimulation |
| `AiProbabilityBranches.buildRadarJudgmentProbabilities/RADAR_BASIC_DEFINITIONS` | 雷达判定池的类别/定义分布 | remaining counts/override/card config | Radar outcome | Simulator、Evaluator、ValueLedger | DOMAIN | `domain/RadarModel` | MOVE；旧文件继续重导出通用 Probability 与 Radar API |
| `AiSimulator` 对 Resource Policy 的调用 | 模拟 destroy/plunder/guardian discard 选择 | SearchState | 资源选择/消费 | Simulator effects | SIMULATION consuming POLICY | AiSimulator -> formal Policy functions | IMPORT UPDATE ONLY；状态修改和效果执行不移动 |
| `AiSimulator` 对 Lightning/Seal/Radar 的调用 | 读取状态分支与判定分布后推进模拟状态 | SearchState | mutated cloned SearchState | Planner/Value query | SIMULATION consuming DOMAIN | AiSimulator -> domain models | IMPORT UPDATE ONLY；实际写状态留 Simulator |
| `AiSimulator` 对 GlobalBenefit/response desire 的调用 | 互利 recipient 值写入、规划反制概率 | SearchState | simulated outcome | Planner | SIMULATION consuming DOMAIN/POLICY | AiSimulator -> façade/domain/policy | IMPORT UPDATE；dynamic counter simulation 仍留 Simulator |
| `AiPlanner.evaluateExposeMarginal/evaluateAssaultStacksMarginal` | search-specific 配对反事实 producer | sibling SearchState/Simulator | domain marginal number | TransitionValue | SEARCH | AiPlanner（ARCH-9 前） | KEEP；不进入 Domain Models |
| `AiPlanner` seal sibling producer | 物化同层候选后计算 delay/timing | sibling base transition/depth | sealTimingPenalty | TransitionValue | SEARCH | AiPlanner + TransitionValue slot | KEEP；不改变 apply 次数 |
| `value/Evaluator` 与 `ValueLedger` 的 radar/seal 消费 | 用 Domain facts 解释 state/ledger value | SearchState + Radar/Seal result | State Value / diagnostics | Planner/diagnostics | VALUE consuming DOMAIN | value owners -> domain models | IMPORT UPDATE ONLY；公式与累加顺序冻结 |
| `TransitionValue.composeCandidateValue` | 组合显式 seal/expose/assault terms | numeric terms | final transition value | Planner | VALUE | `search/TransitionValue` | KEEP；ARCH-5/6 不修改公式 |

### Freeze 结论

- `Legal Actions` 是 RuleEngine/Generator 权威允许的集合；当前历史 `AIController.getLegalActions` 实际返回经过 3v1、零收益技能、敌我目标和正收益转移过滤的 **AI policy candidate set**。AI-ARCH-5 只把过滤判断交给 Policy，不把策略拒绝描述成游戏非法；历史方法名留作兼容债务。
- 3v1 主动闪电禁令唯一归 `policy/ActionCandidatePolicy`。LightningModel 只描述状态、座位环和概率分布，不再复制战略判断。
- Domain 是 AI 的 `DERIVED MODEL` 或 `SIMULATION MIRROR` 输入，不是 Game authority。RuleEngine、真实判定/卡牌/伤害生命周期继续是 `AUTHORITY`。
- Simulator 仍完整负责 SearchState 效果写入；Planner 仍负责 expose/assault/seal sibling 的 search-specific producer；Value 与 Transition 公式全部冻结。

## 26. AI-ARCH-5 Policy Extraction 落地结果

### Physical Policy Architecture

- `policy/ResponsePolicy.js`：只消费 DecisionContext、纯 Domain/Value 结果和窄 query；不投影 GameState、不构造 Simulator。
- `policy/CardSelectionPolicy.js`：拥有合法候选内的已知/未知位置、公开池和资源选择；未知敌方牌只按位置或聚合期望处理。
- `policy/ResourceSelectionPolicy.js`：唯一拥有 discard、destroy/plunder resource、hand/equipment zone 的局部策略公式。
- `policy/TransferPolicy.js`：唯一拥有 source/receiver/zone 合法集合内的转移评分、未知期望、稳定排序和正收益门槛。
- `policy/ActionCandidatePolicy.js`：拥有零收益技能过滤、敌方资源目标过滤与 3v1 主动闪电硬约束。

`AIController` 仍是唯一 composition root：每个正式 Policy 实例只构造一次，再注入 CardSelector façade、Response façade 和 ActionGenerator。Policy 不接收 Controller/Game/Planner；需要真实实体、RuleEngine 合法集合、State projection 或 simulation query 的工作均留在边界层。

### Legal / Policy 与 Compatibility

RuleEngine/Generator 产生规则合法集合；历史 `AIController.getLegalActions` 返回的是进一步经过 AI 战略过滤的 policy candidate set。3v1 禁雷是 `ActionCandidatePolicy.isLightningStrategicallyForbidden` 的唯一硬约束，不属于 LightningModel，也不是 soft penalty。

`AiCardSelector.js`、`AiResponsePolicy.js`、`discardScoring.js`、`resourceSelectionValue.js`、`transferScoring.js` 保留旧签名；前三类 façade 只负责真实实体/状态/query 适配，后三个旧评分路径只重导出正式 owner。不存在旧新双公式。

### 行为与隐藏信息证据

- 正式 Policy 直接测试锁定 Response、Card、Resource、Transfer 和 3v1 owner；兼容 façade 与正式 owner 的固定输入结果一致。
- 敌方未知 `definitionId` 换面不会改变 Response/Card/Transfer 选择；DecisionContext 不包含其他玩家真实未知手牌定义。
- Response/反制/借势/互利/救援/格挡宽覆盖 `210/210`；Policy/selector/resource/transfer/hidden/lightning/seal/build 覆盖 `204/204`。
- ARCH-5 完整入口为 `1371/1371`；固定 planning benchmark 保持 raw `126/1000`、corrected `106/1000`、平均扩展 `41.4`、平均深度 `2.8`。

## 27. AI-ARCH-6 Domain Models 落地结果

### Physical Domain Architecture 与输出契约

| Owner | 正式事实/派生 | 输出 schema | 明确保留在外部 |
|---|---|---|---|
| `domain/RadarModel.js` | 剩余判定池的 tactic/equipment/basic 概率 | `{ tactic, equipment, basic, hasJudgmentPool }` | 雷达真实判定/移动由 JudgmentSystem/Game；价值解释由 Evaluator |
| `domain/LightningModel.js` | 状态分支、装备概率、接收者 ID、存活传播环、无放回命中分布 | status branches；`{ holderId, hop, probability }[]` | 3v1/反制意愿在 Policy；SearchState 写入与伤害在 Simulator |
| `domain/SealModel.js` | 状态分支、战术判定、团队反制输入、先反制后判定/清除生命周期 | frozen `{ present, countered, judgment, success, skipAction, cleared }` | burden/use/threat 留 value/prior adapter；delay/early 移至 `search/SealTiming.js` |
| `domain/GlobalBenefitModel.js` | 全体受益识别、来源优先顺时针座次、公开池定义顺序、recipient outcome、团队收益结构 | `{ seatOrderIds, publicPoolDefinitionOrder, recipients, ...benefit }` | CardValue 由 façade 注入；counter desire 在 Policy；root flip/apply 留 simulation query/Simulator |

所有 Domain 输出均为普通值、ID 或新对象，不持有 Game/Player/Card 引用。输入只读测试会修改返回对象再核对输入未变化。Radar/Lightning/Seal 的通用 merge/normalize/概率质量仍由 `state/Probability` 提供；各 Domain 只构造领域分支。

### Authority / Mirror / Derived Classification

- `AUTHORITY`：RuleEngine 的状态/下一闪电接收者规则、JudgmentSystem/Game 的真实判定与状态移动、card config 的类别/数量、真实伤害和公共池结算。
- `SIMULATION MIRROR`：Simulator 按上述权威事实把 Domain outcome 应用到 SearchState；本阶段只更新 import/字段消费，没有拆 Simulator。
- `DERIVED MODEL`：Radar/Lightning/Seal 概率与 GlobalBenefit 期望 recipient 结构。它们服务 AI 推理，不宣称成为 Game rule authority。

### 依赖、兼容与 Guard

`domain/**` 只向 card config、RuleEngine 与 `state/Probability` 等规则/纯状态源依赖，不 import value、Controller、Planner、Simulator、Evaluator 或 UI，也不 `new AiSimulator`。Value 只向 Domain 消费概率事实；GlobalBenefit 通过 façade 注入窄 `definitionValue` 查询，避免 `Domain -> Value -> Domain` 循环并保持旧逐候选调用次数。

`AiProbabilityBranches.js` 仅重导出 State Probability 与 RadarModel；`lightningScoring.js` 只把正式 `holderId` 回绑为旧 Player 输出；`sealScoring.js` 重导出 SealModel/SealTiming，并暂存既有非 Domain value/prior adapter；`AiGlobalBenefit.js` 注入 CardValue、投影旧摘要并保留 ARCH-7 前的 root simulation helper。

Architecture Guard 已覆盖 `policy/**` 与 `domain/**`：禁止 UI、Controller、Planner、concrete Simulator；Domain 额外禁止 concrete Evaluator/value import。Self-test 同时包含合法夹具和非法 value/Planner/Simulator 夹具。

### 概率、固定轨迹与性能观察

- Radar、Lightning、Seal、GlobalBenefit 直接契约 `4/4`；领域/Policy/Value/Simulator/build 广覆盖 `185/185`。Radar 总质量、Lightning 命中质量、Seal 的 `countered + success + skipAction = present` 均在 tolerance 内守恒。
- D4 `planning.d4-seal-then-kill`（seed `20260814`、node budget `200`）保持 `seal c -> stealSkill c -> assault b -> end`，扩展 `102`、深度 `4`、hidden samples `10`、`bestValueScore=0.04919669968375734`。
- Lightning/Response/Transfer/GlobalBenefit 四个固定场景逐字段锁定 root descriptor、planned sequence、expanded、depth、hidden samples 与 bestValueScore；迁移后测试 `1/1`。对应 `(expanded, depth, hidden)` 分别为 `(3,2,10)`、`(3,2,10)`、`(3,2,10)`、`(3,1,10)`。
- Response 分支每次只执行一个适用 status/guardian query；global counter 执行一次 assessment 且不执行 dynamic root query，普通 tactic 最多一次 assessment 判别加一次 dynamic query。ActionGenerator 注入测试锁定每张 transfer 动作只调用一次 transfer selection。
- TransferPolicy 每个合法 source/receiver 组合只构造/评分一次，最终排序不重算；Card/resource 的 remaining counts 仍由现有测试锁定为每次完整选择扫描一次。
- Lightning lifecycle 以 `(SearchState, holderId, viewerId, presence)` 缓存，同键第二次返回同一结果对象；兼容 façade 只适配正式结果，不再计算一次。Seal lifecycle 每次各求一次 presence/counter/tactic；Radar 在原消费点直接调用正式 owner，没有 façade+Domain 双算。
- 最终 planning benchmark 仍为 raw `126/1000`、corrected `106/1000`，32 次决策平均扩展 `41.4`、平均深度 `2.8`，报告决策耗时约 `0.9s`、总耗时约 `1.0s`。

### 最终验证与 Remaining Debt

ARCH-6 完整测试为 `1377/1377`，统一 build 为 `20260814-ai-policy-domain`。没有修改 Value/Transition 数值、搜索参数、规则或平衡；没有创建 Simulation split，也没有清理 Planner core。

AI-ARCH-6 结束时仍记录了 `getLegalActions` 命名、`sealScoring` adapter、GlobalBenefit root flip 查询和旧 façade 等债务；这些项目随后在 AI-ARCH-7 至 AI-ARCH-10 完成。Simulator、Response 与 Combat 的正式拆分也已按该顺序落地。

## 28. AI-ARCH-7/8 Simulation Responsibility Freeze Table

本表冻结于 `2a339f9 ARCH-5.6`，生产代码迁移尚未开始。分类依据是函数实际读取、写入和规则镜像职责，而不是旧文件位置。`AiSimulator` 只接收过滤后的 `SearchState`；表中 `AUTHORITY` 是真实游戏规则来源，`SIMULATION MIRROR` 是 AI 对该来源的显式近似，`DERIVED MODEL` 只提供概率/领域事实。迁移不得改变调用次数、分支顺序、概率合并顺序或任何策略阈值。

| Function / Group | Category | Current Responsibility | Reads | Writes | Current Callers | Rule Authority Source | Policy Dependency | Domain Dependency | Value Dependency | Target Component | Migration Order | Characterization Test | Risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `constructor`、`clone` | STATE_LIFECYCLE | 建立与克隆隔离的 SearchState 世界，并同步兼容摘要 | 输入 SearchState | 新 clone、`initial`、root guard | Planner、ValueSimulationQuery、测试 | `state/SearchState.cloneSearchState` | 无 | 无 | 无 | `simulation/Simulator` facade | ARCH-7 first | 根/兄弟 clone 深隔离、旧/新入口逐字段一致 | 高：共享引用会污染兄弟分支 |
| `initializeMomentumBranches`、`syncMomentumSummary`、`syncCategoryUsedSummary`、`syncActiveSkillCosts`、`initializeEquipmentBaselines`、`equipmentRoleDelta`、`initializeAssaultSummaries` | STATE_LIFECYCLE | 初始化/投影历史标量与条件分支兼容摘要 | player/status/equipment/skill config | SearchState 派生字段 | constructor、clone、效果方法 | `skillRegistry`、`cardRegistry`、`getActiveSkillCost` | 无 | Lightning/Seal 无关 | CardValue 只供装备角色差量 | `simulation/StatusSimulation`；技能成本同步留 facade | ARCH-8 status/skill | momentum、equipment、skill cost 与旧入口逐字段一致 | 中：摘要与分支双写顺序 |
| `initializeBlockCountDistributions`、`buildInitialBlockCountDistribution`、`syncBlockSummary`、`getBlockCountBranches`、`getKnownBlockCountBranches`、`ensureBlockCountDistribution` | RESPONSE_SIMULATION | 从可见/未知牌构造格挡数量分布与兼容概率 | hand/knownCards/remaining counts | block distribution/probability/expected count | constructor、damage/resource mutation、测试 | `ResponseSystem.askForBlock`、card config | 无 | Probability algebra | 无 | `simulation/ResponseSimulation` | ARCH-7 response | 已知/未知/雷达获得格挡的质量与期望守恒 | 高：条件世界键与容量守恒 |
| `initializeCounterCountDistributions`、`buildInitialCounterCountDistribution`、`syncCounterSummary`、`getCounterCountBranches`、`getKnownCounterCountBranches`、`ensureCounterCountDistribution`、`clearCountersWhenHandEmpty` | RESPONSE_SIMULATION | 构造反制数量分布并投影封印/普通反制共享容量 | hand/knownCards/remaining counts | counter distribution/probability/expected count | constructor、counter/resource mutation、测试 | `ResponseSystem.askForCounter/askForStatusCounter` | ResponsePolicy 只决定意愿 | SealModel 使用相同容量输入 | 无 | `simulation/ResponseSimulation` | ARCH-7 response | 普通反制后封印反制容量不重复、空手归零 | 高：响应容量双算 |
| `addKnownCounterToDistribution`、`addTransferredCounterCapacity`、`removeKnownCounterFromDistribution`、`addOneUnknownCardToCounterDistribution`、`gainUnknownCardsWithCounterState` | RESOURCE_MUTATION | 卡牌获得/转移时同步反制身份与数量世界 | event worlds、known identity、remaining counts | hand/counter 分支和摘要 | card/skill/status effects | Game 卡牌移动与 draw；card config | 无 | Probability algebra | 无 | `simulation/ResponseSimulation` | ARCH-7 response | 获得/转移/未知摸牌后 hand 与 counter 联合质量守恒 | 高：跨资源分布相关性 |
| `addKnownBlockToDistribution`、`removeKnownBlockFromDistribution`、`addOneUnknownCardToBlockDistribution`、`removeUnknownCardsFromBlockDistribution`、`transferUnknownBlockCapacity` | RESOURCE_MUTATION | 卡牌获得/移除/转移时同步格挡身份与数量世界 | event worlds、known identity、remaining counts | hand/block 分支和摘要 | card/skill/status effects | Game 卡牌移动与 draw；card config | 无 | Probability algebra | 无 | `simulation/ResponseSimulation` | ARCH-7 response | known/unknown block 转移与随机损失逐字段一致 | 高：联合概率与排除 ID |
| `removeUnknownCardsFromCounterDistribution` | RESOURCE_MUTATION | 随机损失未知牌时同步反制数量世界 | removal worlds、counter distribution | counter distribution/summary | random resource consumption | Game 随机弃牌语义；card config | 无 | Probability algebra | 无 | `simulation/ResponseSimulation` | ARCH-7 response | 多张随机损失的条件质量与旧结果一致 | 高：无放回近似顺序 |
| `nextProbabilityEventKey`、`getEventWorlds`、`gateEventWorlds`、`eventProbability` | PROBABILITY_HELPER | 创建、门控并汇总条件事件世界 | state sequence、概率分支 | state event sequence；新分支 | 全部 effect components | 无真实规则；AI `state/Probability` DERIVED MODEL | 无 | Probability algebra | 无 | `simulation/Simulator` shared runtime | ARCH-7 facade | 概率质量、condition key 与调用次序一致 | 高：改变 key 次序会改变 join 语义 |
| `updateEnergyFromWorlds`、`changeEnergy`、`updateShieldFromWorlds`、`changeShield` | RESOURCE_MUTATION | 在条件世界中写能量/护盾并同步期望标量 | world branches、player caps | energy/shield branches 与标量 | card/skill/combat/status | `Game.gainEnergy`、Player 能量上限、`Game.damage` 护盾 | 无 | Probability algebra | 无 | `simulation/Simulator` shared runtime | ARCH-7 facade | 条件能量/护盾分支、上限和期望一致 | 高：先 clamp 后 merge 的顺序 |
| `ensureAttackUseSlots`、`ensureSkillUseSlots`、`consumeSlot`、`consumeAttackUse` | RESOURCE_MUTATION | 表示次数额度的条件占用 | turn flags、skill limit、event worlds | attack/skill slots 与兼容 used count | apply、skill/card effects | RuleEngine、Player turn flags、skill config | 无 | Probability algebra | 无 | `simulation/Simulator` shared runtime；skill wrapper 由 SkillEffect 调用 | ARCH-7 facade | partial execution 下 slot 消费概率与旧值一致 | 高：重复占用导致非法深层动作 |
| `apply` | ACTION_DISPATCH | 克隆根状态、消费动作条件，按 card/skill/end 分派并执行公共后置触发 | SearchState、abstract action | 仅新 SearchState clone | Planner、ValueSimulationQuery、测试 | RuleEngine 合法集合；cardRegistry/skillRegistry/Game lifecycle | ActionCandidatePolicy 已在生成前过滤；不在此重判 | 各 Domain 只供事实 | 无 final value | `simulation/Simulator` facade | ARCH-7 建 facade；ARCH-8 移出 card/skill/status branch | 固定 D4 与四场景；旧/新 facade 深状态 parity | 极高：当前单体总调度顺序 |
| `setSimulatedEquipment`、`getSimulatedEquipmentProbability`、`cardAvailability`、`normalizeResourceEffectWorlds`、`nextSimulatedCardId`、`findKnownCardEntry`、`addSimulatedCardToHand`、`availableUnknownCountFor`、`findTransferCardEntry`、`addSimulatedKnownCard`、`transferKnownCardIdentity`、`transferUnknownCardIdentity`、`cardEstimateDistribution`、`syncCardEstimates`、`buildSimulatedKnownCards` | RESOURCE_MUTATION | 维护装备、手牌实体/期望、转移身份和兼容估计 | SearchState 可见身份、remaining counts、effect worlds | equipment/knownCards/handCount/estimates/response distributions | card/skill/combat/status effects、测试 | Game card move/equip/draw；card config | 无 | Probability algebra | CardValue 仅装备角色差量 | `simulation/CardEffectSimulation` | ARCH-8 card | transfer/plunder/destroy/equip 的 identity、hand、distribution parity | 极高：实体与期望不可双计 |
| `chooseSimulatedResourceSelection`、`buildDiscardKeepValueContext` | POLICY_LEAK | 为模拟效果请求正式资源选择策略所需的只读上下文 | SearchState、known cards、range facts | 无 | resource/card/combat methods | RuleEngine/DistanceSystem 只供事实 | `policy/ResourceSelectionPolicy` 是唯一选择 owner | 无 | CardValue/keep value 由 Policy 消费 | 保持 Policy owner；`CardEffectSimulation` 仅调用 | ARCH-8 card | 已知/未知换面、选择次数和结果相同 | 中：Simulation 不得复制选择公式 |
| `consumeKnownCardsFromHand`、`consumeBlockIdentities`、`normalizeAssaultCountDistribution`、`syncAssaultSummary`、`consumeAssaultForOpportunity`、`downgradePartialKnownCardsAfterRandomLoss`、`consumeUnknownResourceCard`、`removeOneRandomCardFromHand`、`consumeRandomHandCards`、`hasCompleteCertainHand`、`consumeChosenHandCard` | RESOURCE_MUTATION | 按确定/概率事件支付、弃置和降级卡身份 | hand/knownCards/count distributions | handCount、knownCards、block/counter/assault distributions | response/combat/card/skill/status | Game discard/payment/move；ResponseSystem 实体支付 | `ResourceSelectionPolicy` 只决定 chosen card | Probability algebra | discard keep value 只作策略输入 | `simulation/ResponseSimulation`（响应支付）与 `CardEffectSimulation`（普通资源支付），公共实现不复制 | ARCH-7 response 后 ARCH-8 card | 资源消费前后联合分布与旧值一致 | 极高：同一张牌跨三种容量双计 |
| `simulateCategoryUse`、`simulateGamble`、`simulateCoordination`、`simulateTracking`、`clearHuntMarksBySource` | STATUS_EFFECT | 镜像 cardUsed/targetSelected/turn 生命周期被动状态与触发 | category、targets、turn/game flags | momentum/gamble/coordination/huntMark/unknown draw | apply、combat fatal、测试 | `skillRegistry` EventBus listeners、Game turn lifecycle | 无 | 无 | 无 | `simulation/StatusSimulation` | ARCH-8 status | 被阻止/部分生效/死亡清理下的触发次数与概率 parity | 高：监听器顺序和有效目标语义 |
| `seatOrderFrom` | DOMAIN_LEAK | 在 SearchState 上投影 source-first/after-source 座次 | players、seatIndex | 新数组 | combat/card/status | `Game.seatOrderFrom`、`RuleEngine.nextLightningReceiver` | 无 | GlobalBenefit/Lightning 也有 ID 级派生 | 无 | `simulation/Simulator` shared rule projection | ARCH-7 facade | 死亡/环回座次固定测试 | 低 |
| `simulateGuardianAid` | RESPONSE_SIMULATION | 按真实 beforeDamage 监听顺序执行一次合法护援并支付资源 | players、incoming damage、flags、effect worlds | guardian used、hand/distributions、damage amount | applyDamage、测试 | `skillRegistry.guardianAid` + EventBus 注册顺序 | discard candidate 来自 ResourceSelectionPolicy | Probability algebra | keep value 只作策略输入 | `simulation/ResponseSimulation`，Combat 负责调用位置 | ARCH-7 response before combat | 多护援者、零伤害、已用/死亡、部分概率 parity | 极高：护援顺序与消费世界 |
| `simulateAfterLifeDamage`、`simulateSpyGapAfterLifeDamage`、`simulateAssaultAfterDamage` | STATUS_EFFECT | 镜像 afterDamage 的余烬、窥隙、连势/孤注消费 | life-damage branches、resolution flags | energy、spy flags、momentum/allIn | applyDamage | `skillRegistry` afterDamage listeners + DyingSystem rescue events | 无 | Probability algebra | 无 | `simulation/StatusSimulation`，Combat 负责调用位置 | ARCH-8 status（ARCH-7 先由 Combat 保持调用） | afterDamage→fatal→spyGap 的顺序与次数 parity | 极高：濒死前后监听语义 |
| `simulateAssault`、`applyDuel` | COMBAT_SIMULATION | 镜像突袭/决斗的响应、伤害与轮流支付 | attacker/target、response distributions | combat/resource/status fields | apply/card effects、测试 | `cardRegistry.assault/duel`、ResponseSystem、Game.damage | counter/block desire 来自 ResponsePolicy | Probability algebra、RadarModel | 无 | `simulation/CombatSimulation` | ARCH-7 combat | 普通/战斗装置/雷达/决斗完整状态 parity | 极高：嵌套响应与伤害顺序 |
| `takeResourceToHand`、`destroyResource`、`stealResourceToHand` | CARD_EFFECT | 镜像掠夺、破坏、窃取的实体/未知资源移动 | selection、identity、worlds | hand/equipment/distributions | apply、applySkill、测试 | `cardRegistry`、`ACTIVE_SKILLS.stealSkill`、Game move APIs | ResourceSelectionPolicy | Probability algebra | CardValue 由 Policy 消费 | CardEffectSimulation；窃取 orchestration 在 SkillEffectSimulation | ARCH-8 card/skill | hand/equipment/known identity 与旧结果一致 | 高 |
| `tacticResolutionChance`、`evaluateCardScopeCounterResponses`、`consumeCountersForCardScope`、`consumeExpectedCounters`、`targetResolutionChance` | RESPONSE_SIMULATION | 计算并消费 card-scope/target-scope 反制的首个成功响应世界 | responders、counter distributions、desire | counter capacity/distribution | apply/card/combat、测试 | `ResponseSystem.askForCounter` 响应顺序与递归结果 | ResponsePolicy 决定 desire | Probability algebra | 无 | `simulation/ResponseSimulation` | ARCH-7 response | scope 顺序、边际和、容量消费、概率质量 parity | 极高：首个响应者归属和重复消费 |
| `counterDesire`、`dynamicCounterGain` | POLICY_LEAK | 把 root 效果经济收益映射为规划侧反制意愿 | public SearchState、root context | 无；root guard 只读 | response evaluation、测试 | 无规则权威；仅 AI 策略 | `policy/ResponsePolicy` 应为唯一 owner | GlobalBenefitModel | Economics/CardValue 单位 | 公式移至 `policy/ResponsePolicy`，ResponseSimulation 仅调用纯策略函数 | ARCH-7 before response move | 原函数/新 owner 逐输入精确相等；调用次数不增加 | 高：不能在 Simulation 留第二套策略 |
| `applySkill` | SKILL_EFFECT | 按条件世界镜像全部主动技能及次数/能量支付 | action、skill config、targets | energy/slots/hand/shield/status/combat | apply、测试 | `ACTIVE_SKILLS.execute`、RuleEngine skill targets | 无 | Probability algebra | 无 | `simulation/SkillEffectSimulation` | ARCH-8 skill | 每技能固定输入完整状态 parity | 极高：技能支付与效果顺序 |
| `buildRadarOutcomePartition` | DOMAIN_LEAK | 把 RadarModel 类别概率绑定到当前攻击条件世界 | remaining counts、override、attack worlds | 新分支 | applyDamage、测试 | `JudgmentSystem.judgeDefense` + card config | 无 | `domain/RadarModel` | 无 | `simulation/StatusSimulation` | ARCH-8 status | tactic/basic/equipment 质量与 basic 获牌 parity | 高 |
| `consumeBlockResponseWorlds`、`consumeTargetCounterResponseWorlds` | RESPONSE_SIMULATION | 在已知/未知响应分布中消费实际格挡/目标反制牌及条件容量 | attack/effect worlds、response distributions | hand/known identities/block/counter distributions | combat/card effects、测试 | `ResponseSystem.requestCardResponse` 原子支付 | desire 由 ResponsePolicy | Probability algebra | 无 | `simulation/ResponseSimulation` | ARCH-7 response | battle-device 双格挡、known/unknown、排除 ID parity | 极高 |
| `applyDamage` | COMBAT_SIMULATION | 镜像雷达→格挡→beforeDamage/护援→护盾→HP→afterDamage→濒死 | attacker/target/options、response/status worlds | shield/HP/resources/status/death | card/skill/status/Value query、测试 | `Game.damage`、EventBus、JudgmentSystem、ResponseSystem、DyingSystem | ResourceSelectionPolicy 仅护援弃牌选择 | RadarModel、Probability algebra | 无 | `simulation/CombatSimulation` | ARCH-7 combat after response | 普通攻击、战斗装置、雷达、护援、盾、致死全状态 parity | 极高：系统主结算顺序 |
| `applyHpLoss` | COMBAT_SIMULATION | 镜像失去生命并绕过雷达/格挡/护盾 | target/amount | HP/death | skill/card effects、测试 | `HpLossSystem.lose`、DyingSystem | 无 | 无 | 无 | `simulation/CombatSimulation` | ARCH-7 combat | 与伤害路径差异、致死救援 parity | 高 |
| `applyLightningHit` | STATUS_EFFECT | 从独立 clone 清除命中者闪电并执行 3 点不可格挡伤害 | state/holder ID | clone status/combat/death | ValueSimulationQuery、测试 | Game global lightning listener、JudgmentSystem、Game.damage | 无 | LightningModel/RadarModel | 无 | `simulation/StatusSimulation`，调用 Combat | ARCH-8 status | 生命周期命中分布各 holder owner delta parity | 高 |
| `resolveFatal` | COMBAT_SIMULATION | 镜像本人优先、顺时针队友的循环调息救援，失败则清理/击杀奖励 | HP、recover capacity、seat order、teams | HP/alive/hand/equipment/status/flags/reward | damage/hp loss、测试 | `DyingSystem.enter/resolve/kill`、ResponseSystem、Game.heal/draw | 无 | Probability algebra | 无 | `simulation/CombatSimulation` | ARCH-7 combat | 多轮救援、负 HP、击杀奖励、猎印清理 parity | 极高：救援次序与死亡后置触发 |
| `heal`、`healFrom` | COMBAT_SIMULATION | 镜像治疗上限及回春/协调等来源触发 | target/source/amount/flags | HP、healing side effects | card/skill/fatal、测试 | `Game.heal`、`skillRegistry.rejuvenation/coordination` | 无 | 无 | 无 | `simulation/CombatSimulation` | ARCH-7 combat | 自疗/队友疗/濒死救援与触发次数 parity | 高 |

### Freeze conclusions

- `Simulator` 是唯一对 Planner/ValueSimulationQuery 暴露的 simulation facade；旧 `AiSimulator` 只允许保留重导出兼容，不能保留第二套算法。
- `ResponseSimulation` 拥有响应概率世界、容量消费和响应资源支付；它调用正式 Policy 的纯意愿函数，但不拥有任何策略公式。
- `CombatSimulation` 拥有伤害、失去生命、治疗、濒死/救援/死亡的顺序；它按真实 `Game.damage`/`DyingSystem` 顺序调用 Response 与状态钩子。
- Card/Skill/Status 组件只镜像各自真实 authority；跨组件效果通过 facade 的显式共享运行时调用，不能复制概率、资源或价值公式。
- ARCH-7 先迁 facade、Response、Combat，并在独立测试和固定规划轨迹精确通过后，才允许进入 ARCH-8。

## 29. AI-ARCH-7 Simulation Facade / Response / Combat 落地结果

### Physical architecture and compatibility

- `simulation/Simulator.js` 是 Planner 与 `AiValueSimulationQuery` 的唯一正式 simulation 入口。它负责 clone、action type dispatch、共享事件世界/能量/护盾/次数槽，以及组件组合。
- `simulation/ResponseSimulation.js` 唯一拥有 block/counter 数量世界、响应身份与容量消费、card/target scope 响应结果 application；规划侧反制意愿公式已移到正式 `policy/ResponsePolicy.js`，Simulation 只调用纯策略查询。
- `simulation/CombatSimulation.js` 唯一拥有攻击、damage、HP loss、heal、dying/rescue/death 的 SearchState 镜像。
- `AiSimulator.js` 只重导出 `Simulator as AiSimulator`，不创建包装对象，也不保留算法。主要生产消费者已改为正式路径；历史测试仍可使用旧名。
- 五个 effect component 使用模块加载期的无状态 class mixin 组合；每个 Simulator 仍只有一个实例，没有每 node/action 创建 component object。

### Combat Lifecycle Contract

| Order | Combat step | SearchState mirror | Real authority | Response/Status boundary |
|---:|---|---|---|---|
| 1 | effect worlds | 绑定 action execution 条件与 damage amount branches | cardRegistry / skillRegistry | Card/Skill 只提供 effect worlds |
| 2 | radar judgment | 生成互斥 noRadar/noJudgment/tactic/equipment/basic 分区，基础牌先进入目标资源身份 | `JudgmentSystem.judgeDefense`、card config | StatusSimulation 提供 Radar outcome partition |
| 3 | block response | 按军火库条件消费 1/2 张格挡；雷达判得格挡可立即使用 | `ResponseSystem.askForBlock/requestCardResponse` | ResponseSimulation 消费容量与身份 |
| 4 | before-damage modifiers | 突袭已有破势、连势、孤注加伤在通过响应的世界中生效 | skillRegistry beforeDamage listeners / cardRegistry assault | Status/Combat hook；不重新决定 Policy |
| 5 | guardian aid | 存活己方守誓者按当前 `state.players` 注册/座次顺序尝试一次，支付一张手牌并减伤 | skillRegistry `guardianAid` + EventBus registration order | ResponseSimulation 拥有触发资源；Combat 固定调用位置 |
| 6 | shield | 每个条件世界用减伤后的 amount 消耗护盾 | `Game.damage` | CombatSimulation |
| 7 | actual HP damage | 只汇总穿过 response、modifier、guardian、shield 的生命伤害 | `Game.damage` | CombatSimulation |
| 8 | after-damage hooks | 余烬、连势/孤注消费按 actual life damage 世界推进 | skillRegistry afterDamage listeners | StatusSimulation，由 Combat 在 fatal 前调用 |
| 9 | dying/rescue/death | HP<=0 时本人优先、再顺时针存活队友循环调息；失败清状态/资源/装备并给合法击杀者奖励 | `DyingSystem.enter/resolve/kill` | CombatSimulation；Response capacity 只消费一次 |
| 10 | rescued spy gap | 目标最终存活才推进窥隙；死亡则不残留触发资格 | skillRegistry spyGap + playerRescued/playerDead | StatusSimulation，由 Combat 在 fatal 后调用 |

真实 `Game.damage` 的宏观顺序为 Radar → Block → beforeDamage（含护援）→ Shield/HP → afterDamage → Dying。Simulation 对条件世界的细化没有改变该顺序。`applyHpLoss` 继续绕过 Radar、Block、Guardian 和 Shield，只扣 HP 后进入同一 fatal lifecycle；不得与 damage 合并。

### Response Trigger Matrix

| Trigger | Scope / order | Resource | Probability application | Effect owner | Policy owner | Authority |
|---|---|---|---|---|---|---|
| normal block | damage target；一次 | block，通常 1 | damage event × count distribution | ResponseSimulation | real ResponsePolicy only decides response | ResponseSystem / Game.damage |
| battle-device block | damage target；一次 | block，要求 2 且原子支付 | equipment existence × count>=2 | ResponseSimulation | ResponsePolicy | ResponseSystem.askForBlock |
| radar block | judgment 后 target | 判定基础牌身份 + 原容量 | 同一 radar outcome key | ResponseSimulation + Status outcome | ResponsePolicy | JudgmentSystem + ResponseSystem |
| card-scope counter | actor 后 `state.players` 顺序，第一个成功者 | counter expected capacity | marginal = previous failures × current effective probability | ResponseSimulation | ResponsePolicy planning desire | ResponseSystem.askForCounter |
| target-scope counter | 每个存活实际目标独立 | 该目标 counter identity/capacity | target effect worlds × desire | ResponseSimulation | ResponsePolicy | cardRegistry shockwave/provoke + ResponseSystem |
| delayed-status counter | holder first，再顺时针 | 与普通反制共享 counter capacity | Seal/Lightning lifecycle 输入消费同一容量 | ResponseSimulation / StatusSimulation | ResponsePolicy | Game global status listeners |
| guardian aid | block 之后、shield 之前；首个可用己方 guardian | 一张选定/期望手牌 + global-turn quota | 只在通过伤害世界消费 | ResponseSimulation | ResourceSelectionPolicy supplies discard choice；真实响应 Policy 不复制效果 | skillRegistry.guardianAid |
| dying rescue | target first，再顺时针存活队友，逐轮每人一张 | recover | 现有 expected capacity approximation | CombatSimulation using Card resource helpers | ResponsePolicy is real response decision owner | DyingSystem / ResponseSystem |

Response 与 Combat characterization、完整 SearchState 指纹、block/counter/guardian/radar/dying 宽回归以及固定搜索轨迹均保持不变。ARCH-7 验证通过后才执行下节 ARCH-8。

## 30. AI-ARCH-8 Card / Skill / Status Simulation 落地结果

### Physical Simulation Architecture

```text
Planner / AiValueSimulationQuery
              |
              v
     simulation/Simulator
       |   |   |   |   |
       v   v   v   v   v
 Response Combat Card Skill Status
       \   |    |    |   /
        state/Probability + Domain facts + explicit Policy query
```

组件是无状态 mixin：组合只在模块加载时各执行一次，实例仍是单一 `Simulator`。组件互不 import facade 或彼此；跨领域效果通过同一个实例的显式方法调用。`Simulator.apply` 只做 clone、end/skill/card dispatch、动作支付与 card-scope 响应门控，然后委托 `applySkill` / `applyCardEffect`。未知 card 的既有默认语义仍是：equipment 走统一装备写入，其余 no-op；未知/空 skill 仍 no-op。

### Card Simulation Coverage Matrix

| definitionId | Authority source | Simulation owner / handler | Combat | Response | Domain | Direct coverage |
|---|---|---|---|---|---|---|
| assault | cardRegistry.assault / Game.damage | CardEffect → Combat `simulateAssault` | damage + slots | block/radar | RadarModel | assault、momentum、expose、allIn、block/radar |
| recover | cardRegistry.recover / Game.heal | CardEffect `healFrom` | heal | dying resource identity shared | none | recover/rejuvenation/dying |
| block | ResponseSystem only | ResponseSimulation response payment | prevents damage | owner | none | block count/identity matrices |
| charge | cardRegistry.charge / Game.gainEnergy | CardEffect `changeEnergy` | none | card-scope if applicable | none | energy branches/caps |
| shield | cardRegistry.shield | CardEffect target validation + shared shield worlds | absorbed in Combat | none | none | ally/self/shield damage |
| scout | cardRegistry.scout | CardEffect information result | none | card-scope counter | none | known/unknown information |
| transfer | cardRegistry.transfer / RuleEngine | CardEffect identity transfer from supplied descriptor | none | card-scope counter | none | transfer identity/capacity/hidden parity |
| exposeWeakness | cardRegistry.exposeWeakness | CardEffect stack producer | consumed by assault Combat | card-scope counter | none | expose stack/search parity |
| shockwave | cardRegistry.shockwave | CardEffect per-target orchestration | shared damage | target-scope counter + block | RadarModel | multi-target response/combat |
| provoke | cardRegistry.provoke | CardEffect per-target assault payment | shared no-block damage | target-scope counter | none | assault response/capacity |
| leverage | cardRegistry.leverage / RuleEngine | CardEffect forced-assault/equipment transfer mirror | shared assault | card-scope counter | none | source/target/equipment probability |
| plunder | cardRegistry.plunder | CardEffect `takeResourceToHand` | none | card-scope counter | none | hand/equipment known/unknown |
| destroy | cardRegistry.destroy | CardEffect `destroyResource` | none | card-scope counter | none | identity/removal distributions |
| counter | ResponseSystem only | ResponseSimulation；active descriptor keeps legacy coordination result | none | owner | none | recursive/scope/capacity tests |
| harvest | cardRegistry.harvest | CardEffect unknown draw | none | card-scope counter | none | hand/counter/block density |
| duel | cardRegistry.duel | CardEffect → Combat `applyDuel` | shared damage/fatal | assault response | none | integer/unknown assault distributions |
| mutualBenefit | cardRegistry / PublicCardPool | CardEffect applies GlobalBenefit recipient values and draws | none | card-scope counter | GlobalBenefitModel via compatibility value adapter | seat order/pool/counter/fixed scene |
| symbiosis | cardRegistry.symbiosis | CardEffect seat-order heal loop | shared heal | card-scope counter | GlobalBenefitModel | per-target heal/rejuvenation |
| seal | cardRegistry.seal / Game status listener | CardEffect delegates state placement to StatusSimulation | none | first placement intentionally no normal counter | SealModel | placement/lifecycle/counter/fixed scene |
| lightning | cardRegistry.lightning / Game status listener | CardEffect delegates state placement to StatusSimulation | hit uses Combat | first placement intentionally no normal counter | LightningModel | placement/hit/transfer/clear |
| energyDevice | cardRegistry equipment resolver | CardEffect unified equipment write | none | card-scope counter | none | equip/replace/energy value |
| recycleDevice | cardRegistry + Game recycle listener | CardEffect equipment + post-tactic trigger | none | card-scope counter | none | two-use cap/draw |
| defenseDevice | cardRegistry + JudgmentSystem | CardEffect equipment state | Combat radar path | block after judgment | RadarModel | radar outcome/identity |
| battleDevice | cardRegistry + ResponseSystem | CardEffect equipment state | attack dependency | two-block requirement | none | battle block matrix |
| telescope | cardRegistry + DistanceSystem | CardEffect equipment state | range-dependent attack | none | none | discrete range branches |
| barrierDevice | cardRegistry + DistanceSystem | CardEffect equipment state | incoming range exposure | none | none | range/value parity |

CardEffect 不生成或评分 selection。`chooseSimulatedResourceSelection` 只组装只读上下文并消费正式 ResourceSelectionPolicy 的结果；transfer 只消费 action descriptor。所有伤害仍经 Combat，所有 response capacity 仍经 Response。

### General / Skill Simulation Coverage Matrix

| generalId | skill | kind | Simulation component / state fields | Lifecycle owner | Authority | Direct coverage |
|---|---|---|---|---|---|---|
| blade-walker | breakArmy | active | SkillEffect：energy、attack slots/limit | per turn skill/attack slots | ACTIVE_SKILLS.breakArmy | conditional slots、deep chain |
| blade-walker | momentum | passive | Status：category/momentum branches；Combat：actual damage consume | global turn end / actual assault HP damage | skillRegistry.momentum | block/radar/miss/hit/partial |
| oath-warden | barrier | active | SkillEffect：energy、skill slots、shield | per turn skill slots | ACTIVE_SKILLS.barrier | two uses、target/shield |
| oath-warden | guardianAid | passive response | Response：quota、discard、reduction；Combat fixes window | every global turn | skillRegistry.guardianAid | guardian matrix / fingerprint |
| spirit-medic | symbiosis | active | SkillEffect：energy/slot + Combat heal | per turn skill slots | ACTIVE_SKILLS.symbiosis | selected ally / repeated use |
| spirit-medic | rejuvenation | passive | Combat heal/fatal rescue：draw + trigger count | every global turn, cap 2 | skillRegistry.rejuvenation | heal/rescue/probability |
| shade-agent | stealSkill | active | SkillEffect orchestration + Card resource transfer | per turn skill slots | ACTIVE_SKILLS.stealSkill | hand/equipment/distance |
| shade-agent | spyGap | passive | Status after actual damage and post-rescue | every global turn, once | skillRegistry.spyGap | normal/lethal/rescued/dead |
| ember-magus | burningField | active | SkillEffect target loop + Combat damage | per turn skill slots | ACTIVE_SKILLS.burningField | cost 3/multi-target/block |
| ember-magus | ember | passive | Status after-damage energy by resolution | once per card resolution ID | skillRegistry.ember | multi-target same resolution |
| trail-hunter | hunt | active | SkillEffect mark consume + Combat damage/draw on block | per turn skill slots | ACTIVE_SKILLS.hunt | block/hit/mark cleanup |
| trail-hunter | tracking | passive | Status targetSelected mark branches | two new enemies/global turn; expires own next turn end | skillRegistry.tracking | mark overlap/expiry/death |
| fate-gambler | allIn | active/status | SkillEffect energy/draw/status probability；Combat/Status consume | non-stackable; next assault finishes status | ACTIVE_SKILLS.allIn + skillRegistry.gamble | draw/probability/block/radar/hit |
| fate-gambler | gamble | passive | Status tactic-use draw probability | once per global turn | skillRegistry.gamble | success/failure/cap |
| resonance-tuner | resonance | active | SkillEffect energy/slot + unknown draw | per turn skill slots | ACTIVE_SKILLS.resonance | self/ally repeated use |
| resonance-tuner | coordination | passive | Status effective ally target draw | once per global turn | skillRegistry.coordination | card/skill/response target semantics |

### Status Lifecycle Coverage Matrix

| Status / flag | Producer | Consumer | Reset / clear boundary | Simulation owner | Domain | Combat hook | Direct test |
|---|---|---|---|---|---|---|---|
| momentum + category-used | distinct card category | next assault actual HP damage | every global turn end; death | StatusSimulation | none | damage modifier/afterDamage | hit/block/radar/partial/end |
| exposeWeakness stacks | exposeWeakness card | next assault damage amount | consumed by next assault even if blocked; death clear | CardEffect + Combat | none | assault entry | stack/consume/search marginal parity |
| allIn assaultBonus | allIn skill probability | next assault completion | consumed on hit/block/radar prevention; death | SkillEffect + Status/Combat | none | before/after damage | nonstack/draw/consume |
| huntMark | tracking target select | hunt skill/action generation | source own next turn end or source death | StatusSimulation | none | hunt damage | mark/expiry/cleanup |
| lightning | lightning card | next holder status phase | counter/judgment hit clears；miss transfers | StatusSimulation | LightningModel | hit calls Combat | placement/transfer/hit/death |
| sealed | seal card | holder next status phase | counter or judgment always clears；may set skipAction | StatusSimulation | SealModel | none | placement/counter/judgment/skip |
| guardianAidUsed | guardian response | later damage in same global turn | every player turn start global reset | ResponseSimulation | none | before shield | repeated/global reset |
| gambleTriggered | first tactic cardUsed | later tactic uses | every global turn start | StatusSimulation | none | none | success/failure/once |
| coordinationTriggered | resolved ally-target action | later card/skill/rescue | every global turn start | StatusSimulation | none | heal/rescue may trigger | valid/effective targets |
| rejuvenationTriggerCount | actual allied healing | later heal/rescue | every global turn start；cap 2 | CombatSimulation | none | heal/fatal rescue | ordinary/rescue/probability |
| recycleDeviceUses | active tactic cardUsed while equipped | later tactics | owner turn reset；cap 2 | CardEffectSimulation | none | none | first two/third no draw |

### Domain / Simulation and authority boundary

RadarModel、LightningModel、SealModel、GlobalBenefitModel 仍只返回概率/ID/outcome 事实。Status/Card components 只把这些显式结果写入 SearchState；没有把传播、判定概率或 recipient value 公式复制回 Simulation。RuleEngine、Game、ResponseSystem、DyingSystem、JudgmentSystem、cardRegistry、skillRegistry、TeamRuleService 和配置继续是唯一真实 authority。

### Validation and remaining boundary

- 四类完整 SearchState SHA-256 characterization 覆盖 combat response、transfer、barrier skill、lightning hit；去除随机 gameId 后指纹逐字节不变。
- 固定 D4 保持 `seal c -> stealSkill c -> assault b -> end`、expanded `102`、depth `4`、hidden samples `10`、`bestValueScore=0.04919669968375734`。
- Lightning、Response、Transfer、GlobalBenefit 四个既有 fixed scenario 与 Combat-heavy、Skill-heavy、Status-heavy 三个新增 fixed scenario 均锁定 root、sequence、expanded、depth、hidden samples 和 bestValueScore。
- Architecture Guard 锁定主要消费者只 import facade、compatibility 仅重导出、组件不 import UI/Controller/Planner/Game/facade、facade 不 import Policy/Value/Domain 细节、五个 mixin 各组合一次且无 component `new`。
- 同一组 32 个 planning scenarios 的 HEAD 单体/当前 facade 插桩结果：constructor `64→64`、clone `1583→1583`、apply `1583→1583`、expanded `1325→1325`、clones/node `1.1947169811320755→1.1947169811320755`、Response calls `27686→27686`、Combat calls `1860→1860`、Skill calls `2905→2905`、probability branch outputs `11689→11689`。Card calls `8550→9276` 与 Status calls `12684→12729` 的增长只来自 `applyCardEffect` / `applyDelayedStatusCard` 组件边界；没有额外 clone、apply 或 probability world。
- 未修改的 `cloneSearchState` 在五人代表局面预热后执行 10×1000 次共 `659.3532 ms`，平均 `65.93532 µs/clone`。planning benchmark（seed `20260814`、node budget `200`）保持 raw `126/1000`、corrected `106/1000`、平均节点 `41.4`、平均深度 `2.8`；非插桩运行 AI 决策约 `0.8s`、总耗时 `0.9s`。
- 最终宽范围 Simulation 回归为 `258/258`，完整测试为 `1380/1380`（墙钟 `41133.5 ms`）；新模块 `node --check`、checker self-test、`check:code-quality --changed`、Architecture Guard、build consistency 与 `git diff --check` 均作为本阶段验收门禁。
- Planner 中 expose/assault stack marginal、seal sibling、end opportunity、candidate materialization 与 descriptor helpers 均未迁移；这是 AI-ARCH-9 的明确 remaining debt。兼容路径的最终删除留 AI-ARCH-10。

## 31. AI-ARCH-9 Search Core 落地结果

### Search Responsibility Freeze

| 职责 | 正式 owner | 输入 | 输出 | Planner 是否拥有 |
|---|---|---|---|---|
| 束搜索遍历与节点编排 | `search/Planner` | SearchState、根候选、显式 capability | 根动作、稳定计划、结构诊断 | 是 |
| TIME/NODE/COMPLETE/CANCELLED 判定与计数 | `search/SearchBudget` | 时钟、预算、结构事件 | stop reason、原始计数 | 否，只消费 |
| depth/beam/prune/tie-break/final selection | `search/SearchPolicy` | 完整候选与 stop reason | 搜索结构、排序和选择 | 否，只消费 |
| 通用候选物化与 final term 组合 | `search/CandidateMaterializer` | before/after、显式 value/search owners | 完整候选记录 | 否，只编排调用 |
| expose/assault/provenance 配对反事实 | `search/CounterfactualTerms` | SearchState、Simulator capability | 命名 transition terms | 否 |
| end opportunity 与 seal sibling timing | `search/SiblingTransitionTerms` | 同 parent 的完整候选集 | sibling terms、fallback base | 否 |
| 战术结算概率查询 | `search/TacticResolutionQuery` | 显式 Simulator capability | resolution scale | 否 |
| 稳定动作描述 | `search/ActionDescriptor` | abstract action | descriptor | 否 |
| 模拟状态推进 | `simulation/Simulator` | SearchState、abstract action | 独立 after-state | 否；factory 注入 |

正式 Planner 不 import Game、RuleEngine、Controller、Domain、Policy、Value owner 或 concrete Simulator，也不构造 Simulator。`AIController` 组合根为一次 plan 注入 `simulatorFactory`、`searchBudgetFactory`、深层动作生成和可取消让步能力；Planner 每次 plan 恰好从 factory 建立一个 Simulator。

### Budget 与 best-seen 语义

`SearchBudget` 是预算和结构计数的唯一 owner。`expandedNodes` 表示已完整物化的搜索候选，不等同 CPU work units；`simulationCalls`、`counterfactualCalls`、`stateUtilityCalls` 与 `yieldCount` 只作诊断，不参与排序、截断或价值计算。

候选只有在模拟、全部 transition terms、frontier/prior 和同层 sibling terms 完成后，才可登记为 `bestSeenCandidate`。正常 `COMPLETE` 保持既有 final beam、near-tie 和随机选择；`TIME` 与 `NODE` 统一返回全局 best-seen，不再从被截断的 partial active beam 重选；`CANCELLED` 安全返回终止动作。此次唯一行为更改只影响 TIME 中断曾选中 partial frontier 的分支，NODE 与完整搜索行为保持冻结。

### Validation 与剩余边界

- 固定 D4 仍为 `seal c -> stealSkill c -> assault b -> end`、expanded `102`、depth `4`、hidden samples `10`、`bestValueScore=0.04919669968375734`；正式诊断新增 `stopReason=COMPLETE`、`simulationCalls=103`。
- 确定性时钟回归覆盖 COMPLETE/TIME/NODE，另有 TIME/NODE 同一全局 best-seen 回归；Planner factory 测试证明每次 plan 只创建一个 Simulator 和一个 SearchBudget。
- planning benchmark（seed `20260814`、node budget `200`、planning category、planner audit）保持 raw `126/1000`、corrected `106/1000`、32 次决策平均节点 `41.4`、平均深度 `2.8`。
- Architecture Guard 禁止 Planner 依赖具体游戏/模拟实现，并禁止 SearchPrior 保存 `getCurrentState` service locator；self-test 同时覆盖合法、非法及注释遮蔽夹具。
- ARCH-9 独立验证出口仍保留 `AiPlanner` 临时组合层；该出口债务已由下一节的 ARCH-10 最终布局关闭，正式 Search Core 不得回迁算法。

## 32. AI-ARCH-10 Engine Closure 最终事实

### 最终物理目录

`js/ai/` 根目录只保留 composition root：

```text
js/ai/
├─ AiController.js
├─ state/       # Visible / Knowledge / Belief / Search contracts 与概率代数
├─ search/      # 候选生成、预算、策略、反事实、物化与 Planner
├─ simulation/  # 唯一 Simulator、五类效果组件与窄状态查询
├─ value/       # 状态、卡牌、威胁、经济、账本与领域价值
├─ policy/      # 动作、选牌、资源、响应与转移策略/执行边界
└─ domain/      # Radar / Lightning / Seal / GlobalBenefit 纯领域事实
```

正式生产文件共 `50` 个。根目录 allowlist 为且仅为 `AiController.js`；任何新增根级 AI JavaScript 文件都会被 Architecture Guard 拒绝。

### 物理移动与兼容路径删除

| 旧位置/名称 | 最终 owner |
|---|---|
| `AiActionGenerator` | `search/ActionGenerator` |
| `AiCardSelector` | `policy/CardSelectionBoundary` |
| `AiResponsePolicy` | `policy/ResponseBoundary` |
| `AiValueSimulationQuery` | `simulation/ValueSimulationQuery` |
| `AiStateValue` | `value/StateValue` |
| `AiVisibleState` | `state/StateContracts` |
| `AiEvaluator` 聚合门面 | `value/ValueService` |
| `AiKnowledge` | `state/Knowledge` |

下列旧兼容文件已从生产目录删除，生产 import 为零：`AiSimulator`、`AiEvaluator`、`AiStateValue`、`AiVisibleState`、`AiKnowledge`、`AiProbabilityBranches`、`AiEconomics`、`ThreatCalculator`、`roleCardValue`、`discardScoring`、`resourceSelectionValue`、`transferScoring`、`sealScoring`、`lightningScoring`、`AiGlobalBenefit`、`AiPlanner`、`AiActionGenerator`、`AiCardSelector`、`AiResponsePolicy`、`AiValueSimulationQuery`。

保留的边界均为正式职责而非 compatibility 算法副本：`AiController` 是唯一 composition/execution root；`Simulator` 是效果组件 facade；`ValueService` 与 `StateValue` 只转发到唯一公式 owner；`CardSelectionBoundary` 与 `ResponseBoundary` 把真实实体和 Game 执行上下文隔离在 Policy 外侧。它们不得拥有第二份搜索、价值、概率或选择公式。

### 最终所有权

| Layer | 最终 owner 与职责 |
|---|---|
| State | `VisibleState` 过滤公开信息；`Knowledge` 持有观察者合法记忆；`BeliefState` 推导未知分布；`StateContracts` 一次组合；`SearchState` 提供可克隆搜索世界；`Probability` 提供条件分支代数。 |
| Search | `ActionGenerator` 枚举候选；`SearchBudget` 管预算；`SearchPolicy` 管束搜索结构；`CounterfactualTerms` 与 `SiblingTransitionTerms` 生成命名项；`CandidateMaterializer` 组合候选；`Planner` 只编排。 |
| Simulation | `Simulator` 管 clone、共享概率 runtime 与 action dispatch；Response、Combat、Card、Skill、Status 五个组件各自拥有状态变换；`ValueSimulationQuery`、`RootResolutionQuery` 只做窄反事实查询。 |
| Value | `Evaluator` 拥有纯状态公式；`StateValue` 提供显式状态查询；`ValueLedger` 管 owner ledger；`Economics`、`CardValue`、`ThreatValue`、`SealValue`、`GlobalBenefitValue` 各拥有对应价值 primitive；`ValueService` 只聚合查询。 |
| Policy | `ActionCandidatePolicy` 管 AI 专属候选约束；`CardSelectionPolicy`、`ResourceSelectionPolicy`、`ResponsePolicy`、`TransferPolicy` 各拥有唯一选择公式；两个 Boundary 只解析真实实体与执行上下文。 |
| AI Models | `RadarModel`、`LightningModel`、`SealModel`、`GlobalBenefitModel` 只返回只读概率、ID 与 outcome 事实；它们不是 Repository Domain Rule authority。 |
| Execution | `AiController` 读取当前 GameState、组合全部 owner、向 Planner 注入窄 capability，并把 descriptor 重新绑定到当前合法实体。 |

`getLegalActions` 已改为 `getActionCandidates`：该集合以 `js/domain/rules/**` 决定确定性合法动作，再由 AI Policy 收窄为候选，不再误称为完整游戏合法集。

### 最终依赖图与门禁

生产静态 import 图已执行 DFS 审计，无循环依赖。Search 不 import concrete Simulation；Planner 没有任何 import，并只消费 `simulatorFactory`、`searchBudgetFactory` 与显式 capability。Simulation component 只在 `simulation/` 内被 import，禁止 Game、Controller、Planner、SearchPolicy 与 final value composition。AI 内部禁止 `game.aiController` 回指；SearchPrior 不保存 GameState callback。

`tools/check-code-quality.mjs` 的 `--ai-all` 会扫描全部 AI 生产文件，而非只看 changed lines。门禁覆盖六段式 Module Header、八段式 Function Header、JSDoc 拒绝、注释/字符串遮蔽、Simulation/Search/State/Value/Policy/Domain 分层、旧兼容路径、根目录布局、AI search/simulation/domain legacy RuleEngine/DistanceSystem import guard、Card/Skill 静态事实 guard、Transfer adapter delegate guard 与已迁移 simulation mirror guard；self-test 同时包含正负夹具。

全部 AI 模块已统一为正式注释格式。复杂 Search/Simulation 说明明确记录 counterfactual、best-seen、pruning、概率分区、资源身份、伤害/救援顺序和状态生命周期；生产 AI 中不存在 `/**`、`@param`、`@returns` 或开发阶段型注释，旧 owner 名称扫描为零。

### 行为、性能与回归冻结

除 TIME 中断选择全局 fully-materialized best-seen 外，未修改规则、阈值、权重、随机次数或 AI 数值。COMPLETE 与 NODE 行为保持冻结；固定 D4 仍为 `seal c -> stealSkill c -> assault b -> end`，expanded `102`、depth `4`、hidden samples `10`、`bestValueScore=0.04919669968375734`、`stopReason=COMPLETE`、`simulationCalls=103`。

planning benchmark（seed `20260814`、node budget `200`、`planning` category、planner audit）为 raw `126/1000`、chance-corrected `106/1000`；`32` 次决策平均 expanded `41.4`、depth `2.8`。

同一 planning 场景的结构计数为 constructor `64`、clone `1583`、apply `1583`、expanded `1325`、clones/node `1.1947169811320755`。Response `27686`、Combat `1860`、Skill `2905`、Status `12729`；Card raw `9340`，其中 `64` 是每个 Simulator 一次的 `initializeAssaultSummaries` 状态初始化，按 ARCH-8 可比 component 口径排除后为 `9276`，与冻结值一致。

AI-ARCH-10 最终非 Balance 验证：Search `71/71`、Simulation `137/137`、Value/Policy/Domain `227/227`、隐藏信息 `59/59`、全部 AI `816/816`、显式排除 `AI·搜索：平衡模拟` 的普通 unit/integration `1383/1383`。其阶段浏览器模块图统一使用 `20260814-ai-engine-2-final`；本轮静态清理后的当前标识记录在页首。

Remaining debt 不包含兼容算法或缺失 owner。尚需人工浏览器 smoke 验证观察战场、动作执行、响应、状态结算与重新开始流程；Git 提交、推送与合并仍由维护者执行。
