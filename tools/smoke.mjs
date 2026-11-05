// End-to-end check against a live deployment: creates a launch on the cheap
// smoke-test configuration, sabotages its pool before graduation the way an
// attacker would, buys the curve out, and confirms the launch still listed at
// the curve's own price with its liquidity locked.
//
//   NETWORK=sepolia RPC_URL=... PRIVATE_KEY=... node tools/smoke.mjs
//
// Reads addresses from deployments/<NETWORK>.json. Spends roughly the smoke
// configuration's graduation target plus gas.
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, Interface, parseEther, parseUnits, ZeroAddress } from "ethers";

const root = path.resolve(import.meta.dirname, "..");
const network = process.env.NETWORK ?? "sepolia";
const deployment = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${network}.json`), "utf8"));
const abi = (name) => JSON.parse(fs.readFileSync(path.join(root, "out", `${name}.json`), "utf8")).abi;

const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { staticNetwork: true });
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const tip = parseUnits(process.env.PRIORITY_FEE_GWEI ?? "0.01", "gwei");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fees(extra = {}) {
  const block = await provider.getBlock("latest");
  return { maxPriorityFeePerGas: tip, maxFeePerGas: block.baseFeePerGas * 3n + tip, ...extra };
}

// The buy that finishes a curve also graduates it, inside a try/catch so the
// buy itself can never fail on graduation. Gas estimation therefore finds the
// smallest budget at which the buy succeeds, which is one where graduation has
// quietly run out of gas. An explicit limit is what lets it complete.
const GRADUATION_GAS = 25_000_000n;

// Public RPC endpoints are load-balanced, and the node answering one request
// can be a block behind the node that accepted the previous transaction. So
// nothing below reads back state it has just written: addresses and amounts
// come from receipts and events, steps whose gas estimate would run against
// stale state carry an explicit limit, and each transaction is followed by a
// short pause before the next one is built.
async function send(pending) {
  const receipt = await (await pending).wait();
  await sleep(4000);
  return receipt;
}

function eventsIn(receipt, iface, name) {
  return receipt.logs
    .map((log) => { try { return iface.parseLog(log); } catch { return null; } })
    .filter((parsed) => parsed?.name === name);
}

const factory = new Contract(deployment.contracts.LaunchFactory.address, abi("LaunchFactory"), wallet);
const venue = new Contract(deployment.contracts.AmmV3Venue.address, abi("AmmV3Venue"), wallet);
const locker = new Contract(deployment.contracts.LiquidityLocker.address, abi("LiquidityLocker"), wallet);
const configId = deployment.configs.findIndex((c) => c.label === "smoke-test");
if (configId < 0) throw new Error("no smoke-test configuration in this deployment");
const smoke = deployment.configs[configId];

const ammFactoryAbi = [
  "function getPool(address,address,uint24) view returns (address)",
  "function createPool(address,address,uint24) returns (address)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];
const poolAbi = [
  "function initialize(uint160 sqrtPriceX96)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
];
const wethAbi = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const managerAbi = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)",
  "function ownerOf(uint256) view returns (address)",
];

function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

function seedPrice(token, quoteToken, tokenAmount, quoteAmount) {
  const tokenIsFirst = token.toLowerCase() < quoteToken.toLowerCase();
  const [a0, a1] = tokenIsFirst ? [tokenAmount, quoteAmount] : [quoteAmount, tokenAmount];
  return isqrt((a1 << 192n) / a0);
}

function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

console.log(`smoke test on ${network} as ${wallet.address}, configuration #${configId}\n`);

// 1. Create the launch.
const params = {
  name: "Smoke Test",
  symbol: "SMOKE",
  logo: "",
  description: "End-to-end check of a live deployment.",
  website: "",
  social: "",
  feeRecipient: ZeroAddress,
  creatorFeeBps: 100,
  buybackEnabled: false,
  expectedEconomics: await factory.previewEconomics(configId, ZeroAddress),
  salt: "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
};
const launchFee = await factory.launchFee();
const launchTx = await factory["launch((string,string,string,string,string,string,address,uint16,bool,bytes32,bytes32),uint256,address)"](
  params, configId, ZeroAddress, await fees({ value: launchFee }),
);
const launchReceipt = await launchTx.wait();
await sleep(4000);
const created = launchReceipt.logs.map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
  .find((parsed) => parsed?.name === "LaunchCreated");
const tokenAddress = created.args.token;
const curve = new Contract(created.args.curve, abi("BondingCurve"), wallet);
const token = new Contract(tokenAddress, abi("LaunchToken"), wallet);
console.log(`launch   ${launchReceipt.hash}`);
console.log(`token    ${tokenAddress}`);
console.log(`curve    ${created.args.curve}\n`);

// 2. Let the opening window close, so this account trades on public terms.
const window = await curve.openingTaxWindow();
await sleep(Number(window + 13n) * 1000);

// 3. Act as an attacker: buy some of the token, then create and seed its pool
//    at a price nine times wrong before the launch can graduate.
const wethAddress = deployment.wrappedNative;
const weth = new Contract(wethAddress, wethAbi, wallet);
const manager = new Contract(deployment.positionManager, managerAbi, wallet);
const ammFactory = new Contract(await venue.ammFactory(), ammFactoryAbi, wallet);

