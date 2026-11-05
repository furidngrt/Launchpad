import { Link } from "react-router-dom";
import { useAccount } from "wagmi";

import { ConnectButton } from "../components/ConnectButton";
import { EmptyState, PhaseBadge, Skeleton, TokenAvatar } from "../components/ui";
import { abis, deployment } from "../generated/contracts";
import { PHASE, useLaunches, usePortfolio } from "../lib/data";
import { formatCompact, formatEth, formatPrice, valuation } from "../lib/format";
import { useTx } from "../lib/tx";

export function Portfolio() {
  const { address, isConnected } = useAccount();
  const { data: launches } = useLaunches(100);
  const { data, isLoading } = usePortfolio(address, launches?.launches);
  const { send, busy } = useTx();

  if (!isConnected) {
    return (
      <div className="container page">
        <EmptyState title="Connect a wallet to see your portfolio" action={<ConnectButton />}>
          Your holdings, the launches you created, and the fees you can claim all appear here.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Portfolio</h1>
        <p className="muted">Rewards you can claim, launches you created, and the tokens you hold.</p>
      </div>

      <div className="portfolio-grid">
        <div className="card rewards">
          <span className="stat-label">Claimable rewards</span>
          {isLoading || !data ? (
            <Skeleton height={36} width="50%" />
          ) : (
            <span className="hero-number">{formatEth(data.escrow, 6)} ETH</span>
          )}
          <p className="muted small">Creator fees and protocol payouts are credited here and wait until you withdraw them.</p>
          <button
            className="btn btn-primary"
            disabled={busy || !data || data.escrow === 0n}
            onClick={() => send("Claim rewards", { address: deployment.contracts.FeeEscrow, abi: abis.FeeEscrow, functionName: "claim", args: [] })}
          >
            Claim to wallet
          </button>
        </div>

        <div className="card">
          <div className="row-between">
            <h3>Your launches</h3>
            <Link to="/create" className="btn btn-secondary btn-sm">
              New launch
            </Link>
          </div>
          {isLoading || !data ? (
            <Skeleton height={80} />
          ) : data.mine.length === 0 ? (
            <p className="muted">You have not created a launch yet.</p>
          ) : (
            <div className="list">
              {data.mine.map((l) => {
                const pending = data.pendingByCurve.find((p) => p.address === l.address);
                const total = (pending?.fee ?? 0n) + (pending?.creatorFee ?? 0n);
                return (
                  <div key={l.address} className="list-row">
                    <Link to={`/token/${l.address}`} className="list-token">
                      <TokenAvatar logo={l.logo} symbol={l.symbol} size={36} />
                      <div>
                        <strong>{l.name}</strong>
                        <span className="muted small">${l.symbol}</span>
                      </div>
                    </Link>
                    <PhaseBadge phase={l.record.phase} />
                    <div className="list-figure">
                      <span className="stat-label">Pending on curve</span>
                      <span className="mono">{formatEth(total, 6)} ETH</span>
                    </div>
                    {l.record.phase === PHASE.Curve && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy || total === 0n || (pending?.earmark ?? 0n) > 0n}
                        title={(pending?.earmark ?? 0n) > 0n ? "A buyback is due, which only the protocol operator can run." : undefined}
                        onClick={() => send("Distribute fees", { address: l.record.curve, abi: abis.BondingCurve, functionName: "sweepFees", args: [0n] })}
                      >
                        Distribute
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card portfolio-holdings">
          <h3>Holdings</h3>
          {isLoading || !data ? (
            <Skeleton height={80} />
          ) : data.holdings.length === 0 ? (
            <p className="muted">You do not hold any launch tokens yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th className="num">Balance</th>
                    <th className="num">Price</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.map(({ launch, balance }) => (
                    <tr key={launch.address}>
                      <td>
                        <Link to={`/token/${launch.address}`} className="list-token">
                          <TokenAvatar logo={launch.logo} symbol={launch.symbol} size={28} />
                          <span>{launch.symbol}</span>
                        </Link>
                      </td>
                      <td className="num mono">{formatCompact(balance)}</td>
                      <td className="num mono">{formatPrice(launch.priceWad)}</td>
                      <td className="num mono">{formatEth(valuation(launch.priceWad, balance), 5)} ETH</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
