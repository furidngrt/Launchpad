import { useQuery } from "@tanstack/react-query";
import { parseAbi, zeroAddress, type Address } from "viem";

import { reader } from "../config/wagmi";
import { abis, deployment } from "../generated/contracts";
import { priceFromReserves, valuation } from "./format";

export const PHASE = { Curve: 0, Settled: 1, Listed: 2, Refunded: 3 } as const;

export const PHASE_LABEL: Record<number, string> = {
  0: "Trading",
  1: "Graduating",
  2: "Graduated",
  3: "Refunded",
};

const C = deployment.contracts;
const poolAbi = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"]);
const poolEventsAbi = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);
const Q192 = 1n << 192n;
const WAD = 10n ** 18n;

export interface LaunchRecord {
  token: Address;
  curve: Address;
  creator: Address;
  feeRecipient: Address;
  quote: Address;
  venue: Address;
  graduationTarget: bigint;
  venueFee: number;
  tickSpacing: number;
  creatorFeeBps: number;
  buybackEnabled: boolean;
  phase: number;
  settledQuote: bigint;
  settledTokens: bigint;
  settledAt: bigint;
  exists: boolean;
}

export interface LaunchSummary {
  address: Address;
  index: number;
  record: LaunchRecord;
  name: string;
  symbol: string;
  logo: string;
  supply: bigint;
  quoteReserve: bigint;
  tokenReserve: bigint;
  raised: bigint;
  sellable: bigint;
  progressBps: number;
  priceWad: bigint;
  marketCap: bigint;
  /** Price the curve opened at, so change since launch can be shown. */
  openPriceWad: bigint;
  /** Change from the opening price, in basis points. */
  changeBps: number;
  pool?: Address;
}

export interface LaunchDetail extends LaunchSummary {
  description: string;
  website: string;
  social: string;
  tradeFeeBps: number;
  virtualQuote: bigint;
  openedAt: number;
  openingTaxStartBps: number;
  openingTaxWindow: number;
  openingExemptRemaining: bigint;
  reserveFloor: bigint;
  feeBalance: bigint;
  creatorFeeBalance: bigint;
  buybackEarmark: bigint;
  readyToGraduate: boolean;
  lockedSupply: bigint;
}

function read<T>(address: Address, abi: (typeof abis)[keyof typeof abis], functionName: string, args: unknown[] = []) {
  return reader.readContract({ address, abi, functionName, args }) as Promise<T>;
}

async function poolPrice(record: LaunchRecord): Promise<{ pool?: Address; priceWad: bigint }> {
  const pool = await read<Address>(C.AmmV3Venue, abis.AmmV3Venue, "poolFor", [record.token, zeroAddress, record.venueFee]);
  if (!pool || pool === zeroAddress) return { priceWad: 0n };
  const slot = (await reader.readContract({ address: pool, abi: poolAbi, functionName: "slot0" })) as readonly [bigint, ...unknown[]];
  const sqrt = slot[0];
  if (sqrt === 0n) return { pool, priceWad: 0n };
  return { pool, priceWad: priceFromSqrt(record.token, sqrt) };
}

/** A pool's sqrt price as the price of one whole token in ETH, scaled by 1e18.
 * Both sides carry 18 decimals, so the raw ratio is already per whole token. */
export function priceFromSqrt(token: Address, sqrt: bigint): bigint {
  if (sqrt === 0n) return 0n;
  const tokenIsFirst = token.toLowerCase() < deployment.wrappedNative.toLowerCase();
  const squared = sqrt * sqrt;
  return tokenIsFirst ? (squared * WAD) / Q192 : (Q192 * WAD) / squared;
}

