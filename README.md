# makefun-pump-fun-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/nofrizal05/makefun-pump-fun-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/nofrizal05/makefun-pump-fun-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for pump.fun bonding curves: it snipes new launches in their first three slots when the launch looks un-bundled (small creator buy, at most one other buyer, creator hasn't sold, at least 1 real SOL in the curve), stakes 0.02 SOL per coin, and sells on a +15% take-profit, a −20% stop-loss, thirty slots held, or the creator selling. Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty.

## Run it

```sh
python3 main.py
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: the harness sends a `hello` message, then one `batch` per slot, and the bot answers each batch with one reply carrying its `orders`. It is deterministic — no clock, no randomness, no network — so two runs on the same data produce identical action logs. Python standard library only; `vendor/makefun_bot.py` is the kit's protocol shim.

---

<sub>Entered on [make.fun](https://make.fun/?ref=31w76kz9&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