const attackerBuy = await send(curve.buy(parseEther("0.0005"), 0, wallet.address, await fees({ value: parseEther("0.0005") })));
const attackerTokens = eventsIn(attackerBuy, curve.interface, "Buy")[0].args.tokensOut;
const attackerWeth = parseEther("0.0002");
await send(weth.deposit(await fees({ value: attackerWeth })));

const floor = (BigInt(smoke.supply) * BigInt(smoke.virtualQuote)) / (BigInt(smoke.virtualQuote) + BigInt(smoke.graduationTarget));
const seedTokens = (floor * BigInt(smoke.graduationTarget)) / (BigInt(smoke.graduationTarget) + BigInt(smoke.virtualQuote));
const fair = seedPrice(tokenAddress, wethAddress, seedTokens, BigInt(smoke.graduationTarget));
const falsePrice = fair * 3n;

const created_ = await send(ammFactory.createPool(tokenAddress, wethAddress, smoke.venueFee, await fees()));
const poolAddress = eventsIn(created_, ammFactory.interface, "PoolCreated")[0].args.pool;
const pool = new Contract(poolAddress, poolAbi, wallet);
await send(pool.initialize(falsePrice, await fees({ gasLimit: 2_000_000n })));

await send(token.approve(deployment.positionManager, attackerTokens, await fees({ gasLimit: 500_000n })));
await send(weth.approve(deployment.positionManager, attackerWeth, await fees({ gasLimit: 500_000n })));
const tokenIsFirst = tokenAddress.toLowerCase() < wethAddress.toLowerCase();
await send(manager.mint({
  token0: tokenIsFirst ? tokenAddress : wethAddress,
  token1: tokenIsFirst ? wethAddress : tokenAddress,
  fee: smoke.venueFee,
  tickLower: -887200,
  tickUpper: 887200,
  amount0Desired: tokenIsFirst ? attackerTokens : attackerWeth,
  amount1Desired: tokenIsFirst ? attackerWeth : attackerTokens,
  amount0Min: 0,
  amount1Min: 0,
  recipient: wallet.address,
  deadline: Math.floor(Date.now() / 1000) + 600,
}, await fees({ gasLimit: 5_000_000n })));

const [sabotaged] = await pool.slot0();
const attackerLiquidity = await pool.liquidity();
console.log(`pool     ${poolAddress}`);
check(sabotaged === falsePrice, "the pool was pre-initialized at a false price");
check(attackerLiquidity > 0n, "and seeded with attacker liquidity at that price");

// 4. Buy the curve out. The finishing buy graduates the launch.
const remaining = await curve.sellableTokens();
console.log(`\nbuying out ${remaining} remaining tokens`);
const buyoutValue = BigInt(smoke.graduationTarget) * 2n;
const buyout = await send(curve.buy(buyoutValue, 0, wallet.address, await fees({ value: buyoutValue, gasLimit: GRADUATION_GAS })));
console.log(`buy-out  ${buyout.hash}  gas ${buyout.gasUsed}`);

let launch = await factory.getLaunch(tokenAddress);
if (launch.phase === 0n) {
  console.log("graduation deferred; finishing it with a permissionless call");
  await send(factory.graduate(tokenAddress, await fees({ gasLimit: GRADUATION_GAS })));
  launch = await factory.getLaunch(tokenAddress);
}
if (launch.phase === 1n) {
  console.log("listing deferred; finishing it with a permissionless call");
  await send(factory.list(tokenAddress, await fees({ gasLimit: GRADUATION_GAS })));
  launch = await factory.getLaunch(tokenAddress);
}

// 5. Confirm the outcome. Every read is pinned to a block the outcome is
//    already in and retried, so a lagging node cannot report a stale state.
console.log("");
const settledAt = { blockTag: (await provider.getBlockNumber()) };
async function stable(read) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 8) throw error;
      await sleep(5000);
    }
  }
}
launch = await stable(() => factory.getLaunch(tokenAddress, settledAt));
check(launch.phase === 2n, "the launch graduated and listed");
check(await stable(() => locker.isLocked(tokenAddress, settledAt)), "its position is locked");
const [positionId] = await stable(() => locker.positionOf(tokenAddress, settledAt));
const owner = await stable(() => manager.ownerOf(positionId, settledAt));
check(owner.toLowerCase() === (await locker.getAddress()).toLowerCase(), "the locker owns the position");

const venueIface = new Interface(abi("AmmV3Venue"));
const factoryIface = new Interface(abi("LaunchFactory"));
const logsOf = async (hash) => (await provider.getTransactionReceipt(hash)).logs;
const allLogs = [...(await logsOf(buyout.hash))];
const parse = (iface, name) => allLogs.map((log) => { try { return iface.parseLog(log); } catch { return null; } }).filter((p) => p?.name === name);

const [listed] = parse(factoryIface, "LaunchListed");
const [restored] = parse(venueIface, "PoolPriceRestored");
const [finalPrice] = await stable(() => pool.slot0(settledAt));
if (listed) {
  const target = seedPrice(tokenAddress, wethAddress, listed.args.tokenAmount, listed.args.quoteAmount);
  check(finalPrice === target, "the pool opened at exactly the curve's own price");
}
if (restored) {
  check(restored.args.from === falsePrice, "the venue found the attacker's price");
  console.log(`  ..  price restored from ${restored.args.from} to ${restored.args.to}`);
}
check(finalPrice !== falsePrice, "the attacker's price did not survive");
check((await stable(() => pool.liquidity(settledAt))) > attackerLiquidity, "the launch's liquidity went in on top");

console.log(`\nsmoke test passed`);
