# Economy spec (v1: in-world coins)

## Goal

All cats share one coin pot and try to grow it. The roster is every cat in `town.config.json` plus any recruits. Cats invent any business they want and run it without owner approval. The owner steers only by talking to the Mayor.

**The engine computes every outcome. Models only choose actions.** A cat claiming a sale changes nothing.

## Shape

- `src/economy.ts` is pure. `apply(state, event)` is a reducer. Each command validates its input and returns the events to append. Nothing in it does I/O and nothing calls a model.
- A season has its own journal, `data/season-<name>.jsonl`, one JSON event per line. It is separate from `events.jsonl`, so chat stays unblocked.
- All amounts are integer coins. Anything holding real money later will reuse this ledger shape with minor units.
- All randomness comes from `rng(seed, ...keys)`, a hash of the key followed by mulberry32. The seed is journaled, so replaying a journal always gives the same state.
- Settings live in `town.config.json` under `economy`: `startingCoins`, `ticksPerDay`, `days`, `baseDemand`, `elasticity`, `maxPrice` and `maxActionsPerTick`.

## Events

| Type | Fields |
|---|---|
| `season.started` | `seed, startingCoins, cats[], ticksPerDay, days` |
| `tick.started` | `day, tick` |
| `action` | `cat, key, name, args, ok, result` (every attempt, rejected ones included) |
| `envelope.set` | `cat, amount, by` |
| `spend.requested` | `id, cat, amount, purpose, business?` |
| `spend.decided` | `id, by, approved, reason` |
| `coins.reserved` | `id, key, cat, amount, purpose` |
| `coins.settled` | `id, amount` |
| `coins.released` | `id` |
| `coins.earned` | `business, amount` |
| `business.opened` | `id, owner, name, pitch, category, price, unitCost, fit` (`fit` is hidden from cats) |
| `business.priced` | `id, price` |
| `business.stocked` | `id, units` |
| `business.sold` | `id, units, revenue` |
| `business.closed` | `id, reason` |

## Actions

Every cat can take every action. Roles shape behaviour through the prompt only. Each action carries an idempotency `key`. A repeated key returns the first result and changes nothing.

- `open_business{name,pitch,category,price,unitCost,startup}`: spends `startup`.
- `buy_stock{business,units}`: spends `units × unitCost`. Owner only.
- `set_price{business,price}`: owner only. The price must be from 1 to `maxPrice`.
- `market{business,amount}`: spends the amount and boosts that business's demand for this day.
- `close_business{business,reason}`: owner only. Stock is lost.
- `research{category}`: returns a noisy estimate of the fit for that category.
- `review{business}`: returns a noisy estimate of that business's fit.
- `set_envelope{cat,amount}`: Mayor only.
- `decide_spend{id,approved,reason}`: Banker or Mayor only, never on their own request.
- `message{to,text}` and `pass{}`: no coin effect.

**How a spend works:**

1. If the cat's envelope has room, coins are reserved and settled immediately.
2. Otherwise a `spend.requested` is created and coins are reserved.
3. An approval settles the reservation. A rejection, or no decision within 2 ticks, releases it.

## Market (once per tick, per open business)

`units = min(stock, floor(baseDemand × fit × (unitCost×2/price)^elasticity × boost × share × noise))`

- `fit` is drawn when the business opens, roughly lognormal between 0.2 and 1.8.
- `boost` is 1 plus the day's marketing divided by 50.
- `share` is 1 divided by the number of open businesses in the same category.
- `noise` is drawn between 0.7 and 1.3.
- Revenue is `units × price`, followed by `coins.earned`.
- **Upkeep:** after a business's sales each tick, it owes `baseUpkeep + ceil(startup / upkeepDivisor)`. This is paid through the ledger as `coins.reserved` (key `upkeep:<id>:<tickIndex>`, purpose `upkeep <id>`, cat = owner) followed by `coins.settled`, with no envelope. If available coins cannot cover it, the engine emits `business.closed{reason:'could not pay upkeep'}` instead. Businesses can go broke.
- `business.opened` carries `startup`.

## Invariants (tests replay the journal file)

- `balance = startingCoins + Σearned − Σsettled`, and the balance is never negative.
- Open reservations never exceed the balance.
- Each reservation resolves exactly once, and a settlement never exceeds its reservation.
- Units sold never exceed stock, and stock is never negative.
- No cat decides its own spend, and no repeated key has a second effect.
- Replaying the same journal and seed produces the same state.

## Later phases

1. **Runner:** a CLI that is resumable and has `--status`, with a scripted demo policy and model tool calls.
2. **Server integration:** Mayor chat directives feed into the next tick.
3. **3D replay:** cats walk to businesses and coins pop over each sale.
