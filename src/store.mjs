// Open positions persist to positions.json so a restart resumes safely.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FILE = "./positions.json";
export const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
export const save = (p) => writeFileSync(FILE, JSON.stringify(p, null, 2));
