# FiveRealms Repository Architecture Authority

状态：FR-ARCH-4 CLOSED / PASS — stateVersion AUTHORITATIVE；FR-ARCH-5 PASS；FR-ARCH-6 PASS；FR-ARCH-7 DONE — RESPONSE APPLICATION WORKFLOW；FR-ARCH-8 NOT STARTED
适用范围：FiveRealms 仓库级架构；`AI_ENGINE.md` 继续作为 AI Engine 2.0 的实施与历史权威，本文件不复制其内部所有权表。
事实源关系：本文件是 repository-wide target architecture 的唯一规范入口；若与 `CODE_STANDARD.md` 冲突，以本文件解释 ownership，以 `CODE_STANDARD.md` 解释注释格式。

冻结裁决：TARGET ARCHITECTURE CAN REMAIN FROZEN。
实施进度：FR-ARCH-0 DONE；FR-ARCH-1 DONE；FR-ARCH-2/2.1 DONE；FR-ARCH-3 DONE；FR-ARCH-4A DONE；FR-ARCH-4 CLOSED / PASS，stateVersion ACTIVATED — AUTHORITATIVE；FR-ARCH-5 DONE；FR-ARCH-6 DONE；FR-ARCH-7 DONE；FR-ARCH-8 NOT STARTED。

## 1. Target Physical Architecture

目标目录继续冻结；只允许按 dependency-aware 阶段逐步创建真实需要的目录，禁止为了“目录整齐”提前搬代码。

当前已落地：
- FR-ARCH-2/2.1：`js/domain/definitions/{cards,characters,skills,statuses,ruleset}` 已创建为纯静态定义 authority；旧 `js/config/**` 仅作 legacy façade/projection。Card `count` 由 `RulesetDefinition.deckComposition` 唯一拥有；`initialRound` 属 Ruleset；`responseTimeoutMs` 是 Application/Presentation runtime policy，不属于 Domain。
- FR-ARCH-3：`js/domain/state/{model,queries}` 已建立 state foundation；Game/Player/Deck 保持 legacy composite runtime identity。
- FR-ARCH-4A/4B：`js/domain/state/transitions` 已建立 generic atomic mutation foundation 并关闭 zone/deck/flags/counters direct writes；stateVersion 已由唯一 Domain authority 激活。
- FR-ARCH-5：`js/domain/rules/{team,distance,turn,judgment,combat,status,response}` 已建立 foundational pure rule layer；TeamRuleService/DistanceSystem/RuleEngine/ResponseSystem/JudgmentSystem/Game 只保留 legacy façade 或 workflow。Turn reset semantics 由 `TurnRules` 唯一拥有，`RuleUsageTransitions` 只 commit。cardRegistry/skillRegistry 完整迁移仍留在 FR-ARCH-10；DyingSystem/JudgmentSystem runtime workflow 仍留后续阶段。
- FR-ARCH-6：`js/application/{choice,ports/{ChoicePort,RandomPort}}` 已建立 evidence-based Choice/Random boundary；`ResponseSystem.waitForDecision` 与 `PublicCardPool.draft` 是真实 ChoicePort consumers；`adapters/{ui/UiChoiceAdapter,ai/AiChoiceAdapter}` 是 peer human/AI bridges。hidden token/session authority 已迁到 `application/choice/HiddenCardSelectionStore`，`core/CardSelectionSystem` 只做实体 façade。Presentation/Audio/Diagnostics ports evidence 不足，暂不创建空 port。
- FR-ARCH-7：`js/application/response/{ResponseWorkflow,ResponsePresentation,ResponseResult,AiResponseTimingPort}` 拥有 response window、block/counter/nested-chain/status-counter、dying-rescue window、forced assault window、request lifecycle、cancellation、payment orchestration 与 result normalization；`core/ResponseSystem.js` 仅 thin compatibility façade。`domain/rules/response` 保持 pure rule。AI timing 由 Application timing port 拥有，AI adapter 只做决策 bridge。GameChoiceRouter 仍作为 Game 组合根 wiring bridge。