async function summarize(address: Address, index: number): Promise<LaunchSummary> {
  const [view, name, symbol, logo, supply] = await Promise.all([
    read<{
      launch: LaunchRecord;
      quoteReserve: bigint;
      tokenReserve: bigint;
      realQuoteReserve: bigint;
      sellableTokens: bigint;
      progressBps: bigint;
    }>(C.LaunchLens, abis.LaunchLens, "launchView", [address, zeroAddress]),
    read<string>(address, abis.LaunchToken, "name"),
    read<string>(address, abis.LaunchToken, "symbol"),
    read<string>(address, abis.LaunchToken, "logo"),
    read<bigint>(address, abis.LaunchToken, "totalSupply"),
  ]);
  const record = normalizeRecord(view.launch);
  const virtualQuote = await read<bigint>(record.curve, abis.BondingCurve, "virtualQuote");

  let priceWad = priceFromReserves(view.quoteReserve, view.tokenReserve);
  let raised = view.realQuoteReserve;
  let progressBps = Number(view.progressBps);
  let pool: Address | undefined;

  if (record.phase === PHASE.Listed) {
    const listed = await poolPrice(record);
    priceWad = listed.priceWad;
    pool = listed.pool;
    raised = record.graduationTarget;
    progressBps = 10_000;
  } else if (record.phase === PHASE.Settled) {
    raised = record.settledQuote;
    progressBps = 10_000;
  }

  const openPriceWad = supply === 0n ? 0n : (virtualQuote * WAD) / supply;
  const changeBps = openPriceWad === 0n || priceWad === 0n ? 0 : Number(((priceWad - openPriceWad) * 10_000n) / openPriceWad);

  return {
    address,
    index,
    record,
    name,
    symbol,
    logo,
    supply,
    openPriceWad,
    changeBps,
    quoteReserve: view.quoteReserve,
    tokenReserve: view.tokenReserve,
    raised,
    sellable: view.sellableTokens,
    progressBps,
    priceWad,
    marketCap: valuation(priceWad, supply),
    pool,
  };
}

function normalizeRecord(raw: LaunchRecord): LaunchRecord {
  return {
    ...raw,
    venueFee: Number(raw.venueFee),
    tickSpacing: Number(raw.tickSpacing),
    creatorFeeBps: Number(raw.creatorFeeBps),
    phase: Number(raw.phase),
  };
}

/** The most recent launches, newest first. */
export function useLaunches(limit = 60) {
  return useQuery({
    queryKey: ["launches", limit],
    refetchInterval: 15_000,
    queryFn: async () => {
      const count = Number(await read<bigint>(C.LaunchFactory, abis.LaunchFactory, "launchCount"));
      const start = Math.max(0, count - limit);
      const page = await read<Address[]>(C.LaunchLens, abis.LaunchLens, "launches", [BigInt(start), BigInt(limit)]);
      const summaries = await Promise.all(page.map((address, i) => summarize(address, start + i)));
      return { count, launches: summaries.reverse() };
    },
  });
}

/** Everything the token page shows about one launch. */
export function useLaunch(address: Address | undefined) {
  return useQuery({
    queryKey: ["launch", address],
    enabled: !!address,
    refetchInterval: 8_000,
    queryFn: async (): Promise<LaunchDetail> => {
      const token = address as Address;
      const record = normalizeRecord(await read<LaunchRecord>(C.LaunchFactory, abis.LaunchFactory, "getLaunch", [token]));
      if (!record.exists) throw new Error("not-found");
      const summary = await summarize(token, -1);
      const curve = record.curve;
      const [
        description,
        website,
        social,
        tradeFeeBps,
        virtualQuote,
        openedAt,
        openingTaxStartBps,
        openingTaxWindow,
        openingExemptRemaining,
        reserveFloor,
        feeBalance,
        creatorFeeBalance,
        buybackEarmark,
        readyToGraduate,
        lockedSupply,
      ] = await Promise.all([
        read<string>(token, abis.LaunchToken, "description"),
        read<string>(token, abis.LaunchToken, "website"),
        read<string>(token, abis.LaunchToken, "social"),
        read<number>(curve, abis.BondingCurve, "tradeFeeBps"),
        read<bigint>(curve, abis.BondingCurve, "virtualQuote"),
        read<bigint>(curve, abis.BondingCurve, "openedAt"),
        read<bigint>(curve, abis.BondingCurve, "openingTaxStartBps"),
        read<bigint>(curve, abis.BondingCurve, "openingTaxWindow"),
        read<bigint>(curve, abis.BondingCurve, "openingExemptRemaining"),
        read<bigint>(curve, abis.BondingCurve, "reserveFloor"),
        read<bigint>(curve, abis.BondingCurve, "feeBalance"),
        read<bigint>(curve, abis.BondingCurve, "creatorFeeBalance"),
        read<bigint>(curve, abis.BondingCurve, "buybackEarmark"),
        read<boolean>(curve, abis.BondingCurve, "readyToGraduate"),
        read<bigint>(C.LiquidityLocker, abis.LiquidityLocker, "lockedSupply", [token]),
      ]);
      return {
        ...summary,
        description,
        website,
        social,
        tradeFeeBps: Number(tradeFeeBps),
        virtualQuote,
        openedAt: Number(openedAt),
        openingTaxStartBps: Number(openingTaxStartBps),
        openingTaxWindow: Number(openingTaxWindow),
        openingExemptRemaining,
        reserveFloor,
        feeBalance,
        creatorFeeBalance,
        buybackEarmark,
        readyToGraduate,
        lockedSupply,
      };
    },
  });
}

