/**
 * Write run-meta.json for the formal v117-1000 run.
 * Read-only git queries; no git writes.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { runDirFromEnv, runDirUrl } from "../lib/runPaths.js";

const RUN_BASE = runDirUrl(runDirFromEnv());
const RUN_DIR = RUN_BASE ?? new URL("../", import.meta.url);
const REPO_ROOT = new URL("../../../", import.meta.url);

function sha256(fileUrl) {
  return createHash("sha256").update(readFileSync(fileUrl)).digest("hex");
}

function git(args) {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function fileHash(relativePath) {
  return sha256(new URL(relativePath, RUN_DIR));
}

async function main() {
  const branch = git("branch --show-current");
  const head = git("log -1 --oneline");
  const build = "20260808-burning-field-2x-v117";
  const meta = {
    runPurpose: "Three-stage equipment AI Hold/Acquire formal study first 1000 states of fixed 2000-state manifest.",
    createdTime: new Date().toISOString(),
    branch,
    HEAD: head,
    build,
    nodeBudget: 1000,
    workers: 24,
    maxRounds: 250,
    mainJobTimeoutMs: 600000,
    slowRetryTimeoutMs: 3600000,
    compositeTarget: 1000,
    roleStateTargetPerRole: 0,
    useStateTarget: 0,
    runRoleUsePhases: false,
    cardDefinitions: "current real 25-card set (js/config/cardConfig.js, read-only)",
    corpus: {
      games: 239,
      uniqueNaturalStates: 3622,
      statesPerGame: (3622 / 239).toFixed(2)
    },
    corpusFileSha256: {
      "corpus.json": fileHash("data/corpus.json"),
      "corpus-states.jsonl": fileHash("data/corpus-states.jsonl"),
      "role-states.jsonl": fileHash("data/role-states.jsonl")
    },
    toolSha256: {
      "study.js": fileHash("study.js"),
      "lib/jobs.js": fileHash("lib/jobs.js"),
      "lib/studyRandom.js": fileHash("lib/studyRandom.js"),
      "lib/aggregate.js": fileHash("lib/aggregate.js"),
      "lib/harness.js": fileHash("lib/harness.js")
    },
    manifestSha256: {
      "manifest-2000.json": fileHash("manifest-2000.json"),
      "manifest-1000.json": fileHash("manifest-1000.json")
    },
    manifestRng: "TrackedRng(LCG) seed=0xbeef1177; deterministic Fisher-Yates over 3622 natural states; fixed once, no re-shuffle.",
    deterministicRng: [
      "TrackedRng paired for game RNG",
      "StudyRandom paired for Math.random",
      "deterministic Math.random (LCG seeded from job.seed)",
      "deterministic Date.now (fixed base + call sequence)",
      "snapshot/restore covers both random state and clock state"
    ].join("; "),
    timeoutSemantic: "600s is only the main-queue -> slow-backlog threshold; timeout jobs are NOT marked experimentDone, NOT deleted, NOT set to delta=0; slow pass resumes them with 3600s cap.",
    resumeSemantic: "Same manifest/corpus/RNG/nodeBudget/progress/pair files; completed jobs skipped via progress.experimentDone."
  };
  await writeFile(new URL("run-meta.json", RUN_DIR), JSON.stringify(meta, null, 2) + "\n", "utf8");
  console.log("run-meta.json written");
  console.log(`branch=${branch}`);
  console.log(`HEAD=${head}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
