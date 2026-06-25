// Open positions persist to positions.json so a restart resumes safely.
// Evaluated markets persist to seen.json so each market is bought at most once.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";

// On a cloud host the working dir is ephemeral (wiped on every redeploy), which would orphan
// open positions. Point COSMOS_DATA_DIR at a mounted persistent disk (e.g. /data on Render) so
// state survives restarts. Defaults to the current dir for local installs.
const DIR = (process.env.COSMOS_DATA_DIR || ".").replace(/\/$/, "");
if (DIR !== ".") { try { mkdirSync(DIR, { recursive: true }); } catch { /* exists or unwritable */ } }
const POS = `${DIR}/positions.json`;
const SEEN = `${DIR}/seen.json`;

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
