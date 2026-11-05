import { Link } from "react-router-dom";

import { PHASE, type LaunchSummary } from "../lib/data";
import { formatAge, formatEth, formatPercent, formatPrice, shortAddress } from "../lib/format";
import { Change, PhaseBadge, Progress, TokenAvatar } from "./ui";

/** Card for the grid view: identity, valuation, and how far along it is. */
export function LaunchCard({ launch, createdAt }: { launch: LaunchSummary; createdAt?: number }) {
  const listed = launch.record.phase === PHASE.Listed;
  return (
    <Link to={`/token/${launch.address}`} className="lcard">
      <div className="lcard-head">
        <TokenAvatar logo={launch.logo} symbol={launch.symbol} size={44} rounded={12} />
        <div className="lcard-names">
          <span className="lcard-name truncate">{launch.name}</span>
          <span className="lcard-sub">
            <span className="mono">${launch.symbol}</span>
            {createdAt !== undefined && <span>· {formatAge(createdAt)}</span>}
          </span>
        </div>
        <PhaseBadge phase={launch.record.phase} />
      </div>

      <div className="lcard-figures">
        <div>
          <span className="label">Market cap</span>
          <span className="lcard-mcap">{formatEth(launch.marketCap, 3)} ETH</span>
        </div>
        <Change bps={launch.changeBps} />
      </div>

      <div className="lcard-foot">
        {listed ? (
          <div className="lcard-pool">
            <span className="lock-icon" aria-hidden>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
              </svg>
            </span>
            Liquidity locked · trading in pool
          </div>
        ) : (
          <>
            <div className="row-between small">
              <span className="muted">Bonding curve</span>
              <span className="mono">{formatPercent(launch.progressBps, 0)}</span>
            </div>
            <Progress bps={launch.progressBps} thin label="Graduation progress" />
          </>
        )}
      </div>
    </Link>
  );
}

/** The highest-valued launch, shown large at the top of the page. */
export function SpotlightCard({ launch, createdAt }: { launch: LaunchSummary; createdAt?: number }) {
  const listed = launch.record.phase === PHASE.Listed;
  return (
    <Link to={`/token/${launch.address}`} className="spotlight">
      <div className="spotlight-tag">Spotlight</div>
      <div className="spotlight-head">
        <TokenAvatar logo={launch.logo} symbol={launch.symbol} size={64} rounded={16} />
        <div className="lcard-names">
          <span className="spotlight-name truncate">{launch.name}</span>
          <span className="lcard-sub">
            <span className="mono">${launch.symbol}</span>
            <span>· by {shortAddress(launch.record.creator)}</span>
            {createdAt !== undefined && <span>· {formatAge(createdAt)}</span>}
          </span>
        </div>
      </div>
      <div className="spotlight-stats">
        <div>
          <span className="label">Market cap</span>
          <span className="spotlight-figure">{formatEth(launch.marketCap, 3)} ETH</span>
        </div>
        <div>
          <span className="label">Price</span>
          <span className="spotlight-figure mono">{formatPrice(launch.priceWad)}</span>
        </div>
        <div>
          <span className="label">Since launch</span>
          <span className="spotlight-figure">
            <Change bps={launch.changeBps} />
          </span>
        </div>
      </div>
      {listed ? (
        <div className="lcard-pool">Graduated · liquidity locked forever</div>
      ) : (
        <div>
          <div className="row-between small">
            <span className="muted">
              {formatEth(launch.raised, 3)} / {formatEth(launch.record.graduationTarget, 3)} ETH raised
            </span>
            <span className="mono">{formatPercent(launch.progressBps, 0)}</span>
          </div>
          <Progress bps={launch.progressBps} label="Graduation progress" />
        </div>
      )}
      <span className="spotlight-cta">Trade {launch.symbol} →</span>
    </Link>
  );
}

/** Row for the table view. */
export function LaunchRow({ launch, createdAt, rank }: { launch: LaunchSummary; createdAt?: number; rank: number }) {
  return (
    <Link to={`/token/${launch.address}`} className="row">
      <span className="row-rank muted mono">{rank}</span>
      <span className="row-token">
        <TokenAvatar logo={launch.logo} symbol={launch.symbol} size={32} rounded={9} />
        <span className="row-names">
          <span className="truncate">{launch.name}</span>
          <span className="muted small">${launch.symbol}</span>
        </span>
      </span>
      <span className="row-num mono">{formatPrice(launch.priceWad)}</span>
      <span className="row-num">
        <Change bps={launch.changeBps} />
      </span>
      <span className="row-num mono">{formatEth(launch.marketCap, 3)}</span>
      <span className="row-num row-progress">
        {launch.record.phase === PHASE.Listed ? (
          <span className="badge badge-blue">Pool</span>
        ) : (
          <>
            <Progress bps={launch.progressBps} thin />
            <span className="mono small">{formatPercent(launch.progressBps, 0)}</span>
          </>
        )}
      </span>
      <span className="row-num muted small hide-sm">{formatAge(createdAt)}</span>
    </Link>
  );
}