```text
js/
├─ domain/
│  ├─ definitions/{cards,characters,skills,statuses,ruleset}
│  ├─ state/{model,queries,transitions}
│  ├─ rules/{card,skill,combat,response,status,turn,team,distance,judgment}
│  └─ events/
├─ application/
│  ├─ match/
│  ├─ action/
│  ├─ turn/
│  ├─ combat/
│  ├─ response/
│  ├─ judgment/
│  ├─ choice/
│  ├─ trigger/
│  ├─ messaging/
│  └─ ports/
├─ adapters/
│  ├─ ai/{state,models,policy,search,simulation,value}
│  ├─ ui/
│  ├─ audio/
│  └─ diagnostics/
└─ main.js
```

## 2. Logical Layering

- Domain：FiveRealms 游戏本身；回答“是什么、按规则应如何解释、真实领域状态如何变化、发生了什么事实”。
- Application：一局真实游戏如何运行 Domain；回答“先做什么、等待谁、如何协调、如何传播”。
- Adapters：外界如何参与 Application；回答“浏览器如何呈现、人类如何输入、AI 如何决策、声音如何播放、开发者如何诊断”。

## 3. Ownership

### 3.1 Domain

Domain 拥有：Definitions、State、Rules、Domain Events。

Domain 不知道：AI、Human、Browser、DOM、UIManager、SoundManager、Application Coordinator、Worker、EventBus runtime、concrete adapters。

#### Definitions
- 回答“游戏中有什么”，只允许纯领域静态事实。
- 当前 `js/config` 是混合基线；未来必须拆分：
  - `cardConfig.aiValue`、`generalConfig.aiProfile`、`portrait`、`art`、`gameConfig.aiSearch*`、animation/presentation timing 不得进入 Domain Definitions。
  - `generalConfig.activeCost/activeLimitPerTurn` 与 `ACTIVE_SKILLS.cost/limitPerTurn` 的重复必须收敛为唯一 owner。

#### State Model
- 真实领域状态。长期 `PlayerState` 不拥有 `controllerType`（属于 Application participant/session metadata）和 `aiMemory`（属于 AI Adapter state）。

#### State Queries
- 纯读取；不得 mutation。

#### State Transitions
- 只允许通用、原子状态变化：draw、discard、moveCard、energy/hp/shield mutation、status add/remove、zone movement。
- 禁止 cardId-specific/skillId-specific resolver、response workflow、combat pipeline、judgment workflow、status-specific workflow。
- `state/transitions` 绝不能成为新 RuleEngine。

#### Rules
- 游戏规则事实源。同一规则事实最终只有一个 owner。

#### Domain Events
- 表示“已经发生的领域事实”。
- 当前 mutable `before*/after*` EventBus context 不能机械改名为 Domain Event；其协调语义归 Application Trigger/Messaging。

### 3.2 Application

Application 拥有：match、action、turn、combat、response、judgment、choice、trigger、messaging、ports。

- Domain Rule = 规则是什么。
- Application Workflow = 真实游戏如何执行这些规则。
- Choice：要求某参与者作出决定；Choice 不知道 Human 还是 AI。
- Trigger：发现、排序、调度、执行 trigger workflow；不拥有具体 Skill Rule。
- Messaging：EventBus、Dispatcher、Subscription；Messaging != Domain Event。

### 3.3 Adapters

Adapters：AI、UI、Audio、Diagnostics。

- AI Engine 2.0 内部结构原则上保持。
- 未来 `js/ai/domain/* -> adapters/ai/models/*`；本阶段禁止 rename。

## 4. Dependency Rules

正式冻结：

```text
Adapters -> Application -> Domain
```

允许：`Adapters -> Domain`。

禁止：

- `Domain -> Application`
- `Domain -> Adapters`
- `Application -> concrete AI`
- `Application -> concrete UI`
- `Application -> concrete Audio`
- `Application -> concrete Diagnostics`

Application 需要外部能力时依赖 Port。禁止为了 Clean Architecture 形式主义提前制造无实际价值的接口。

## 5. Single Source of Truth

一个业务事实最终只能有一个 authoritative owner。

禁止通过 copy、mirror、duplicated helper、duplicated resolver、compatibility implementation 完成最终迁移。

短期 façade 允许，但必须：
1. 只 forward；
2. 不包含第二份业务实现；
3. 明确真正 owner；
4. 明确删除条件。

重点待收敛区域：
- `cardRegistry <-> CardEffectSimulation`
- `ResponseSystem <-> ResponseSimulation`
- `Game.damage/Dying <-> CombatSimulation`
- `skillRegistry <-> SkillEffectSimulation`
- Status real runtime `<-> StatusSimulation`
- `generalConfig <-> ACTIVE_SKILLS` cost/limit
- `RuleEngine <-> ActionGenerator` deep legality

