// Deploys the whole stack, wires it, adds launch configurations, and records
// every address and constructor argument for verification.
//
// Three contracts need an address that only exists after the contract that
// needs it, so the order below is not arbitrary. The vault, the locker and the
// factory are deployed first; the deployer, collector, router and lens follow,
// because their constructors take the factory; and the factory is then told
// about them. Each wiring call can be made exactly once.
//
//   NETWORK=sepolia RPC_URL=... PRIVATE_KEY=... node tools/deploy.mjs
//   NETWORK=sepolia ADD=PoolRouter RPC_URL=... PRIVATE_KEY=... node tools/deploy.mjs   # add to an existing deployment
//
// A known NETWORK supplies the AMM's addresses; any other network needs
// POSITION_MANAGER and WRAPPED_NATIVE. TREASURY and ADMIN default to the
// deploying account. Add DRY_RUN=1 to print the plan without sending anything.
//
// Node only routes through an HTTP proxy when NODE_USE_ENV_PROXY=1 is set, so
// set it in environments that reach the network through one.
import fs from "node:fs";
import path from "node:path";
import { ContractFactory, Contract, JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "out");

/** AMM deployments the script knows, confirmed against each chain. */
const NETWORKS = {
  sepolia: {
    chainId: 11155111,
    positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
    wrappedNative: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    explorer: "https://sepolia.etherscan.io",
  },
};

/**
 * Configurations added at deployment. The first is the reference economics
 * the documentation describes; the second graduates for a hundredth of a
 * unit, so a live end-to-end run costs almost nothing on a test network.
 */
const CONFIGS = [
  {
    label: "reference",
    supply: parseEther("1000000000"),
    virtualQuote: parseEther("1.68"),
    graduationTarget: parseEther("4.2"),
    tradeFeeBps: 100,
    venueFee: 10_000,
    tickSpacing: 200,
    enabled: true,
  },
  {
    label: "smoke-test",
    supply: parseEther("1000000000"),
    virtualQuote: parseEther("0.004"),
    graduationTarget: parseEther("0.01"),
    tradeFeeBps: 100,
    venueFee: 10_000,
    tickSpacing: 200,
    enabled: true,
  },
];

