import { execFileSync } from "node:child_process";

const sources = new Map([
  ["/js/core/Game.js", "js/core/Game.js"],
  ["/js/core/Deck.js", "js/core/Deck.js"],
  ["/js/cards/cardRegistry.js", "js/cards/cardRegistry.js"]
]);

export async function load(url, context, nextLoad) {
  const path = new URL(url).pathname.replaceAll("\\", "/");
  const match = [...sources.entries()].find(([suffix]) => path.endsWith(suffix));
  if (!match) return nextLoad(url, context);
  return {
    format:"module",
    shortCircuit:true,
    source:execFileSync("git", ["show", `HEAD:${match[1]}`], { encoding:"utf8" })
  };
}