## 6. Behavior Preservation

除明确批准的例外外：Before Refactor Behavior == After Refactor Behavior。

禁止迁移改变：游戏规则、卡牌/技能语义、状态、合法性、target/seat/event/async/response/nested-counter/passive ordering、judgment timing、damage pipeline、dying/rescue、energy/card payment timing、turn/reset timing、random call ordering、hidden information、AI value/policy/search semantics、玩家日志、UI 交互、动画/音频业务触发。

发现旧行为疑似 bug：报告，不顺手修。

## 7. Definition / State / Transition / Rule 区别

- Definition：静态事实；无运行时身份。
- State：运行时身份与可变事实。
- Transition：不解释 cardId/skillId 的原子写操作。
- Rule：解释合法性、结果和生命周期。
- Workflow：解释等待、顺序、响应窗口和真实执行编排。

## 8. Choice / Trigger / Messaging 区别

- Choice：把“需要参与者决定”建模为请求；由 main thread 协调；不内含 AI/Human 判断。
- Trigger：因领域事实检查并调度被动逻辑；可依赖 Rule，但不拥有 Rule。
- Messaging：只传播；不解释事件业务含义。

## 9. Ports / Adapter Semantics

候选 Ports：
- `ChoicePort`：统一 Human/AI decision request；当前 `game.ui.request*` 与 `game.aiController.*` 分支是历史实现，不是最终契约。
- `PresentationPort`：render、player-visible log、thinking/current-card/feedback；不得吞并 Choice/Audio。
- `AudioPort`：业务音频触发；Application 只表达“发生了什么”，不构造 AudioContext。
- `DiagnosticsPort`：developer diagnostics；玩家可见日志不属 Diagnostics。
- `RandomPort`：语义上必须区分 Real Game RNG 与 AI Search RNG，不得用一个共享流伪装成解耦。

Adapters：
- UI：DOM、Human interaction、player-visible presentation。
- Audio：Audio implementation。
- AI：AI 决策；SearchState 属于 AI，不等于 Domain State。
- Diagnostics：debug、trace、performance、architecture diagnostics。

## 10. Worker-Ready Target

```text
MAIN THREAD
  Authoritative Domain State
  Application Workflow
  Match / Turn Lifecycle
  Choice Coordination
  Real Rule Execution
  Session Ownership
  UI / DOM / Animation / Audio Scheduling / Player-visible Presentation
        |
        | Serializable SearchRequest
        v
DEDICATED AI WORKER
  SearchState / VisibleState / BeliefState
  Planner / Simulator / Probability
  Counterfactual / VOI
  Value / Search Policy / Deep Action Generation
        |
        | Serializable ActionDescriptor
        v
MAIN THREAD
  session validation
  stateVersion validation
  actor validation
  action rebind
  Domain legality validation
  real execution
  trigger continuation
  presentation / animation / audio
```

Worker 不得成为：第二 Game Runtime、第二 Application Runtime、第二 Domain Rule Authority。
Worker 不得拥有：Game、real Player entity、UI、DOM、Audio、EventBus runtime、Application Coordinator、真实隐藏信息。
Worker 只消费：可序列化、合法过滤、信息安全的 SearchState/VisibleState/BeliefState/DecisionContext/Search Configuration。
Worker 返回：stable serializable ActionDescriptor。
Main Thread 永远 authoritative。

## 11. AI Thinking-Time Contract

### 11.1 Core Principle
玩家看到的“AI 正在思考”应对应 AI 真正搜索计算，不再依赖随机假思考等待。AI Thinking Time = Actual Search Compute Time，不是 Search Time + Random Presentation Delay。搜索提前完成立即行动，不得人为补足随机等待。

### 11.2 Fast Mode
- Soft Thinking Target：500 ms。
- Compatibility Hard Ceiling：900 ms。
- 500 ms 不是 hard stop、不是固定等待、不是最大允许搜索时间。
- 如果 500ms 前 minimum search quality 已达到、best candidate 稳定、或搜索自然完成：立即返回（例如 120ms、430ms）。
- 如果 500ms 时 frontier 仍有明显高价值未展开、top candidate 不稳定、near-tie 未解析、required depth/node floor 未完成：允许继续。
- Fast Mode 最迟 900 ms 必须停止正常搜索并返回 best-so-far valid candidate。
- 900 ms 是当前搜索质量兼容上限；Worker 化初期不能为了 Fast UI 把当前约 900ms 搜索能力砍成 500ms。

