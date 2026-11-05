import { Link } from "react-router-dom";

import { deployment } from "../generated/contracts";
import { useProtocol } from "../lib/data";
import { formatEth, shortAddress } from "../lib/format";

const STEPS = [
  ["Create", "Name the token and pick its terms. The entire supply is minted to its own bonding curve. Nobody, the creator included, holds a bag before trading opens."],
  ["Trade the curve", "Anyone can buy and sell at any time. The price rises as people buy and falls as they sell. Fees are always paid in ETH, never in the token."],
  ["Graduate", "When the curve sells out it closes, and what it collected seeds a Uniswap pool at exactly the price the curve finished at, even if someone prepared that pool first."],
  ["Locked forever", "The pool position goes to a contract with no function that could release it. Trading carries on in the pool like any other token."],
];

const CONTRACTS: [keyof typeof deployment.contracts, string][] = [
  ["LaunchFactory", "Creates launches and drives graduation"],
  ["LaunchRouter", "Creates a launch and buys in one transaction"],
  ["LiquidityLocker", "Holds every graduated position forever"],
  ["FeeEscrow", "Holds claimable fees until withdrawn"],
  ["BuybackVault", "Vests bought-back supply over five years"],
  ["AmmV3Venue", "Lists on Uniswap at the curve's own price"],
  ["FeeCollector", "Splits pool fees after graduation"],
  ["LaunchLens", "Read-only views for interfaces"],
];

export function HowItWorks() {
  const { data } = useProtocol();
  const reference = data?.configs.find((c) => c.label === "reference") ?? data?.configs[0];

  return (
    <div className="container page">
      <div className="page-head">
        <h1>How it works</h1>
        <p className="muted">Four steps, the same for every launch. Nobody can change them halfway through.</p>
      </div>

      <div className="steps">
        {STEPS.map(([title, body], i) => (
          <div key={title} className="panel step">
            <span className="step-number">{String(i + 1).padStart(2, "0")}</span>
            <h3>{title}</h3>
            <p className="muted">{body}</p>
          </div>
        ))}
      </div>

      <div className="split">
        <div className="panel">
          <h3>Fees</h3>
          <div className="kv">
            <div>
              <span className="muted">Trade fee</span>
              <span>{reference ? `${reference.tradeFeeBps / 100}% on every trade` : "—"}</span>
            </div>
            <div>
              <span className="muted">Protocol share</span>
              <span>30% of the trade fee</span>
            </div>
            <div>
              <span className="muted">Creator share</span>
              <span>70%, or 35% with buyback on</span>
            </div>
            <div>
              <span className="muted">Creator fee</span>
              <span>0–10%, set at launch, curve only</span>
            </div>
            <div>
              <span className="muted">Opening tax</span>
              <span>Starts near 99%, gone within seconds</span>
            </div>
            <div>
              <span className="muted">Launch fee</span>
              <span>{data ? `${formatEth(data.launchFee, 6)} ETH` : "—"}</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <h3>Standard terms</h3>
          <div className="kv">
            <div>
              <span className="muted">Supply</span>
              <span>1,000,000,000</span>
            </div>
            <div>
              <span className="muted">Opens at</span>
              <span>{reference ? `${formatEth(reference.openValuation, 2)} ETH market cap` : "—"}</span>
            </div>
            <div>
              <span className="muted">Graduates at</span>
              <span>{reference ? `${formatEth(reference.graduationValuation, 2)} ETH market cap` : "—"}</span>
            </div>
            <div>
              <span className="muted">Raised to graduate</span>
              <span>{reference ? `${formatEth(reference.graduationTarget, 2)} ETH` : "—"}</span>
            </div>
            <div>
              <span className="muted">Sold on the curve</span>
              <span>71.4% of supply</span>
            </div>
            <div>
              <span className="muted">Seeded into the pool</span>
              <span>20.4%, the rest locked</span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="block-head">
          <h3>Contracts</h3>
          <span className="muted small">Source-verified on the explorer</span>
        </div>
        <div className="contract-list">
          {CONTRACTS.map(([name, role]) => (
            <a key={name} className="contract-row" href={`${deployment.explorer}/address/${deployment.contracts[name]}#code`} target="_blank" rel="noreferrer">
              <span>
                <strong>{name}</strong>
                <span className="muted small block">{role}</span>
              </span>
              <span className="mono small">{shortAddress(deployment.contracts[name])}</span>
            </a>
          ))}
        </div>
      </div>

      <div className="cta-row">
        <Link to="/create" className="btn btn-primary">
          Launch a token
        </Link>
        <Link to="/" className="btn btn-secondary">
          Browse tokens
        </Link>
      </div>
    </div>
  );
}
