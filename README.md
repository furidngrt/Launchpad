# Launchpad

A token launchpad built on one idea: a launch should not need anybody's good behaviour to be safe.

A creator deploys a token, the public buys it from a bonding curve that holds the entire supply, and once the curve is bought out the launch graduates into an automated market maker pool whose liquidity is locked permanently. Every step is a transaction a user signs for themselves. The protocol never takes custody of anybody's tokens or funds.

There is no pre-allocation for the creator, no mint function on the launch token, no way for anyone to pause trading or move locked liquidity, and no way for the terms a creator was shown to change after they commit. These are not promises. They are the absence of the functions that would be needed.

**Status: unaudited, live on Sepolia.** Every contract fits the deployed-code limit, 43 tests pass against a real EVM, and the full stack is deployed and source-verified on Ethereum Sepolia, where an end-to-end graduation was run against the real Uniswap V3 deployment with a sabotaged pool. It has not been through an independent security review. Treat it accordingly.

---

## Contents

- [Why a curve, then a pool](#why-a-curve-then-a-pool)
- [Lifecycle](#lifecycle)
- [Contracts](#contracts)
- [Economics](#economics)
- [Fee mechanics](#fee-mechanics)
- [What cannot happen](#what-cannot-happen)
- [Administrative powers, in full](#administrative-powers-in-full)
- [Recovery paths](#recovery-paths)
- [Integration](#integration)
- [Build, test, deploy](#build-test-deploy)
- [Web app](#web-app)
- [Deployments](#deployments)
- [Design notes](#design-notes)
- [Known limitations](#known-limitations)
- [Risks](#risks)

---

## Why a curve, then a pool

The failure mode a launchpad has to design around is the launch day itself. If a token starts life as a pool, somebody has to fund that pool, and whoever funds it can take it back out. If it starts trading before anyone has seen it exists, the first block belongs to whoever was watching hardest.

Starting on a curve removes both problems at once.

**There is nothing to take.** The curve holds the whole supply and the only quote asset it holds is what buyers paid in. The creator never holds liquidity, so they cannot remove it. At graduation the position goes to a contract that has no function to send it anywhere.

**There is nothing to snipe before the curve opens.** The curve opens at a set price in the same transaction that creates it, and buys in the first seconds pay a tax steep enough that being first is not worth it.

**The destination is fixed in advance.** A share of supply is reserved from the start and the curve will not sell through it. Every launch on the same configuration graduates into a pool of the same size at the same price, whether the curve was bought out by one order or by a thousand.

**The creator is paid in real money from the first trade.** The curve trades in the asset its future pool will use and charges its fee on that leg, so revenue is never a pile of the launch token that has to be sold to be worth anything. It also means graduation needs no swap, no router and no price oracle anywhere in the system.

## Lifecycle

| Phase | What is happening | Where to trade |
| --- | --- | --- |
| `Curve` | The curve holds the supply and prices every trade. Buying and selling are both open. | The launch's own curve |
| `Settled` | The curve is bought out and closed. The protocol holds the reserves; the pool does not exist yet. Normally lasts part of one transaction. | Nowhere |
| `Listed` | The pool exists, seeded and locked forever. | The pool |
| `Refunded` | Recovery path. The pool could never be seeded and the reserves were returned. Terminal and deliberately visible. | Nowhere |

Graduation is attempted inside the buy that finishes the curve, so the ordinary path completes in a single transaction with no keeper involved. If listing cannot complete, the launch waits in `Settled` and **anyone at all** can finish it with one permissionless, retryable call. A launch cannot be stranded because its creator lost interest, and the protocol is not needed either.

Selling closes slightly before buying does. The moment the curve is bought out it holds exactly the reserves the pool is about to be built from, and a sell landing in that window would seed the pool deeper and cheaper than the reserved allocation fixes it at. Holders are not stranded by this: graduation is permissionless, so anyone refused can settle the launch themselves in the same transaction and trade the pool instead.

## Contracts

| Contract | Role |
| --- | --- |
| `LaunchFactory` | Entry point. Creates launches, holds the terms they are created on, drives graduation. |
| `BondingCurve` | One per launch. Prices and settles every pre-graduation trade, and quotes them on chain. |
| `LaunchToken` | One per launch. Fixed-supply ERC-20 minted entirely to its curve. No owner, no mint, no pause. |
| `LaunchDeployer` | Deploys each curve and token at addresses derived from the creator's own salt. |
| `LiquidityLocker` | Final custody of graduated liquidity. Has no function that could release it. |
| `FeeEscrow` | Pull-payment ledger. Every payout is credited here and withdrawn on request. |
| `BuybackVault` | Holds bought-back supply on a five-year linear vest and splits each release. |
| `FeeCollector` | Converts and splits the fees a launch earns after graduation. |
| `LaunchRouter` | Optional. Creates a launch and makes the first buy in one transaction. |
| `LaunchLens` | Read-only. Paged lists of launches and a launch's whole picture in one call. |
| `PoolRouter` | Trades a graduated launch against its pool in ETH, with exact on-chain quotes, so it keeps trading in the same interface. Stateless, no admin. |
| `AmmV3Venue` | Adapter for a concentrated-liquidity AMM. The only contract that knows how one works, and the one that refuses to list at a price it did not choose. |

The core never names an AMM. Supporting a different one means deploying another adapter, and because every launch records the adapter it was created with, doing so leaves existing launches exactly where they are.

## Economics

A configuration fixes the supply, the trade fee, the virtual reserve, the graduation target and the pool's parameters. Configurations are **append-only and immutable**: there is no function that edits one. Changing terms means a new configuration with a new id, so an id always means the same thing.

The reference configuration the tests exercise:

| Term | Value |
| --- | --- |
| Supply | 1,000,000,000 |
| Trade fee | 1% |
| Virtual quote reserve | 1.68 |
| Graduation target | 4.2 |
| Pool fee tier | 1% |
| Tick spacing | 200 |

Everything else follows from those five numbers:

| Derived | Value | Share of supply |
| --- | --- | --- |
| Sellable on the curve | 714,285,714.29 | 71.43% |
| Reserved for the pool | 285,714,285.71 | 28.57% |
| Seeded into the pool | 204,081,632.65 | 20.41% |
| Locked forever at graduation | 81,632,653.06 | 8.16% |

| Price | Value |
| --- | --- |
| Opening price | 1.68 × 10⁻⁹ per token |
| Opening valuation | 1.68 |
| Price at graduation | 2.058 × 10⁻⁸ per token |
| Valuation at graduation | 20.58 |
| Rise across the curve | 12.25× |

The virtual reserve is priced against but never withdrawable. It is what gives the curve an opening price instead of starting at zero, which is why the first buyer does not get the supply for nothing.

Two details worth understanding:

**The reserved allocation is not a separate parameter.** It is the token balance that corresponds to the graduation target on the same curve. Reserving it does not move where a launch graduates; it only stops the curve selling through that point. The quote target and the token reserve are the same moment seen from two sides, which is what makes the graduated pool deterministic.

**Not all of the reserve enters the pool.** The virtual reserve is not real money and cannot be paid in, so seeding the whole reserved balance against the real quote collected would open the pool below the price the curve ended at. The token side is scaled by the same ratio instead, which preserves the price exactly, and the remainder is locked forever.

A launch can be quoted in an approved ERC-20 instead of the native asset. That asset then becomes the currency of the whole launch: buyers spend it, the target is counted in it, the pool is paired against it, and the creator is paid in it. Its economics are recorded in its own decimals, because a reserve sized in eighteen decimals applied to a six-decimal stablecoin would misprice the curve by twelve orders of magnitude.

## Fee mechanics

### What a trader pays

Two things, and they are worth telling apart.

**The trade fee** is set by the configuration, charged on the quote leg of every trade in both directions, and shared out. On a buy it comes off the input; on a sell it comes out of the proceeds. The launch token is never used to pay a fee.

**The creator fee** is optional, chosen by the creator at creation within the protocol cap, and paid to them in full. It can be anything from 0% to 10%, in basis points. It is fixed once set: it cannot be raised on a trader later, and a launch that set it to zero charges the trade fee and nothing else. Check it before trading, because it varies from token to token.

The creator fee is charged on the curve only. Once a launch graduates, trading happens in an ordinary pool, and the pool charges its own fee tier and nothing more. See [after graduation](#after-graduation) and [known limitations](#known-limitations).

The two together are capped at 20%, and each individually at 10%.

### How the trade fee divides

The protocol's share comes off the whole fee first. If the creator has buybacks enabled, a slice of what remains is spent buying the token back. Whatever is left, plus the entire creator fee, goes to the creator.

| Leg | Share of the trade fee | On a 1% fee |
| --- | --- | --- |
| Protocol | 30% | 0.30% of the trade |
| Buyback, when enabled | 35% | 0.35% of the trade |
| Creator | 35% enabled, 70% disabled | 0.35% or 0.70% |

The split is recorded when the launch is created and stays the same for the life of the token, before and after graduation. A later change to the protocol's policy governs future launches only.

Note where the buyback is funded from: the creator's share alone, never the protocol's. The creator funds the whole lock and then receives only their share of each release back, so enabling a buyback moves value from the creator to the protocol relative to taking the fee directly. That is why only the creator can switch it on, and why the protocol can only switch it off.

The buyback slice is marked at the moment each fee is charged, not worked out when fees are paid. That keeps the switch forward-looking: flipping it decides how the next trade's fee is split and never how an already-charged one is.

### The opening tax

A launch is most vulnerable in its first seconds. Every launch therefore opens with a tax on buying, set high enough that being first is not worth it and decaying to nothing within seconds.

With the reference settings — 99% across a five-second window, halving fourteen times across it:

| Seconds into the launch | Tax on a buy |
| --- | --- |
| 0 | 98% |
| 1 | 24.75% |
| 2 | 3.09% |
| 3 | 0.38% |
| 4 | 0.04% |
| 5 and after | 0% |

It applies to buys only; selling is never taxed by it. It is bounded so a taxed buy always nets its buyer something, which is why the launch second reads 98% rather than 99% once the trade fee is accounted for.

What it collects is not burned. It joins the trade fee and is distributed the same way, so the value a bot gives up flows back into the launch rather than out of it.

The creator is never a sniper on their own launch: the launching address and the fee recipient are exempted automatically, and a creator can name up to 32 further wallets at creation for a team bundling its opening buys. Exemptions are fixed at creation and cannot be added later. Each launch takes its own copy of the tax terms, so a curve already trading keeps what it opened under.

Exempt wallets are capped while the window is open. Together they may buy at most a set share of supply, 10% by default, before the window closes; a buy that would cross it reverts with `OpeningAllocationExceeded`. Uncapped, the same exemption that lets a team bundle its opening buys would let a creator and every wallet they declared take most of the supply at the opening price in the launch second and sell it into everyone who arrives afterwards. Read `openingExemptRemaining()` before sizing an exempt buy. Once the window closes, the cap no longer applies and everyone trades on equal terms.

If you are quoting a trade, read `openingTaxBps(recipient)` and apply it. It is keyed on the wallet receiving the tokens rather than the sender, so a router must ask about its end user.

### After graduation

A graduated launch keeps trading in the same place. `PoolRouter` swaps ETH for the token and back directly against the locked pool: it wraps and unwraps the native asset itself, refunds anything the pool does not take, enforces a minimum output and a deadline, and quotes by simulating the exact swap, so a quote is what the pool would do at that moment. It depends on no external router, holds nothing between calls and has no admin. Anyone can still trade the pool through any other interface.

After graduation the pool's own fee tier is the fee. On the reference configuration that tier is 1%, the same rate as the curve's trade fee, and it is split protocol, buyback and creator exactly as on the curve. The creator's own extra fee does not carry over, because an ordinary pool has no way to charge one.

A pool cannot charge its fee the way a curve does: which side a fee lands on depends on the direction of the swap, so a graduated launch accrues a mixture of its own token and its quote asset. `FeeCollector` restores the pre-graduation guarantee. It converts the launch-token side back to the quote asset against the pool's own liquidity, and only then splits and pays out. A creator is paid in the asset their launch traded in, before and after graduation alike.

Conversions are price-sensitive, so they are restricted to the protocol's sweep operator, who supplies an explicit minimum output. A creator can still distribute fees themselves whenever no conversion is needed. A conversion or buyback that cannot be done at an acceptable price is left for later rather than forced through, and the events say so.

### Getting paid

Fees are not pushed to wallets as they are earned. They accrue on the curve, or on the collector after graduation, until a sweep moves them into the escrow, where they wait to be withdrawn.

That is a deliberate liveness decision. A push model lets one recipient whose address cannot accept a transfer revert the distribution that pays everybody else. Here a failing recipient fails alone, and the test suite covers exactly that case.

Two consequences for anyone building an interface:

- An escrow balance of zero does not mean a launch has earned nothing. Read `feeBalance` and `creatorFeeBalance` on the curve, or `pendingTokenFees` on the collector, and add them.
- Balances are kept per asset. A creator with launches against different quote assets holds several separate balances and claims each one independently, because there is no honest rate at which to aggregate them.

### Buybacks and vesting

Bought-back tokens are not burned. They are locked and released linearly over five years, split between the creator and the protocol on the share recorded for that launch. A burn is irreversible and invisible afterwards; a long vest keeps the supply accounted for, and there is no moment at which a large balance can return to the market at once.

The five-year clock is weighted. Each deposit moves the schedule's end forward in proportion to its share of the new total, so a small top-up barely disturbs a large existing lock and a large one pulls a small lock most of the way to its own clock. A buyback made this month cannot become withdrawable immediately because the launch has been buying back for years.

Either beneficiary can release, and whichever one calls pays both. A creator who stops paying attention cannot strand the protocol's share, and a creator can always take their own without waiting on anyone. Nobody else can call it, because a third party choosing the moment could time a release inside a pending recipient change, or advance the clock every second so each step rounds down to zero and the vest stalls.

## What cannot happen

The properties the rest of the design exists to protect. Each one is enforced by the absence of a function, not by a policy.

**Liquidity cannot be removed.** `LiquidityLocker` has no transfer, no withdrawal, no decrease-liquidity call, no arbitrary call, no upgrade path and no admin role that could add one. Its entire write surface is four functions, and the test suite asserts that list. The only value that leaves is accrued fees, through a call that settles fees already owed and cannot reach principal.

**Trading cannot be stopped.** Nothing in the protocol can pause, blocklist or tax a live launch. The gate that exists governs the creation of new launches; disabling a configuration or withdrawing a quote asset likewise affects only launches made afterwards. The suite covers this directly: creation is closed and the existing launch keeps trading.

**The launch token has no privileged holder.** It is an ERC-20 with permit and burn, and nothing else. No owner, no mint after construction, no pause, no blocklist, no transfer fee, no proxy. Supply can only fall, and only because a holder chose to burn their own balance.

**Terms cannot change underneath a creator.** Configurations are immutable once added. On top of that, a creator can pin the whole set of terms they read with `previewEconomics` and pass it back as `expectedEconomics`; if anything moved in between, the launch reverts instead of settling on different terms.

**A prepared pool cannot set the listing price.** A launch's token address is public from the moment it is created, so anyone can create its pool first and initialize it at whatever price they like, with or without liquidity of their own. Minting into that pool as found would deposit the curve's reserves at the attacker's price for them to trade out. The venue never does that. It computes the price the curve finished at, and if the pool is anywhere else it trades the pool back to exactly that price first, using the reserves it was given, in the same transaction as the mint. Against an empty pool that costs nothing, since a swap through zero liquidity moves the price without exchanging anything. Against an attacker's liquidity it is profitable for the launch, because pushing a mispriced pool back to fair value buys from it below value or sells to it above value. If the reserves run out before the price is restored, listing refuses rather than mint at the wrong price, and the launch waits, retryable, in the settled phase. This is covered by tests against a modelled pool and was exercised live on Sepolia against the real AMM; see [deployments](#deployments).

**Nothing a graduation leaves over is stranded.** Whatever the mint does not take comes back from the venue and is accounted for in the same call: launch tokens are locked with the rest of the supply that missed the pool, and quote is credited to the protocol's escrow balance.

**Donations cannot move a price.** The curve tracks the reserves it received through trades rather than reading its own balance, so sending tokens or value to a curve changes neither its price nor the point at which it graduates.

**A fee asset that misbehaves cannot inflate the books.** Every ERC-20 boundary credits the balance that actually arrived rather than the amount requested, so an asset that keeps part of a transfer, or rebases, can never make the protocol record more liability than it holds.

## Administrative powers, in full

Authority is split across roles rather than held by one owner, and the role that grants the others can only be handed over after a delay, so a transfer is visible before it takes effect. What each role can do, stated plainly:

| Role | Can | Cannot |
| --- | --- | --- |
| Admin | Grant and revoke the roles below. Hand over its own role, after the delay. | Touch a launch, a trade or locked liquidity directly. |
| `CONFIG_ROLE` | Add configurations, set the fee policy, the launch fee, the creator-fee cap, the opening tax, the venue, the sweep operator and the router. Disable a configuration. Switch a launch's buyback **off**. | Edit a configuration's economics. Change the policy of a launch that exists. Switch a buyback on. |
| `ASSET_ROLE` | Approve ERC-20 quote assets and record their economics. | Affect launches already trading against an asset. |
| `GUARDIAN_ROLE` | Open or close new-launch creation, manage the whitelist, propose a fee-recipient override, and run the three recovery paths. | Stop a live launch. Reach locked liquidity. Redirect fees without the timelock. |

The one power worth reading carefully is the fee-recipient override. Its motivating case is a creator who has lost access to their wallet, but it is deliberately not conditioned on that, so it should be read as a standing protocol power over fee routing rather than a narrow recovery. What bounds it is notice: nothing happens for three days, the proposal states both the new address and the date from the moment it is made, anyone can execute it once mature, and it expires three days later. Holders learn of it before it happens, and the wait is their window to act.

A creator moving their fees during the wait does not cancel the proposal. That is intentional: otherwise whoever had stolen a creator's wallet could sidestep the very recovery proposed because it was stolen.

## Recovery paths

Three, each narrow and each visible.

**A curve whose fees cannot reach the escrow.** A quote asset can stop delivering to one address while still permitting transfers between traders and the curve. Trading would carry on but the fees would be unreachable, and graduation unreachable with them, because settlement sweeps fees before handing over reserves. `rescueCurveFees` pays them straight to the protocol and the creator instead, which unblocks graduation.

**A launch whose pool can never be seeded.** Settlement credits whatever it actually received, so it tolerates an asset that under-delivers, but seeding requires the full amount. `refundSettled` returns the reserves after seven days. What makes that wait meaningful is that listing stays permissionless throughout it: any holder can end the window early, and permanently, with one call. Reserves stay reachable by this path only if nobody could list them. The launch is marked `Refunded` forever afterwards.

**A launch the venue refuses before settlement.** The preflight runs before the irreversible step, so a launch it refuses stays on its curve, with its sell side already closed. `forceSettle` moves it into the settled phase so the refund path applies. It is restricted to launches the preflight genuinely refuses: while a seed is viable, anyone can graduate the launch normally and this reverts.

Some things cannot be recovered by anyone, deliberately: locked liquidity, supply locked at graduation, and tokens sent directly to a contract by mistake.

## Integration

Everything reads and writes on chain. There is no hosted service in the trust path, and the protocol keeps its own enumerable registry so an indexer can reconstruct every launch without replaying logs.

### Creating a launch

One call to the factory. Read `previewEconomics(configId, quote)` immediately before and pass the result as `expectedEconomics`, so a change in terms makes the launch revert rather than go through on different ones. Check `canLaunch(address)` rather than assuming creation is open, and read `launchFee()` rather than hardcoding it.

```solidity
(address token, address curve) = factory.launch{value: factory.launchFee()}(
    LaunchParams({
        name: "Example",
        symbol: "EXMPL",
        logo: "ipfs://...",
        description: "An example launch.",
        website: "https://example.com",
        social: "https://example.com/social",
        feeRecipient: address(0),   // zero defaults to the caller
        creatorFeeBps: 0,           // optional, capped by maxCreatorFeeBps()
        buybackEnabled: true,
        expectedEconomics: pinned,  // from previewEconomics
        salt: salt                  // namespaced per creator
    }),
    configId,
    address(0)                      // native quote, or an approved ERC-20
);
```

An overload takes a final `address[]` of wallets exempt from the opening tax, up to 32. `LaunchDeployer.predict` returns both addresses before the transaction is sent, so a creator can mine a vanity address offline and confirm it.

To create and buy in one transaction, use `LaunchRouter.launchAndBuy`. It closes the gap a second transaction would leave on a public curve, holds its caller to the factory's own gate, and exempts the buy's recipient automatically.

### Trading and quoting

Before graduation, trades go to the launch's curve. The curve quotes its own trades on chain, so an interface never has to reimplement the arithmetic and risk showing a number the trade will not honour:

```solidity
(uint256 tokensOut, uint256 spent, uint256 refund, uint256 fee, uint256 creatorFee, uint256 tax)
    = curve.quoteBuy(quoteIn, recipient);

(uint256 quoteOut, uint256 fee_, uint256 creatorFee_) = curve.quoteSell(tokensIn);
```

The figures are the ones `buy` and `sell` compute, in the same integer order, so they match exactly when nothing moves in between. The suite asserts that equality, including for a clamped final fill and its refund.

Four things to respect:

- A native launch requires `quoteIn` to equal the value sent. An ERC-20 launch requires an approval and no value at all.
- A buy that would cross the reserved allocation is filled to the edge and refunded the difference, so read the amounts from the return value or the `Buy` event rather than assuming. `minTokensOut` bounds the **price**, not the quantity, so size it from the rate you were quoted.
- Buying closes when `sellableTokens()` reaches zero; selling closes earlier, as soon as `readyToGraduate()` is true. A quote engine gating only on the settled flag will offer sells that revert.
- Give the buy that finishes a curve a generous explicit gas limit. It graduates the launch inside a try/catch, so gas estimation finds the smallest budget at which the buy succeeds, which is one where graduation has quietly run out of gas. If that happens the launch is still safe, and anyone can finish it with `graduate` or `list`, but an explicit limit lets the buyer complete it in one transaction.

### Reading state

`getLaunch(token)` returns the whole record, including the phase, which is the authoritative signal for where a launch is and which venue to route to. Do not infer it from balances or events.

| Read | Meaning |
| --- | --- |
| `reserves()` | The reserves to price against, virtual quote included, pending fees excluded. |
| `quoteReserve()` | Pricing quote reserve only. |
| `realQuoteReserve()` | What the curve physically holds. The wrong input for a quote. |
| `sellableTokens()` | Tokens still buyable before the curve closes. |
| `reserveFloor()` | Supply held back for the pool. Fixed at creation. |
| `graduationProgressBps()` | Progress towards the target, in basis points. |
| `openingTaxBps(recipient)` | Opening tax that wallet would pay right now. |

The factory exposes `launchCount`, `launchAt`, `launchCountOf` and `launchOfAt`. `LaunchLens` builds on them: `launches(offset, limit)` and `launchesOf(creator, offset, limit)` return pages, and `launchView(token, viewer)` returns a launch's record together with its reserves, sellable tokens, progress, the viewer's opening tax and the remaining exempt allowance, in one call.

### Claiming

```solidity
uint256 owed = escrow.balanceOf(creator);                 // native launches
uint256 owedToken = escrow.balanceOfToken(creator, asset); // ERC-20 quotes and released vests
escrow.claim();
escrow.claimToken(asset);
escrow.claimTo(otherAddress, amount);          // for a recipient that cannot receive native value
escrow.claimTokenTo(asset, otherAddress, amount);
```

Partial claims exist for a reason: a balance aggregates credits from every launch a recipient earns from, and crediting is open, so against an asset that caps the size of a single transfer a whole-balance claim could grow past that cap. Choosing the amount keeps the aggregate from becoming a single point of failure.

### Events worth indexing

| Event | From | Meaning |
| --- | --- | --- |
| `LaunchCreated` | Factory | A new launch, its curve and its quote asset. |
| `Buy`, `Sell` | Curve | Trades, with the fee and the creator fee reported separately. |
| `Refunded` | Curve | A clamped final buy returned unspent quote. |
| `OpeningTaxCharged` | Curve | A buy paid the opening tax, and which wallet. |
| `LaunchSettled` | Factory | The curve closed and handed over its reserves. |
| `LaunchListed` | Factory | The pool was created and the position locked. |
| `SupplyPermanentlyLocked` | Factory | Supply that could not enter the pool. |
| `AutoGraduationFailed` | Curve | Graduation needs a push. Treat as a work queue. |
| `FeesSwept`, `FeesDistributed` | Curve, Collector | Fee splits before and after graduation. |
| `Credited`, `Claimed` (and `...Token`) | Escrow | Payouts accrued and withdrawn. |
| `Locked`, `Released` | Vault | Tokens entering and leaving the vest. |
| `FeeRecipientChangeProposed` | Factory | A fee-routing override was proposed, with its date. |
| `ConversionSkipped`, `BuybackSkipped` | Collector, Curve | A leg was deferred rather than forced through. |
| `PoolPriceRestored` | Venue | A prepared pool was traded back to the curve's price before listing. |
| `ListingRemainderHandled` | Factory | What the mint did not take, and where it went. |

## Build, test, deploy

Everything runs on npm dependencies alone. No downloaded compiler, no node, no network.

```bash
npm install
npm run build
npm test
```

`npm run build` compiles with the bundled `solc`, writes artifacts to `out/` together with the exact standard-JSON compiler input used for explorer verification, and fails if any contract exceeds the 24,576-byte deployed-code limit. `npm test` compiles the mocks too and runs 43 tests against an in-process EVM, including a randomised trading run that checks solvency, token conservation and quote exactness after every step. The mock pool is faithful to what the venue relies on: anyone may initialize it, a swap through zero liquidity moves its price for free, and payment is checked after the callback.

Current sizes:

| Contract | Bytes | Of limit |
| --- | --- | --- |
| `LaunchFactory` | 23,691 | 96.4% |
| `LaunchDeployer` | 22,989 | 93.5% |
| `BondingCurve` | 11,348 | 46.2% |
| `AmmV3Venue` | 7,195 | 29.3% |
| `BuybackVault` | 4,891 | 19.9% |
| `LaunchToken` | 4,698 | 19.1% |
| `FeeCollector` | 4,611 | 18.8% |
| `LaunchRouter` | 3,405 | 13.9% |
| `LaunchLens` | 3,013 | 12.3% |
| `LiquidityLocker` | 2,442 | 9.9% |
| `FeeEscrow` | 2,034 | 8.3% |

A `foundry.toml` is included for anyone who prefers `forge build` and `forge test`; the remappings point at `node_modules`.

To deploy, print the plan first and then run it. A known `NETWORK` supplies the AMM's addresses; any other network needs `POSITION_MANAGER` and `WRAPPED_NATIVE`. `TREASURY` and `ADMIN` default to the deploying account, and `OPEN=1` opens creation to everyone.

```bash
NETWORK=sepolia DRY_RUN=1 node tools/deploy.mjs
```

```bash
NETWORK=sepolia RPC_URL=... PRIVATE_KEY=... OPEN=1 node tools/deploy.mjs
```

The order is not arbitrary. Three contracts need an address that only exists after the contract needing it, so the vault, locker and factory are deployed first, the deployer, collector, router and lens follow, and the factory is then told about them. Each wiring call can be made exactly once, and launching is impossible until a configuration has been added and creation opened. Every address, transaction and constructor argument is written to `deployments/<network>.json`.

Then verify the sources and run the live check:

```bash
NETWORK=sepolia ETHERSCAN_API_KEY=... node tools/verify.mjs
```

```bash
NETWORK=sepolia RPC_URL=... PRIVATE_KEY=... node tools/smoke.mjs
```

The smoke test creates a launch on the cheap configuration, sabotages its pool the way an attacker would, buys the curve out, and confirms the launch listed at the curve's own price with its liquidity locked. In environments that reach the network through an HTTP proxy, set `NODE_USE_ENV_PROXY=1` so Node routes through it.

## Web app

`web/` is the trading interface: a Vite + React single-page app with wagmi and viem for wallets and reads, and [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) for price charts. It needs no backend and no indexer. Launch lists come from `LaunchLens`, curve state from batched multicall reads, and trade history and candles are rebuilt in the browser from the curve's own events.

Pages:

- **Tokens**: top launches, then every launch as a grid or a list, filterable by top, new, near graduation and graduated, with search by name, symbol or address.
- **Token**: candles or line chart from 1m to 4h, trades, details, buy and sell with slippage control, curve progress, and the finishing transaction for a launch that is ready to graduate. After graduation the same panel trades against the locked pool through `PoolRouter`, with live quotes, price impact and a deadline, and the chart and trade list continue from the curve into the pool.
- **Create**: name, image and links, curve terms, creator fee, buyback toggle and an optional opening buy in the same transaction. The economics are pinned, so the launch reverts if the terms change before it lands.
- **Portfolio**: claimable escrow balance, the launches you created with their pending fees, and your holdings.
- **How it works**: the lifecycle, the fee split, the live terms and the verified contract addresses.

Run it locally:

```bash
cd web
npm install
npm run dev
```

The contract addresses and ABIs live in `web/src/generated/contracts.ts`. After changing the contracts or redeploying, regenerate it from the repository root:

```bash
npm run build && node web/scripts/sync-contracts.mjs
```

`NETWORK` selects the file in `deployments/` (Sepolia by default). `VITE_RPC_URL` overrides the public RPC endpoint; see `web/.env.example`.

### Deploying to Vercel

1. Import the repository in Vercel.
2. Set **Root Directory** to `web`. The framework preset is Vite; `web/vercel.json` already sets the build command, the `dist` output and the single-page rewrite.
3. Optionally add `VITE_RPC_URL` under Environment Variables with a private Sepolia endpoint. The public default works but is rate-limited.
4. Deploy.

## Deployments

### Ethereum Sepolia

Chain id 11155111. Graduates into the official Uniswap V3 deployment: position manager `0x1238536071E1c677A632429e3655c799b22cDA52`, wrapped native `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`. Every contract below is source-verified.

| Contract | Address |
| --- | --- |
| `LaunchFactory` | [`0xC9804B2255aECA7640C241363990a0D3aDa4ec1F`](https://sepolia.etherscan.io/address/0xC9804B2255aECA7640C241363990a0D3aDa4ec1F#code) |
| `LaunchRouter` | [`0x8a8E7ed303A7C4f1939f61cE9B737821A965578e`](https://sepolia.etherscan.io/address/0x8a8E7ed303A7C4f1939f61cE9B737821A965578e#code) |
| `LaunchLens` | [`0x5a610cd3F7019D109d284f60B3189C3e098870Cb`](https://sepolia.etherscan.io/address/0x5a610cd3F7019D109d284f60B3189C3e098870Cb#code) |
| `LaunchDeployer` | [`0xDDc14Ab7A5255227982BB3e15e05B9ae0884e910`](https://sepolia.etherscan.io/address/0xDDc14Ab7A5255227982BB3e15e05B9ae0884e910#code) |
| `AmmV3Venue` | [`0xcf06b1E16575b327159F0909dc4BB4eb3ed9D988`](https://sepolia.etherscan.io/address/0xcf06b1E16575b327159F0909dc4BB4eb3ed9D988#code) |
| `LiquidityLocker` | [`0xB40a72b2658beb3d66eF384D002B0F38D5EAbdB1`](https://sepolia.etherscan.io/address/0xB40a72b2658beb3d66eF384D002B0F38D5EAbdB1#code) |
| `FeeEscrow` | [`0x1146e1558a15B9C7eA6a9a9fBD25F2583D5ee09d`](https://sepolia.etherscan.io/address/0x1146e1558a15B9C7eA6a9a9fBD25F2583D5ee09d#code) |
| `BuybackVault` | [`0x8cb4d6d9d5C4B22E3cCd589bC4FBD30abf65e084`](https://sepolia.etherscan.io/address/0x8cb4d6d9d5C4B22E3cCd589bC4FBD30abf65e084#code) |
| `FeeCollector` | [`0xa65D42283231186834BEa3350645853060B55a70`](https://sepolia.etherscan.io/address/0xa65D42283231186834BEa3350645853060B55a70#code) |
| `PoolRouter` | [`0xc856Ad88782a843EFe2d552c7d092c34d1a35428`](https://sepolia.etherscan.io/address/0xc856Ad88782a843EFe2d552c7d092c34d1a35428#code) |

Two configurations are live. Both use a supply of one billion, a 1% trade fee and a 1% pool tier with tick spacing 200, and both rise 12.25× across the curve.

| Id | Label | Virtual reserve | Target | Valuation at open | Valuation at graduation |
| --- | --- | --- | --- | --- | --- |
| 0 | `reference` | 1.68 ETH | 4.2 ETH | 1.68 ETH | 20.58 ETH |
| 1 | `smoke-test` | 0.004 ETH | 0.01 ETH | 0.004 ETH | 0.049 ETH |

Valuation is price times total supply. It opens at the virtual reserve and graduates at `(virtual + target)² / virtual`, and the pool opens at that same price.

**Live graduation against a sabotaged pool.** The smoke test pre-created the pool for token `0x8C5A6f17Aa508588F6C84b0bAfaAec0cF21e872A`, initialized it at three times the fair sqrt-price, and seeded it with its own liquidity there. The [finishing buy](https://sepolia.etherscan.io/tx/0xd6bbb17b87b247371ab1b6c1cd6cf3afd21ad8c6528725932f9ea1a8a0da52d3) graduated the launch in one transaction:

| Check | Result |
| --- | --- |
| Pool price found | `1663791412799551089464421` |
| Pool price after restoring | `554597137599850422575929` |
| Curve's own price | `554597137599850422575929`, an exact match |
| Seeded | 204,081,632.65 tokens and 0.01 ETH |
| Position owner | the locker |
| Remainder | 17,743 tokens locked, 0.000178 ETH credited to the treasury |

**Live trading after graduation.** Through `PoolRouter`, a [buy of 0.0005 ETH](https://sepolia.etherscan.io/tx/0xe360440df1ded13cd35050c5b7dc27a9b6c248b41ed99a2cfabced52d7fa0e14) and a [sale of half of it](https://sepolia.etherscan.io/tx/0xc2639ec01325cd817be3cda09aa10336c500d8a101983164fd822c39365c1525) in the same pool each settled at exactly the amount quoted beforehand.

## Design notes

Where this departs from the common bonding-curve launchpad design, and why.

**On-chain quoting.** Most launchpads expose no quote function and leave the arithmetic to integrators, which means every interface reimplements it and some get it wrong. `quoteBuy` and `quoteSell` return exactly what the trade will settle at, clamped final fills included.

**Immutable configurations.** Where a configuration can be edited in place, an id stops being a stable description of anything and integrators must re-read and pin on every launch. Here the economics cannot be edited at all; only the flag that decides whether new launches may still select it can move. The economics pin remains as defence in depth.

**Split roles with a delayed admin handover.** One omnipotent owner key is the single largest trust assumption in most launchpads. Separating configuration, asset approval and recovery means no one key can both reprice launches and move value, and the role that grants the others cannot be transferred without notice.

**An enumerable registry.** Reconstructing protocol state from logs alone is fragile and favours whoever runs an indexer. The factory keeps its own list, and `LaunchLens` pages it.

**Listing at a price the protocol chose.** A graduation that mints into whatever pool it finds can be hijacked by anyone who prepared that pool first. The venue restores the pool to the curve's price before every mint, which turns the attack from a theft into a loss for the attacker.

**Graduation completes in the finishing buy.** Settlement and listing stay separate steps, because settlement only moves balances between the protocol's own contracts while listing touches an external AMM. Listing is attempted inside settlement anyway, so the ordinary path needs no keeper, and the separation still means a failure cannot strand reserves.

**A venue adapter.** The core contracts never name an AMM, so supporting another one is a deployment rather than a rewrite, and existing launches are unaffected.

**Permit on the launch token.** Approving by signature lets an interface bundle an approval and a trade into one transaction instead of asking a user for two.

## Known limitations

Stated plainly, so nobody has to find them.

- **The creator fee stops at graduation.** An ordinary pool charges its own fee tier and cannot add a second fee on top, so the creator's extra fee applies on the curve only. Platform and creator still share the pool's tier afterwards.
- **Pool fees can be diluted.** The graduated pool is an ordinary pool, so anyone can add liquidity to it. Fees are shared pro rata across every position in range, so third-party liquidity lowers the share the locked position earns.
- **A graduation's leftover quote goes to the treasury.** When the venue restores a prepared pool it can end up holding more of one asset than the mint takes. The token side is locked, but the quote side is credited to the protocol rather than to the creator.
- **The exempt allowance can be spent by anyone buying for an exempt wallet.** Exemptions are keyed on the recipient, so a third party can buy for the creator's address during the window, at their own cost, to use up the allowance. The tokens go to the creator, which makes this an expensive nuisance rather than a theft, and the router's atomic opening buy runs before anyone else can act.
- **Post-graduation conversions need the operator.** Converting the launch-token side of pool fees trades against a live pool, so only the sweep operator can do it, with an explicit minimum output. A creator can distribute already-quoted fees alone, but not convert.
- **The factory has little room to grow.** It sits at 96.4% of the deployed-code limit, so further features belong in separate contracts, as the lens already does.

## Risks

Launch tokens are volatile and can lose all their value.

Anyone can create a launch with any name, symbol and image, including ones that deliberately imitate an existing project. Names and symbols are not unique and are not verified by anybody. **The token address is the only identifier that cannot be copied.**

Reaching graduation is not a signal of quality. It means the curve sold out and nothing else.

A launch quoted in another token carries that token's risk on top of its own. If the quote asset falls, the position falls with it; if the quote asset becomes hard to trade, so does the launch, because the pool is paired directly against it.

A creator can set a creator fee at launch, within the protocol cap. Read it before trading.

This code is unaudited. Transactions are irreversible.

## License

MIT. See [LICENSE](LICENSE).
