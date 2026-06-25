// Open positions persist to positions.json so a restart resumes safely.
// Evaluated markets persist to seen.json so each market is bought at most once.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const POS = "./positions.json";
const SEEN = "./seen.json";

function read(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback; // corrupted file -> start clean instead of crashing
  }
}

function write(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2)); // write-then-rename = no half-written file
  renameSync(tmp, file);
}

export const load = () => read(POS, {});
export const save = (p) => write(POS, p);

// Markets already evaluated for entry (condition_id -> ISO time). A market is
// bought at most once, when it is newly added to the feed.
export const loadSeen = () => read(SEEN, {});
export const saveSeen = (s) => write(SEEN, s);
