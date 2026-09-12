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
├─ ai/
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

### Match Performance, History and Achievement sidecar

终局 sidecar 链路为 `Match Performance → Achievement evaluation → Achievement Store / History persistence → Achievement ViewModel → History / Toast / MVP 本局成就展示`。Achievement 不参与 Gameplay 判定，也不进入 AI、Search 或 Simulation。

`HistoryStatsManager` 是长期档案入口；`AchievementStore` 管理成就持久化记录与 ViewModel；`AchievementTracker` 只根据最终真实 Match facts 判定。Achievement Presentation 位于 UI/History sidecar；现有 `js/ui/history/**` 物理目录不代表需要迁移或重构。

浏览器开发环境默认使用 `/api/history`。桌面封装通过 `electron/history-server.js` 注入 storage adapter，把历史文件写入可写 user-data 目录，不依赖 `app.asar` 或安装目录可写。Electron 只提供运行时、历史服务和网络传输，不拥有游戏规则 authority。

## 5. Definitions and Configuration

Definitions are split by ownership instead of being reassembled into a mixed config object:

- Domain fixed facts: `CardDefinitions`, `CharacterDefinitions`, `SkillDefinitions`, `StatusDefinitions`, `RulesetDefinition`.
- UI labels, art and presentation metadata: `js/adapters/ui/*Presentation*.js`.
- AI card/resource value：`js/ai/Evaluator/CardValue.js`。
- AI state/value aggregation：`js/ai/Evaluator/{StateValue,Evaluator}.js`。
- AI search scheduling/policy：`js/ai/Searcher/{Searcher,Pattern,Rng}.js`。
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

### Network 游戏侧多人 authority

`js/network/NetworkSession.js` 唯一拥有房间成员、容量、选择、准备屏障和席位控制权。Host 独占真实 MatchApplication、MatchState、GameLoop、canonical Action、AI 与 RNG；Guest 只保留 Host 快照和本地展示/输入状态。

- 真人成员保存在 `participants[participantId]`，包含 role、稳定 guestOrdinal、connectionId、Transport 注入的 remoteAddress、connected/kicked、selection、ready、gameReady。AI 不进入此集合。
- `finalSetup.players` 始终为五个 canonical 席位，每席的 `controller = { type: HOST | GUEST | AI, participantId }` 是唯一 ownership 描述。AI 的 participantId 为 null；角色、playerId、seatId 和阵营在锁房后固定。
- `NetworkSetup` 每个房间只生成一次共享角色排列与既有 2V3 阵营席位。真人共用角色候选，Host 校验角色和席位唯一；同一成员只能保存一项 selection。
- `snapshot().currentHumanCount` 统计仍有效且连接的真人，`maxHumanCount` 可由 Host 设置为 2–5。允许 Host 单真人开局；最大值不是必须达到的人数。未锁房的加入达到上限返回 `ROOM_FULL`；降低上限到现有人数以下返回 `CAPACITY_BELOW_COUNT`，不踢人。
- 第一屏障是现有 selection confirmation：所有当前真人选择并确认后仅得到 `canStart`。Host 显式 `start()` 锁房并补齐 AI，然后进入原 `LOADING_GAME / gameReady / MATCH_START` 屏障。全部有效真人的 UI 就绪后才由原 composition 调用 `startPreparedMatch → initializeMatch → GameLoop`。
- Lobby 移除 Guest 会删除其成员和 selection；锁房后移除只标记成员失效并将原席位 controller 转 AI。`NetworkHostBridge` 将 ownership 投影到原 Player 的 controlType/controllerType/networkRole，不替换任何实体或写入领域状态。
- `NetworkGameChannel.cancelParticipant` 只取消该成员的 pending 决定。`PlayerControlRouter` 将挂起的 ChoiceRequest 转交原 AI port；尚未完成的真人目标/附加选择取消，当前出牌等待接续既有 AI play-phase capability；后续所有选择按 AI 路由。私密揭示不得转而显示给 Host。
- 断线和踢人不属于可回滚的 Action 数据。Host bridge 通过原 transaction participant 扩展点，在领域对象原位恢复后重新投影当前 ownership，防止 rollback 恢复已撤销的真人控制权。
- 状态、距离、提示和事件时日志按每位 Guest 的 viewerId 独立投影；私有手牌、请求和日志不得广播给其他 Guest。对局标签来自 controller ownership，不从位置或阵营推断。

#### Transport 消费契约

多人聊天使用同一个 envelope 和 participant 路由：`CHAT_SEND` 上行 payload 仅含 `scope: all | team` 与 `text`，Host `NetworkSession` 从已认证 connectionId 解析 participant，再从 `finalSetup.players.controller` 查正式角色与 teamId，昵称使用 participant 当前 displayName authority。Host 本端进入相同验收函数，按 participantId 的单调时钟冷却每秒最多接受一条；原始正文最多 50 个 UTF-16 code unit（与 HTML maxlength 一致），trim 后为空或附加身份字段均拒绝。`CHAT_MESSAGE` 仅定向给仍连接且未移除的真人；all 为所有真人，team 再筛选同队席位，发送者包含在内。`CHAT_REJECTED` 只返回发送者并在输入栏提示，不写游戏日志。

