# FiveRealms Repository Architecture Authority

状态：FR-ARCH 0–15 COMPLETE / TARGET ARCHITECTURE IMPLEMENTED / LEGACY MIGRATION CLOSED

适用范围：FiveRealms 仓库级物理架构、依赖方向、职责所有权与结构守卫。

事实源关系：本文件解释仓库架构；`AI_ENGINE.md` 解释 AI Engine 内部结构；`CODE_STANDARD.md` 解释代码与注释格式。三者不得复制彼此形成第二事实源。

## 1. Current Physical Architecture

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
│  ├─ policy/
│  └─ ports/
├─ adapters/
│  ├─ ai/
│  │  └─ worker/
│  ├─ ui/
│  └─ diagnostics/
├─ ai/{domain,policy,search,simulation,state,value}
├─ composition/
├─ ui/
├─ audio/
├─ utils/
└─ main.js
```

`js/core/**`、`js/config/**`、`js/cards/cardRegistry.js` 与 `js/generals/skillRegistry.js` 不再存在生产文件。正式代码不通过转发文件访问最终 owner。

## 2. Runtime Composition Graph

```text
main.js
  -> createGameApplication()
      -> MatchApplication (internal composition/session object)
          -> Application workflows and ports
          -> Domain definitions, rules, state and transitions
          -> UI / diagnostics / AI integration adapters
          -> AIController
              -> serializable SearchRequest
              -> Dedicated Browser Worker
              -> descriptor-only SearchResult
          -> public application command boundary

UI / Human input ------> ChoicePort ------> Application workflow
AI decision adapter ---> ChoicePort ------> Application workflow
Application workflow --> Domain Rule -----> Domain Transition
Application workflow --> PresentationPort -> UI adapter
Application workflow --> DiagnosticsPort --> diagnostics adapter
```

Composition 只负责实例化、依赖注入、生命周期和公开 capability 装配。它不得包含 card/skill-specific 分支、规则公式或 workflow body。

`createGameApplication` 保留为浏览器入口工厂名称；它返回内部 `MatchApplication`，不是 `Game` 业务壳。`GamePresentationAdapter` 是只实现 `PresentationPort` 的具体 UI adapter，也不是 Game runtime。

## 3. Layer Semantics

- Domain：定义 FiveRealms 的静态事实、真实状态、纯规则、原子 transition 与不可变领域事实。
- Application：编排一局游戏的顺序、等待、选择、响应、触发、生命周期和真实结算。
- Adapters：连接 UI、人类输入、AI、Worker 与 diagnostics；不得成为业务规则 owner。
- Composition：把 final owners 连接成单局应用；不得回收业务职责。

正式依赖方向：

```text
UI / Audio / Diagnostics / AI adapters
                |
                v
           Application
                |
                v
              Domain
```

允许 outer layer 直接读取纯 Domain facts。禁止 Domain 依赖 Application、AI、UI、Audio、DOM、Worker 或具体 adapter；禁止 Application 静态依赖具体 UI、AI、Audio 或 diagnostics 实现。

## 4. Authoritative Ownership

| Concern | Final owner |
|---|---|
| Card / character / skill / status / ruleset facts | `js/domain/definitions/**` |
| Match / player / zone state shape | `js/domain/state/model/**` |
| State reads and canonical projections | `js/domain/state/queries/**` |
| Atomic state commits and `stateVersion` | `js/domain/state/transitions/**` |
| Team, distance, turn, judgment, combat, status, response, card and skill rules | `js/domain/rules/**` |
| Immutable match facts | `js/domain/events/MatchEvents.js` |
| Match setup, victory and dispose | `js/application/match/MatchWorkflow.js` |
| Turn loop and discard phase | `js/application/turn/TurnWorkflow.js` |
| Card / skill commands, locks and resolution lifecycle | `js/application/action/ActionWorkflow.js` |
| Card and skill execution | `js/application/action/{CardRuntime,CardIntentRuntime,CardEffectRuntime,SkillRuntime,SkillEffectRuntime}.js` |
| Hidden-card human/AI selection workflow | `js/application/action/HiddenCardChoiceWorkflow.js` |
| Damage, heal and HP-loss sequencing | `js/application/combat/CombatWorkflow.js` |
| Dying queue, rescue, death commit and cleanup | `js/application/combat/DyingWorkflow.js` |
| Defense and delayed judgment sequencing | `js/application/judgment/**` |
| Response windows, Counter chains and atomic payment | `js/application/response/ResponseWorkflow.js` |
| Participant decisions | `js/application/choice/**` plus `ChoicePort` |
| Passive/global triggers | `js/application/trigger/**` |
| Mutable hook dispatch | `js/application/messaging/EventDispatcher.js` |
| Runtime presentation and diagnostics contracts | `js/application/ports/**` |
| Human choice and browser presentation | `js/adapters/ui/**` and `js/ui/**` |
| AI integration and Worker transport | `js/adapters/ai/**` |
| AI policy, probability, simulation, search and value | `js/ai/**` |

## 5. Definitions and Configuration

Definitions are split by ownership instead of being reassembled into a mixed config object:

- Domain fixed facts: `CardDefinitions`, `CharacterDefinitions`, `SkillDefinitions`, `StatusDefinitions`, `RulesetDefinition`.
- UI labels, art and presentation metadata: `js/adapters/ui/*Presentation*.js`.
- AI card values and character role metadata: `js/ai/value/CardValue.js` and `js/ai/policy/CharacterRoleMetadata.js`.
- AI search and response policy: `js/ai/policy/AiRuntimePolicy.js`.
- Application timing/debug policy: `js/application/policy/RuntimePolicy.js`.
- Character selection metadata: `js/application/match/CharacterSelectionMetadata.js`.

There is no `general` domain schema. Internal identifiers and state use `character`; stable external IDs, asset filenames and player-visible names remain unchanged.

## 6. State, Rules and Transitions

- Definition：静态事实；无运行时身份。
- State：运行时身份与可变事实。
- Query：纯读取与受控投影。
- Rule：解释合法性、结果、顺序和生命周期事实。
- Transition：提交已经决定的原子变化，不解释 `definitionId` 或 `skillId`。
- Workflow：执行等待、响应、重验证、提交和反馈顺序。

`stateVersion` 由 Domain transition authority 维护：成功提交 `+1`，no-op 或失败 `+0`，原子组只增加一次。Application 不直接写 Domain-owned resource、zone、status 或 rule-usage 字段。

## 7. Choice and Hidden Information

`ChoiceRequest` / `ChoiceResult` 是 data-only contract。Human 与 AI adapter 返回同一种结果形状；participant metadata 只在 composition routing 使用。

隐藏手牌选择由三部分组成：

- `HiddenCardSelectionStore` 只保存 opaque token、selection ID、owner ID 与 hand version。
- `HiddenCardSelectionAdapter` 在私有 UI boundary 内完成实体重绑。
- `HiddenCardChoiceWorkflow` 统一 human 与 AI 的选择、重验证、清理和 private reveal 等待。

公开 request、DOM 与日志不得泄漏未知牌的 `definitionId`、名称、类别、描述或 art。private reveal 必须 await 用户关闭；session invalidation、restart 和 dispose 必须安全解除等待并清除 DOM。

## 8. Messaging and Domain Events

`EventDispatcher` 是 mutable hook 的唯一 owner：listener registry、顺序 await、generation、clear 与 shared mutable context 都在 Application。

`MatchEvents` 只创建不可变、data-only 的已发生事实。玩家日志属于 Presentation；Domain Event 不携带应用对象、Player entity、UI 或 callback。

Messaging 只传播和协调，不解释卡牌、技能、战斗或状态规则。

## 9. Response, Combat and Judgment

Application workflow 唯一拥有真实执行顺序：

- Response：block、Counter、nested Counter、forced assault、dying rescue、request lifecycle 与原子支付。
- Combat：防御判定、响应、before/after hook、Domain 计算、transition commit、telemetry、presentation 与 dying 入口。
- Dying：可重入队列、救援座次、恢复原 phase、死亡提交、击杀奖励与清理。
- Judgment：draw、show/log、reveal、Domain outcome、destination、hand-version 更新与 phase restore。

玩家和 AI 共享同一 Domain legality 与 Application execution path。AI simulation 是 SearchState 上的概率模型，不是第二真实规则 owner。

## 10. AI and Dedicated Worker

Dedicated Browser Worker 已是生产路径。Main Thread 创建 structured-clone-safe `SearchRequest`；Worker 返回 descriptor-only result 与 `rngAfter`。生产浏览器不会静默退回同线程搜索。

Worker 只拥有搜索计算：VisibleState、BeliefState、SearchState、Planner、Simulator、Probability、Value 与 Search Policy。Worker 不拥有真实应用状态、Application workflow、Domain transition、UI、DOM、Audio 或 mutable messaging。

Main Thread 永远负责：

- session、gameId、stateVersion、actor 与 phase validation；
- descriptor rebind 与当前 Domain legality validation；
- accepted RNG state commit；
- real action、trigger、presentation 与 audio continuation。

浏览器生产搜索固定使用同一 `NORMAL` 搜索结构与价值模型。Application 在每次真实 decision 前以独立 timing RNG 采样 `{Tmin,Tmax}`，只通过 data-only config 把 `Tmax` 传给 `SearchRequest`；Planner/Worker 不读取速度档位或 Presentation 状态。`Tmin` 只补足搜索后的最低可见节奏，首次动作与后续重规划都不叠加额外 initial pacing；`Tmax` 只由 `SearchBudget.TIME` 解释为正常 wall-clock 上限，已开始的完整候选可在下一预算检查点正常收束并保留 best-seen。node-budget 模式不使用正常 wall-clock deadline，只由 NODE、session cancel 或 10 秒 hard watchdog 停止；hard watchdog 仅处理失控 Worker。1×、2×、3× 不改变 searchDepth、beamWidth、hiddenStateSamples、价值、合法性或随机选择规则，但更长窗口可以物化更多完整候选。搜索计算 RNG、真实游戏 RNG 与 timing/presentation RNG 相互隔离。

## 11. Behavior Preservation

架构变更不得改变：游戏规则、卡牌/技能语义、合法性、target/seat ordering、response/Counter/nested Counter、damage/shield/heal/energy、dying/rescue、judgment、turn/reset、随机调用顺序、隐藏信息、AI policy/search、日志、UI 交互或音频触发。

真实行为修复必须作为独立 Bug 处理并具有直接回归测试；架构 guard 不得通过复制实现或弱化测试获得通过。

## 12. Test Architecture

`tests/run.mjs` 按 `test.md` 的稳定分类和命名规则组织。架构测试验证 final owner、依赖方向、公开 contract、行为 characterization、Worker transport、stale-result rejection、RNG isolation 和 browser stable URL/no-cache server 契约。

Facade-only loader tests 与已删除模块 fixture 不再存在。测试从 final owner 导入；不存在用于维持旧路径的 test-only shim。

非 Balance 验证入口：

```text
node tools/check-code-quality.mjs --self-test
node tools/check-code-quality.mjs --changed
node tools/check-code-quality.mjs --ai-all
TEST_PATTERN=<pattern> node tests/run.mjs
node tests/run.mjs
```

Balance 入口、参数与解释口径只由仓库根目录 `test.md` 定义。

## 13. Architecture Guard Closure

`tools/check-code-quality.mjs` 持续阻止：

1. 已删除文件或 import path 回流；
2. `Game` shell class/export 回流；
3. 内部 `general` schema 回流；
4. composition 出现 card/skill-specific business branch；
5. Domain/Application/AI/Worker 禁止依赖；
6. transition 与 rule owner 越界；
7. duplicate deterministic legality 或 duplicate business authority；
8. root artifact、service locator、mutable owner escape 与 production 同线程 Worker fallback；
9. 模块头、函数头和禁止迁移注释回归。

Checker self-test 必须包含每类禁止模式的 negative fixture，证明 guard 会对违规输入失败。

## 14. Closed Migration Record

FR-ARCH 0–15 已完成以下闭环：Definitions、State、Transitions、Rules、Choice/Ports、Response、Combat/Dying/Judgment、Match/Turn/Action、Card/Skill/Trigger、Messaging、AI/Domain convergence、main-thread boundary、Dedicated Worker、旧壳删除、`general -> character`、测试架构与 guard。

以下组件已物理删除，不得重新创建为转发层：

- `js/core/{Game,RuleEngine,EventBus,ResponseSystem,DyingSystem,HpLossSystem,JudgmentSystem,TeamRuleService,DistanceSystem,CardSelectionSystem,GameChoiceRouter,GameLogger,GeneralSelection,TeamManager,Player,Deck,PublicCardPool}.js`
- `js/cards/cardRegistry.js`
- `js/generals/skillRegistry.js`
- `js/config/{gameConfig,cardConfig,generalConfig}.js`
- `tests/head-loader.mjs`

任何新需求都必须落在上表 final owner 中。不得通过 `shared/common/helpers/compat` 目录、复制 resolver、镜像 config 或新增 God Object 绕开 ownership。

## 15. Architecture Authority

本文件只维护当前架构事实，不维护待办阶段。FR-ARCH 的历史设计与实施证据可从 Git 历史和架构测试读取；当前生产代码与本文件共同受 architecture guard 约束。
