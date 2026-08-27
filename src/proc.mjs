// Pure /proc parsing. Kept in its own module with NO side effects so it can be imported by tests -
// runner.mjs validates RUNNER_SECRET and starts timers at import time, so importing it from a test
// exits the process.

// /proc/<pid>/stat: field 4 is ppid, field 22 is starttime. Field 2 (comm) is the executable name in
// parentheses and may itself contain spaces or ')', so splitting the whole line on whitespace picks
// the wrong fields for any process whose name is unusual. Everything after the LAST ')' is
// fixed-position, which is the documented way to parse this file.
// Returns null on anything it cannot parse with confidence - the caller treats null as "do not act".
export function parseProcStat(stat) {
  const s = String(stat ?? "");
  const close = s.lastIndexOf(")");
  if (close < 0) return null;
  const tail = s.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(tail[1]);                    // tail[0] = state, tail[1] = ppid
  const startTicks = Number(tail[19]);             // overall field 22
  if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) return null;
  return { ppid, startTimeS: startTicks / 100 };   // USER_HZ is 100 on Linux/x86
}