### 11.3 Normal Mode
- Hard Search Ceiling：3000 ms。
- Normal 没有 minimum fake wait。
- 100ms 已明确完成、700ms 已收敛：立即行动。
- 复杂局面仍有高 VOI：允许继续。
- 最迟 3000ms 返回 best-so-far valid candidate。
- 3000ms 是 normal search quality deadline，不是唯一 hard safety watchdog。

### 11.4 Search Quality != Wall Clock
Worker 化后搜索质量不能只定义成“搜了多少毫秒”。可考虑的长期指标：
minimum node/depth completion、root candidate coverage、beam/frontier completion、best-candidate stability、top1/top2 separation、near-tie resolution、remaining VOI、search completion state。

本阶段禁止设计并实现新的搜索算法。

### 11.5 Convergence / Early Stop
未来语义：

```text
if (
    minimumSearchQualityReached
    && bestCandidateStable
    && noMaterialFrontierValueRemaining
) {
    return bestCandidate;
}
```

这只是长期语义。真正实现前必须基于当前 Planner/SearchPolicy 重新设计，不能机械使用伪代码。

### 11.6 500ms != Old 900ms
Worker 会减少 main-thread yield/UI scheduling 开销，因此 500ms Worker 的有效节点量可能高于当前主线程 500ms；但未经 benchmark 不得假定它与当前 900ms 搜索质量等价。
未来把 Fast Hard Ceiling 从 900ms 降到任何小于 900ms 的值前，必须有固定种子证据证明决策质量没有明显下降。至少比较：
expanded node count、completed depth、root candidate coverage、selected action、selected sequence、final value、near-tie resolution、representative complex states。
禁止只比较平均耗时。

### 11.7 Compatibility Quality Floor
Worker 化初期 Fast Search Quality >= Current validated ~900ms baseline quality。
“>=”不要求每局选择绝对相同，而是不得因人为砍时间系统性降低搜索深度、关键候选覆盖、near-tie 判断、multi-step sequence quality、response planning、probabilistic reasoning quality。
未来主动降低 Fast Search Quality 属于 AI 行为/产品策略调整，不得伪装成架构重构。

### 11.8 Deadline / Watchdog 区分
必须严格区分：
1. Search Quality Deadline；
2. Hard Safety Watchdog；
3. Node Hard Limit；
4. Cancellation；
5. Stale-result Rejection；
6. Main-thread Responsiveness；
7. Presentation Pacing。

Worker 后 main-thread responsiveness 不再依靠 yieldEvery/wall-clock yielding；仍必须保留 cancellation、node budget、watchdog、stale result rejection、session validation、stateVersion validation。
Fast 900ms / Normal 3000ms 是正常 Search Deadline；Hard Watchdog 独立存在，用于防搜索异常、死循环、cancellation failure、combinatorial explosion、Worker 失控。

### 11.9 Best-So-Far Requirement
达到 Search Deadline 时 AI 必须返回当前已完整评估的 best valid candidate。
不得返回半构造 action、未完成 simulation branch、非法 action、SearchState、real Game entity。
Worker 返回 ActionDescriptor；Main Thread 执行 session/stateVersion/actor/phase validation、rebind、Domain legality validation 后才真实执行。

### 11.10 No Fake Random Thinking Delay
Worker 正式落地后逐步淘汰随机“AI 思考展示延迟”。
AI Search Compute != Presentation Pacing。动画/反馈/牌移动/响应 UI transition 仍可有真实 Presentation 时间，但不得伪装成 AI Thinking Time。

### 11.11 Fast Animation Relationship
Fast Animation 同时选择更快 Presentation Profile + 更短 AI Thinking Profile。
Fast 不是“AI 只允许思考一半”；目标是简单局面尽快行动，复杂局面仍允许保住约当前搜索质量。

### 11.12 Behavior-Preservation Exception
“随机假思考 -> 真实 AI compute duration”是 Behavior Preservation Contract 的显式未来例外。
只有未来专门 Worker/Thinking-Time 阶段可实施。FR-ARCH-1 及中间所有迁移阶段必须保持当前 timing 行为；禁止提前修改 SearchBudget、yieldEvery、yieldControl、aiTiming、animation timing、thinking delay。

