// Runs the suite against a real EVM. Compile first, then execute every test.
//
//   node tools/test.mjs
//   node tools/test.mjs lifecycle      # only tests whose name matches
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Chainlet, ZERO } from "./harness.mjs";

const root = path.resolve(import.meta.dirname, "..");
execFileSync("node", [path.join(root, "tools", "compile.mjs"), "--tests"], { stdio: "inherit" });

const filter = process.argv[2];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const E = (n) => BigInt(n) * 10n ** 18n;
const BPS = 10_000n;

// Accounts
const ADMIN = "0x1000000000000000000000000000000000000001";
const TREASURY = "0x1000000000000000000000000000000000000002";
const CREATOR = "0x1000000000000000000000000000000000000003";
const TRADER = "0x1000000000000000000000000000000000000004";
const SNIPER = "0x1000000000000000000000000000000000000005";
const OTHER = "0x1000000000000000000000000000000000000006";
const OPERATOR = "0x1000000000000000000000000000000000000007";

// The reference configuration the tests exercise: a fixed billion-token supply,
// a 1% trade fee, a virtual reserve of 1.68 and a target of 4.2, which reserves
// 28.57% of supply for the pool.
const CONFIG = {
  supply: E(1_000_000_000),
  virtualQuote: 168n * 10n ** 16n,
  graduationTarget: 42n * 10n ** 17n,
  tradeFeeBps: 100,
  venueFee: 10_000,
  tickSpacing: 200,
  enabled: true,
};

const params = (overrides = {}) => ({
  name: "Test Launch",
  symbol: "TEST",
  logo: "ipfs://logo",
  description: "A launch created by the test suite.",
  website: "https://example.invalid",
  social: "https://example.invalid/social",
  feeRecipient: ZERO,
  creatorFeeBps: 0,
  buybackEnabled: false,
  expectedEconomics: "0x" + "00".repeat(32),
  salt: "0x" + "01".repeat(32),
  ...overrides,
});

async function deployProtocol({ launchFee = 0n, openingTax = { startBps: 0, window: 5 } } = {}) {
  const c = await Chainlet.create();
  for (const account of [ADMIN, TREASURY, CREATOR, TRADER, SNIPER, OTHER, OPERATOR]) {
    await c.setBalance(account, E(1_000));
  }

  const weth = await c.deploy("MockWrappedNative", [], { from: ADMIN });
  const ammFactory = await c.deploy("MockAmmFactory", [], { from: ADMIN });
  const positions = await c.deploy("MockPositionManager", [ammFactory.address], { from: ADMIN });
  const router = await c.deploy("MockSwapRouter", [], { from: ADMIN });
  const venue = await c.deploy("AmmV3Venue", [positions.address, router.address, weth.address], { from: ADMIN });

  const escrow = await c.deploy("FeeEscrow", [], { from: ADMIN });
  const vault = await c.deploy("BuybackVault", [escrow.address, ADMIN], { from: ADMIN });
  const locker = await c.deploy("LiquidityLocker", [ADMIN], { from: ADMIN });

  const factory = await c.deploy(
    "LaunchFactory",
    [ADMIN, 86_400, escrow.address, vault.address, locker.address, venue.address, TREASURY, launchFee],
    { from: ADMIN },
  );
  const deployer = await c.deploy("LaunchDeployer", [factory.address], { from: ADMIN });
  const collector = await c.deploy(
    "FeeCollector",
    [factory.address, locker.address, escrow.address, vault.address],
    { from: ADMIN },
  );

  await c.send(factory, "wire", [deployer.address, collector.address], { from: ADMIN });
  await c.send(vault, "setFactory", [factory.address], { from: ADMIN });
  await c.send(locker, "setFactory", [factory.address], { from: ADMIN });
  await c.send(factory, "addLaunchConfig", [CONFIG], { from: ADMIN });
  await c.send(factory, "setLaunchEnabled", [true], { from: ADMIN });
  await c.send(factory, "setFeeSweepOperator", [OPERATOR], { from: ADMIN });
  if (openingTax) {
    await c.send(factory, "setOpeningTax", [openingTax.startBps, openingTax.window], { from: ADMIN });
  }

  return { c, weth, ammFactory, positions, router, venue, escrow, vault, locker, factory, deployer, collector };
}

/** Creates a launch and returns handles for its token and curve. */
async function createLaunch(env, overrides = {}, { from = CREATOR, value = 0n } = {}) {
  const { c, factory } = env;
  const { logs } = await c.send(factory, "launch(" + LAUNCH_TUPLE + ",uint256,address)", [params(overrides), 0, ZERO], {
    from,
    value,
  });
  const [event] = c.eventsFrom(logs, "LaunchFactory", "LaunchCreated");
  return {
    token: { name: "LaunchToken", address: event.token.toLowerCase() },
    curve: { name: "BondingCurve", address: event.curve.toLowerCase() },
  };
}

const LAUNCH_TUPLE =
  "(string,string,string,string,string,string,address,uint16,bool,bytes32,bytes32)";