export interface Trade {
  kind: "buy" | "sell";
  /** Where the trade happened: on the bonding curve, or in the locked pool. */
  venue: "curve" | "pool";
  account: Address;
  quote: bigint;
  tokens: bigint;
  /** Spot price immediately before and after the trade, scaled by 1e18. */
  priceBefore: bigint;
  priceAfter: bigint;
  block: bigint;
  hash: `0x${string}`;
  timestamp: number;
}

interface CurveLog {
  eventName: string;
  args: Record<string, bigint | Address>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
}

/**
 * Every trade on a launch, oldest first, with the exact spot price on either
 * side of it: first on its curve, then in its pool once it has graduated.
 *
 * The curve's pricing reserves are a pure function of its events, so they are
 * replayed from the opening state rather than read per block: the virtual
 * reserve and the full supply to start, each buy adding its net quote and
 * removing its tokens, each sell the reverse, and each buyback leaving its
 * quote in and taking its tokens out. Pool swaps carry the price they leave
 * behind, and the pool opens at the curve's final price, so the series runs on
 * without a gap.
 */
export function useTrades(launch: LaunchDetail | undefined) {
  const curve = launch?.record.curve;
  const pool = launch?.pool;
  return useQuery({
    queryKey: ["trades", curve, pool],
    enabled: !!launch,
    refetchInterval: 12_000,
    queryFn: async (): Promise<Trade[]> => {
      const l = launch as LaunchDetail;
      const latest = await reader.getBlock({ blockTag: "latest" });
      const stamp = (block: bigint) => Number(latest.timestamp) - Number(latest.number - block) * 12;
      const [logs, poolLogs, routed] = await Promise.all([
        logsInWindows(l.record.curve, abis.BondingCurve, latest.number),
        pool ? logsInWindows(pool, poolEventsAbi, latest.number) : Promise.resolve([] as CurveLog[]),
        pool ? logsInWindows(C.PoolRouter, abis.PoolRouter, latest.number, "Swap", { token: l.address }) : Promise.resolve([] as CurveLog[]),
      ]);
      const byOrder = (a: CurveLog, b: CurveLog) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber);
      logs.sort(byOrder);
      poolLogs.sort(byOrder);

      let Q = l.virtualQuote;
      let T = l.supply;
      const spot = () => (T === 0n ? 0n : (Q * WAD) / T);
      const trades: Trade[] = [];

      for (const log of logs) {
        const a = log.args;
        if (log.eventName === "Buy" || log.eventName === "Sell") {
          const before = spot();
          const fees = (a.fee as bigint) + (a.creatorFee as bigint);
          const isBuy = log.eventName === "Buy";
          const quote = (isBuy ? a.quoteIn : a.quoteOut) as bigint;
          const tokens = (isBuy ? a.tokensOut : a.tokensIn) as bigint;
          if (isBuy) {
            Q += quote - fees;
            T -= tokens;
          } else {
            Q -= quote + fees;
            T += tokens;
          }
          trades.push({
            kind: isBuy ? "buy" : "sell",
            venue: "curve",
            account: (a.recipient ?? a.buyer ?? a.seller) as Address,
            quote,
            tokens,
            priceBefore: before,
            priceAfter: spot(),
            block: log.blockNumber,
            hash: log.transactionHash,
            timestamp: stamp(log.blockNumber),
          });
        } else if (log.eventName === "FeesSwept" && (a.tokensLocked as bigint) > 0n) {
          Q += a.buybackAmount as bigint;
          T -= a.tokensLocked as bigint;
        }
      }

      if (pool) {
        // The listing transaction mints the locked position and, if someone
        // had mispriced the pool beforehand, swaps it back to the curve's
        // price. That correction is part of graduation, not a trade.
        const listingTxs = new Set(poolLogs.filter((x) => x.eventName === "Mint").map((x) => x.transactionHash));
        const traders = new Map(routed.map((x) => [x.transactionHash, x.args.trader as Address]));
        const tokenIsFirst = l.address.toLowerCase() < deployment.wrappedNative.toLowerCase();
        let last = trades.length ? trades[trades.length - 1].priceAfter : l.openPriceWad;
        for (const log of poolLogs) {
          if (log.eventName !== "Swap") continue;
          const a = log.args;
          const after = priceFromSqrt(l.address, a.sqrtPriceX96 as bigint);
          if (listingTxs.has(log.transactionHash)) {
            last = after;
            continue;
          }
          const tokenDelta = (tokenIsFirst ? a.amount0 : a.amount1) as bigint;
          const quoteDelta = (tokenIsFirst ? a.amount1 : a.amount0) as bigint;
          trades.push({
            kind: tokenDelta < 0n ? "buy" : "sell",
            venue: "pool",
            account: traders.get(log.transactionHash) ?? (a.recipient as Address),
            quote: quoteDelta < 0n ? -quoteDelta : quoteDelta,
            tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
            priceBefore: last,
            priceAfter: after,
            block: log.blockNumber,
            hash: log.transactionHash,
            timestamp: stamp(log.blockNumber),
          });
          last = after;
        }
      }
      return trades;
    },
  });
}