## 12. StateVersion Governance

长期以 `sessionId + stateVersion` 拒绝 stale Worker result。

阶段区分：
- Contract Definition：FR-ARCH-3 State Model 阶段建立数据契约。
- Runtime Activation：只有 FR-ARCH-4 Atomic State Transitions 建立 authoritative mutation boundary 后才启用真实 increment points。

本阶段只记录 contract；禁止修改 production State。

## 13. RNG Isolation

正式冻结：REAL GAME RNG != AI SEARCH RNG。

AI 搜索的思考时间、节点数、深度、Worker scheduling 不得推进真实游戏 RNG。
Game RNG 由 authoritative Main Thread Game Runtime 持有；AI Search RNG 由 SearchRequest 提供独立 seed 或 search RNG state。

本阶段禁止修改 production RNG。

## 14. Migration DAG

| Phase | 内容 |
|---|---|
| FR-ARCH-0 | Architecture Audit（DONE） |
| FR-ARCH-1 | Governance + Characterization Freeze（DONE） |
| FR-ARCH-2 | Domain Definitions（DONE，含 2.1 ownership closure） |
| FR-ARCH-3 | Domain State Model + StateView + Queries；定义 stateVersion contract，不完全激活 increment（DONE） |
| FR-ARCH-4 | Atomic State Transitions；CLOSED / PASS；stateVersion authoritative（DONE） |
| FR-ARCH-5 | Foundational Domain Rules：Team/Distance/Turn/Judgment/Combat/Status/Response；主要提纯 Rules，不过早迁全部 Runtime Workflow |
| FR-ARCH-6 | Choice + Ports Boundary：ChoicePort/PresentationPort/AudioPort 及代码证明需要的最小 Port |
| FR-ARCH-7 | Response Workflow（Combat/Dying 依赖 Response/Rescue） |
| FR-ARCH-8 | Combat/Dying/Judgment/Status Workflow |
| FR-ARCH-9 | Match/Turn/Action Workflow，逐步瘦身 Game |
| FR-ARCH-10 | Card/Skill Rules + Runtime + Trigger；逐卡、逐技能迁移 |
| FR-ARCH-11 | Messaging + Domain Events Closure；区分 mutable workflow context 与 immutable Domain Facts |
| FR-ARCH-12 | AI <-> Domain Convergence；逐规则族消除 Simulation mirror 重复语义 |
| FR-ARCH-13 | AI Main-Thread Boundary Hardening（legal memory projection、ActionGenerator root/deep split、SearchRequest/ActionDescriptor contract、stateVersion、RNG split、cancellation、stale result rejection）；仍不创建 Worker |
| FR-ARCH-14 | Dedicated AI Worker + Thinking-Time Contract Implementation |
| FR-ARCH-15 | Legacy Removal + Architecture Closure（删除旧 façade、general->character 收尾、test architecture 收口、guard 闭环） |

依赖顺序解释：
- Definitions 必须先于 Rules 与 State 消费。
- Queries/StateView 必须先于 Rules 去 dual-schema。
- Transitions 必须先于 Combat/Response/Status workflow。
- Response 必须先于 Combat/Dying workflow。
- Choice/Ports 必须先于 Match/Turn/Action 的参与者分叉移除。
- Card/Skill 拆解依赖前序 workflow 与 trigger 边界。
- AI/Domain convergence 不得先复制 Domain 到 AI。
- Worker 只能在 FR-ARCH-13 全部完成后创建。

## 15. Forbidden Architecture Patterns

以下模式在目标层出现即失败：
1. Domain import Application/Adapters/legacy UI/audio/AI/Game/UIManager/SoundManager。
2. Application import concrete UIManager/AIController/SoundManager/future concrete adapters。
3. Adapters 跨 concrete adapter 直接耦合。
4. `domain/state/transitions` import cardRegistry/skillRegistry/ResponseSystem/DyingSystem/JudgmentSystem 或出现 `definitionId ===` / `skillId ===` 具体规则分支。
5. 新增 `utils/common/helpers/misc/shared/legacy/compat` 兜底目录（当前 `js/utils` 是历史 baseline，不因存量判失败，但不得继续成为迁移目标）。
6. Domain 内用 `Array.isArray(player.statuses)` 等 dual-schema 兼容分支同时识别 Real Player/SearchState。
7. 为通过 guard 制造第二份业务实现、copy/mirror、compat implementation。
8. 为了 Clean Architecture 形式主义制造无消费者 Port 或空 abstraction。
9. 大爆炸式 rewrite、批量 rename、全仓格式化。
10. 迁移阶段修改 SearchBudget/yieldEvery/yieldControl/aiTiming/thinking delay/RNG。

