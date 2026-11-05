import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { LaunchCard, LaunchRow, SpotlightCard } from "../components/LaunchCard";
import { EmptyState, Skeleton } from "../components/ui";
import { chain } from "../config/wagmi";
import { PHASE, useLaunchTimes, useLaunches, type LaunchSummary } from "../lib/data";
import { formatEth } from "../lib/format";

type Tab = "top" | "new" | "near" | "graduated";
type View = "grid" | "list";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "top", label: "Trending", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { id: "new", label: "New", icon: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" },
  { id: "near", label: "About to graduate", icon: "M3 17l6-6 4 4 8-8M15 7h6v6" },
  { id: "graduated", label: "Graduated", icon: "M5 12.5 10 17l9-10" },
];

function readView(): View {
  try {
    return localStorage.getItem("view") === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function Explore() {
  const { data, isLoading, isError, refetch } = useLaunches(100);
  const { data: times } = useLaunchTimes();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>("top");
  const [view, setView] = useState<View>(readView);
  const query = (params.get("q") ?? "").trim().toLowerCase();

  const created = (l: LaunchSummary) => times?.get(l.address.toLowerCase());

  const all = useMemo(() => {
    const list = data?.launches ?? [];
    if (!query) return list;
    return list.filter((l) => l.name.toLowerCase().includes(query) || l.symbol.toLowerCase().includes(query) || l.address.toLowerCase() === query);
  }, [data, query]);

  const spotlight = useMemo(() => {
    const list = data?.launches ?? [];
    // Prefer the most valuable launch still on its curve, where there is
    // something left to watch; fall back to the most valuable overall.
    const live = list.filter((l) => l.record.phase === PHASE.Curve).sort(byMarketCap);
    return live[0] ?? [...list].sort(byMarketCap)[0];
  }, [data]);

  const stats = useMemo(() => {
    const list = data?.launches ?? [];
    return {
      total: data?.count ?? 0,
      live: list.filter((l) => l.record.phase === PHASE.Curve).length,
      graduated: list.filter((l) => l.record.phase === PHASE.Listed).length,
      raised: list.reduce((sum, l) => sum + l.raised, 0n),
    };
  }, [data]);

  const shown = useMemo(() => {
    const list = [...all];
    if (tab === "top") return list.sort(byMarketCap);
    if (tab === "new") return list.sort((a, b) => b.index - a.index);
    if (tab === "near") return list.filter((l) => l.record.phase === PHASE.Curve).sort((a, b) => b.progressBps - a.progressBps);
    return list.filter((l) => l.record.phase === PHASE.Listed).sort(byMarketCap);
  }, [all, tab]);

  const changeView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem("view", next);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <div className="explore">
      {!query && (
        <section className="container hero">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="status-dot live" aria-hidden />
              Live on {chain.name}
            </span>
            <h1>Fair launches that graduate into liquidity nobody can pull.</h1>
            <p className="muted">
              Every token starts on a bonding curve with its whole supply. When the curve fills, it moves into a pool whose liquidity is
              locked forever, and you keep trading it right here.
            </p>
            <div className="hero-actions">
              <Link to="/create" className="btn btn-primary">
                Launch a token
              </Link>
              <Link to="/how-it-works" className="btn btn-secondary">
                How it works
              </Link>
            </div>
            <dl className="hero-stats">
              <div>
                <dt>Launches</dt>
                <dd>{isLoading ? "—" : stats.total}</dd>
              </div>
              <div>
                <dt>On the curve</dt>
                <dd>{isLoading ? "—" : stats.live}</dd>
              </div>
              <div>
                <dt>Graduated</dt>
                <dd>{isLoading ? "—" : stats.graduated}</dd>
              </div>
              <div>
                <dt>Raised</dt>
                <dd>{isLoading ? "—" : `${formatEth(stats.raised, 3)} ETH`}</dd>
              </div>
            </dl>
          </div>
          <div className="hero-side">
            {isLoading ? (
              <div className="spotlight">
                <Skeleton height={64} width={64} radius={16} />
                <Skeleton width="60%" />
                <Skeleton height={48} />
                <Skeleton height={8} />
              </div>
            ) : spotlight ? (
              <SpotlightCard launch={spotlight} createdAt={created(spotlight)} />
            ) : (
              <div className="spotlight spotlight-empty">
                <span className="spotlight-tag">Spotlight</span>
                <p className="muted">The first launch on this network will appear here.</p>
                <Link to="/create" className="btn btn-primary btn-sm">
                  Be the first
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="container block">
        <div className="block-head">
          <h2>{query ? `Results for “${params.get("q")}”` : "Explore launches"}</h2>
          {data && <span className="muted small">{data.count} total</span>}
        </div>

        <div className="toolbar">
          <div className="pills" role="tablist" aria-label="Sort and filter">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={`pill ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d={t.icon} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t.label}
              </button>
            ))}
          </div>
          <div className="view-toggle" role="group" aria-label="View">
            <button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")} aria-label="Grid view">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="3" y="3" width="8" height="8" rx="1.5" />
                <rect x="13" y="3" width="8" height="8" rx="1.5" />
                <rect x="3" y="13" width="8" height="8" rx="1.5" />
                <rect x="13" y="13" width="8" height="8" rx="1.5" />
              </svg>
            </button>
            <button className={view === "list" ? "active" : ""} onClick={() => changeView("list")} aria-label="List view">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="cards">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="lcard">
                <div className="lcard-head">
                  <Skeleton height={44} width={44} radius={12} />
                  <div className="lcard-names">
                    <Skeleton width="70%" height={12} />
                    <Skeleton width="40%" height={10} />
                  </div>
                </div>
                <Skeleton height={34} width="60%" />
                <Skeleton height={6} />
              </div>
            ))}
          </div>
        ) : isError ? (
          <EmptyState title="Could not load launches" action={<button className="btn btn-secondary btn-sm" onClick={() => refetch()}>Retry</button>}>
            The network did not answer. This is usually temporary.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            title={query ? "Nothing matches that search" : tab === "graduated" ? "Nothing has graduated yet" : "No launches here yet"}
            action={!query && <Link to="/create" className="btn btn-primary btn-sm">Launch a token</Link>}
          >
            {query ? "Try a name, a symbol, or paste the full token address." : "Launches appear here the moment they are created."}
          </EmptyState>
        ) : view === "grid" ? (
          <div className="cards">
            {shown.map((launch) => (
              <LaunchCard key={launch.address} launch={launch} createdAt={created(launch)} />
            ))}
          </div>
        ) : (
          <div className="rows">
            <div className="row row-head" aria-hidden>
              <span className="row-rank">#</span>
              <span>Token</span>
              <span className="row-num">Price</span>
              <span className="row-num">Since launch</span>
              <span className="row-num">Mkt cap</span>
              <span className="row-num">Curve</span>
              <span className="row-num hide-sm">Age</span>
            </div>
            {shown.map((launch, i) => (
              <LaunchRow key={launch.address} launch={launch} createdAt={created(launch)} rank={i + 1} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function byMarketCap(a: LaunchSummary, b: LaunchSummary) {
  return b.marketCap > a.marketCap ? 1 : b.marketCap < a.marketCap ? -1 : 0;
}
