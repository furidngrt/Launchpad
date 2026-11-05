// Deploys the whole stack and wires it, in the order the contracts require.
//
// Three contracts need an address that is only known after the contract that
// needs it exists, so the order below is not arbitrary. The vault, the locker
// and the factory are deployed first; the deployer and the collector follow,
// because their constructors take the factory; and the factory is then told
// about all three. Each wiring call can be made exactly once.
//
//   RPC_URL=... PRIVATE_KEY=... \
//   POSITION_MANAGER=... SWAP_ROUTER=... WRAPPED_NATIVE=... TREASURY=... \
//   node tools/deploy.mjs
//
// Add DRY_RUN=1 to print the plan without sending anything.
import fs from "node:fs";
import path from "node:path";
import { ContractFactory, Contract, JsonRpcProvider, Wallet, parseEther } from "ethers";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "out");

function artifact(name) {
  const file = path.join(outDir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`run "npm run build" first: missing ${name}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`set ${key}`);
  return value;
}

const config = {
  rpcUrl: process.env.RPC_URL,
  positionManager: required("POSITION_MANAGER"),
  swapRouter: required("SWAP_ROUTER"),
  wrappedNative: required("WRAPPED_NATIVE"),
  treasury: required("TREASURY"),
  // Notice an admin handover must serve. Days, not seconds, so a transfer of
  // the role that grants every other role is visible before it takes effect.
  adminDelay: Number(process.env.ADMIN_DELAY ?? 2 * 24 * 60 * 60),
  launchFee: parseEther(process.env.LAUNCH_FEE ?? "0.0005"),
};

const plan = [
  "FeeEscrow()",
  "BuybackVault(escrow, deployerAccount)",
  "LiquidityLocker(deployerAccount)",
  "AmmV3Venue(positionManager, swapRouter, wrappedNative)",
  "LaunchFactory(admin, adminDelay, escrow, vault, locker, venue, treasury, launchFee)",
  "LaunchDeployer(factory)",
  "FeeCollector(factory, locker, escrow, vault)",
  "LaunchRouter(factory)",
  "factory.wire(launchDeployer, feeCollector)",
  "vault.setFactory(factory)",
  "locker.setFactory(factory)",
  "factory.setForwarder(router)",
  "factory.addLaunchConfig(...)   # once per set of terms you want to offer",
];

if (process.env.DRY_RUN) {
  console.log("deployment order:\n");
  for (const [i, step] of plan.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${step}`);
  console.log("\nnothing was sent (DRY_RUN)");
  process.exit(0);
}

const provider = new JsonRpcProvider(required("RPC_URL"));
const wallet = new Wallet(required("PRIVATE_KEY"), provider);
const admin = process.env.ADMIN ?? wallet.address;

async function deploy(name, args) {
  const { abi, bytecode } = artifact(name);
  const factory = new ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`${name.padEnd(16)} ${address}`);
  return new Contract(address, abi, wallet);
}

async function call(contract, fn, args) {
  const tx = await contract[fn](...args);
  await tx.wait();
  console.log(`  ${fn}(${args.join(", ")})`);
}

console.log(`deploying as ${wallet.address}, admin ${admin}\n`);

const escrow = await deploy("FeeEscrow", []);
const vault = await deploy("BuybackVault", [await escrow.getAddress(), wallet.address]);
const locker = await deploy("LiquidityLocker", [wallet.address]);
const venue = await deploy("AmmV3Venue", [config.positionManager, config.swapRouter, config.wrappedNative]);

const factory = await deploy("LaunchFactory", [
  admin,
  config.adminDelay,
  await escrow.getAddress(),
  await vault.getAddress(),
  await locker.getAddress(),
  await venue.getAddress(),
  config.treasury,
  config.launchFee,
]);

const launchDeployer = await deploy("LaunchDeployer", [await factory.getAddress()]);
const collector = await deploy("FeeCollector", [
  await factory.getAddress(),
  await locker.getAddress(),
  await escrow.getAddress(),
  await vault.getAddress(),
]);
const router = await deploy("LaunchRouter", [await factory.getAddress()]);

console.log("\nwiring");
await call(factory, "wire", [await launchDeployer.getAddress(), await collector.getAddress()]);
await call(vault, "setFactory", [await factory.getAddress()]);
await call(locker, "setFactory", [await factory.getAddress()]);
await call(factory, "setForwarder", [await router.getAddress()]);

console.log(
  "\nnext: add at least one launch configuration with addLaunchConfig, then open" +
    "\ncreation with setLaunchEnabled(true). Launching is impossible until both.",
);