/** Buys until the curve is bought out, returning the number of buys it took. */
async function buyOutCurve(env, curve, buyer = TRADER) {
  const { c } = env;
  let rounds = 0;
  for (; rounds < 40; rounds++) {
    const sellable = await c.call(curve, "sellableTokens");
    if (sellable === 0n) break;
    await c.send(curve, "buy", [E(2), 0, buyer], { from: buyer, value: E(2) });
  }
  return rounds;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  let a = String(actual);
  let b = String(expected);
  if (/^0x[0-9a-fA-F]{40}$/.test(a) && /^0x[0-9a-fA-F]{40}$/.test(b)) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (a !== b) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertClose(actual, expected, tolerance, message) {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff > tolerance) {
    throw new Error(`${message}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

// --- Tests ------------------------------------------------------------------

test("lifecycle: a launch mints to its curve, trades, graduates and locks liquidity", async () => {
  const env = await deployProtocol();
  const { c, factory, locker, positions } = env;
  const { token, curve } = await createLaunch(env);

  // The whole supply starts on the curve, and nobody holds a pre-allocation.
  assertEqual(await c.call(token, "totalSupply"), CONFIG.supply, "supply");
  assertEqual(await c.call(token, "balanceOf", [curve.address]), CONFIG.supply, "curve holds supply");
  assertEqual(await c.call(token, "balanceOf", [CREATOR]), 0n, "creator holds nothing");

  // The reserved allocation is exactly supply * virtual / (virtual + target).
  const expectedFloor = (CONFIG.supply * CONFIG.virtualQuote) / (CONFIG.virtualQuote + CONFIG.graduationTarget);
  assertEqual(await c.call(curve, "reserveFloor"), expectedFloor, "reserve floor");

  const launchBefore = await c.call(factory, "getLaunch", [token.address]);
  assertEqual(launchBefore.phase, 0, "starts on the curve");

  await buyOutCurve(env, curve);

  const launch = await c.call(factory, "getLaunch", [token.address]);
  assertEqual(launch.phase, 2, "ends listed");
  assert(await c.call(locker, "isLocked", [token.address]), "position locked");

  const [positionId] = await c.call(locker, "positionOf", [token.address]);
  assertEqual(await c.call(positions, "ownerOf", [positionId]), locker.address, "locker owns the position");

  // Supply that could not enter the pool at the graduation price is locked too,
  // so it never reaches circulation.
  assert((await c.call(locker, "lockedSupply", [token.address])) > 0n, "excess supply locked");

  // Every token is accounted for: circulating, in the pool, or locked.
  const held = await c.call(token, "balanceOf", [positions.address]);
  const locked = await c.call(locker, "lockedSupply", [token.address]);
  const traderBalance = await c.call(token, "balanceOf", [TRADER]);
  assertClose(held + locked + traderBalance, CONFIG.supply, E(1), "supply conserved");
});

test("quoting: quoteBuy predicts exactly what buy settles, clamped fills included", async () => {
  const env = await deployProtocol();
  const { c } = env;
  const { curve } = await createLaunch(env);

  const quoted = await c.call(curve, "quoteBuy", [E(1), TRADER]);
  const { logs } = await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });
  const [buy] = c.eventsFrom(logs, "BondingCurve", "Buy");
  assertEqual(buy.tokensOut, quoted[0], "tokens out match the quote");
  assertEqual(buy.quoteIn, quoted[1], "spend matches the quote");
  assertEqual(buy.fee, quoted[3] + quoted[5], "fee matches the quote");

  // Come close to the target, then offer far more than the curve can sell.
  await c.send(curve, "buy", [E(3), 0, TRADER], { from: TRADER, value: E(3) });

  const finalQuote = await c.call(curve, "quoteBuy", [E(50), OTHER]);
  assert(finalQuote[2] > 0n, "an oversized buy is quoted a refund");

  const before = await c.balanceOf(OTHER);
  const { logs: finalLogs } = await c.send(curve, "buy", [E(50), 0, OTHER], { from: OTHER, value: E(50) });
  const [finalBuy] = c.eventsFrom(finalLogs, "BondingCurve", "Buy");
  const [refund] = c.eventsFrom(finalLogs, "BondingCurve", "Refunded");

  assertEqual(finalBuy.tokensOut, finalQuote[0], "clamped tokens out match the quote");
  assertEqual(finalBuy.quoteIn, finalQuote[1], "clamped spend matches the quote");
  assertEqual(refund.amount, finalQuote[2], "refund matches the quote");
  assertEqual(await c.balanceOf(OTHER), before - finalQuote[1], "only the spent amount left the buyer");
});

test("quoting: quoteSell predicts exactly what sell settles", async () => {
  const env = await deployProtocol();
  const { c } = env;
  const { token, curve } = await createLaunch(env);

  await c.send(curve, "buy", [E(2), 0, TRADER], { from: TRADER, value: E(2) });
  const balance = await c.call(token, "balanceOf", [TRADER]);
  const half = balance / 2n;

  const quoted = await c.call(curve, "quoteSell", [half]);
  await c.send(token, "approve", [curve.address, half], { from: TRADER });
  const { logs } = await c.send(curve, "sell", [half, 0, TRADER], { from: TRADER });
  const [sell] = c.eventsFrom(logs, "BondingCurve", "Sell");

  assertEqual(sell.quoteOut, quoted[0], "proceeds match the quote");
  assertEqual(sell.fee, quoted[1], "fee matches the quote");
});

test("opening tax: decays from near-total to nothing, and never touches the creator", async () => {
  const env = await deployProtocol({ openingTax: { startBps: 9_900, window: 5 } });
  const { c } = env;
  const { curve } = await createLaunch(env);

  // Bounded so a taxed buy always nets its buyer something: 9900 requested,
  // less the trade fee and the buyer's one-percent floor.
  assertEqual(await c.call(curve, "openingTaxBps", [SNIPER]), 9_800n, "peaks in the launch second");
  assertEqual(await c.call(curve, "openingTaxBps", [CREATOR]), 0n, "the creator is exempt");

  const sniped = (await c.call(curve, "quoteBuy", [E(1), SNIPER]))[0];
  const creatorBuy = (await c.call(curve, "quoteBuy", [E(1), CREATOR]))[0];
  assert(sniped * 50n < creatorBuy, "a sniper gets far less for the same spend");

  // The decay is fast: by the halfway point the tax is already small.
  c.warp(3);
  const mid = await c.call(curve, "openingTaxBps", [SNIPER]);
  assert(mid < 500n, `tax should have mostly decayed, got ${mid}`);

  c.warp(3);
  assertEqual(await c.call(curve, "openingTaxBps", [SNIPER]), 0n, "zero once the window closes");

  // What the tax collected is not burned: it is distributed like any other fee.
  const { logs } = await c.send(curve, "buy", [E(1), 0, OTHER], { from: OTHER, value: E(1) });
  const [buy] = c.eventsFrom(logs, "BondingCurve", "Buy");
  assertEqual(buy.fee, E(1) / 100n, "an untaxed buy pays only the trade fee");
});

test("opening tax: exemptions are fixed at creation and cannot be added later", async () => {
  const env = await deployProtocol({ openingTax: { startBps: 9_900, window: 5 } });
  const { c, factory } = env;

  const { logs } = await c.send(
    factory,
    "launch(" + LAUNCH_TUPLE + ",uint256,address,address[])",
    [params(), 0, ZERO, [OTHER]],
    { from: CREATOR },
  );
  const [event] = c.eventsFrom(logs, "LaunchFactory", "LaunchCreated");
  const curve = { name: "BondingCurve", address: event.curve.toLowerCase() };

  assertEqual(await c.call(curve, "openingTaxBps", [OTHER]), 0n, "a declared wallet is exempt");
  assertEqual(await c.call(curve, "openingTaxBps", [SNIPER]), 9_800n, "an undeclared wallet is not");

  // Only the factory may write an exemption, and the factory offers no path to
  // add one after creation.
  await c.expectRevert(c.send(curve, "exemptFromOpeningTax", [SNIPER], { from: CREATOR }), "NotFactory");
  await c.expectRevert(c.send(curve, "exemptFromOpeningTax", [SNIPER], { from: ADMIN }), "NotFactory");
});

test("fees: the trade fee splits protocol then creator, and reaches the escrow on a sweep", async () => {
  const env = await deployProtocol();
  const { c, escrow, curve: _ignored, factory } = env;
  const { curve } = await createLaunch(env);

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });

  const expectedFee = (E(1) * 100n) / BPS;
  assertEqual(await c.call(curve, "feeBalance"), expectedFee, "fee accrued on the quote leg");
  assertEqual(await c.call(escrow, "balanceOf", [TREASURY]), 0n, "nothing reaches the escrow before a sweep");

  await c.send(curve, "sweepFees", [0], { from: OPERATOR });

  const policy = await c.call(factory, "getFeePolicy", [(await c.call(curve, "token"))]);
  const expectedTreasury = (expectedFee * BigInt(policy.treasuryShareBps)) / BPS;
  assertEqual(await c.call(escrow, "balanceOf", [TREASURY]), expectedTreasury, "protocol share credited");
  assertEqual(
    await c.call(escrow, "balanceOf", [CREATOR]),
    expectedFee - expectedTreasury,
    "creator receives the rest",
  );

  // The escrow pays only on request, and pays the caller.
  const before = await c.balanceOf(CREATOR);
  await c.send(escrow, "claim()", [], { from: CREATOR });
  assertEqual(
    await c.balanceOf(CREATOR),
    before + expectedFee - expectedTreasury,
    "the creator withdrew their balance",
  );
  assertEqual(await c.call(escrow, "balanceOf", [CREATOR]), 0n, "balance cleared after claiming");
});

test("fees: the creator's own fee is paid to them whole and never split", async () => {
  const env = await deployProtocol();
  const { c, escrow } = env;
  const { curve } = await createLaunch(env, { creatorFeeBps: 500 });

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });

  const tradeFee = (E(1) * 100n) / BPS;
  const creatorFee = (E(1) * 500n) / BPS;
  assertEqual(await c.call(curve, "creatorFeeBalance"), creatorFee, "creator fee accrued separately");

  await c.send(curve, "sweepFees", [0], { from: OPERATOR });

  const treasuryShare = (tradeFee * 3_000n) / BPS;
  assertEqual(
    await c.call(escrow, "balanceOf", [CREATOR]),
    tradeFee - treasuryShare + creatorFee,
    "creator gets their fee in full plus their share of the trade fee",
  );
  assertEqual(await c.call(escrow, "balanceOf", [TREASURY]), treasuryShare, "protocol share untouched by it");
});

test("fees: a buyback is funded from the creator's share and vests rather than burning", async () => {
  const env = await deployProtocol();
  const { c, vault, escrow } = env;
  const { token, curve } = await createLaunch(env, { buybackEnabled: true });

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });

  const fee = (E(1) * 100n) / BPS;
  const treasuryShare = (fee * 3_000n) / BPS;
  const creatorShare = fee - treasuryShare;
  const expectedEarmark = (creatorShare * 5_000n) / BPS;
  assertEqual(await c.call(curve, "buybackEarmark"), expectedEarmark, "buyback marked at accrual");

  await c.send(curve, "sweepFees", [1], { from: OPERATOR });

  const locked = await c.call(vault, "totalLocked", [token.address]);
  assert(locked > 0n, "tokens were bought back and locked");
  assertEqual(await c.call(escrow, "balanceOf", [TREASURY]), treasuryShare, "protocol share unaffected");
  assertEqual(
    await c.call(escrow, "balanceOf", [CREATOR]),
    creatorShare - expectedEarmark,
    "the buyback came out of the creator's share",
  );

  // Nothing is immediately withdrawable, and the schedule runs for five years.
  assertEqual(await c.call(vault, "releasable", [token.address]), 0n, "nothing vested yet");
  const duration = await c.call(vault, "VESTING_DURATION");
  assertEqual(duration, 5n * 365n * 86_400n, "five-year schedule");
});

test("fees: a sweep that would trade is refused to anyone but the operator", async () => {
  const env = await deployProtocol();
  const { c } = env;
  const { curve } = await createLaunch(env, { buybackEnabled: true });

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });

  // The creator may not run a sweep that executes a buyback, because that leg
  // trades against the curve at a price they would be choosing the moment for.
  await c.expectRevert(c.send(curve, "sweepFees", [1], { from: CREATOR }), "OperatorRequired");
  await c.expectRevert(c.send(curve, "sweepFees", [1], { from: TRADER }), "NotSweepOperator");
  await c.send(curve, "sweepFees", [1], { from: OPERATOR });
});

test("fees: a sweep with no trade to make is open to the creator", async () => {
  const env = await deployProtocol();
  const { c, escrow } = env;
  const { curve } = await createLaunch(env);

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });
  await c.send(curve, "sweepFees", [0], { from: CREATOR });
  assert((await c.call(escrow, "balanceOf", [CREATOR])) > 0n, "the creator distributed their own fees");
});

test("vesting: a lock releases linearly and pays both sides on either one's call", async () => {
  const env = await deployProtocol();
  const { c, vault, escrow } = env;
  const { token, curve } = await createLaunch(env, { buybackEnabled: true });

  await c.send(curve, "buy", [E(3), 0, TRADER], { from: TRADER, value: E(3) });
  await c.send(curve, "sweepFees", [1], { from: OPERATOR });

  const locked = await c.call(vault, "totalLocked", [token.address]);
  assert(locked > 0n, "something is locked");

  const halfway = (5n * 365n * 86_400n) / 2n;
  c.warp(halfway);
  assertClose(await c.call(vault, "releasable", [token.address]), locked / 2n, locked / 1_000n, "half vested");

  // Either beneficiary releasing pays both, so neither can strand the other.
  await c.send(vault, "release", [token.address], { from: CREATOR });
  const creatorTokens = await c.call(escrow, "balanceOfToken", [CREATOR, token.address]);
  const treasuryTokens = await c.call(escrow, "balanceOfToken", [TREASURY, token.address]);
  assert(creatorTokens > 0n && treasuryTokens > 0n, "both sides credited");
  assertClose(creatorTokens + treasuryTokens, locked / 2n, locked / 1_000n, "half released in total");

  // Nobody else can time a release.
  await c.expectRevert(c.send(vault, "release", [token.address], { from: OTHER }), "NotBeneficiary");

  c.warp(halfway + 10n);
  await c.send(vault, "release", [token.address], { from: TREASURY });
  assertClose(await c.call(vault, "totalReleased", [token.address]), locked, locked / 1_000n, "fully released");
});

test("graduation: selling closes the moment the curve is bought out", async () => {
  const env = await deployProtocol();
  const { c } = env;
  const { token, curve } = await createLaunch(env);

  await c.send(curve, "buy", [E(2), 0, TRADER], { from: TRADER, value: E(2) });
  const balance = await c.call(token, "balanceOf", [TRADER]);
  await c.send(token, "approve", [curve.address, balance], { from: TRADER });
  await c.send(curve, "sell", [balance / 10n, 0, TRADER], { from: TRADER });

  await buyOutCurve(env, curve);

  // Past graduation both directions revert, and the pool is where to trade.
  await c.expectRevert(c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) }), "AlreadySettled");
  await c.expectRevert(c.send(curve, "sell", [E(1), 0, TRADER], { from: TRADER }), "AlreadySettled");
});

test("graduation: the pool opens at the price the curve finished at, every time", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  const prices = [];
  for (const salt of ["0x" + "aa".repeat(32), "0x" + "bb".repeat(32)]) {
    const { token, curve } = await createLaunch(env, { salt });
    // One launch is bought out in large steps, the other in small ones.
    const step = salt.includes("aa") ? E(4) : E(1);
    for (let i = 0; i < 40; i++) {
      if ((await c.call(curve, "sellableTokens")) === 0n) break;
      await c.send(curve, "buy", [step, 0, TRADER], { from: TRADER, value: step });
    }
    const record = await c.call(factory, "getLaunch", [token.address]);
    assertEqual(record.phase, 2, "listed");
    prices.push(record.graduationTarget);
  }

  // Both launches graduated on the same terms, which is the guarantee: the
  // route to graduation does not change the destination.
  assertEqual(prices[0], prices[1], "both graduated against the same target");
});

test("graduation: listing is permissionless and retryable when it first fails", async () => {
  const env = await deployProtocol();
  const { c, factory, positions, locker } = env;
  const { token, curve } = await createLaunch(env);

  // The venue refuses to mint, so graduation settles but cannot list.
  await c.send(positions, "setMintReverts", [true], { from: ADMIN });
  await buyOutCurve(env, curve);

  const settled = await c.call(factory, "getLaunch", [token.address]);
  assertEqual(settled.phase, 1, "waiting in the settled phase");
  assert(settled.settledQuote > 0n, "reserves are held by the protocol");
  await c.expectRevert(c.send(factory, "list", [token.address], { from: OTHER }), "mint reverts");

  // Anyone can finish it once the obstacle clears.
  await c.send(positions, "setMintReverts", [false], { from: ADMIN });
  await c.send(factory, "list", [token.address], { from: OTHER });

  assertEqual((await c.call(factory, "getLaunch", [token.address])).phase, 2, "listed by a third party");
  assert(await c.call(locker, "isLocked", [token.address]), "position locked");
});

test("graduation: a launch that can never list is refundable, but only after the wait", async () => {
  const env = await deployProtocol();
  const { c, factory, positions } = env;
  const { token, curve } = await createLaunch(env);

  await c.send(positions, "setMintReverts", [true], { from: ADMIN });
  await buyOutCurve(env, curve);

  await c.expectRevert(c.send(factory, "refundSettled", [token.address, OTHER], { from: ADMIN }), "RescueTooEarly");

  // Listing stays open throughout the wait, which is what makes the wait safe.
  c.warp(7 * 86_400 + 1);
  await c.send(factory, "refundSettled", [token.address, OTHER], { from: ADMIN });

  const record = await c.call(factory, "getLaunch", [token.address]);
  assertEqual(record.phase, 3, "permanently marked as refunded");
  assert((await c.balanceOf(OTHER)) > E(1_000), "reserves were returned");
});

test("liquidity: the locker has no way to release a position", async () => {
  const env = await deployProtocol();
  const { c, locker, positions } = env;
  const { token, curve } = await createLaunch(env);
  await buyOutCurve(env, curve);

  // Nothing in the locker's own interface can move a position or its principal.
  const abi = c.artifacts.LiquidityLocker.abi;
  const writable = abi
    .filter((entry) => entry.type === "function" && entry.stateMutability !== "view" && entry.stateMutability !== "pure")
    .map((entry) => entry.name);
  const forbidden = writable.filter((name) =>
    /transfer|withdraw|unlock|release|decrease|burn|execute|call|sweep|rescue|upgrade|renounce/i.test(name),
  );
  assertEqual(forbidden.length, 0, `locker exposes ${forbidden.join(", ")}`);
  assertEqual(writable.sort().join(","), "collectFees,lockPosition,lockSupply,setFactory", "locker's write surface");

  // And the factory, which is its only privileged caller, cannot lock twice.
  const [positionId] = await c.call(locker, "positionOf", [token.address]);
  assertEqual(await c.call(positions, "ownerOf", [positionId]), locker.address, "still held");
  await c.expectRevert(c.send(locker, "lockPosition", [token.address, positionId, ZERO], { from: ADMIN }), "NotFactory");
});

test("liquidity: the launch token has no owner, mint, pause or blocklist", async () => {
  const env = await deployProtocol();
  const { c } = env;
  const { token } = await createLaunch(env);

  const names = c.artifacts.LaunchToken.abi
    .filter((entry) => entry.type === "function")
    .map((entry) => entry.name);
  const forbidden = names.filter((name) =>
    /^(mint|pause|unpause|blacklist|blocklist|setFee|setTax|owner|transferOwnership|upgradeTo)$/i.test(name),
  );
  assertEqual(forbidden.length, 0, `token exposes ${forbidden.join(", ")}`);

  // Burning is the holder's own choice: it lowers supply and can never raise it.
  assertEqual(await c.call(token, "totalSupply"), CONFIG.supply, "supply is the launch supply");
  assert(names.includes("burn"), "a holder can burn their own balance");
});

test("terms: a configuration's economics cannot be edited, only closed to new launches", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  const names = c.artifacts.LaunchFactory.abi
    .filter((entry) => entry.type === "function")
    .map((entry) => entry.name);
  assert(!names.includes("updateLaunchConfig"), "there is no way to edit a configuration in place");

  const stored = await c.call(factory, "getLaunchConfig", [0]);
  assertEqual(stored.supply, CONFIG.supply, "configuration reads back as added");

  await c.send(factory, "setLaunchConfigEnabled", [0, false], { from: ADMIN });
  await c.expectRevert(c.send(factory, "launch(" + LAUNCH_TUPLE + ",uint256,address)", [params(), 0, ZERO], { from: CREATOR }), "ConfigDisabled");

  // A disabled configuration is still readable, so historic launches stay
  // explainable.
  assertEqual((await c.call(factory, "getLaunchConfig", [0])).supply, CONFIG.supply, "still readable");
});

test("terms: a pinned quote makes a launch revert rather than reprice", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  const pinned = await c.call(factory, "previewEconomics", [0, ZERO]);
  await c.send(
    factory,
    "setFeePolicy",
    [{ treasury: TREASURY, treasuryShareBps: 4_000, buybackShareBps: 5_000, maxPriceImpactBps: 300 }],
    { from: ADMIN },
  );

  await c.expectRevert(
    c.send(factory, "launch(" + LAUNCH_TUPLE + ",uint256,address)", [params({ expectedEconomics: pinned }), 0, ZERO], {
      from: CREATOR,
    }),
    "EconomicsChanged",
  );

  // Re-reading the terms and pinning those succeeds.
  const fresh = await c.call(factory, "previewEconomics", [0, ZERO]);
  await c.send(factory, "launch(" + LAUNCH_TUPLE + ",uint256,address)", [params({ expectedEconomics: fresh }), 0, ZERO], {
    from: CREATOR,
  });
});

test("terms: a creator fee above the cap is refused, and the cap cannot be raised past the ceiling", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  await c.expectRevert(
    c.send(factory, "launch(" + LAUNCH_TUPLE + ",uint256,address)", [params({ creatorFeeBps: 1_001 }), 0, ZERO], {
      from: CREATOR,
    }),
    "CreatorFeeTooHigh",
  );
  await c.expectRevert(c.send(factory, "setMaxCreatorFeeBps", [1_001], { from: ADMIN }), "InvalidBps");

  // A launch keeps the fee it was created with even if the cap later drops.
  const { curve } = await createLaunch(env, { creatorFeeBps: 1_000 });
  await c.send(factory, "setMaxCreatorFeeBps", [0], { from: ADMIN });
  assertEqual(await c.call(curve, "creatorFeeBps"), 1_000n, "the launch keeps its own fee");
});

test("creator controls: fees can be handed over, and only by whoever holds them", async () => {
  const env = await deployProtocol();
  const { c, factory, curve: _c, escrow } = env;
  const { token, curve } = await createLaunch(env);

  await c.expectRevert(c.send(factory, "transferFeeRecipient", [token.address, OTHER], { from: OTHER }), "NotFeeRecipient");
  await c.send(factory, "transferFeeRecipient", [token.address, OTHER], { from: CREATOR });

  assertEqual(await c.call(curve, "feeRecipient"), OTHER, "the curve now pays the new address");
  assertEqual((await c.call(factory, "getLaunch", [token.address])).feeRecipient, OTHER, "record updated");

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });
  await c.send(curve, "sweepFees", [0], { from: OPERATOR });
  assert((await c.call(escrow, "balanceOf", [OTHER])) > 0n, "fees reach the new recipient");
  assertEqual(await c.call(escrow, "balanceOf", [CREATOR]), 0n, "and not the old one");
});

test("creator controls: only the creator may switch buybacks on; the protocol may only switch them off", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;
  const { token, curve } = await createLaunch(env);

  // The buyback is funded from the creator's own share, so nobody else can
  // spend it for them.
  await c.expectRevert(c.send(factory, "setBuybackEnabled", [token.address, true], { from: ADMIN }), "NotBuybackController");
  await c.expectRevert(c.send(factory, "setBuybackEnabled", [token.address, true], { from: OTHER }), "NotBuybackController");

  await c.send(factory, "setBuybackEnabled", [token.address, true], { from: CREATOR });
  assert(await c.call(curve, "buybackEnabled"), "creator switched it on");

  // Switching it off is favourable to the creator, so the protocol may do it.
  await c.send(factory, "setBuybackEnabled", [token.address, false], { from: ADMIN });
  assert(!(await c.call(curve, "buybackEnabled")), "protocol switched it off");
});

test("creator controls: a protocol override of fee routing serves notice and expires", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;
  const { token, curve } = await createLaunch(env);

  await c.expectRevert(c.send(factory, "proposeFeeRecipient", [token.address, OTHER], { from: OTHER }), "revert");
  const { logs } = await c.send(factory, "proposeFeeRecipient", [token.address, OTHER], { from: ADMIN });
  const [proposal] = c.eventsFrom(logs, "LaunchFactory", "FeeRecipientChangeProposed");
  assertEqual(proposal.proposed, OTHER, "the proposal names the address");
  assert(proposal.effectiveAt > BigInt(c.now), "and the date it takes effect");

  // Nothing happens during the notice period.
  await c.expectRevert(c.send(factory, "executeFeeRecipientChange", [token.address], { from: OTHER }), "TimelockNotElapsed");
  assertEqual(await c.call(curve, "feeRecipient"), CREATOR, "unchanged while pending");

  // Afterwards anyone may carry it out, so the protocol cannot sit on it.
  c.warp(3 * 86_400 + 1);
  await c.send(factory, "executeFeeRecipientChange", [token.address], { from: OTHER });
  assertEqual(await c.call(curve, "feeRecipient"), OTHER, "applied after the wait");

  // A second proposal left to expire can no longer be executed.
  await c.send(factory, "proposeFeeRecipient", [token.address, TRADER], { from: ADMIN });
  c.warp(7 * 86_400);
  await c.expectRevert(c.send(factory, "executeFeeRecipientChange", [token.address], { from: OTHER }), "TimelockExpired");
  assertEqual(await c.call(curve, "feeRecipient"), OTHER, "an expired proposal changes nothing");
});

test("router: creating and buying in one transaction leaves no gap to front-run", async () => {
  const env = await deployProtocol({ launchFee: 10n ** 15n });
  const { c, factory } = env;

  const router = await c.deploy("LaunchRouter", [factory.address], { from: ADMIN });
  await c.send(factory, "setForwarder", [router.address], { from: ADMIN });

  const launchFee = await c.call(factory, "launchFee");
  const spend = E(3);
  const { logs } = await c.send(
    router,
    "launchAndBuy",
    [params({ feeRecipient: CREATOR }), 0, ZERO, spend, 0, CREATOR, []],
    { from: CREATOR, value: launchFee + spend },
  );

  const [launched] = c.eventsFrom(logs, "LaunchRouter", "Launched");
  assert(launched.tokensReceived > 0n, "the opening buy settled in the same transaction");

  const record = await c.call(factory, "getLaunch", [launched.token]);
  assertEqual(record.creator, CREATOR, "the launch is attributed to the caller, not the router");

  const token = { name: "LaunchToken", address: launched.token.toLowerCase() };
  assertEqual(await c.call(token, "balanceOf", [CREATOR]), launched.tokensReceived, "tokens went to the recipient");

  // Only the configured router may name another account as creator.
  await c.expectRevert(
    c.send(factory, "launchFor", [params({ feeRecipient: CREATOR }), 0, ZERO, OTHER, []], { from: OTHER }),
    "NotForwarder",
  );
});

test("post-graduation: pool fees are converted to the quote asset before they are split", async () => {
  const env = await deployProtocol();
  const { c, factory, positions, router, weth, escrow, collector, locker } = env;
  const { token, curve } = await createLaunch(env);
  await buyOutCurve(env, curve);

  const [positionId] = await c.call(locker, "positionOf", [token.address]);

  // The pool owes fees on both sides, as a real pool would after trading in
  // both directions. One account funds both legs for simplicity.
  const quoteFees = E(1);
  const tokenFees = E(100_000);
  await c.send(token, "transfer", [ADMIN, tokenFees], { from: TRADER });
  await c.send(weth, "deposit", [], { from: ADMIN, value: quoteFees });
  await c.send(token, "approve", [positions.address, tokenFees], { from: ADMIN });
  await c.send(weth, "approve", [positions.address, quoteFees], { from: ADMIN });

  const tokenIsFirst = token.address.toLowerCase() < weth.address.toLowerCase();
  const amount0 = tokenIsFirst ? tokenFees : quoteFees;
  const amount1 = tokenIsFirst ? quoteFees : tokenFees;
  await c.send(positions, "accrueFees", [positionId, amount0, amount1], { from: ADMIN });

  // One launch token converts to a little quote asset.
  await c.send(router, "setRate", [token.address, weth.address, 10n ** 13n], { from: ADMIN });
  await c.send(weth, "deposit", [], { from: ADMIN, value: E(5) });
  await c.send(weth, "transfer", [router.address, E(5)], { from: ADMIN });

  // A conversion is price-sensitive, so the creator cannot run it themselves.
  await c.expectRevert(c.send(collector, "collect", [token.address, 1, 0], { from: CREATOR }), "OperatorRequired");

  await c.send(collector, "collect", [token.address, 1, 0], { from: OPERATOR });

  // The creator is paid in the asset the launch traded in, not in its own token.
  const creatorBalance = await c.call(escrow, "balanceOf", [CREATOR]);
  const treasuryBalance = await c.call(escrow, "balanceOf", [TREASURY]);
  assert(creatorBalance > 0n, "creator credited in the quote asset");
  assert(treasuryBalance > 0n, "protocol credited in the quote asset");
  assertEqual(await c.call(escrow, "balanceOfToken", [CREATOR, token.address]), 0n, "and never in the launch token");

  const policy = await c.call(factory, "getFeePolicy", [token.address]);
  const total = creatorBalance + treasuryBalance;
  assertClose(treasuryBalance, (total * BigInt(policy.treasuryShareBps)) / BPS, total / 1_000n, "split as recorded");
});

test("quote assets: an ERC-20 must be approved, with economics in its own decimals", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  const usd = await c.deploy("MockERC20", ["Stable", "USD", 6], { from: ADMIN });

  await c.expectRevert(
    c.send(factory, "launch(" + LAUNCH_TUPLE + ",uint256,address)", [params(), 0, usd.address], { from: CREATOR }),
    "QuoteAssetNotApproved",
  );

  // Terms must exist before approval, and the scale must match what the asset
  // itself reports.
  await c.expectRevert(c.send(factory, "setQuoteAssetApproved", [usd.address, true], { from: ADMIN }), "QuoteAssetTermsMissing");
  await c.expectRevert(
    c.send(factory, "setQuoteAssetTerms", [usd.address, 3_236_000_000, 8_090_000_000, 18], { from: ADMIN }),
    "QuoteAssetDecimalsMismatch",
  );

  await c.send(factory, "setQuoteAssetTerms", [usd.address, 3_236_000_000, 8_090_000_000, 6], { from: ADMIN });
  await c.send(factory, "setQuoteAssetApproved", [usd.address, true], { from: ADMIN });

  const { logs } = await c.send(
    factory,
    "launch(" + LAUNCH_TUPLE + ",uint256,address)",
    [params({ salt: "0x" + "cc".repeat(32) }), 0, usd.address],
    { from: CREATOR },
  );
  const [event] = c.eventsFrom(logs, "LaunchFactory", "LaunchCreated");
  assertEqual(event.quote.toLowerCase(), usd.address.toLowerCase(), "the launch is quoted in the asset");

  const curve = { name: "BondingCurve", address: event.curve.toLowerCase() };
  assertEqual(await c.call(curve, "graduationTarget"), 8_090_000_000n, "target in the asset's own decimals");
  assert(!(await c.call(curve, "isNativeQuote")), "not a native launch");

  // An ERC-20 launch takes no native value, and takes the asset by approval.
  await c.send(usd, "mint", [TRADER, 1_000_000_000], { from: ADMIN });
  await c.expectRevert(
    c.send(curve, "buy", [1_000_000, 0, TRADER], { from: TRADER, value: 1n }),
    "UnexpectedNativeValue",
  );
  await c.send(usd, "approve", [curve.address, 1_000_000], { from: TRADER });
  await c.send(curve, "buy", [1_000_000, 0, TRADER], { from: TRADER });
  assertEqual(await c.call(curve, "trackedQuote"), 1_000_000n, "the curve holds what it received");
});

test("quote assets: a token that keeps part of a transfer is credited only what arrived", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  const fot = await c.deploy("MockFeeOnTransferToken", [200], { from: ADMIN });
  await c.send(factory, "setQuoteAssetTerms", [fot.address, E(2), E(5), 18], { from: ADMIN });
  await c.send(factory, "setQuoteAssetApproved", [fot.address, true], { from: ADMIN });

  const { logs } = await c.send(
    factory,
    "launch(" + LAUNCH_TUPLE + ",uint256,address)",
    [params({ salt: "0x" + "dd".repeat(32) }), 0, fot.address],
    { from: CREATOR },
  );
  const [event] = c.eventsFrom(logs, "LaunchFactory", "LaunchCreated");
  const curve = { name: "BondingCurve", address: event.curve.toLowerCase() };

  await c.send(fot, "mint", [TRADER, E(10)], { from: ADMIN });
  await c.send(fot, "approve", [curve.address, E(1)], { from: TRADER });
  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER });

  // Two percent was kept by the token, so the curve credits 98%.
  assertEqual(await c.call(curve, "trackedQuote"), (E(1) * 98n) / 100n, "credited what arrived");
});

test("registry: launches are enumerable from the chain alone", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  const first = await createLaunch(env, { salt: "0x" + "11".repeat(32) });
  const second = await createLaunch(env, { salt: "0x" + "22".repeat(32) }, { from: OTHER });

  assertEqual(await c.call(factory, "launchCount"), 2n, "two launches");
  assertEqual((await c.call(factory, "launchAt", [0])).toLowerCase(), first.token.address, "first by index");
  assertEqual((await c.call(factory, "launchAt", [1])).toLowerCase(), second.token.address, "second by index");

  const byCreator = await c.call(factory, "launchesOf", [CREATOR]);
  assertEqual(byCreator.length, 1, "one launch for this creator");
  assertEqual(byCreator[0].toLowerCase(), first.token.address, "and it is theirs");

  const page = await c.call(factory, "launchesPaged", [1, 10]);
  assertEqual(page.length, 1, "paging past the end stops at the end");
});

test("access: launching is gated, and the gate cannot reach a live launch", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;
  const { curve } = await createLaunch(env);

  await c.send(factory, "setLaunchEnabled", [false], { from: ADMIN });
  assert(!(await c.call(factory, "canLaunch", [OTHER])), "creation closed");
  await c.expectRevert(
    c.send(factory, "launch(" + LAUNCH_TUPLE + ",uint256,address)", [params({ salt: "0x" + "ee".repeat(32) }), 0, ZERO], {
      from: OTHER,
    }),
    "NotWhitelisted",
  );

  await c.send(factory, "setWhitelisted", [OTHER, true], { from: ADMIN });
  assert(await c.call(factory, "canLaunch", [OTHER]), "whitelisted while closed");

  // Closing creation does not stop the launch that already exists.
  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });
  assert((await c.call(curve, "trackedQuote")) > 0n, "trading continues regardless");
});

test("access: configuration is role-gated and the admin handover is delayed", async () => {
  const env = await deployProtocol();
  const { c, factory } = env;

  await c.expectRevert(c.send(factory, "setLaunchFee", [1], { from: OTHER }), "revert");
  await c.expectRevert(c.send(factory, "setVenue", [OTHER], { from: OTHER }), "revert");
  await c.expectRevert(c.send(factory, "setQuoteAssetApproved", [OTHER, true], { from: OTHER }), "revert");

  // The admin role is the one that grants the others, and handing it over
  // serves notice first.
  assertEqual(await c.call(factory, "defaultAdminDelay"), 86_400n, "handover delay");
  await c.send(factory, "beginDefaultAdminTransfer", [OTHER], { from: ADMIN });
  const [newAdmin, schedule] = await c.call(factory, "pendingDefaultAdmin");
  assertEqual(newAdmin, OTHER, "handover announced");
  assert(schedule > BigInt(c.now), "and dated");
  await c.expectRevert(c.send(factory, "acceptDefaultAdminTransfer", [], { from: OTHER }), "revert");
});

test("safety: a recipient that refuses payment cannot block anybody else", async () => {
  const env = await deployProtocol();
  const { c, escrow } = env;
  const { curve } = await createLaunch(env);

  const rejecting = await c.deploy("RejectingRecipient", [], { from: ADMIN });
  await c.send(env.factory, "transferFeeRecipient", [await c.call(curve, "token"), rejecting.address], { from: CREATOR });

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });
  // The sweep credits the escrow rather than pushing value, so it succeeds even
  // though this recipient could never receive a transfer.
  await c.send(curve, "sweepFees", [0], { from: OPERATOR });
  assert((await c.call(escrow, "balanceOf", [rejecting.address])) > 0n, "credited despite being unable to receive");
  assert((await c.call(escrow, "balanceOf", [TREASURY])) > 0n, "and the protocol was paid regardless");

  // Only the claim fails, and only for that recipient.
  await c.expectRevert(c.send(escrow, "claim()", [], { from: rejecting.address }), "revert");
});

test("safety: donations to a curve cannot move its price or its graduation", async () => {
  const env = await deployProtocol();
  const { c, token: _t } = env;
  const { token, curve } = await createLaunch(env);

  const before = await c.call(curve, "reserves");
  await c.setBalance(curve.address, E(100));
  const after = await c.call(curve, "reserves");
  assertEqual(after[0], before[0], "a native donation does not move the quote reserve");

  await c.send(curve, "buy", [E(1), 0, TRADER], { from: TRADER, value: E(1) });
  await c.send(token, "transfer", [curve.address, await c.call(token, "balanceOf", [TRADER])], { from: TRADER });
  const reserves = await c.call(curve, "reserves");
  const tracked = await c.call(curve, "trackedTokens");
  assertEqual(reserves[1], tracked, "a token donation does not move the token reserve");
});

// --- Runner -----------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

for (const { name, fn } of tests) {
  if (filter && !name.includes(filter)) continue;
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
  }
}

if (failures.length > 0) {
  console.log("");
  for (const { name, error } of failures) {
    console.log(`--- ${name}\n    ${error.message}\n`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