`NetworkChatView` 唯一拥有当前会话的本地屏蔽偏好，按 participantId 过滤后续收到的聊天，始终保留自己；不发送屏蔽设置，不影响 Host 路由。正文用 textContent，姓名复用正式 player 日志 fragment 与队伍颜色。聊天直接追加为 UI 日志容器中的 `is-chat` 节点，不进入 MatchState、GameChannel 快照或历史统计。UIManager 仅索引游戏日志 DOM；Action rollback 和 Guest 日志恢复只删除游戏节点，保留交错聊天。会话关闭重置屏蔽，页面离局清空展示。

Electron transport 通过 `preload.js → NetworkIpcBridge → LanHostTransport/LanClientTransport → TcpPeer` 提供 capability；游戏侧仍只由 `NetworkSession`、`NetworkGameChannel` 和 Host runtime 拥有会话、Decision 协议与游戏 authority。

Decision 采用 `DECISION_REQUEST → DECISION_RECEIVED → DECISION_RESPONSE → DECISION_ACCEPTED` 生命周期。Guest 在 Accepted 前保留请求；同 requestId 的重复 Request 必须内容一致，重复 Response 必须匹配原消息类型、participantId 和完整回答。Host 只补发 Accepted，不再次 decode 或完成 workflow。IPC ACK 仅确认 renderer callback 投递，不代表 gameplay 登记或接受。

Host 的 accepted ledger 以 requestId 索引，条目绑定 participantId、消息类型及含 gameId 的完整回答。requestId 的通道内 serial 在 reset 时不归零；新 Session 的房间与认证连接另由 NetworkSession 隔离。已接受条目保留至该局 channel reset（Host dispose、session disconnect/close），撤销成员时只清除该 participant 的条目。不存在跨局永久缓存，也不使用 TTL 提前遗忘仍可能重试的回答。

Guest 缺少 projection，或合法 Decision 的 stateVersion 比本地快照新时，发送 RESYNC_REQUEST；Host 验证当前 gameId 和成员身份，仅回复请求者的最新 viewer-safe GAME_SNAPSHOT 及其仍有效 pending Decision。恢复时发现 pending 已过期、角色死亡或终局，则沿用现有回答验收规则发送 DECISION_CANCELLED 并收束原 Promise。完整旧快照不触发恢复。projectionRevision 是 Guest 本地展示通知计数，非网络增量版本；revision 是 Host 完整房间快照版本；stateVersion 是 Domain 提交版本；sequence 仅按认证连接防重放，允许定向发送导致的序号间隙，gameplay 成功后单调提交，不重建 TCP 排序。

公开日志仍由原 MatchLogAdapter 产生，NetworkHostBridge 只缓存事件发生时各 viewer 的安全展示。GAME_SNAPSHOT 的 `display.logSync = { start, total, rollbackRevision, entries }` 表示保留前 `start` 条并追加本块；普通 render/feedback/currentCard 更新只发送尚未交付条目，已同步时 entries 为空。正式 rollback 同时裁掉 Host 缓存和发送位置，Guest 用原 `restoreLogBoundary` 裁尾，不改变日志内容、顺序或领域回滚。Host 仅在正式 restoreLogBoundary 入口增加 rollbackRevision：新的回滚边界允许接受同时恢复的较低 stateVersion；普通旧快照和回滚前 epoch 仍拒绝，Guest 不生成或修改领域版本。Guest Channel 保存唯一网络展示副本；日常通知只 clone 增量，新订阅/显式本地 snapshot 才附上累计副本。

初始同步或显式 RESYNC 从起点恢复，按最多 32 条、聚合 64 KiB 分块，不截断历史。超出聚合预算的单条日志独占一块，仍受原 1 MiB Transport frame 上限约束。Host 为每个 participant 只保留一个可继续的 offset；`LOG_REQUEST` 必须匹配当前 gameId、认证成员和该 offset，消费后不可重放。Guest 每 50 ms 最多拉一块，续块不重复发送 Decision。每成员的 RESYNC 构造间隔至少 1000 ms；窗口内请求合并为一个延迟恢复，执行时读最新状态，离房/reset 会取消计时器。正常 Decision/stateVersion 校验保持原语义。

Electron 接收队列保持单 flight/ACK 串行消费。Host 的排队和 flight 都保留 Transport 注入的 connectionId；每连接最多待处理 32 条或 1 MiB，原整端 128 条/4 MiB 上限不变，普通事件预留 12 条/12 KiB 给离房通知。超限只丢弃该来源未交付事件并关闭其 TcpPeer，已投递 flight 仍等待原 ACK。未投递入房的连接关闭时一并撤销入房事件；已投递入房则必须交付 DISCONNECTED，继续原 participant 离线/AI 接管流程。迟到定向回复与目标 socket 写入失败不能升级为整端 ERROR。renderer 消失、IPC send 失败或 10 秒不消费仍是 endpoint 故障，可以关闭整个 transport。

