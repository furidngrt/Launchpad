import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance } from "wagmi";
import { parseUnits, zeroAddress, type Address } from "viem";

import { chain, reader } from "../config/wagmi";
import { abis, deployment } from "../generated/contracts";
import { PHASE, type LaunchDetail } from "../lib/data";
import { formatCompact, formatEth, formatPercent } from "../lib/format";
import { useTx } from "../lib/tx";
import { ConnectButton } from "./ConnectButton";

const C = deployment.contracts;
/** A finishing buy graduates the launch in the same transaction, inside a
 * try/catch. Wallet gas estimates find the smallest budget at which the buy
 * succeeds, which is one where graduation silently runs out of gas, so the
 * finishing buy carries an explicit limit instead. */
const GRADUATION_GAS = 15_000_000n;

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

const SLIPPAGE = [50, 100, 300, 500];

export function TradePanel({ launch }: { launch: LaunchDetail }) {
  const { address, isConnected, chainId } = useAccount();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const { send, busy } = useTx();

  const debounced = useDebounced(amount, 300);
  const parsed = parseAmount(debounced);
  const curve = launch.record.curve;
  const viewer = (address ?? zeroAddress) as Address;

  const { data: ethBalance } = useBalance({ address, chainId: chain.id, query: { refetchInterval: 12_000 } });
  const { data: wallet } = useQuery({
    queryKey: ["wallet", launch.address, address],
    enabled: !!address,
    refetchInterval: 12_000,
    queryFn: async () => {
      const [balance, allowance, exempt, windowActive] = await Promise.all([
        reader.readContract({ address: launch.address, abi: abis.LaunchToken, functionName: "balanceOf", args: [viewer] }) as Promise<bigint>,
        reader.readContract({ address: launch.address, abi: abis.LaunchToken, functionName: "allowance", args: [viewer, curve] }) as Promise<bigint>,
        reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "openingTaxExempt", args: [viewer] }) as Promise<boolean>,
        reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "openingWindowActive" }) as Promise<boolean>,
      ]);
      return { balance, allowance, exempt, windowActive };
    },
  });

  const { data: quote, isFetching: quoting } = useQuery({
    queryKey: ["quote", side, curve, parsed?.toString(), viewer],
    enabled: parsed !== undefined && launch.record.phase === PHASE.Curve,
    queryFn: async () => {
      if (side === "buy") {
        const r = (await reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "quoteBuy", args: [parsed, viewer] })) as readonly bigint[];
        return { side, out: r[0], spent: r[1], refund: r[2], fee: r[3] + r[5], creatorFee: r[4], tax: r[5] };
      }
      const r = (await reader.readContract({ address: curve, abi: abis.BondingCurve, functionName: "quoteSell", args: [parsed] })) as readonly bigint[];
      return { side, out: r[0], spent: parsed as bigint, refund: 0n, fee: r[1], creatorFee: r[2], tax: 0n };
    },
  });

  const current = quote && quote.side === side && parsed !== undefined ? quote : undefined;
  const minOut = current ? (current.out * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  const finishing = side === "buy" && current !== undefined && (current.refund > 0n || current.out >= launch.sellable);
  const overAllowance =
    side === "buy" && current !== undefined && !!wallet?.exempt && wallet.windowActive && current.out > launch.openingExemptRemaining;

  const insufficient = useMemo(() => {
    if (parsed === undefined) return false;
    if (side === "buy") return ethBalance !== undefined && parsed > ethBalance.value;
    return wallet !== undefined && parsed > wallet.balance;
  }, [parsed, side, ethBalance, wallet]);

  const needsApproval = side === "sell" && parsed !== undefined && wallet !== undefined && wallet.allowance < parsed;

  useEffect(() => setAmount(""), [side]);

  if (launch.record.phase === PHASE.Listed) {
    const uniswap = `https://app.uniswap.org/swap?chain=${deployment.network}&inputCurrency=ETH&outputCurrency=${launch.address}`;
    return (
      <div className="card trade-panel">
        <div className="panel-title">
          <h3>Trading in the pool</h3>
          <span className="badge badge-blue">Graduated</span>
        </div>
        <p className="muted">
          This launch completed its curve. Its liquidity is locked forever in a Uniswap V3 pool, and trading continues there.
        </p>
        <a className="btn btn-primary btn-block" href={uniswap} target="_blank" rel="noreferrer">
          Trade on Uniswap
        </a>
        {launch.pool && (
          <a className="btn btn-ghost btn-block" href={`${deployment.explorer}/address/${launch.pool}`} target="_blank" rel="noreferrer">
            View pool
          </a>
        )}
      </div>
    );
  }

  if (launch.record.phase === PHASE.Refunded) {
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

  if (launch.record.phase === PHASE.Settled || launch.readyToGraduate) {
    const settled = launch.record.phase === PHASE.Settled;
    return (
      <div className="card trade-panel">
        <div className="panel-title">
          <h3>Curve complete</h3>
          <span className="badge badge-amber">Graduating</span>
        </div>
        <p className="muted">
          The curve sold out. Graduation into the pool is permissionless, so anyone can finish it with one transaction.
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

  const presets = side === "buy" ? ["0.001", "0.005", "0.01", "0.05"] : ["25", "50", "75", "100"];

  return (
    <div className="card trade-panel">
      <div className="segmented" role="tablist">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={side === s} className={`segment ${side === s ? `active ${s}` : ""}`} onClick={() => setSide(s)}>
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <label className="field">
        <div className="row-between">
          <span className="field-label">{side === "buy" ? "You pay" : "You sell"}</span>
          <span className="muted small">
            Balance{" "}
            {side === "buy"
              ? `${formatEth(ethBalance?.value, 4)} ETH`
              : `${formatCompact(wallet?.balance)} ${launch.symbol}`}
          </span>
        </div>
        <div className="amount-input">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            aria-label={side === "buy" ? "Amount of ETH to spend" : `Amount of ${launch.symbol} to sell`}
          />
          <span className="amount-unit">{side === "buy" ? "ETH" : launch.symbol}</span>
        </div>
      </label>

      <div className="chips">
        {presets.map((p) => (
          <button
            key={p}
            className="chip"
            onClick={() => {
              if (side === "buy") setAmount(p);
              else if (wallet) {
                const share = (wallet.balance * BigInt(p)) / 100n;
                setAmount(share === 0n ? "" : formatUnitsExact(share));
              }
            }}
          >
            {side === "buy" ? `${p} ETH` : p === "100" ? "Max" : `${p}%`}
          </button>
        ))}
      </div>

      <div className="quote">
        <div className="row-between">
          <span className="muted">You receive</span>
          <strong className="mono">
            {current ? (side === "buy" ? `${formatCompact(current.out)} ${launch.symbol}` : `${formatEth(current.out, 6)} ETH`) : quoting ? "…" : "—"}
          </strong>
        </div>
        <div className="row-between small">
          <span className="muted">Trade fee</span>
          <span className="mono">{current ? `${formatEth(current.fee - current.tax, 6)} ETH` : formatPercent(launch.tradeFeeBps)}</span>
        </div>
        <div className="row-between small">
          <span className="muted">Creator fee</span>
          <span className="mono">{current ? `${formatEth(current.creatorFee, 6)} ETH` : formatPercent(launch.record.creatorFeeBps)}</span>
        </div>
        {current && current.tax > 0n && (
          <div className="row-between small warn">
            <span>Opening tax</span>
            <span className="mono">{formatEth(current.tax, 6)} ETH</span>
          </div>
        )}
        {current && current.refund > 0n && (
          <div className="row-between small">
            <span className="muted">Refunded (curve sells out)</span>
            <span className="mono">{formatEth(current.refund, 6)} ETH</span>
          </div>
        )}
        <div className="row-between small">
          <span className="muted">Minimum after slippage</span>
          <span className="mono">
            {current ? (side === "buy" ? `${formatCompact(minOut)} ${launch.symbol}` : `${formatEth(minOut, 6)} ETH`) : "—"}
          </span>
        </div>
      </div>

      <div className="slippage">
        <span className="muted small">Slippage</span>
        <div className="chips compact">
          {SLIPPAGE.map((bps) => (
            <button key={bps} className={`chip ${slippageBps === bps ? "active" : ""}`} onClick={() => setSlippageBps(bps)}>
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {finishing && <p className="notice">This buy completes the curve and graduates the launch into its pool in the same transaction.</p>}
      {overAllowance && (
        <p className="notice notice-warn">
          Tax-exempt wallets can buy at most {formatCompact(launch.openingExemptRemaining)} more {launch.symbol} until the opening window closes.
        </p>
      )}

      {!isConnected || chainId !== chain.id ? (
        <ConnectButton block />
      ) : (
        <button
          className={`btn btn-block ${side === "buy" ? "btn-primary" : "btn-danger"}`}
          disabled={busy || parsed === undefined || insufficient || !current || current.out === 0n || overAllowance}
          onClick={async () => {
            if (!current || parsed === undefined || !address) return;
            if (side === "buy") {
              const ok = await send(`Buy ${launch.symbol}`, {
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
                args: [curve, parsed],
              });
              if (!approved) return;
            }
            const ok = await send(`Sell ${launch.symbol}`, {
              address: curve,
              abi: abis.BondingCurve,
              functionName: "sell",
              args: [parsed, minOut, address],
            });
            if (ok) setAmount("");
          }}
        >
          {busy
            ? "Working…"
            : parsed === undefined
              ? "Enter an amount"
              : insufficient
                ? "Insufficient balance"
                : side === "buy"
                  ? `Buy ${launch.symbol}`
                  : needsApproval
                    ? `Approve and sell`
                    : `Sell ${launch.symbol}`}
        </button>
      )}
    </div>
  );
}

function formatUnitsExact(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