/** Logs for one address from the deployment block onwards, in windows a public node will serve. */
async function logsInWindows(
  address: Address,
  abi: (typeof abis)[keyof typeof abis] | typeof poolEventsAbi,
  latest: bigint,
  eventName?: string,
  args?: Record<string, unknown>,
): Promise<CurveLog[]> {
  const span = 45_000n;
  const all: CurveLog[] = [];
  for (let from = deployment.startBlock; from <= latest; from += span) {
    const to = from + span - 1n > latest ? latest : from + span - 1n;
    const logs = await reader.getContractEvents({
      address,
      abi: abi as (typeof abis)[keyof typeof abis],
      fromBlock: from,
      toBlock: to,
      ...(eventName ? { eventName } : {}),
      ...(args ? { args } : {}),
    });
    all.push(...(logs as unknown as CurveLog[]));
  }
  return all;
}

/** When each launch was created, for its age. */
export function useLaunchTimes() {
  return useQuery({
    queryKey: ["launch-times"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const latest = await reader.getBlock({ blockTag: "latest" });
      const logs = await logsInWindows(C.LaunchFactory, abis.LaunchFactory, latest.number, "LaunchCreated");
      const times = new Map<string, number>();
      for (const log of logs) {
        const token = String(log.args.token).toLowerCase();
        times.set(token, Number(latest.timestamp) - Number(latest.number - log.blockNumber) * 12);
      }
      return times;
    },
  });
}

/** The chain head, for the status bar. */
export function useBlockNumber() {
  return useQuery({
    queryKey: ["block"],
    refetchInterval: 12_000,
    queryFn: () => reader.getBlockNumber(),
  });
}

export interface LaunchConfigView {
  id: number;
  label: string;
  supply: bigint;
  virtualQuote: bigint;
  graduationTarget: bigint;
  tradeFeeBps: number;
  venueFee: number;
  tickSpacing: number;
  enabled: boolean;
  openValuation: bigint;
  graduationValuation: bigint;
}

