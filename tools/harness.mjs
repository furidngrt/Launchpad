// A small EVM harness so the suite can be exercised with nothing but npm
// dependencies: no downloaded compiler, no node, no network.
import fs from "node:fs";
import path from "node:path";
import { EVM } from "@ethereumjs/evm";
import { DefaultStateManager } from "@ethereumjs/statemanager";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { Account, Address, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { Interface } from "ethers";

const root = path.resolve(import.meta.dirname, "..");
const GAS = 60_000_000n;

export const ZERO = "0x0000000000000000000000000000000000000000";

export class Chainlet {
  constructor(evm, stateManager, artifacts) {
    this.evm = evm;
    this.state = stateManager;
    this.artifacts = artifacts;
    this.interfaces = new Map();
    this.now = 1_700_000_000n;
    for (const [name, artifact] of Object.entries(artifacts)) {
      this.interfaces.set(name, new Interface(artifact.abi));
    }
  }

  static async create() {
    const outDir = path.join(root, "out");
    const artifacts = {};
    for (const file of fs.readdirSync(outDir)) {
      if (!file.endsWith(".json")) continue;
      artifacts[file.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(outDir, file), "utf8"));
    }
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
    const stateManager = new DefaultStateManager();
    const evm = await EVM.create({ common, stateManager });
    return new Chainlet(evm, stateManager, artifacts);
  }

  get block() {
    return {
      header: {
        number: 1n,
        timestamp: this.now,
        gasLimit: 100_000_000n,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        coinbase: new Address(hexToBytes(ZERO)),
        baseFeePerGas: 0n,
        getBlobGasPrice: () => 0n,
      },
    };
  }

  warp(seconds) {
    this.now += BigInt(seconds);
  }

  async setBalance(address, wei) {
    const addr = new Address(hexToBytes(address));
    const account = (await this.state.getAccount(addr)) ?? new Account();
    account.balance = BigInt(wei);
    await this.state.putAccount(addr, account);
  }

  async balanceOf(address) {
    const account = await this.state.getAccount(new Address(hexToBytes(address)));
    return account?.balance ?? 0n;
  }

  iface(name) {
    const found = this.interfaces.get(name);
    if (!found) throw new Error(`unknown artifact: ${name}`);
    return found;
  }

  /** Turns revert data into the clearest name available, custom errors included. */
  describeRevert(returnValue) {
    const data = bytesToHex(returnValue);
    if (data === "0x") return "revert(no data)";
    for (const [name, iface] of this.interfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          const args = parsed.args.map((a) => String(a)).join(", ");
          return `${parsed.name}(${args})${name === "__" ? "" : ""}`;
        }
      } catch {
        /* try the next interface */
      }
    }
    return `revert(${data.slice(0, 74)})`;
  }

  async deploy(name, args = [], { from, value = 0n } = {}) {
    const artifact = this.artifacts[name];
    if (!artifact) throw new Error(`unknown artifact: ${name}`);
    const iface = this.iface(name);
    const data = hexToBytes("0x" + artifact.bytecode + iface.encodeDeploy(args).slice(2));

    const result = await this.evm.runCall({
      caller: new Address(hexToBytes(from)),
      data,
      gasLimit: GAS,
      value: BigInt(value),
      block: this.block,
    });
    if (result.execResult.exceptionError) {
      throw new Error(`deploy ${name} failed: ${this.describeRevert(result.execResult.returnValue)}`);
    }
    return { name, address: result.createdAddress.toString() };
  }

  async send(contract, fn, args = [], { from, value = 0n } = {}) {
    const iface = this.iface(contract.name);
    const result = await this.evm.runCall({
      caller: new Address(hexToBytes(from)),
      to: new Address(hexToBytes(contract.address)),
      data: hexToBytes(iface.encodeFunctionData(fn, args)),
      gasLimit: GAS,
      value: BigInt(value),
      block: this.block,
    });
    if (result.execResult.exceptionError) {
      const reason = this.describeRevert(result.execResult.returnValue);
      const error = new Error(`${contract.name}.${fn} reverted: ${reason}`);
      error.reason = reason;
      throw error;
    }
    const decoded = iface.decodeFunctionResult(fn, bytesToHex(result.execResult.returnValue));
    return {
      result: decoded.length === 1 ? decoded[0] : decoded,
      logs: (result.execResult.logs ?? []).map(([address, topics, data]) => ({
        address: bytesToHex(address),
        topics: topics.map(bytesToHex),
        data: bytesToHex(data),
      })),
    };
  }

  /** Same as send, returning only the decoded value. */
  async call(contract, fn, args = [], options = {}) {
    const { result } = await this.send(contract, fn, args, { from: options.from ?? ZERO, ...options });
    return result;
  }

  /** Expects a revert, and optionally that its name contains `expected`. */
  async expectRevert(promise, expected) {
    try {
      await promise;
    } catch (error) {
      if (expected && !error.message.includes(expected)) {
        throw new Error(`reverted, but not with ${expected}: ${error.message}`);
      }
      return error;
    }
    throw new Error(`expected a revert${expected ? ` with ${expected}` : ""}, but the call succeeded`);
  }

  /** Decodes every log a call produced that matches `event` on `contract`. */
  eventsFrom(logs, contractName, event) {
    const iface = this.iface(contractName);
    const fragment = iface.getEvent(event);
    const topic = fragment.topicHash;
    return logs
      .filter((log) => log.topics[0] === topic)
      .map((log) => iface.decodeEventLog(fragment, log.data, log.topics));
  }
}