function artifact(name) {
  const file = path.join(outDir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`run "npm run build" first: missing ${name}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function env(key, fallback) {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === "") throw new Error(`set ${key}`);
  return value;
}

const networkName = process.env.NETWORK ?? "custom";
const preset = NETWORKS[networkName] ?? {};

const plan = [
  "FeeEscrow()",
  "BuybackVault(escrow, deployer)",
  "LiquidityLocker(deployer)",
  "AmmV3Venue(positionManager, wrappedNative)",
  "LaunchFactory(admin, adminDelay, escrow, vault, locker, venue, treasury, launchFee)",
  "LaunchDeployer(factory)",
  "FeeCollector(factory, locker, escrow, vault)",
  "LaunchRouter(factory)",
  "LaunchLens(factory)",
  "PoolRouter(positionManager, wrappedNative)",
  "factory.wire(launchDeployer, feeCollector)",
  "vault.setFactory(factory)",
  "locker.setFactory(factory)",
  "factory.setForwarder(router)",
  ...CONFIGS.map((config, i) => `factory.addLaunchConfig(#${i} ${config.label})`),
  "factory.setLaunchEnabled(true)   # only with OPEN=1",
];

if (process.env.DRY_RUN) {
  console.log(`deployment order (${networkName}):\n`);
  for (const [i, step] of plan.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${step}`);
  console.log("\nnothing was sent (DRY_RUN)");
  process.exit(0);
}

const provider = new JsonRpcProvider(env("RPC_URL"), undefined, { staticNetwork: true });
const wallet = new Wallet(env("PRIVATE_KEY"), provider);
const chainId = Number((await provider.getNetwork()).chainId);
if (preset.chainId && preset.chainId !== chainId) {
  throw new Error(`NETWORK=${networkName} expects chain ${preset.chainId}, RPC reports ${chainId}`);
}

const config = {
  positionManager: env("POSITION_MANAGER", preset.positionManager),
  wrappedNative: env("WRAPPED_NATIVE", preset.wrappedNative),
  treasury: env("TREASURY", wallet.address),
  admin: env("ADMIN", wallet.address),
  // Notice an admin handover must serve. Days, not seconds, so a transfer of
  // the role that grants every other role is visible before it takes effect.
  adminDelay: Number(env("ADMIN_DELAY", String(2 * 24 * 60 * 60))),
  launchFee: parseEther(env("LAUNCH_FEE", "0.0005")),
};

// A small explicit tip keeps costs predictable on networks whose suggested
// priority fee is far above what inclusion actually needs.
const tip = parseUnits(env("PRIORITY_FEE_GWEI", "0.01"), "gwei");
async function fees() {
  const block = await provider.getBlock("latest");
  return { maxPriorityFeePerGas: tip, maxFeePerGas: block.baseFeePerGas * 3n + tip };
}

const recordFile = path.join(root, "deployments", `${networkName}.json`);
const record = {
  network: networkName,
  chainId,
  deployer: wallet.address,
  admin: config.admin,
  treasury: config.treasury,
  positionManager: config.positionManager,
  wrappedNative: config.wrappedNative,
  contracts: {},
  configs: [],
};

function save() {
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
}

async function deploy(name, args) {
  const { abi, bytecode, source } = artifact(name);
  const factory = new ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(...args, await fees());
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  const constructorArgs = factory.interface.encodeDeploy(args);
  record.contracts[name] = {
    address,
    source: `${source}:${name}`,
    constructorArgs,
    transaction: receipt.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  };
  save();
  console.log(`${name.padEnd(18)} ${address}  gas ${receipt.gasUsed}`);
  return new Contract(address, abi, wallet);
}

async function call(contract, fn, args, label = fn) {
  const tx = await contract[fn](...args, await fees());
  const receipt = await tx.wait();
  console.log(`  ${label}  gas ${receipt.gasUsed}`);
  return receipt;
}

// ADD=PoolRouter deploys only the stateless contracts that need nothing but
// the AMM, and appends them to an existing deployment record.
const ADDABLE = { PoolRouter: () => [config.positionManager, config.wrappedNative] };
if (process.env.ADD) {
  const existing = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  if (existing.chainId !== chainId) throw new Error(`${recordFile} is for chain ${existing.chainId}`);
  Object.assign(record, existing);
  for (const name of process.env.ADD.split(",")) {
    if (!ADDABLE[name]) throw new Error(`ADD supports ${Object.keys(ADDABLE).join(", ")}`);
    await deploy(name, ADDABLE[name]());
  }
  console.log(`\nrecorded in ${path.relative(root, recordFile)}`);
  process.exit(0);
}

console.log(`network ${networkName} (chain ${chainId})`);
console.log(`deploying as ${wallet.address}, admin ${config.admin}, treasury ${config.treasury}\n`);

const escrow = await deploy("FeeEscrow", []);
const vault = await deploy("BuybackVault", [await escrow.getAddress(), wallet.address]);
const locker = await deploy("LiquidityLocker", [wallet.address]);
const venue = await deploy("AmmV3Venue", [config.positionManager, config.wrappedNative]);

const factory = await deploy("LaunchFactory", [
  config.admin,
  config.adminDelay,
  await escrow.getAddress(),
  await vault.getAddress(),
  await locker.getAddress(),
  await venue.getAddress(),
  config.treasury,
  config.launchFee,
]);
const factoryAddress = await factory.getAddress();

const launchDeployer = await deploy("LaunchDeployer", [factoryAddress]);
const collector = await deploy("FeeCollector", [
  factoryAddress,
  await locker.getAddress(),
  await escrow.getAddress(),
  await vault.getAddress(),
]);
const router = await deploy("LaunchRouter", [factoryAddress]);
await deploy("LaunchLens", [factoryAddress]);
await deploy("PoolRouter", [config.positionManager, config.wrappedNative]);

console.log("\nwiring");
await call(factory, "wire", [await launchDeployer.getAddress(), await collector.getAddress()]);
await call(vault, "setFactory", [factoryAddress], "vault.setFactory");
await call(locker, "setFactory", [factoryAddress], "locker.setFactory");
await call(factory, "setForwarder", [await router.getAddress()]);

console.log("\nconfigurations");
for (const { label, ...terms } of CONFIGS) {
  await call(factory, "addLaunchConfig", [terms], `addLaunchConfig ${label}`);
  record.configs.push({
    id: record.configs.length,
    label,
    ...Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
  });
  save();
}

if (process.env.OPEN === "1") {
  await call(factory, "setLaunchEnabled", [true]);
  record.launchEnabled = true;
  save();
}

console.log(`\nrecorded in ${path.relative(root, recordFile)}`);
if (preset.explorer) console.log(`factory: ${preset.explorer}/address/${factoryAddress}`);
