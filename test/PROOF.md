# Delayed-placement fix: adversarial proof (2026-09-03)

Branch `phase3b/delayed-fill`, commit d9e24e6 on top of origin/main 4d5918b. Files: `src/polymarket.mjs`
(+183 lines, one existing branch rewired), `test/delayed-fill.test.mjs` (14 cases). Not deployed.

## The defect, reproduced on the unfixed parser

origin/main `extractFill()` applied to the venue's documented delayed answer
(`status:"delayed"`, `orderID` set, `makingAmount:""`, `takingAmount:""`):

```
old extractFill(delayed answer) -> {"shares":0}
=> "FAK killed: nothing filled" (ok:false, size 0) -> placeWithRetry: definitelyNothing -> exposure released
```

Venue-verified consequence (data-api activity, 7 days): 328 of 336 such "kills" were real fills,
$1,906.28 unbooked across 22 accounts (see `../../recon-ledger.json`).

## Hard invariant

After a venue order enters `delayed`, it is unresolved execution state. It is never converted to a
zero-fill, and the same (token, side) cannot issue another order until the venue record is terminal
or the placement is classified ambiguous. Implemented by `settlePlacement()` + `delayedLockFor()`;
asserted by the "hard invariant" test over four never-resolving venue scripts.

## Adversarial cases -> tests

| case | test | verdict / behaviour |
|---|---|---|
| delayed -> full fill | case 1 | booked 9.6 sh @ 75c from the venue's trades, not 10 @ 80c requested; lock released |
| delayed -> partial fill | case 2, 2b | matched part only, average over the partial's trades; partial-at-deadline is final |
| delayed -> genuine terminal kill | case 3 | CANCELED with 0 matched is the only route to `{shares:0}`; lock released |
| delayed -> record disappears | case 4 | ambiguous, `fill_unknown`, polled through the whole window, BUY lock held 5 min then expires |
| delayed -> order-record API timeout | case 5, 5b | every read bounded (2.5 s live, 40 ms in test); loop ends at its deadline; transient errors skipped |
| process restart while unresolved | not testable in-process; see residual below |
| repeated polling cannot double-book | case 7 | one verdict, one fill object, trades fetched once per trade id, loop stops at first terminal record |
| same opportunity cannot re-fire | case 8 | pending lock on (token, side) while unresolved; opposite side and other tokens free; BUY refused for the hold after ambiguous |
| booked from venue truth | case 9 | trades win; trades that do not reconcile with size_matched fall back to the record, flagged `delayed_price_source:"limit"` |
| SELL parser | case 10 | delayed SELL books from the record; an immediate SELL answer is byte-identical to extractFill's reading and never touches the record |

Old-tree proof: the same suite against origin/main fails at import (no `settlePlacement`); the
defect reproduction above is the behavioural half.

## Wiring review (money path, by eye + `node --check`)

- `attempt()` in `placeOrder`: `settlePlacement({ resp, side, size, priceCents, client: c, tokenId })`
  replaces the bare `extractFill` read. `c`, `meta`, `resp`, `tokenId` are in scope (same closure).
- Ambiguous verdict returns `ok:false, status:409, meta.fill_unknown:true, size:0`. In
  `placeWithRetry`, `definitelyNothing` requires `fill_unknown !== true`, so the platform is NOT told
  "zero" and keeps counting the exposure until CLOUD_OUTCOME_TTL_MS (fail-closed against the 7% cap).
  It carries no `rejected:true`, so the affiliate fallback cannot re-post; its error text does not
  match DEPOSIT_ERR, so the POLY_1271 recovery cannot re-post.
- Filled/killed verdicts flow into the unchanged branches (kill -> existing "FAK killed" 400 path;
  fill -> `meta.size/price`, `riskRecordBuy`, balance-cache invalidation, `ok:true`).
- The (token, side) lock check sits at the top of `placeOrder`, before any signing: a refused re-post
  returns `cloudDefinitive:true, cloudCode:"delayed_inflight"`; `closeOutCloudOrder` is a no-op because
  nothing was signed in that sign context. SELLs are refused only while their own delayed sell is
  pending, so exits keep flowing.
- Immediate answers (`matched`/`live`/`unmatched`, or readable amounts) take the `immediate` kind and
  are parsed exactly as before: candles and pregame orders are unaffected.

## Residual: process restart while a delayed order is unresolved

The wait is at most 12 s (COPY_DELAYED_POLL_MS) and the lock is in-memory. A restart inside that window
leaves the order at the venue with nothing booked and `seen` (buy-once, persisted only on ok:true)
unset. The next cycle's position store shows the venue position (HOLDING_RESOLVED -> top-up logic, not a
fresh entry), so the exposure is one cycle (~30 s) for a token whose delayed order was in flight at the
restart instant. Expected frequency at the v1 in-play rate (~45 delayed orders/day, 12 s each) is about
0.6% per fleet restart. Backstop: the read-only reconciliation ledger (`recon-ledger.mjs`) detects any
such fill. Closing this fully needs a persisted "unresolved order" record and a startup sweep; not in
this change.

## Live proof still required before clock_v2 is re-run

`delayed -> terminal venue state -> exactly one booked position`, on natural in-play top-ups after
deployment: cloud_orders rows with `meta.delayed_state` starting `terminal:` and `filled_size_usd > 0`,
each with exactly one venue trade and one copy_trades row.

## Recommendation

Full-fleet deployment (a bot push; the runner pulls within 600 s and restarts every child). The unfixed
parser is the unsafe state: it is booking nothing for every in-play top-up under v1 today.
