import { Link } from "react-router-dom";

import { PHASE, type LaunchSummary } from "../lib/data";
import { formatAge, formatEth, formatPercent, formatPrice } from "../lib/format";
import { Change, Progress, TokenArt, TokenAvatar } from "./ui";

/** Square tile for the grid view. */
export function LaunchTile({ launch, createdAt }: { launch: LaunchSummary; createdAt?: number }) {
  const graduated = launch.record.phase === PHASE.Listed;
  return (
    <Link to={`/token/${launch.address}`} className="tile">
      <div className="tile-art">
        <TokenArt logo={launch.logo} symbol={launch.symbol} />
        {createdAt !== undefined && <span className="tile-age">{formatAge(createdAt)}</span>}
        <span className={`tile-phase ${graduated ? "graduated" : launch.record.phase === PHASE.Curve ? "curve" : "other"}`} title={graduated ? "Graduated" : "On the curve"}>
          {graduated ? "Pool" : `${Math.floor(launch.progressBps / 100)}%`}
        </span>
      </div>
      <div className="tile-body">
        <span className="tile-name truncate">{launch.name}</span>
        <div className="tile-figures">
          <span className="tile-mcap">{formatEth(launch.marketCap, 3)} Ξ</span>
          <Change bps={launch.changeBps} />
        </div>
        {!graduated && <Progress bps={launch.progressBps} thin label="Graduation progress" />}
      </div>
    </Link>
  );
}

/** Wide card for the top tokens strip. */
export function TopCard({ launch, createdAt }: { launch: LaunchSummary; createdAt?: number }) {
  return (
    <Link to={`/token/${launch.address}`} className="top-card">
      <div className="top-art">
        <TokenArt logo={launch.logo} symbol={launch.symbol} />
        {createdAt !== undefined && <span className="tile-age">{formatAge(createdAt)}</span>}
      </div>
      <div className="top-body">
        <span className="top-name truncate">{launch.name}</span>
        <div className="tile-figures">
          <span className="top-mcap">{formatEth(launch.marketCap, 3)} ETH</span>
          <Change bps={launch.changeBps} />
        </div>
        <div className="top-meta">
          <span className="muted">${launch.symbol}</span>
          <span className="muted mono">{launch.record.phase === PHASE.Listed ? "Graduated" : `${formatPercent(launch.progressBps, 0)} to pool`}</span>
        </div>
      </div>
    </Link>
  );
}

/** Row for the table view. */
export function LaunchRow({ launch, createdAt, rank }: { launch: LaunchSummary; createdAt?: number; rank: number }) {
  return (
    <Link to={`/token/${launch.address}`} className="row">
      <span className="row-rank muted mono">{rank}</span>
      <span className="row-token">
        <TokenAvatar logo={launch.logo} symbol={launch.symbol} size={32} rounded={8} />
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
