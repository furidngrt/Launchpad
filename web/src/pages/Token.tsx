import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";

import { PriceChart } from "../components/PriceChart";
import { TradePanel } from "../components/TradePanel";
import { Change, CopyButton, EmptyState, PhaseBadge, Progress, Skeleton, TokenAvatar } from "../components/ui";
import { abis, deployment } from "../generated/contracts";
import { PHASE, useLaunch, useLaunchTimes, useTrades } from "../lib/data";
import { formatAge, formatCompact, formatEth, formatPercent, formatPrice, safeLink, shortAddress, timeAgo } from "../lib/format";
import { useTx } from "../lib/tx";

type Tab = "trades" | "about" | "details";

export function Token() {
  const { address: param } = useParams();
  const token = param && isAddress(param) ? (param as Address) : undefined;
  const { data: launch, isLoading, isError, error } = useLaunch(token);
  const { data: trades, isLoading: tradesLoading } = useTrades(launch);
  const { data: times } = useLaunchTimes();
  const { address } = useAccount();
  const { send, busy } = useTx();
  const [tab, setTab] = useState<Tab>("trades");

  const volume24h = useMemo(() => {
    const since = Date.now() / 1000 - 86_400;
    return (trades ?? []).filter((t) => t.timestamp >= since).reduce((sum, t) => sum + t.quote, 0n);
  }, [trades]);

  if (!token) {
    return (
      <div className="container page">
        <EmptyState title="That is not a token address" action={<Link to="/" className="btn btn-secondary btn-sm">Back to tokens</Link>} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container page">
        <Skeleton height={56} width={320} />
        <div className="token-layout" style={{ marginTop: 20 }}>
          <div className="token-main">
            <div className="panel">
              <Skeleton height={380} />
            </div>
          </div>
          <div className="token-side">
            <div className="panel">
              <Skeleton height={360} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isError || !launch) {
    const missing = (error as Error | undefined)?.message === "not-found";
    return (
      <div className="container page">
        <EmptyState title={missing ? "No launch at this address" : "Could not load this launch"} action={<Link to="/" className="btn btn-secondary btn-sm">Back to tokens</Link>}>
          {missing ? "This address was not created by this launchpad. Check that you have the right token." : "The network did not answer. Try again in a moment."}
        </EmptyState>
      </div>
    );
  }

  const isCreator = !!address && address.toLowerCase() === launch.record.feeRecipient.toLowerCase();
  const website = safeLink(launch.website);
  const social = safeLink(launch.social);
  const createdAt = times?.get(launch.address.toLowerCase());
  const windowEnds = launch.openedAt + launch.openingTaxWindow;
  const openingActive = launch.openingTaxStartBps > 0 && Date.now() / 1000 < windowEnds;
  const recent = [...(trades ?? [])].reverse();
  const listed = launch.record.phase === PHASE.Listed;

  return (
    <div className="container page">
      <div className="token-head">
        <div className="token-identity">
          <TokenAvatar logo={launch.logo} symbol={launch.symbol} size={52} rounded={12} />
          <div className="token-title">
            <div className="token-name-row">
              <h1>{launch.name}</h1>
              <span className="ticker">${launch.symbol}</span>
              <PhaseBadge phase={launch.record.phase} />
            </div>
            <div className="token-meta">
              <span className="mono">{shortAddress(launch.address)}</span>
              <CopyButton value={launch.address} />
              <a className="btn btn-ghost btn-xs" href={`${deployment.explorer}/token/${launch.address}`} target="_blank" rel="noreferrer">
                Explorer ↗
              </a>
              {createdAt !== undefined && <span className="muted">· {formatAge(createdAt)} old</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="stat-strip">
        <div>
          <span className="label">Price</span>
          <span className="figure mono">{formatPrice(launch.priceWad)} ETH</span>
        </div>
        <div>
          <span className="label">Market cap</span>
          <span className="figure">{formatEth(launch.marketCap, 3)} ETH</span>
        </div>
        <div>
          <span className="label">Since launch</span>
          <span className="figure">
            <Change bps={launch.changeBps} />
          </span>
        </div>
        <div>
          <span className="label">24h volume</span>
          <span className="figure">{trades ? `${formatEth(volume24h, 4)} ETH` : "—"}</span>
        </div>
        <div>
          <span className="label">{listed ? "Trading in" : "Raised"}</span>
          <span className="figure">{listed ? "Locked pool" : `${formatEth(launch.raised, 4)} ETH`}</span>
        </div>
      </div>

      <div className="token-layout">
        <div className="token-main">
          <div className="panel chart-panel">
            <PriceChart trades={trades} loading={tradesLoading} priceWad={launch.priceWad} />
          </div>

          <div className="mobile-trade">
            <TradePanel launch={launch} />
          </div>

          <div className="panel tabs-panel">
            <div className="tabs" role="tablist">
              {(["trades", "about", "details"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                  {t === "trades" ? `Trades${trades ? ` (${trades.length})` : ""}` : t === "about" ? "About" : "Details"}
                </button>
              ))}
            </div>

            {tab === "trades" &&
              (tradesLoading ? (
                <Skeleton height={140} />
              ) : recent.length === 0 ? (
                <p className="muted tab-empty">No trades yet.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th className="num">Price</th>
                        <th className="num">ETH</th>
                        <th className="num">{launch.symbol}</th>
                        <th className="hide-sm">Account</th>
                        <th className="num">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.slice(0, 50).map((t) => (
                        <tr key={`${t.hash}-${t.kind}-${t.tokens}`}>
                          <td>
                            <span className={`side side-${t.kind}`}>{t.kind === "buy" ? "Buy" : "Sell"}</span>
                            <span className="venue-tag">{t.venue === "pool" ? "Pool" : "Curve"}</span>
                          </td>
                          <td className="num mono">{formatPrice(t.priceAfter)}</td>
                          <td className="num mono">{formatEth(t.quote, 4)}</td>
                          <td className="num mono">{formatCompact(t.tokens)}</td>
                          <td className="mono hide-sm">
                            <a href={`${deployment.explorer}/address/${t.account}`} target="_blank" rel="noreferrer">
                              {shortAddress(t.account)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="muted" href={`${deployment.explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">
                              {timeAgo(t.timestamp)}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

            {tab === "about" && (
              <div className="tab-body">
                {launch.description ? <p className="about-text">{launch.description}</p> : <p className="muted">The creator did not add a description.</p>}
                {(website || social) && (
                  <div className="link-row">
                    {website && (
                      <a className="btn btn-secondary btn-sm" href={website} target="_blank" rel="noreferrer nofollow">
                        Website ↗
                      </a>
                    )}
                    {social && (
                      <a className="btn btn-secondary btn-sm" href={social} target="_blank" rel="noreferrer nofollow">
                        Social ↗
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "details" && (
              <div className="tab-body kv">
                <div>
                  <span className="muted">Creator</span>
                  <a className="mono" href={`${deployment.explorer}/address/${launch.record.creator}`} target="_blank" rel="noreferrer">
                    {shortAddress(launch.record.creator)}
                  </a>
                </div>
                <div>
                  <span className="muted">Curve contract</span>
                  <a className="mono" href={`${deployment.explorer}/address/${launch.record.curve}`} target="_blank" rel="noreferrer">
                    {shortAddress(launch.record.curve)}
                  </a>
                </div>
                {launch.pool && (
                  <div>
                    <span className="muted">Pool</span>
                    <a className="mono" href={`${deployment.explorer}/address/${launch.pool}`} target="_blank" rel="noreferrer">
                      {shortAddress(launch.pool)}
                    </a>
                  </div>
                )}
                <div>
                  <span className="muted">Supply</span>
                  <span className="mono">{formatCompact(launch.supply)}</span>
                </div>
                <div>
                  <span className="muted">Trade fee + creator fee</span>
                  <span className="mono">
                    {formatPercent(launch.tradeFeeBps)} + {formatPercent(launch.record.creatorFeeBps)}
                  </span>
                </div>
                <div>
                  <span className="muted">Pool fee tier</span>
                  <span className="mono">{formatPercent(launch.record.venueFee / 100, 2)}</span>
                </div>
                <div>
                  <span className="muted">Buyback and lock</span>
                  <span>{launch.record.buybackEnabled ? "On" : "Off"}</span>
                </div>
                {launch.record.phase === PHASE.Listed && (
                  <div>
                    <span className="muted">Supply locked at graduation</span>
                    <span className="mono">{formatCompact(launch.lockedSupply)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="token-side">
          <div className="sticky">
            <div className="desktop-trade">
              <TradePanel launch={launch} />
            </div>

            {listed ? (
              <div className="panel">
                <div className="row-between">
                  <span className="label">Locked pool</span>
                  <span className="badge badge-blue">Graduated</span>
                </div>
                <div className="kv compact">
                  <div>
                    <span className="muted">Pool</span>
                    {launch.pool ? (
                      <a className="mono" href={`${deployment.explorer}/address/${launch.pool}`} target="_blank" rel="noreferrer">
                        {shortAddress(launch.pool)}
                      </a>
                    ) : (
                      <span>—</span>
                    )}
                  </div>
                  <div>
                    <span className="muted">Fee tier</span>
                    <span className="mono">{formatPercent(launch.record.venueFee / 100, 0)}</span>
                  </div>
                  <div>
                    <span className="muted">Raised on the curve</span>
                    <span className="mono">{formatEth(launch.record.graduationTarget, 4)} ETH</span>
                  </div>
                  <div>
                    <span className="muted">Supply locked at graduation</span>
                    <span className="mono">{formatCompact(launch.lockedSupply)}</span>
                  </div>
                </div>
                <p className="muted small">The position belongs to the locker contract, which has no way to withdraw it. Pool fees are split like curve fees.</p>
              </div>
            ) : (
              <div className="panel">
                <div className="row-between">
                  <span className="label">Bonding curve</span>
                  <span className="mono small">{formatPercent(launch.progressBps)}</span>
                </div>
                <Progress bps={launch.progressBps} label="Graduation progress" />
                <div className="kv compact">
                  <div>
                    <span className="muted">Raised</span>
                    <span className="mono">
                      {formatEth(launch.raised, 4)} / {formatEth(launch.record.graduationTarget, 4)} ETH
                    </span>
                  </div>
                  <div>
                    <span className="muted">Left on the curve</span>
                    <span className="mono">{formatCompact(launch.sellable)}</span>
                  </div>
                  <div>
                    <span className="muted">Reserved for the pool</span>
                    <span className="mono">{formatCompact(launch.reserveFloor)}</span>
                  </div>
                </div>
                {openingActive && <p className="notice notice-warn">Opening tax is active and falls to zero by {new Date(windowEnds * 1000).toLocaleTimeString()}.</p>}
              </div>
            )}

            <div className="panel">
              <span className="label">Guarantees</span>
              <ul className="checks">
                <li>Fixed supply, minted entirely to the curve</li>
                <li>No owner, mint, pause or blocklist</li>
                <li>Pool liquidity locked forever</li>
                <li>Fees paid in ETH, never in the token</li>
              </ul>
            </div>

            {isCreator && launch.record.phase === PHASE.Curve && (
              <div className="panel">
                <span className="label">Creator tools</span>
                <div className="kv compact">
                  <div>
                    <span className="muted">Trade fees pending</span>
                    <span className="mono">{formatEth(launch.feeBalance, 6)}</span>
                  </div>
                  <div>
                    <span className="muted">Creator fees pending</span>
                    <span className="mono">{formatEth(launch.creatorFeeBalance, 6)}</span>
                  </div>
                </div>
                <div className="link-row">
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy || launch.buybackEarmark > 0n || launch.feeBalance + launch.creatorFeeBalance === 0n}
                    title={launch.buybackEarmark > 0n ? "A buyback is due, which only the protocol operator can run." : undefined}
                    onClick={() => send("Distribute fees", { address: launch.record.curve, abi: abis.BondingCurve, functionName: "sweepFees", args: [0n] })}
                  >
                    Distribute fees
                  </button>
                  <Link to="/portfolio" className="btn btn-ghost btn-sm">
                    Claim →
                  </Link>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
