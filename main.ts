// Pump.fun Replay Sprint — early-launch sniper with fast exits.
//
// The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout through the
// vendored shim (vendor/makefun-bot.ts). The harness opens with a `hello`
// message (capital, caps, fees, latency in slots), then sends one `batch` per
// slot, and the bot answers each batch with exactly one reply carrying its
// `orders` for that slot. Orders decided on the batch for slot s fill at
// s + latency_slots. A reply may hold at most hello.caps.max_orders_per_batch
// orders, and buys on one mint in one reply share one size cap
// (state.maxBuyLamports). The bot is deterministic: no clock, no randomness,
// no network, no unordered iteration — two runs on the same data produce the
// same action log.
//
// Strategy, in one paragraph: watch every coin from its CreateEvent and read
// its opening tape in the first three slots after creation. Buy only a launch
// that looks un-bundled and already has momentum — the creator's own buys are
// small, at most one other wallet has bought, the creator has not sold, the
// curve already holds at least 1 real SOL, and the price has run up at least
// 5% over its create price — and stake 0.02 SOL on it. Then exit fast: sell
// everything on a +15% take-profit, a -20% stop-loss, thirty slots held, or
// the moment the creator sells. One buy per coin, never more; the harness closes a position
// itself when its curve completes, and flattens whatever is left when the
// replay ends.
//
// Exits are priced off the curve's virtual reserves: selling `tokens` against
// (virtual_token_reserves, virtual_quote_reserves) pays
// tokens*vq/(vt+tokens) less the 95 + 30 bps curve fees, less one tx fee.
// That value is compared with the position's cost_lamports (SOL spent, fees
// included), which the harness reports in the account each batch.

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL staked on each launch that passes the filter. */
const STAKE_LAMPORTS = 20_000_000n; // 0.02 SOL
/** A buy smaller than this is not worth its tx fee. */
const MIN_BUY_LAMPORTS = 2_000_000n; // 0.002 SOL
/** Youngest and oldest age (slots since the CreateEvent) at which a first buy may be decided. */
const MAX_AGE_SLOTS = 3;
/** Real SOL the curve must hold before a buy is decided. */
const MIN_REAL_SOL_LAMPORTS = 1_000_000_000n; // 1 SOL
/** The creator's own buys must total no more than this: a big creator buy smells bundled. */
const MAX_CREATOR_BUY_LAMPORTS = 500_000_000n; // 0.5 SOL
/** Distinct non-creator buyers seen before entry, at most: a launch bundled by many wallets is a dump in waiting. */
const MAX_OTHER_BUYERS = 1;
/** The price must already have run up this far over its create price before a buy is decided (bps): buy strength, not just any launch. */
const MIN_RUNUP_BPS = 500n; // +5%
/** Exit when the position is worth this much over its cost (bps). */
const TAKE_PROFIT_BPS = 1_500n; // +15%
/** Exit when it is worth this much under its cost (bps). */
const STOP_LOSS_BPS = -2_000n; // -20%
/** Exit after holding this many slots. */
const MAX_HOLD_SLOTS = 30;
/** Slippage allowed on every order (bps): wide open, so an exit is never refused for the price moving in the latency. */
const SLIPPAGE_BPS = 10_000;
/** Curve fees on a sell, protocol + creator (95 + 30 bps). */
const SELL_FEE_BPS = 125n;
const BPS_DENOM = 10_000n;

// ------------------------------------------------------------------ state

/** What the opening tape says about one coin. */
interface CoinTape {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number;
  /** Create-time virtual reserves: the price run-up is measured against them. */
  createVq: bigint;
  createVt: bigint;
  creatorBuyLamports: bigint;
  otherBuyers: Set<Pubkey>;
  creatorSold: boolean;
  /** Decided for good: bought, dropped, or too old to snipe. */
  decided: boolean;
}

/** A position we hold, with the slot its buy filled at. */
interface Held {
  openedSlot: number;
}

const tapes = new Map<Pubkey, CoinTape>();
const held = new Map<Pubkey, Held>();

