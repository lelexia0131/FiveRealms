/**
 * Build the one-time fixed 2000-state manifest for the v117 formal study.
 *
 * Algorithm (frozen once generated; do not re-shuffle):
 *   - read natural states from ../data/corpus-states.jsonl (roleOverride == null)
 *   - deterministic Fisher-Yates over all natural states using TrackedRng
 *     (LCG, same family as the study runner) with fixed seed 0xbeef1177
 *   - take the first 2000 states as manifest-2000.json
 *   - take ordinals 1..1000 as manifest-1000.json (strict prefix)
 */
import { readFile, writeFile } from "node:fs/promises";
import { TrackedRng } from "../lib/rng.js";
import { runDirFromEnv, runDirUrl } from "../lib/runPaths.js";

const RUN_BASE = runDirUrl(runDirFromEnv());
const DATA_DIR = RUN_BASE ? new URL("data/", RUN_BASE) : new URL("../data/", import.meta.url);
const OUT_DIR = RUN_BASE ?? new URL("../", import.meta.url);
const MANIFEST_RNG_SEED = 0xbeef1177;
const MANIFEST_TOTAL = 2000;
const MANIFEST_PREFIX = 1000;

async function main() {
  const text = await readFile(new URL("corpus-states.jsonl", DATA_DIR), "utf8");
  const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const natural = records.filter((record) => record.roleOverride == null);
  if (natural.length !== 3622) throw new Error(`expected 3622 natural states, got ${natural.length}`);

  const seen = new Set();
  for (const record of natural) {
    const key = `${record.seed}:${record.turn}`;
    if (seen.has(key)) throw new Error(`duplicate natural stateId: ${key}`);
    seen.add(key);
  }

  const rng = new TrackedRng(MANIFEST_RNG_SEED);
  const indices = natural.map((_, index) => index);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const selected = indices.slice(0, MANIFEST_TOTAL).map((index) => natural[index]);
  const entries = selected.map((record, index) => ({
    ordinal: index + 1,
    stateId: `${record.seed}:${record.turn}`,
    seed: record.seed,
    turn: record.turn,
    round: record.round,
    actor: record.playerId,
    playerId: record.playerId,
    seat: record.seat,
    generalId: record.generalId,
    battleTeam: record.battleTeam,
    roleOverride: record.roleOverride ?? null,
    fingerprint: record.fingerprint
  }));

  const prefix = entries.slice(0, MANIFEST_PREFIX);
  for (let i = 0; i < MANIFEST_PREFIX; i += 1) {
    if (JSON.stringify(prefix[i]) !== JSON.stringify(entries[i])) {
      throw new Error(`manifest-1000 is not a strict prefix at index ${i}`);
    }
  }

  await writeFile(new URL("manifest-2000.json", OUT_DIR), JSON.stringify(entries, null, 2) + "\n", "utf8");
  await writeFile(new URL("manifest-1000.json", OUT_DIR), JSON.stringify(prefix, null, 2) + "\n", "utf8");

  const unique2000 = new Set(entries.map((entry) => entry.stateId));
  const unique1000 = new Set(prefix.map((entry) => entry.stateId));
  if (entries.length !== MANIFEST_TOTAL || unique2000.size !== MANIFEST_TOTAL) {
    throw new Error("manifest-2000 validation failed");
  }
  if (prefix.length !== MANIFEST_PREFIX || unique1000.size !== MANIFEST_PREFIX) {
    throw new Error("manifest-1000 validation failed");
  }

  console.log(`manifest-2000: count=${entries.length} unique=${unique2000.size} duplicates=0`);
  console.log(`manifest-1000: count=${prefix.length} unique=${unique1000.size} duplicates=0 strictPrefix=true`);
  console.log(`RNG: TrackedRng seed=0x${MANIFEST_RNG_SEED.toString(16)} Fisher-Yates over ${natural.length} natural states`);
  console.log(`first: ordinal=${entries[0].ordinal} stateId=${entries[0].stateId} turn=${entries[0].turn}`);
  console.log(`last: ordinal=${entries.at(-1).ordinal} stateId=${entries.at(-1).stateId} turn=${entries.at(-1).turn}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
