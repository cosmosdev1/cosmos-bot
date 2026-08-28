// RUNNER ADMISSION CAP - how many bot children one box may run. Pure and side-effect free so the
// platform's test can import it without starting a runner.
//
// The cap is the MINIMUM of a memory term and a CPU term. Two failures bracket this file: the
// 2026-08-05 OOM (cap too generous) and the 2026-08-11 starvation (cap too stingy, 60 runnable vs
// 48 slots, ~$1,050 of accounts silently unmanaged). Both came from a single hand-tuned constant.
//
// Measured 2026-08-28 on cosmos-hosted-runner (2 dedicated CPUs, 15.62 GB, 106 children), three
// samples across two market regimes - see docs/stage2f-frozen.md in the platform repo:
//   memory  PSS/child mean 77.9 MB stable across samples, p95 91.2, max 95.2, mean+2sd 98.1;
//           base (OS + runner) 600-639 MB. Per-child memory rises ~19% from cold start to plateau.
//   cpu     mean/child 0.447% of one core in a quiet window, 0.556% in a busier one (+24% in 2h);
//           steal 0.32% - CPU is NOT the binding resource on dedicated cores, memory is.
//
// Budgets are deliberately the distribution's TAIL, not its mean, plus explicit headroom:
//   MEM_PER_CHILD_MB  98    mean+2sd. The previous 55 was tuned from one reading taken 16 minutes
//                           after a restart, before memory had settled, and implied 22 GB at its own
//                           cap of 279 on a 15.6 GB box.
//   BASE_MB           700   measured 600-639, rounded up.
//   MEM_HEADROOM      0.85  15% of RAM left free for the spawn ramp (every restart re-runs it),
//                           position-heavy children, and measurement uncertainty across regimes.
//   CPU_PER_CHILD     0.011 cores - about 2x the busiest measured mean, because CPU/child moved
//                           24% between two samples two hours apart and regimes vary more than that.
//   CPU_TARGET        0.70  sustained box utilisation.
// Every one is env-tunable so a re-measurement never needs a code change.
export const DEFAULTS = Object.freeze({
  MEM_PER_CHILD_MB: 98,
  BASE_MB: 700,
  MEM_HEADROOM: 0.85,
  CPU_PER_CHILD: 0.011,
  CPU_TARGET: 0.70,
  FLOOR: 4,
});

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; }

export function deriveCap({ totalMemMB, nproc, env = {} }) {
  const memPerChild = num(env.RUNNER_MEM_PER_CHILD_MB, DEFAULTS.MEM_PER_CHILD_MB);
  const base = num(env.RUNNER_BASE_MB, DEFAULTS.BASE_MB);
  const headroom = Math.min(1, num(env.RUNNER_MEM_HEADROOM, DEFAULTS.MEM_HEADROOM));
  const cpuPerChild = num(env.RUNNER_CPU_PER_CHILD, DEFAULTS.CPU_PER_CHILD);
  const cpuTarget = Math.min(1, num(env.RUNNER_CPU_TARGET, DEFAULTS.CPU_TARGET));
  const memCap = Math.floor((totalMemMB * headroom - base) / memPerChild);
  const cpuCap = Math.floor((nproc * cpuTarget) / cpuPerChild);
  const derived = Math.max(DEFAULTS.FLOOR, Math.min(memCap, cpuCap));
  const override = num(env.RUNNER_MAX, 0);
  const cap = override || derived;
  return {
    cap, derived, memCap, cpuCap, binding: memCap <= cpuCap ? "memory" : "cpu", override: Boolean(override),
    detail: `${cap} = ${override ? `RUNNER_MAX override (derived ${derived})` : `min(mem ${memCap}, cpu ${cpuCap})`}`
      + ` · ${Math.round(totalMemMB)}MB x${headroom} - ${base} base @${memPerChild}MB/child`
      + ` · ${nproc} cpus x${cpuTarget} @${cpuPerChild} cores/child`,
  };
}