## 16. Current Timing Baseline Classification

当前生产事实（FR-ARCH-1 冻结；不得修改）：

| 机制 | 当前职责分类 |
|---|---|
| `SearchBudget.timeBudget`（默认 900ms） | SEARCH QUALITY（当前同时兼任 MAIN-THREAD RESPONSIVENESS） |
| `SearchBudget.nodeBudget`（测试/benchmark override） | SEARCH QUALITY + HARD SAFETY 近似 |
| `GAME_CONFIG.aiSearchYieldEvery`（48） | MAIN-THREAD RESPONSIVENESS |
| Planner `yieldControl`（经 AIController 注入 CleanupManager/会话检查） | MAIN-THREAD RESPONSIVENESS + CANCELLATION |
| `SearchBudget` stopReason/计数 | SEARCH QUALITY + BENCHMARKING |
| `utils/aiTiming` / `getAiDelay` | PRESENTATION PACING |
| `CleanupManager` | CANCELLATION + SESSION TEARDOWN |
| `Game.aiMaxActionsPerTurn` | HARD SAFETY |

## 17. Search Quality Baseline Contract

- 固定状态、固定 seed 的 representative fixtures 是未来 Fast Worker 比较基线。
- 当前 ~900ms 搜索质量基线 fixture 位于 `tests/fixtures/fr-arch-search-quality-baseline.json`。
- 必须记录：selected action、selected sequence、expanded nodes、completed depth、root candidate count、search stats、final value、near-tie 可见字段。
- elapsed wall-clock 仅作辅助，不作为质量证据。
- `Planner.lastSearchStats` 未提供 root candidate coverage / near-tie top separation 的完整字段；未来若需要，只能在 FR-ARCH-13/14 通过诊断边界补观测，不得侵入 production Planner 决策。
- 未来 FR-ARCH-14 比较：CURRENT BASELINE ~900ms main-thread vs WORKER FAST（500ms soft、900ms hard），比较 decision quality/node progress/depth/coverage/sequence/value/near-tie，不比较平均耗时。
- 在获得固定 seed 证据前，Fast Hard Ceiling 不得从 900ms 进一步降低。

## 18. Validation Contract

每一未来阶段至少执行：
- `node tools/check-code-quality.mjs --self-test`
- `node tools/check-code-quality.mjs --changed`
- `node tools/check-code-quality.mjs --ai-all`
- 相关 architecture fixtures
- 新增 characterization tests
- full existing non-balance suite（不含 balance harness）

禁止：`tests/balance.mjs`、大规模随机对局、长时间 benchmark。
固定 seed 的小型 search characterization 不属于 balance，可用于冻结搜索质量。

## 19. Architecture Challenge Protocol

若未来发现 checker 无法表达 frozen architecture、ownership 冲突、DAG 顺序错误、Worker-ready 与三层冲突、Thinking-Time Contract 与 Planner 冲突、900ms baseline 无法合理定义、Port 设计错误：

1. 报告 Evidence；
2. 报告 Conflict；
3. 给出最多 3 个 Options；
4. 比较 ownership/coupling/source-of-truth/behavior risk/worker-readiness/migration cost/maintenance cost；
5. 明确 Recommendation；
6. 输出 `ARCHITECTURE REMAINS FROZEN` 或 `ARCHITECTURE CHANGE REQUIRED`。

禁止通过 shared/compat/legacy/common/helpers/misc 绕过 ownership 问题。

## 20. Architecture Authority

本文件是 repository-wide architecture authority。`AI_ENGINE.md` 保留 AI Engine 2.0 实施细节与历史迁移证据；`CODE_STANDARD.md` 保留代码与注释格式 authority。三份文档分别回答：仓库架构、AI 内部架构、代码格式。禁止复制同一份规范形成双文档事实源。