Host admission 在构造 TcpPeer 前执行：总连接最多 12、未完成 TCP handshake 最多 8、相同 remote 最多 6；IPv4-mapped IPv6 与对应 IPv4 按同一地址计数。包含关闭尚未完成的连接，socket close 后释放名额；超限只 destroy 当前新 socket。Host 每个已握手 Guest 的 envelope token bucket 容量 128、每秒补充 32；ping/pong 不计入，超限只关闭该 Guest。以上均为网络资源预算，不是游戏平衡值；游戏侧仍按原房间容量、ROOM_FULL/ROOM_LOCKED、身份与 ownership 验证决定是否入房。

| 条件 | 分类与行为 |
|---|---|
| projection 缺失、同局 Decision.stateVersion 高于本地 | C：请求定向 Resync，不登记暂不可用的请求 |
| projection viewerId、gameId 与已绑定身份/游戏冲突 | D：拒绝；旧会话 envelope 也由 roomId/generation 拒绝 |
| projectionRevision 不一致 | B：本地展示计数，不作为消息拒绝条件 |
| GAME_SNAPSHOT.stateVersion 低于已接受快照 | A：忽略迟到完整快照；Host 正式回滚产生的新 rollbackRevision 允许恢复同步的状态与日志边界 |
| Decision.stateVersion 低于当前 projection | A：忽略旧请求；Host 收到过期回答时取消 pending 并收束原 workflow |
| 房间 snapshot revision gap | B：验证后接受完整权威快照；不等待缺失 revision |
| 房间 snapshot revision 重复或倒退 | A：忽略 |
| application sequence gap | B：接受通过其余校验的消息，不请求重排 |
| duplicate/stale sequence | A：拒绝重放；被 gameplay 拒绝的序号不算已提交 |
| 同 requestId 且内容相同 | A：复用已有请求并补 receipt，不重新开启 UI |
| participant/connection binding 冲突、越权 Response、同 ID 内容冲突、非法 payload | D：拒绝，不借安全错误触发 Resync |
| Transport handshake 协议版本错误 | D：由 TcpPeer 拒绝握手 |

Receipt 丢失测试通过显式 Resync 触发原请求重发；Accepted 丢失测试通过显式重发同一回答恢复。当前通道未设置自动 receipt/response 重试计时器，不能把这些测试解释为静默丢失时必然自动恢复的证明；玩家思考也没有 gameplay timeout。

| 入口或字段 | 契约 |
|---|---|
| `addParticipant({ connectionId, remoteAddress })` | Host-only，接收 Transport 认证的新连接；返回 `{ ok, participantId }` 或 `ROOM_FULL / ROOM_LOCKED / INVALID_CONNECTION`。重复当前连接幂等；新的连接应使用新的 connectionId。 |
| `setMaxHumanCount(count)` | Host-only，锁房后拒绝。 |
| `markParticipantDisconnected(participantId)` | Host-only，Transport 根据已保存映射通知指定 Guest 离线；不得用于 Host migration。 |
| `kickParticipant(participantId)` | Host-only，禁止踢自己；发出游戏侧离房通知并撤销控制权，实际关闭 Socket 由外部 Transport 负责。 |
| `receive(envelope)` | capability 交付事件前必须根据真实连接覆盖注入 connectionId，禁止信任客户端同名字段；participantId 必须匹配 Host 保存的映射，sequence 按连接检查。 |
| `send(envelope).recipientParticipantId` | Host 指定唯一接收成员。Transport 按映射定向发送，严禁向其他 Guest 广播 viewer 私有内容；首个定向房间快照同时确立 Guest 的 participantId。 |
| `CAPABILITY / PEER_CONNECTED` | 生命周期事件由 Transport 构造，payload.remoteAddress 也必须由 Transport 注入；普通 Guest payload 中的地址或身份字段不更新成员。 |
| `CAPABILITY / DISCONNECTED` | Host 按 connectionId 接管该 Guest；已移除连接的迟到通知忽略。Guest 收到 Host 连接消失则终止本端。 |
| `CAPABILITY / ERROR` | 整端 authority/连接故障终止会话；不迁移 Host。 |

既有未提供 connectionId 的 Transport 使用 `default` 作为该连接标识，仍进入同一成员模型和业务流程；多连接 Transport 必须提供独立认证 connectionId 并实现 recipientParticipantId 定向路由。`formatNetworkAddress` 统一显示 IPv4-mapped IPv6 地址，游戏侧不查询网卡或 Socket。

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

Balance 入口、参数与解释口径只由仓库根目录 `test.md` 定义，且仅允许项目所有者本人运行和解释。Codex、Claude、DeepSeek、任何其他 AI 或自动化流程不得运行 Balance、自博弈或卡牌价值研究实验，不得根据结果调整、试探、搜索或拟合平衡常数、权重、阈值、倍率、utility 参数及类似数值。AI 只能将这些数值作为既定规则读取和使用；正确性、回归、架构和性能验证不得扩展为数值平衡评估。

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
