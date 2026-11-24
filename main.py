"""Early-launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).

The harness speaks a newline-delimited JSON protocol on stdin/stdout. It opens
with one ``hello`` message (protocol id, seed, universe, capital, caps, latency
in slots, fees), then sends one ``batch`` per slot: the slot number, that slot's
events (CreateEvent / TradeEvent / CompleteEvent), marks with the latest
reserves of the curves we hold or have pending, the fills of our earlier
orders, and the account (cash + positions). For every batch we must answer
with exactly one reply that echoes the batch's ``seq`` and carries our
``orders`` for that slot (at most ``caps.max_orders_per_batch``). Orders
decided on a batch fill two slots later (``latency_slots``), so every decision
is made on the reserves the batch shows and lands on the reserves two slots
on. When the data ends the harness sends ``done`` and we stop.

Strategy (chosen on the kit's dev window; every pilot family loses a little
there, this one loses the least, about -0.07 SOL):

* Entry: buy a new coin on the batch that carries its CreateEvent, or within
  the next three slots, but only when the launch looks un-bundled and
  un-front-run: the creator's own buys in the create slot are at most 1 SOL,
  at most one distinct non-creator buyer has appeared, the creator has not
  sold, and the curve already holds at least 1 real SOL (so the 1%-of-real-
  reserve size cap lets us buy a meaningful 0.01-0.02 SOL in one order).
  One buy per coin, no adds: adding to a position never paid on the dev
  window. Stake is 0.02 SOL per coin, at most five open positions.
* Exit: sell the whole position on the first of a +15% take-profit, a -20%
  stop-loss, thirty slots held, or the creator selling while we hold. A
  fixed take-profit beats a trailing stop here: most coins peak only a few
  percent above entry and then decay, so banking the small wins and cutting
  losers fast loses the least; the winners that do run are still banked at
  +15%. The replay closes a position itself when its curve completes and
  flattens everything left at the end, so we never need to chase the close.
* Fees: every trade pays 95 bps protocol + 30 bps creator (1.25%) plus a
  105,000-lamport transaction fee, so a round trip needs roughly +3% just to
  break even; that is why the stake is never smaller than 0.01 SOL (a
  smaller buy would be eaten by the fixed transaction fee) and why we only
  trade when the size cap allows at least that much.

Determinism: the bot is a pure function of the batch stream. No clock, no
randomness, no network, no environment reads; iteration is only over
insertion-ordered dicts, and all money math is integer lamports, so two runs
on the same data produce byte-identical action logs.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bot  # noqa: E402  (after the sys.path line: -P leaves the script directory off sys.path)

LAMPORTS_PER_SOL = makefun_bot.LAMPORTS_PER_SOL

# --- strategy parameters (lamports unless noted) ---
STAKE_LAMPORTS = 20_000_000          # 0.02 SOL per coin at most
MIN_BUY_LAMPORTS = 10_000_000        # 0.01 SOL: smallest buy worth the tx fee; also the guardrail round-trip floor
MAX_AGE_SLOTS = 3                    # buy only within 3 slots of the CreateEvent
MAX_DEV_BUY_LAMPORTS = 1_000_000_000  # creator's own buys in the create slot, at most 1 SOL
MAX_OTHER_BUYERS = 1                 # at most one distinct non-creator buyer seen
MIN_REAL_SOL_LAMPORTS = 1_000_000_000  # curve must hold >= 1 real SOL (size cap then allows >= 0.01 SOL)
TAKE_PROFIT_BPS = 1500               # sell all at +15% over cost
STOP_LOSS_BPS = 2000                 # sell all at -20% under cost
MAX_HOLD_SLOTS = 30                  # sell all after 30 slots held
MAX_SLIPPAGE_BPS = 10_000            # wide open: a fill two slots late must still land
CURVE_FEE_BPS = 125                  # protocol 95 bps + creator 30 bps


def sell_value_lamports(tokens, vq, vt, tx_fee):
    """What selling `tokens` against reserves (vq, vt) pays, after curve fees and one tx fee."""
    if tokens <= 0 or vt <= 0:
        return 0
    quote = (tokens * vq) // (vt + tokens)
    fee = (quote * CURVE_FEE_BPS + 9999) // 10000
    return quote - fee - tx_fee


class Coin:
    """What we know about one curve, from its CreateEvent and trades so far."""

    __slots__ = ("mint", "created_slot", "creator", "dev_buy", "buyers", "dev_sold", "dead", "decided")

    def __init__(self, mint, created_slot, creator):
        self.mint = mint
        self.created_slot = created_slot
        self.creator = creator
        self.dev_buy = 0          # lamports the creator bought in the create slot
        self.buyers = set()       # distinct non-creator buyers seen
        self.dev_sold = False     # the creator sold at any point
        self.dead = False         # failed a permanent filter: never buy
        self.decided = False      # a buy was sent for it


class Held:
    """A position we hold: when we first saw it, and its cost."""

    __slots__ = ("opened_slot",)

    def __init__(self, opened_slot):
        self.opened_slot = opened_slot


# Coins by mint, in first-seen order; positions by mint, in first-seen order.
coins = {}
held = {}


def on_batch(state, batch):
    try:
        return _on_batch(state, batch)
    except Exception as exc:  # never let one bad batch kill the whole run
        print(f"batch {state.seq}: {exc!r}", file=sys.stderr)
        return []


def _on_batch(state, batch):
    now = batch["slot"]
    tx_fee = state.tx_fee_lamports()
    caps = state.hello["caps"]
    max_orders = caps["max_orders_per_batch"]

    # Fold this batch's events into the per-coin tape.
    for e in batch["events"]:
        kind = e["event"]
        mint = e["mint"]
        if kind == "CreateEvent":
            if mint not in coins:
                coins[mint] = Coin(mint, e["slot"], e["creator"])
        elif kind == "TradeEvent":
            coin = coins.get(mint)
            if coin is None:
                continue
            amount = int(e["sol_amount"])
            if e["user"] == coin.creator:
                if e["is_buy"]:
                    if e["slot"] == coin.created_slot:
                        coin.dev_buy += amount
                else:
                    coin.dev_sold = True
            elif e["is_buy"]:
                coin.buyers.add(e["user"])
        else:  # CompleteEvent: the replay closes any position; never buy it again
            coin = coins.get(mint)
            if coin is not None:
                coin.dead = True

    # Latest reserves per mint, from the batch's marks (they already include
    # the effect of our own earlier fills); fall back to the curve state.
    marks = {}
    for m in batch["marks"]:
        marks[m["mint"]] = (int(m["virtual_quote_reserves"]), int(m["virtual_token_reserves"]))

    def reserves(mint):
        mark = marks.get(mint)
        if mark is not None:
            return mark
        curve = state.curves.get(mint)
        if curve is None:
            return (0, 0)
        return (curve.virtual_quote_reserves, curve.virtual_token_reserves)

    orders = []

    # Exits first: take-profit, stop-loss, time stop, creator sold.
    for mint in list(held):
        pos = state.positions.get(mint)
        if pos is None:
            # Position gone (filled sell, harness close, or flatten): forget it.
            if not any(p.order["mint"] == mint for p in state.pending.values()):
                del held[mint]
            continue
        curve = state.curves.get(mint)
        if curve is None or curve.complete:
            continue
        vq, vt = reserves(mint)
        value = sell_value_lamports(pos.token_amount, vq, vt, tx_fee)
        cost = pos.cost_lamports
        h = held[mint]
        creator_sold = coins[mint].dev_sold if mint in coins else False
        if (
            value * 10000 >= cost * (10000 + TAKE_PROFIT_BPS)
            or value * 10000 <= cost * (10000 - STOP_LOSS_BPS)
            or now - h.opened_slot >= MAX_HOLD_SLOTS
            or creator_sold
        ):
            if len(orders) >= max_orders:
                break
            orders.append(
                {"side": "sell", "mint": mint, "token_amount": pos.token_amount, "max_slippage_bps": MAX_SLIPPAGE_BPS}
            )

    # Record positions we hold now (a buy filled since the last batch).
    for mint in state.positions:
        if mint not in held:
            held[mint] = Held(now)

    # Entries: new coins, decided once, on the create batch or within 3 slots.
    free_cash = state.free_cash_lamports()
    slots_left = caps["max_open_positions"] - state.committed_position_count()
    pending_mints = {p.order["mint"] for p in state.pending.values()}
    for e in batch["events"]:
        if len(orders) >= max_orders or slots_left <= 0:
            break
        mint = e["mint"]
        coin = coins.get(mint)
        if coin is None or coin.dead or coin.decided:
            continue
        if coin.created_slot is None or now - coin.created_slot > MAX_AGE_SLOTS:
            continue
        if mint in held or mint in pending_mints or mint in state.positions:
            continue
        curve = state.curves.get(mint)
        if curve is None or curve.complete:
            coin.dead = True
            continue
        # Permanent filters: bundled or front-run launches are out for good.
        if coin.dev_buy > MAX_DEV_BUY_LAMPORTS or len(coin.buyers) > MAX_OTHER_BUYERS or coin.dev_sold:
            coin.dead = True
            continue
        # Temporary condition: need enough real SOL for a >= 0.01 SOL buy; retry next batch while young.
        if curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS:
            continue
        cap = state.max_buy_lamports(mint)
        amount = min(cap, STAKE_LAMPORTS)
        if amount < MIN_BUY_LAMPORTS or free_cash < amount + tx_fee:
            continue
        orders.append(
            {"side": "buy", "mint": mint, "quote_lamports": amount, "max_slippage_bps": MAX_SLIPPAGE_BPS}
        )
        coin.decided = True
        free_cash -= amount + tx_fee
        slots_left -= 1

    return orders


if __name__ == "__main__":
    makefun_bot.run(on_batch)
