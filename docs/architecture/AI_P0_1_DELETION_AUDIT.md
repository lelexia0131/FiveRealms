# FiveRealms AI P0-1 删除候选审计

审计时间：2026-08-23T05:39:39.345Z

任务模式：ARCHITECTURE/QUALITY MODE。此文件记录大规模修改前的只读审计基线；候选不是删除许可，执行时仍须逐项迁移调用者并以测试证明语义保留。

## Baseline

- AI 生产文件：61
- AI 生产物理行：33928
- named functions / class methods：615
- 删除候选：133（最终 KPI 需要物理删除至少 100，预留 33 项审计余量）
- 统计范围：`js/ai/**/*.js`；不含测试、benchmark、匿名 callback。
- 调用者口径：对 `js/**/*.js` 做去注释/字符串后的保守标识符引用扫描；同名方法可能高估。每批执行前仍用 `rg` 核对精确 receiver/import。

## Candidate table

| Function | File | Callers before | Category | Action |
|---|---|---:|---|---|
| `createFinitePoolModel` | `js/ai/state/BeliefState.js:185` | 1 refs / 1 files<br>ai/state/BeliefState.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `copyFinitePoolModel` | `js/ai/state/BeliefState.js:229` | 12 refs / 1 files<br>ai/state/BeliefState.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `finitePoolPartitionMass` | `js/ai/state/BeliefState.js:275` | 6 refs / 1 files<br>ai/state/BeliefState.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `finitePoolPlayerCountDistribution` | `js/ai/state/BeliefState.js:330` | 6 refs / 3 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js<br>ai/state/BeliefState.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `restrictFinitePoolPlayerCounts` | `js/ai/state/BeliefState.js:381` | 6 refs / 2 files<br>ai/simulation/ResponseSimulation.js<br>ai/state/BeliefState.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `finitePoolRestrictionProbability` | `js/ai/state/BeliefState.js:417` | 1 refs / 1 files<br>ai/state/BeliefState.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `finitePoolGroupAtLeastOneProbability` | `js/ai/state/BeliefState.js:448` | 5 refs / 2 files<br>ai/domain/SealModel.js<br>ai/simulation/ResponseSimulation.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `finitePoolPlayerSlotSuccessProbability` | `js/ai/state/BeliefState.js:488` | 2 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `finitePoolOutsideSlotSuccessProbability` | `js/ai/state/BeliefState.js:522` | 0 | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `removeFinitePoolOutsideSlot` | `js/ai/state/BeliefState.js:565` | 0 | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `moveFinitePoolOutsideSlotToPlayer` | `js/ai/state/BeliefState.js:608` | 2 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `consumeFinitePoolPlayerSuccess` | `js/ai/state/BeliefState.js:659` | 3 refs / 1 files<br>ai/simulation/ResponseSimulation.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `removeFinitePoolPlayerSlot` | `js/ai/state/BeliefState.js:733` | 2 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `addFinitePoolPlayerSlot` | `js/ai/state/BeliefState.js:776` | 2 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `createDefinitionBelief` | `js/ai/state/BeliefState.js:865` | 1 refs / 1 files<br>ai/state/BeliefState.js | REPLACED_BY_CANONICAL_OWNER | MIGRATE→HiddenPool core/query/mutation; DELETE |
| `initializeBlockCountDistributions` | `js/ai/simulation/ResponseSimulation.js:85` | 2 refs / 1 files<br>ai/simulation/Simulator.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `buildInitialBlockCountDistribution` | `js/ai/simulation/ResponseSimulation.js:119` | 5 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `syncBlockSummary` | `js/ai/simulation/ResponseSimulation.js:182` | 15 refs / 3 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/CombatSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `getBlockCountBranches` | `js/ai/simulation/ResponseSimulation.js:230` | 9 refs / 3 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/CombatSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `getKnownBlockCountBranches` | `js/ai/simulation/ResponseSimulation.js:266` | 2 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `ensureBlockCountDistribution` | `js/ai/simulation/ResponseSimulation.js:321` | 1 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `initializeCounterCountDistributions` | `js/ai/simulation/ResponseSimulation.js:353` | 2 refs / 1 files<br>ai/simulation/Simulator.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `buildInitialCounterCountDistribution` | `js/ai/simulation/ResponseSimulation.js:389` | 6 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `syncCounterSummary` | `js/ai/simulation/ResponseSimulation.js:452` | 15 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `getCounterCountBranches` | `js/ai/simulation/ResponseSimulation.js:500` | 8 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `queryCounterCountBranches` | `js/ai/simulation/ResponseSimulation.js:536` | 2 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `getKnownCounterCountBranches` | `js/ai/simulation/ResponseSimulation.js:573` | 4 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `ensureCounterCountDistribution` | `js/ai/simulation/ResponseSimulation.js:628` | 3 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `clearCountersWhenHandEmpty` | `js/ai/simulation/ResponseSimulation.js:660` | 4 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `addKnownCounterToDistribution` | `js/ai/simulation/ResponseSimulation.js:697` | 5 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `addTransferredCounterCapacity` | `js/ai/simulation/ResponseSimulation.js:739` | 0 | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `removeKnownCounterFromDistribution` | `js/ai/simulation/ResponseSimulation.js:769` | 3 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `addOneUnknownCardToCounterDistribution` | `js/ai/simulation/ResponseSimulation.js:811` | 2 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `gainUnknownCardsWithCounterState` | `js/ai/simulation/ResponseSimulation.js:878` | 11 refs / 4 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/CombatSimulation.js<br>ai/simulation/SkillEffectSimulation.js<br>… | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `addKnownBlockToDistribution` | `js/ai/simulation/ResponseSimulation.js:988` | 4 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `removeKnownBlockFromDistribution` | `js/ai/simulation/ResponseSimulation.js:1030` | 3 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `addOneUnknownCardToBlockDistribution` | `js/ai/simulation/ResponseSimulation.js:1072` | 0 | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `removeUnknownCardsFromBlockDistribution` | `js/ai/simulation/ResponseSimulation.js:1139` | 2 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `removeUnknownCardsFromCounterDistribution` | `js/ai/simulation/ResponseSimulation.js:1273` | 2 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `transferUnknownBlockCapacity` | `js/ai/simulation/ResponseSimulation.js:1405` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `consumeBlockIdentities` | `js/ai/simulation/ResponseSimulation.js:1477` | 2 refs / 2 files<br>ai/simulation/CombatSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `finitePoolCounterCandidates` | `js/ai/simulation/ResponseSimulation.js:1622` | 3 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `syncCounterSummariesFromFinitePool` | `js/ai/simulation/ResponseSimulation.js:1658` | 2 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `evaluateFinitePoolCardScopeCounterResponses` | `js/ai/simulation/ResponseSimulation.js:1715` | 1 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `consumeFinitePoolCountersForCardScope` | `js/ai/simulation/ResponseSimulation.js:1847` | 1 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `consumeFinitePoolTargetCounterResponseWorlds` | `js/ai/simulation/ResponseSimulation.js:1975` | 1 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | MIGRATE callers→query/condition/mutateHiddenPool; DELETE |
| `knownDefinitionCountBranches` | `js/ai/simulation/CardEffectSimulation.js:763` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `syncCardSummariesFromFinitePool` | `js/ai/simulation/CardEffectSimulation.js:816` | 5 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `compactFinitePoolMutationOutcomes` | `js/ai/simulation/CardEffectSimulation.js:896` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `mutateFinitePoolAnonymousCard` | `js/ai/simulation/CardEffectSimulation.js:970` | 3 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `gainFinitePoolAnonymousCard` | `js/ai/simulation/CardEffectSimulation.js:1108` | 2 refs / 1 files<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `addFinitePoolIdentityToViewerHand` | `js/ai/simulation/CardEffectSimulation.js:1183` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `availableUnknownCountFor` | `js/ai/simulation/CardEffectSimulation.js:1414` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `transferUnknownCardIdentity` | `js/ai/simulation/CardEffectSimulation.js:1659` | 2 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `cardEstimateDistribution` | `js/ai/simulation/CardEffectSimulation.js:1718` | 7 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `convolve` | `js/ai/simulation/CardEffectSimulation.js:1760` | 3 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `syncCardEstimates` | `js/ai/simulation/CardEffectSimulation.js:1862` | 13 refs / 4 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/ResponseSimulation.js<br>ai/simulation/Simulator.js<br>… | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `expectation` | `js/ai/simulation/CardEffectSimulation.js:1889` | 2 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `atLeast` | `js/ai/simulation/CardEffectSimulation.js:1917` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `normalizeAssaultCountDistribution` | `js/ai/simulation/CardEffectSimulation.js:2172` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `syncAssaultSummary` | `js/ai/simulation/CardEffectSimulation.js:2254` | 12 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/CombatSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `consumeAssaultForOpportunity` | `js/ai/simulation/CardEffectSimulation.js:2294` | 3 refs / 2 files<br>ai/simulation/CardEffectSimulation.js<br>ai/simulation/Simulator.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `identitySlotStateFor` | `js/ai/simulation/CardEffectSimulation.js:2471` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `marginalizeIdentitySlotBranches` | `js/ai/simulation/CardEffectSimulation.js:2529` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `addAnonymousStolenIdentityToHand` | `js/ai/simulation/CardEffectSimulation.js:3681` | 1 refs / 1 files<br>ai/simulation/CardEffectSimulation.js | LEGACY_DUPLICATE_SPECIALIZATION | EXPRESS DRAW/REMOVE/MOVE/OBSERVE data; call HiddenPool; DELETE |
| `acceptSearchResult` | `js/ai/AiController.js:593` | 0 | DEAD_OR_TEST_ONLY_PRODUCTION_API | MIGRATE tests/diagnostics to formal owner; DELETE |
| `getSearchDiagnostics` | `js/ai/AiController.js:1079` | 0 | DEAD_OR_TEST_ONLY_PRODUCTION_API | MIGRATE tests/diagnostics to formal owner; DELETE |
| `getLastDecisionDiagnostics` | `js/ai/AiController.js:1108` | 0 | DEAD_OR_TEST_ONLY_PRODUCTION_API | MIGRATE tests/diagnostics to formal owner; DELETE |
| `getLastMainThreadOperationDiagnostics` | `js/ai/AiController.js:1142` | 0 | DEAD_OR_TEST_ONLY_PRODUCTION_API | MIGRATE tests/diagnostics to formal owner; DELETE |
| `chooseRedirectTarget` | `js/ai/AiController.js:1509` | 0 | DEAD_OR_TEST_ONLY_PRODUCTION_API | MIGRATE tests/diagnostics to formal owner; DELETE |
| `equipmentJudgmentProbability` | `js/ai/domain/LightningModel.js:208` | 0 | TEST_ONLY_PRODUCTION_API | MOVE assertion to RadarModel/public outcome; DELETE |
| `chooseTransferSource` | `js/ai/policy/CardSelectionBoundary.js:384` | 0 | DEAD | DELETE |
| `chooseTransferReceiver` | `js/ai/policy/CardSelectionBoundary.js:414` | 0 | DEAD | DELETE |
| `dynamicRootCounterDecision` | `js/ai/policy/ResponseBoundary.js:560` | 0 | DEAD_THIN_WRAPPER | CALL shouldRespond directly; DELETE |
| `expectedHandValue` | `js/ai/policy/TransferPolicy.js:433` | 0 | TEST_ONLY_PRODUCTION_API | TEST through canonical selection/evaluation; DELETE |
| `scoreTransferCombination` | `js/ai/policy/TransferPolicy.js:739` | 0 | TEST_ONLY_PRODUCTION_API | TEST through canonical selection/evaluation; DELETE |
| `searchRequestViolations` | `js/ai/search/SearchRequest.js:142` | 0 | TEST_ONLY_PRODUCTION_API | MOVE contract oracle to tests; DELETE |
| `searchResultViolations` | `js/ai/search/SearchResult.js:106` | 0 | TEST_ONLY_PRODUCTION_API | MOVE contract oracle to tests; DELETE |
| `applyHpLoss` | `js/ai/simulation/CombatSimulation.js:825` | 0 | DEAD | DELETE |
| `remainingRadarJudgmentProbabilities` | `js/ai/simulation/SimulationSupport.js:160` | 0 | DEAD_DUPLICATE | USE RadarModel; DELETE |
| `simulateAssaultAfterDamage` | `js/ai/simulation/StatusSimulation.js:749` | 0 | DEAD_THIN_WRAPPER | CALL canonical status operation directly; DELETE |
| `totalCards` | `js/ai/state/Knowledge.js:273` | 0 | DEAD | DELETE |
| `partitionAvailabilityBranches` | `js/ai/state/Probability.js:1043` | 0 | DEAD | DELETE |
| `validateRoleCardValueDeltas` | `js/ai/value/CardValue.js:371` | 0 | TEST_ONLY_OR_DIAGNOSTIC_API | MOVE validation oracle to tests/remove unused binding; DELETE |
| `cardOpportunityCost` | `js/ai/value/CardValue.js:506` | 0 | TEST_ONLY_OR_DIAGNOSTIC_API | MOVE validation oracle to tests/remove unused binding; DELETE |
| `chooseDiscards` | `js/ai/policy/ResourceSelectionPolicy.js:591` | 8 refs / 5 files<br>adapters/ai/AiChoiceAdapter.js<br>ai/AiController.js<br>ai/policy/CardSelectionPolicy.js<br>… | THIN_WRAPPER | MIGRATE callers to canonical exported policy functions; DELETE class wrapper methods |
| `chooseHandCandidate` | `js/ai/policy/ResourceSelectionPolicy.js:620` | 4 refs / 1 files<br>ai/policy/CardSelectionPolicy.js | THIN_WRAPPER | MIGRATE callers to canonical exported policy functions; DELETE class wrapper methods |
| `chooseZone` | `js/ai/policy/ResourceSelectionPolicy.js:649` | 1 refs / 1 files<br>ai/policy/CardSelectionPolicy.js | THIN_WRAPPER | MIGRATE callers to canonical exported policy functions; DELETE class wrapper methods |
| `buildCandidates` | `js/ai/policy/ResourceSelectionPolicy.js:678` | 2 refs / 2 files<br>ai/policy/CardSelectionBoundary.js<br>ai/simulation/CardEffectSimulation.js | THIN_WRAPPER | MIGRATE callers to canonical exported policy functions; DELETE class wrapper methods |
| `chooseContextual` | `js/ai/policy/ResourceSelectionPolicy.js:707` | 2 refs / 2 files<br>ai/policy/CardSelectionBoundary.js<br>ai/simulation/CardEffectSimulation.js | THIN_WRAPPER | MIGRATE callers to canonical exported policy functions; DELETE class wrapper methods |
| `peekIndex` | `js/ai/policy/CardSelectionBoundary.js:235` | 2 refs / 2 files<br>ai/policy/CardSelectionBoundary.js<br>ai/policy/CardSelectionPolicy.js | THIN_WRAPPER | MIGRATE internal callers to CardSelectionPolicy; DELETE |
| `extremeIndex` | `js/ai/policy/CardSelectionBoundary.js:264` | 1 refs / 1 files<br>ai/policy/CardSelectionBoundary.js | THIN_WRAPPER | MIGRATE internal callers to CardSelectionPolicy; DELETE |
| `expectedCardValue` | `js/ai/policy/CardSelectionBoundary.js:355` | 1 refs / 1 files<br>ai/policy/CardSelectionBoundary.js | THIN_WRAPPER | MIGRATE internal callers to CardSelectionPolicy; DELETE |
| `shouldUseGuardianAid` | `js/ai/policy/ResponseBoundary.js:473` | 1 refs / 1 files<br>ai/policy/ResponsePolicy.js | REDUNDANT_SPECIALIZATION | MIGRATE callers to shouldRespond(type/context); DELETE |
| `shouldCounterLightning` | `js/ai/policy/ResponseBoundary.js:502` | 1 refs / 1 files<br>ai/policy/ResponsePolicy.js | REDUNDANT_SPECIALIZATION | MIGRATE callers to shouldRespond(type/context); DELETE |
| `shouldCounterSeal` | `js/ai/policy/ResponseBoundary.js:531` | 1 refs / 1 files<br>ai/policy/ResponsePolicy.js | REDUNDANT_SPECIALIZATION | MIGRATE callers to shouldRespond(type/context); DELETE |
| `choose` | `js/ai/policy/TransferPolicy.js:878` | 3 refs / 2 files<br>ai/policy/CardSelectionBoundary.js<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE to chooseBestPositiveTransfer/chooseTransferHandCandidate or inline single expression; DELETE |
| `chooseHandCandidate` | `js/ai/policy/TransferPolicy.js:907` | 4 refs / 1 files<br>ai/policy/CardSelectionPolicy.js | THIN_WRAPPER | MIGRATE to chooseBestPositiveTransfer/chooseTransferHandCandidate or inline single expression; DELETE |
| `roleOrBaseCardAiValue` | `js/ai/policy/TransferPolicy.js:286` | 1 refs / 1 files<br>ai/policy/TransferPolicy.js | THIN_WRAPPER | MIGRATE to chooseBestPositiveTransfer/chooseTransferHandCandidate or inline single expression; DELETE |
| `enemyThreatGap` | `js/ai/policy/TransferPolicy.js:635` | 1 refs / 1 files<br>ai/policy/TransferPolicy.js | THIN_WRAPPER | MIGRATE to chooseBestPositiveTransfer/chooseTransferHandCandidate or inline single expression; DELETE |
| `rootSchedulingKey` | `js/ai/search/CandidateMaterializer.js:133` | 3 refs / 2 files<br>ai/search/CandidateMaterializer.js<br>ai/search/Planner.js | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `schedulingSecondaryKey` | `js/ai/search/CandidateMaterializer.js:162` | 2 refs / 1 files<br>ai/search/Planner.js | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `childSchedulingScore` | `js/ai/search/CandidateMaterializer.js:191` | 1 refs / 1 files<br>ai/search/Planner.js | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `childSchedulingKey` | `js/ai/search/CandidateMaterializer.js:220` | 2 refs / 1 files<br>ai/search/Planner.js | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `createContext` | `js/ai/search/CandidateMaterializer.js:249` | 2 refs / 2 files<br>ai/search/CandidateMaterializer.js<br>ai/search/Planner.js | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `observeCandidate` | `js/ai/search/CandidateMaterializer.js:278` | 2 refs / 2 files<br>ai/search/CandidateMaterializer.js<br>ai/search/Planner.js | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `describeAction` | `js/ai/search/CandidateMaterializer.js:537` | 27 refs / 6 files<br>adapters/ai/worker/WorkerSearchRuntime.js<br>ai/search/ActionDescriptor.js<br>ai/search/CandidateMaterializer.js<br>… | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `findTerminalAction` | `js/ai/search/CandidateMaterializer.js:566` | 8 refs / 1 files<br>ai/search/Planner.js | THIN_WRAPPER | MIGRATE Planner to canonical ActionDescriptor/SearchPrior/Counterfactual/Sibling owners; DELETE |
| `resolveRuleTargets` | `js/ai/search/ActionGenerator.js:182` | 6 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `projectPlayers` | `js/ai/search/ActionGenerator.js:211` | 5 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `projectTransferPlayers` | `js/ai/search/ActionGenerator.js:240` | 2 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `getCardTargetsFromRule` | `js/ai/search/ActionGenerator.js:269` | 6 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `getAssaultTargetsFromRule` | `js/ai/search/ActionGenerator.js:300` | 2 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `getLeverageFirstTargetsFromRule` | `js/ai/search/ActionGenerator.js:331` | 2 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `getTransferSourcesFromRule` | `js/ai/search/ActionGenerator.js:362` | 3 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `getTransferReceiversFromRule` | `js/ai/search/ActionGenerator.js:394` | 2 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `getSkillTargetsFromRule` | `js/ai/search/ActionGenerator.js:427` | 7 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `checkpointProbabilityPreparation` | `js/ai/search/ActionGenerator.js:1061` | 11 refs / 1 files<br>ai/search/ActionGenerator.js | THIN_WRAPPER | MIGRATE internal calls to RuleProjection/Rule APIs/SearchBudget; DELETE |
| `mergeProbabilityBranches` | `js/ai/state/Probability.js:407` | 4 refs / 1 files<br>ai/state/Probability.js | DUPLICATE_THIN_WRAPPER | MIGRATE to one optional-checkpoint canonical operation; DELETE |
| `mergeProbabilityStateBranches` | `js/ai/state/Probability.js:544` | 8 refs / 3 files<br>ai/domain/LightningModel.js<br>ai/domain/SealModel.js<br>ai/state/Probability.js | DUPLICATE_THIN_WRAPPER | MIGRATE to one optional-checkpoint canonical operation; DELETE |
| `joinProbabilityStateBranches` | `js/ai/state/Probability.js:667` | 5 refs / 2 files<br>ai/domain/SealModel.js<br>ai/simulation/ResponseSimulation.js | DUPLICATE_THIN_WRAPPER | MIGRATE to one optional-checkpoint canonical operation; DELETE |
| `projectProbabilityStateBranches` | `js/ai/state/Probability.js:725` | 0 | DUPLICATE_THIN_WRAPPER | MIGRATE to one optional-checkpoint canonical operation; DELETE |
| `clampProbability` | `js/ai/simulation/SimulationSupport.js:216` | 74 refs / 13 files<br>ai/domain/LightningModel.js<br>ai/domain/RadarModel.js<br>ai/domain/SealModel.js<br>… | SAME_SEMANTICS_AS_ANOTHER_FUNCTION | USE state/Probability.clampProbability; DELETE |
| `equipmentConditionKey` | `js/ai/state/DistanceProbabilityBranches.js:108` | 2 refs / 1 files<br>ai/state/DistanceProbabilityBranches.js | SAME_SEMANTICS_AS_ANOTHER_FUNCTION | USE state/Probability.equipmentConditionKey(player.id,...); DELETE |
| `actionEconomicValue` | `js/ai/value/Economics.js:80` | 2 refs / 1 files<br>ai/search/TransitionValue.js | LEGACY_ZERO_FUNCTION | REMOVE zero term and binding; DELETE |
| `observeClone` | `js/ai/search/SearchBudget.js:632` | 2 refs / 1 files<br>ai/simulation/Simulator.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |
| `observeResponseBranches` | `js/ai/search/SearchBudget.js:865` | 6 refs / 1 files<br>ai/simulation/ResponseSimulation.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |
| `observeCounterfactual` | `js/ai/search/SearchBudget.js:895` | 2 refs / 1 files<br>ai/search/CounterfactualTerms.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |
| `observeYield` | `js/ai/search/SearchBudget.js:974` | 2 refs / 1 files<br>ai/search/Planner.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |
| `observeRootCandidateStarted` | `js/ai/search/SearchBudget.js:832` | 3 refs / 1 files<br>ai/search/Planner.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |
| `observeActionGeneration` | `js/ai/search/SearchBudget.js:929` | 2 refs / 1 files<br>ai/search/ActionGenerator.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |
| `observeSimulation` | `js/ai/search/SearchBudget.js:600` | 10 refs / 2 files<br>ai/search/CounterfactualTerms.js<br>ai/search/Planner.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |
| `observeNode` | `js/ai/search/SearchBudget.js:561` | 4 refs / 1 files<br>ai/search/Planner.js | REDUNDANT_SPECIALIZATION | MIGRATE to one canonical work-observation method/data event; DELETE |

## 执行约束

- 默认动作：找到全部 caller → 迁到 canonical owner → 物理删除旧函数；不保留 compat/adapter/fallback。
- 如果候选在精确 receiver 审计中仍有独立必要生产语义，从执行清单撤回，并从 33 项余量或继续全域审计中补足。
- Function count 以本文件 baseline 清单与最终同口径清单按 `file + name + signature` 复核；改名、搬移、method→arrow、匿名 callback 不计删除。
- HiddenPool 新算法核心函数最多 8 个；其它删除不得靠制造超大函数或改变 Planner/游戏行为完成。

