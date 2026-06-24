// Open positions persist to positions.json so a restart resumes safely.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const FILE = "./positions.json";

export const load = () => {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {}; // corrupted file -> start clean instead of crashing
  }
};

export const save = (p) => {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2)); // write-then-rename = no half-written file
  renameSync(tmp, FILE);
};