/** Terms a creator can launch on right now, and the protocol's own settings. */
export function useProtocol() {
  return useQuery({
    queryKey: ["protocol"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const [count, launchFee, maxCreatorFeeBps, launchEnabled, openingTaxStartBps, openingTaxWindow, openingExemptCapBps] =
        await Promise.all([
          read<bigint>(C.LaunchFactory, abis.LaunchFactory, "launchConfigCount"),
          read<bigint>(C.LaunchFactory, abis.LaunchFactory, "launchFee"),
          read<number>(C.LaunchFactory, abis.LaunchFactory, "maxCreatorFeeBps"),
          read<boolean>(C.LaunchFactory, abis.LaunchFactory, "launchEnabled"),
          read<bigint>(C.LaunchFactory, abis.LaunchFactory, "openingTaxStartBps"),
          read<bigint>(C.LaunchFactory, abis.LaunchFactory, "openingTaxWindow"),
          read<bigint>(C.LaunchFactory, abis.LaunchFactory, "openingExemptCapBps"),
        ]);
      const configs: LaunchConfigView[] = [];
      for (let id = 0; id < Number(count); id++) {
        const c = await read<{
          supply: bigint;
          virtualQuote: bigint;
          graduationTarget: bigint;
          tradeFeeBps: number;
          venueFee: number;
          tickSpacing: number;
          enabled: boolean;
        }>(C.LaunchFactory, abis.LaunchFactory, "getLaunchConfig", [BigInt(id)]);
        const sum = c.virtualQuote + c.graduationTarget;
        configs.push({
          id,
          label: deployment.configs.find((x) => x.id === id)?.label ?? `config-${id}`,
          supply: c.supply,
          virtualQuote: c.virtualQuote,
          graduationTarget: c.graduationTarget,
          tradeFeeBps: Number(c.tradeFeeBps),
          venueFee: Number(c.venueFee),
          tickSpacing: Number(c.tickSpacing),
          enabled: c.enabled,
          openValuation: c.virtualQuote,
          graduationValuation: (sum * sum) / c.virtualQuote,
        });
      }
      return {
        configs,
        launchFee,
        maxCreatorFeeBps: Number(maxCreatorFeeBps),
        launchEnabled,
        openingTaxStartBps: Number(openingTaxStartBps),
        openingTaxWindow: Number(openingTaxWindow),
        openingExemptCapBps: Number(openingExemptCapBps),
      };
    },
  });
}

/** What a wallet is owed and holds across the protocol. */
export function usePortfolio(account: Address | undefined, launches: LaunchSummary[] | undefined) {
  return useQuery({
    queryKey: ["portfolio", account, launches?.length],
    enabled: !!account && !!launches,
    refetchInterval: 15_000,
    queryFn: async () => {
      const who = account as Address;
      const list = launches ?? [];
      const [escrow, createdCount, balances] = await Promise.all([
        read<bigint>(C.FeeEscrow, abis.FeeEscrow, "balanceOf", [who]),
        read<bigint>(C.LaunchFactory, abis.LaunchFactory, "launchCountOf", [who]),
        Promise.all(list.map((l) => read<bigint>(l.address, abis.LaunchToken, "balanceOf", [who]))),
      ]);
      const created = await read<Address[]>(C.LaunchLens, abis.LaunchLens, "launchesOf", [who, 0n, createdCount]);
      const createdSet = new Set(created.map((a) => a.toLowerCase()));
      const mine = list.filter((l) => createdSet.has(l.address.toLowerCase()) || l.record.feeRecipient.toLowerCase() === who.toLowerCase());
      const pendingByCurve = await Promise.all(
        mine.map(async (l) => {
          if (l.record.phase !== PHASE.Curve) return { address: l.address, fee: 0n, creatorFee: 0n, earmark: 0n };
          const [fee, creatorFee, earmark] = await Promise.all([
            read<bigint>(l.record.curve, abis.BondingCurve, "feeBalance"),
            read<bigint>(l.record.curve, abis.BondingCurve, "creatorFeeBalance"),
            read<bigint>(l.record.curve, abis.BondingCurve, "buybackEarmark"),
          ]);
          return { address: l.address, fee, creatorFee, earmark };
        }),
      );
      const holdings = list
        .map((l, i) => ({ launch: l, balance: balances[i] }))
        .filter((h) => h.balance > 0n);
      return { escrow, mine, pendingByCurve, holdings };
    },
  });
}
