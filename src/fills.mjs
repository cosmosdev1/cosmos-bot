// SHARED FILL PARSING. The Stage 4 denominator must count the SAME semantic unit the numerator
// counts, so the runner and chainwatch must agree exactly on what a fill is. Rather than
// reimplementing the parse in two places and hoping they stay identical, both import this.
//
// WHY THE IDENTITY IS txHash#logIndex#itemIndex:
//   * wallet|token|block was REJECTED on evidence - measured against one heavily-followed wallet
//     over ~1h of chain history it merged 4 of 74 fills (5.4%), because two separate orders ~1s
//     apart land in the same 2s Polygon block. A denominator that merges legitimate fills
//     understates fan-out, which is the direction that would make Stage 4 look successful falsely.
//   * txHash#logIndex is unique per LOG, but one TransferBatch log carries N token entries and
//     chainwatch fires onFill - and therefore one copy-check - for EACH of them. So it is unique at
//     the chain level and wrong at the work level.
//   * itemIndex is the position within this log's parsed entries. ERC-1155 permits the same token id
//     to appear twice in one batch, so the index is used rather than the token id.
// Every component comes from immutable chain data, so the identity is stable across retries,
// reconnects and restarts - the same property that makes chainwatch's `done` set correct.

export const T_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
export const T_BATCH  = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

const words = (hex) => (String(hex ?? "").replace(/^0x/, "").match(/.{64}/g) ?? []);

/**
 * Parse the token/share entries a log carries. TransferSingle yields one; TransferBatch yields N.
 * Returns [] for anything unparseable - a metric must never throw into a caller.
 */
export function tokensFromLog(l) {
  try {
    const w = words(l?.data);
    const t0 = l?.topics?.[0];
    if (t0 === T_SINGLE) {
      if (w.length < 2) return [];
      return [{ tokenId: BigInt("0x" + w[0]).toString(), shares: Number(BigInt("0x" + w[1])) / 1e6 }];
    }
    if (t0 === T_BATCH) {
      const idsAt = Number(BigInt("0x" + w[0])) / 32;
      const valsAt = Number(BigInt("0x" + w[1])) / 32;
      const n = Number(BigInt("0x" + w[idsAt]));
      if (!Number.isFinite(n) || n < 0 || n > 1024) return [];   // bound it: a malformed length must not allocate
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push({
          tokenId: BigInt("0x" + w[idsAt + 1 + i]).toString(),
          shares: Number(BigInt("0x" + w[valsAt + 1 + i])) / 1e6,
        });
      }
      return out;
    }
  } catch { /* fall through */ }
  return [];
}

const addrFromTopic = (t) => "0x" + String(t ?? "").slice(-40).toLowerCase();

/**
 * The identities of the QUALIFYING fills in a log - exactly the set for which chainwatch would fire
 * onFill, and therefore exactly the set that produces copy-checks.
 *
 * `isWatched(addr)` must answer whether an address is one of the wallets this box follows. The two
 * filters mirror chainwatch's handle(): the recipient must be watched, and a transfer BETWEEN two
 * watched wallets is a shuffle rather than a new position.
 */
export function qualifyingFillIds(l, isWatched) {
  try {
    const to = addrFromTopic(l?.topics?.[3]);
    if (!isWatched(to)) return [];
    const from = addrFromTopic(l?.topics?.[2]);
    if (isWatched(from)) return [];                        // whale-to-whale shuffle, not a new position
    const tx = String(l?.transactionHash ?? "");
    const li = String(l?.logIndex ?? "");
    if (!tx || li === "") return [];
    const out = [];
    const entries = tokensFromLog(l);
    for (let i = 0; i < entries.length; i++) {
      if (!(entries[i].shares > 0)) continue;              // zero-share entries fire no onFill
      out.push(`${tx}#${li}#${i}`);
    }
    return out;
  } catch { return []; }
}


/**
 * STAGE 4: the fills in a log as the hub needs them - id, whale (recipient), token, shares - using
 * the SAME index rule as qualifyingFillIds so hub and child derive identical ids.
 */
export function fillsFromLog(l, isWatched) {
  try {
    const to = addrFromTopic(l?.topics?.[3]);
    if (!isWatched(to)) return [];
    const from = addrFromTopic(l?.topics?.[2]);
    if (isWatched(from)) return [];
    const tx = String(l?.transactionHash ?? ""), li = String(l?.logIndex ?? "");
    if (!tx || li === "") return [];
    const block = Number(l?.blockNumber);
    const entries = tokensFromLog(l), out = [];
    for (let i = 0; i < entries.length; i++) {
      if (!(entries[i].shares > 0)) continue;
      out.push({ fillId: `${tx}#${li}#${i}`, wallet: to, tokenId: entries[i].tokenId, shares: entries[i].shares, block: Number.isFinite(block) ? block : null });
    }
    return out;
  } catch { return []; }
}