/** What selling `tokens` against the curve's virtual reserves (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * SELL_FEE_BPS + BPS_DENOM - 1n) / BPS_DENOM;
}

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const txFee = state.txFeeLamports();
    const { caps } = state.hello;
    const orders: OrderInput[] = [];

    // 1. Fold this batch's fills into our held book: a filled buy opens a
    // position (at the slot it filled), any sell — ours or the harness's
    // close of a completed curve — ends it.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        held.set(fill.mint, { openedSlot: fill.slot });
      } else if (fill.side === 'sell') {
        held.delete(fill.mint);
      }
    }
    // Drop book entries the harness already flattened or wrote off.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // 2. Read this batch's events into the opening tapes, in chain order.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        tapes.set(event.mint, {
          mint: event.mint,
          creator: event.creator,
          createdSlot: event.slot,
          createVq: BigInt(event.virtual_sol_reserves),
          createVt: BigInt(event.virtual_token_reserves),
          creatorBuyLamports: 0n,
          otherBuyers: new Set<Pubkey>(),
          creatorSold: false,
          decided: false,
        });
      } else if (event.event === 'TradeEvent') {
        const tape = tapes.get(event.mint);
        if (tape === undefined) continue;
        if (event.user === tape.creator) {
          if (event.is_buy) tape.creatorBuyLamports += BigInt(event.sol_amount);
          else tape.creatorSold = true;
        } else if (event.is_buy) {
          tape.otherBuyers.add(event.user);
        }
      } else if (event.event === 'CompleteEvent') {
        tapes.delete(event.mint);
      }
    }

    // 3. Exits first: every held position is checked against take-profit,
    // stop-loss, max hold and creator-sold, and sold whole when any fires.
    // A sell already in flight is not sent twice.
    const selling = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') selling.add(pending.order.mint);
    }
    for (const [mint, position] of state.positions) {
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const entry = held.get(mint);
      const tape = tapes.get(mint);
      const value = sellValue(position.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - txFee;
      let exit = false;
      if (position.cost_lamports > 0n) {
        const pnlBps = ((value - position.cost_lamports) * BPS_DENOM) / position.cost_lamports;
        if (pnlBps >= TAKE_PROFIT_BPS || pnlBps <= STOP_LOSS_BPS) exit = true;
      }
      if (entry !== undefined && batch.slot - entry.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (tape !== undefined && tape.creatorSold) exit = true;
      if (!exit) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({
        side: 'sell',
        mint,
        token_amount: position.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      selling.add(mint);
    }

    // 4. Entries: coins still undecided, in the order their events arrived
    // this batch. A coin is decided once, on the first batch inside its
    // three-slot window where the curve holds at least 1 real SOL; past
    // the window it is dropped for good.
    const pendingBuys = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy') pendingBuys.add(pending.order.mint);
    }
    let free = state.freeCashLamports();
    for (const event of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const tape = tapes.get(event.mint);
      if (tape === undefined || tape.decided) continue;
      const age = batch.slot - tape.createdSlot;
      if (age > MAX_AGE_SLOTS) {
        tape.decided = true;
        continue;
      }
      const curve = state.curves.get(event.mint);
      if (curve === undefined || curve.complete) {
        tape.decided = true;
        continue;
      }
      if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
      // Buy strength: the price must already sit at least MIN_RUNUP_BPS
      // above its create price — a launch nobody is bidding up is not a snipe.
      if (tape.createVq > 0n && tape.createVt > 0n && curve.virtual_quote_reserves > 0n && curve.virtual_token_reserves > 0n) {
        const runupBps =
          ((curve.virtual_quote_reserves * tape.createVt * BPS_DENOM) / (curve.virtual_token_reserves * tape.createVq)) - BPS_DENOM;
        if (runupBps < MIN_RUNUP_BPS) continue;
      }
      if (tape.creatorBuyLamports > MAX_CREATOR_BUY_LAMPORTS) {
        tape.decided = true;
        continue;
      }
      if (tape.otherBuyers.size > MAX_OTHER_BUYERS || tape.creatorSold) {
        tape.decided = true;
        continue;
      }
      const cap = state.maxBuyLamports(event.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (pendingBuys.has(event.mint)) {
        tape.decided = true;
        continue;
      }
      if (state.committedPositionCount() >= caps.max_open_positions) break;
      if (free < amount + txFee) break;
      orders.push({
        side: 'buy',
        mint: event.mint,
        quote_lamports: amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      tape.decided = true;
      pendingBuys.add(event.mint);
      free -= amount + txFee;
    }

    return orders;
  },
});
