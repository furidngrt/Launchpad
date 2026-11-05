import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance } from "wagmi";
import { parseUnits, zeroAddress, type Address } from "viem";

import { chain, reader } from "../config/wagmi";
import { abis, deployment } from "../generated/contracts";
import { PHASE, priceFromSqrt, type LaunchDetail } from "../lib/data";
import { formatCompact, formatEth, formatPercent, formatPrice } from "../lib/format";
import { useTx } from "../lib/tx";
import { ConnectButton } from "./ConnectButton";

const C = deployment.contracts;
/** A finishing buy graduates the launch in the same transaction, inside a
 * try/catch. Wallet gas estimates find the smallest budget at which the buy
 * succeeds, which is one where graduation silently runs out of gas, so the
 * finishing buy carries an explicit limit instead. */
const GRADUATION_GAS = 15_000_000n;
const SLIPPAGE = [50, 100, 300, 500];
/** Pool trades carry a deadline so a transaction stuck in the mempool cannot
 * fill hours later at a price nobody agreed to. */
const DEADLINE_SECONDS = 20 * 60;

function useDebounced<T>(value: T, delay: number): T {
  const [state, setState] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setState(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return state;
}

function parseAmount(text: string): bigint | undefined {
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return undefined;
  try {
    const value = parseUnits(text, 18);
    return value > 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

interface Quote {
  side: "buy" | "sell";
  input: bigint;
  out: bigint;
  /** Fees in ETH where they are known in ETH; pool fees on a sale are taken in tokens. */
  fee: bigint;
  creatorFee: bigint;
  tax: bigint;
  refund: bigint;
  priceAfter: bigint;
}

export function TradePanel({ launch }: { launch: LaunchDetail }) {
  const { address, isConnected, chainId } = useAccount();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [showDetails, setShowDetails] = useState(false);
  const { send, busy } = useTx();

  const phase = launch.record.phase;
  const inPool = phase === PHASE.Listed && !!launch.pool;
  const curve = launch.record.curve;
  const spender = inPool ? C.PoolRouter : curve;
  const viewer = (address ?? zeroAddress) as Address;
  const poolFeeBps = launch.record.venueFee / 100;

  const debounced = useDebounced(amount, 300);
  const parsed = parseAmount(debounced);
  const typed = parseAmount(amount);

  const { data: ethBalance } = useBalance({ address, chainId: chain.id, query: { refetchInterval: 12_000 } });
  const { data: wallet } = useQuery({
    queryKey: ["wallet", launch.address, address, spender],
    enabled: !!address,
    refetchInterval: 12_000,
    queryFn: async () => {
      const [balance, allowance, exempt, windowActive] = await Promise.all([
        reader.readContract({ address: launch.address, abi: abis.LaunchToken, functionName: "balanceOf", args: [viewer] }) as Promise<bigint>,
        reader.readContract({ address: launch.address, abi: abis.LaunchToken, functionName: "allowance", args: [viewer, spender] }) as Promise<bigint>,
        inPool ? false : (reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "openingTaxExempt", args: [viewer] }) as Promise<boolean>),
        inPool ? false : (reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "openingWindowActive" }) as Promise<boolean>),
      ]);
      return { balance, allowance, exempt, windowActive };
    },
  });

  const { data: quote, isFetching: quoting, isError: quoteFailed } = useQuery({
    queryKey: ["quote", side, inPool ? "pool" : "curve", launch.address, parsed?.toString(), viewer],
    enabled: parsed !== undefined && (phase === PHASE.Curve || inPool),
    retry: 1,
    queryFn: async (): Promise<Quote> => {
      const input = parsed as bigint;
      if (inPool) {
        const fn = side === "buy" ? "quoteBuy" : "quoteSell";
        const r = (await reader.readContract({
          address: C.PoolRouter,
          abi: abis.PoolRouter,
          functionName: fn,
          args: [launch.address, launch.record.venueFee, input],
        })) as readonly [bigint, bigint];
        const fee = side === "buy" ? (input * BigInt(launch.record.venueFee)) / 1_000_000n : 0n;
        return { side, input, out: r[0], fee, creatorFee: 0n, tax: 0n, refund: 0n, priceAfter: priceFromSqrt(launch.address, r[1]) };
      }
      if (side === "buy") {
        const r = (await reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "quoteBuy", args: [input, viewer] })) as readonly bigint[];
        // out, spent, refund, fee, creatorFee, tax
        const net = r[1] - r[3] - r[4] - r[5];
        const priceAfter = launch.tokenReserve > r[0] ? ((launch.quoteReserve + net) * 10n ** 18n) / (launch.tokenReserve - r[0]) : 0n;
        return { side, input, out: r[0], fee: r[3], creatorFee: r[4], tax: r[5], refund: r[2], priceAfter };
      }
      const r = (await reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "quoteSell", args: [input] })) as readonly bigint[];
      const gross = r[0] + r[1] + r[2];
      const priceAfter = ((launch.quoteReserve - gross) * 10n ** 18n) / (launch.tokenReserve + input);
      return { side, input, out: r[0], fee: r[1], creatorFee: r[2], tax: 0n, refund: 0n, priceAfter };
    },
  });

  const current = quote && quote.side === side && parsed !== undefined && quote.input === parsed ? quote : undefined;
  const stale = typed !== parsed;
  const minOut = current ? (current.out * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  const finishing = !inPool && side === "buy" && current !== undefined && (current.refund > 0n || current.out >= launch.sellable);
  const overAllowance =
    !inPool && side === "buy" && current !== undefined && !!wallet?.exempt && wallet.windowActive && current.out > launch.openingExemptRemaining;

  const impactBps = useMemo(() => {
    if (!current || launch.priceWad === 0n || current.priceAfter === 0n) return 0;
    const diff = current.priceAfter > launch.priceWad ? current.priceAfter - launch.priceWad : launch.priceWad - current.priceAfter;
    return Number((diff * 10_000n) / launch.priceWad);
  }, [current, launch.priceWad]);

  const insufficient = useMemo(() => {
    if (typed === undefined) return false;
    if (side === "buy") return ethBalance !== undefined && typed > ethBalance.value;
    return wallet !== undefined && typed > wallet.balance;
  }, [typed, side, ethBalance, wallet]);

  const needsApproval = side === "sell" && parsed !== undefined && wallet !== undefined && wallet.allowance < parsed;

  useEffect(() => setAmount(""), [side]);

  if (phase === PHASE.Refunded) {
    return (
      <div className="card trade-panel">
        <div className="panel-title">
          <h3>Refunded</h3>
          <span className="badge badge-red">Closed</span>
        </div>
        <p className="muted">The pool for this launch could never be seeded, so its reserves were returned through the recovery path.</p>
      </div>
    );
  }

  if (phase === PHASE.Settled || (phase === PHASE.Curve && launch.readyToGraduate)) {
    const settled = phase === PHASE.Settled;
    return (
      <div className="card trade-panel">
        <div className="panel-title">
          <h3>Curve complete</h3>
          <span className="badge badge-amber">Graduating</span>
        </div>
        <p className="muted">
          The curve sold out. Moving it into its locked pool is permissionless: anyone can finish it with one transaction, and trading
          resumes here straight after.
        </p>
        {isConnected && chainId === chain.id ? (
          <button
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={() =>
              send("Finish graduation", {
                address: C.LaunchFactory,
                abi: abis.LaunchFactory,
                functionName: settled ? "list" : "graduate",
                args: [launch.address],
                gas: GRADUATION_GAS,
              })
            }
          >
            {busy ? "Working…" : "Finish graduation"}
          </button>
        ) : (
          <ConnectButton block />
        )}
      </div>
    );
  }

  const payUnit = side === "buy" ? "ETH" : launch.symbol;
  const getUnit = side === "buy" ? launch.symbol : "ETH";
  const balance = side === "buy" ? ethBalance?.value : wallet?.balance;
  const presets = side === "buy" ? ["0.001", "0.01", "0.05", "0.1"] : ["25", "50", "75", "100"];
  const rate = current && current.out > 0n ? (side === "buy" ? (current.input * 10n ** 18n) / current.out : (current.out * 10n ** 18n) / current.input) : 0n;
  const highImpact = impactBps >= 500;

  const submit = async () => {
    if (!current || parsed === undefined || !address) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
    if (side === "buy") {
      const ok = inPool
        ? await send(`Buy ${launch.symbol}`, {
            address: C.PoolRouter,
            abi: abis.PoolRouter,
            functionName: "buy",
            args: [launch.address, launch.record.venueFee, minOut, address, deadline],
            value: parsed,
          })
        : await send(`Buy ${launch.symbol}`, {
            address: curve,
            abi: abis.BondingCurve,
            functionName: "buy",
            args: [parsed, minOut, address],
            value: parsed,
            gas: finishing ? GRADUATION_GAS : undefined,
          });
      if (ok) setAmount("");
      return;
    }
    if (needsApproval) {
      const approved = await send(`Approve ${launch.symbol}`, {
        address: launch.address,
        abi: abis.LaunchToken,
        functionName: "approve",
        args: [spender, parsed],
      });
      if (!approved) return;
    }
    const ok = inPool
      ? await send(`Sell ${launch.symbol}`, {
          address: C.PoolRouter,
          abi: abis.PoolRouter,
          functionName: "sell",
          args: [launch.address, launch.record.venueFee, parsed, minOut, address, deadline],
        })
      : await send(`Sell ${launch.symbol}`, {
          address: curve,
          abi: abis.BondingCurve,
          functionName: "sell",
          args: [parsed, minOut, address],
        });
    if (ok) setAmount("");
  };

  const label = busy
    ? "Confirm in your wallet…"
    : typed === undefined
      ? "Enter an amount"
      : insufficient
        ? `Not enough ${payUnit}`
        : quoteFailed && !current
          ? "Amount too large for the pool"
          : side === "buy"
            ? `Buy ${launch.symbol}`
            : needsApproval
              ? "Approve and sell"
              : `Sell ${launch.symbol}`;

  return (
    <div className="card trade-panel">
      <div className="trade-top">
        <div className="segmented" role="tablist">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} className={`segment ${side === s ? `active ${s}` : ""}`} onClick={() => setSide(s)}>
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <span className={`route ${inPool ? "route-pool" : "route-curve"}`} title={inPool ? "Trades against the locked liquidity pool" : "Trades against the bonding curve"}>
          <span className="route-dot" aria-hidden />
          {inPool ? `Pool · ${formatPercent(poolFeeBps, 0)}` : "Curve"}
        </span>
      </div>

      <div className="swap-box">
        <div className="swap-box-head">
          <span>You pay</span>
          <button
            type="button"
            className="link-button"
            disabled={balance === undefined || balance === 0n}
            onClick={() => {
              if (balance === undefined) return;
              // Keep a little native value back for gas.
              const max = side === "buy" ? (balance > 2_000_000_000_000_000n ? balance - 2_000_000_000_000_000n : 0n) : balance;
              setAmount(max === 0n ? "" : formatUnitsExact(max));
            }}
          >
            Balance {side === "buy" ? formatEth(balance, 4) : formatCompact(balance)}
          </button>
        </div>
        <div className="swap-input">
          <input
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            aria-label={side === "buy" ? "Amount of ETH to spend" : `Amount of ${launch.symbol} to sell`}
          />
          <span className="unit-pill">{payUnit}</span>
        </div>
        <div className="chips">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className="chip"
              onClick={() => {
                if (side === "buy") setAmount(p);
                else if (wallet) {
                  const share = (wallet.balance * BigInt(p)) / 100n;
                  setAmount(share === 0n ? "" : formatUnitsExact(share));
                }
              }}
            >
              {side === "buy" ? p : p === "100" ? "Max" : `${p}%`}
            </button>
          ))}
        </div>
      </div>

      <div className="swap-arrow" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="swap-box swap-box-out">
        <div className="swap-box-head">
          <span>You receive</span>
          {current && rate > 0n && (
            <span className="muted">
              1 {launch.symbol} = {formatPrice(rate)}
            </span>
          )}
        </div>
        <div className={`swap-output ${stale || quoting ? "pending" : ""}`}>
          <span className="mono">
            {current ? (side === "buy" ? formatCompact(current.out) : formatEth(current.out, 6)) : typed !== undefined && (quoting || stale) ? "…" : "0"}
          </span>
          <span className="unit-pill">{getUnit}</span>
        </div>
      </div>

      {current && (
        <div className="swap-details">
          <button type="button" className="details-toggle" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
            <span>
              Minimum {side === "buy" ? `${formatCompact(minOut)} ${launch.symbol}` : `${formatEth(minOut, 6)} ETH`}
            </span>
            <span className={`impact ${highImpact ? "high" : ""}`}>
              Impact {formatPercent(impactBps, impactBps < 100 ? 2 : 1)}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className={showDetails ? "flip" : ""}>
                <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
          {showDetails && (
            <div className="kv compact">
              <div>
                <span className="muted">Route</span>
                <span>{inPool ? "Locked pool via PoolRouter" : "Bonding curve"}</span>
              </div>
              {inPool ? (
                <div>
                  <span className="muted">Pool fee</span>
                  <span className="mono">
                    {formatPercent(poolFeeBps, 0)}
                    {side === "buy" && current.fee > 0n ? ` · ${formatEth(current.fee, 6)} ETH` : ""}
                  </span>
                </div>
              ) : (
                <>
                  <div>
                    <span className="muted">Trade fee</span>
                    <span className="mono">{formatEth(current.fee, 6)} ETH</span>
                  </div>
                  {current.creatorFee > 0n && (
                    <div>
                      <span className="muted">Creator fee</span>
                      <span className="mono">{formatEth(current.creatorFee, 6)} ETH</span>
                    </div>
                  )}
                </>
              )}
              {current.tax > 0n && (
                <div className="warn">
                  <span>Opening tax</span>
                  <span className="mono">{formatEth(current.tax, 6)} ETH</span>
                </div>
              )}
              {current.refund > 0n && (
                <div>
                  <span className="muted">Refunded (curve sells out)</span>
                  <span className="mono">{formatEth(current.refund, 6)} ETH</span>
                </div>
              )}
              <div>
                <span className="muted">Slippage tolerance</span>
                <span className="chips compact">
                  {SLIPPAGE.map((bps) => (
                    <button key={bps} type="button" className={`chip ${slippageBps === bps ? "active" : ""}`} onClick={() => setSlippageBps(bps)}>
                      {bps / 100}%
                    </button>
                  ))}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {finishing && <p className="notice">This buy completes the curve and moves the launch into its locked pool in the same transaction.</p>}
      {highImpact && <p className="notice notice-warn">This trade moves the price by {formatPercent(impactBps, 1)}. Consider a smaller amount.</p>}
      {overAllowance && (
        <p className="notice notice-warn">
          Tax-exempt wallets can buy at most {formatCompact(launch.openingExemptRemaining)} more {launch.symbol} until the opening window closes.
        </p>
      )}

      {!isConnected || chainId !== chain.id ? (
        <ConnectButton block />
      ) : (
        <button
          className={`btn btn-block btn-lg ${side === "buy" ? "btn-buy" : "btn-sell"}`}
          disabled={busy || typed === undefined || stale || insufficient || !current || current.out === 0n || overAllowance}
          onClick={submit}
        >
          {label}
        </button>
      )}

      {inPool && (
        <p className="trade-foot muted">
          Liquidity is locked forever.{" "}
          <a href={`${deployment.explorer}/address/${launch.pool}`} target="_blank" rel="noreferrer">
            View pool ↗
          </a>
        </p>
      )}
    </div>
  );
}

function formatUnitsExact(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
