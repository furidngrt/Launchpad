import { useState, type ReactNode } from "react";
import { PHASE_LABEL } from "../lib/data";
import { resolveMedia } from "../lib/format";

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo-mark">
      <rect width="32" height="32" rx="8" className="logo-bg" />
      <path d="M9.5 20 16 11.5l6.5 8.5" className="logo-stroke" />
      <path d="M16 11.5V23" className="logo-stroke" />
    </svg>
  );
}

/** Flat tile colours for tokens without an image. Deep, muted and solid. */
const TONES = ["#1f5f57", "#7a3b26", "#4c2c6b", "#5b6a1c", "#23426e", "#6b2340", "#2f5a2a", "#6b4a1a", "#2b3f66", "#5a2d5f"];

export function toneFor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  return TONES[hash % TONES.length];
}

export function TokenAvatar({ logo, symbol, size = 40, rounded = 10 }: { logo?: string; symbol: string; size?: number; rounded?: number }) {
  const [failed, setFailed] = useState(false);
  const src = resolveMedia(logo);
  if (src && !failed) {
    return (
      <img
        className="avatar"
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: rounded }}
        onError={() => setFailed(true)}
        loading="lazy"
      />
    );
  }
  return (
    <span className="avatar avatar-fallback" style={{ width: size, height: size, borderRadius: rounded, background: toneFor(symbol), fontSize: Math.max(10, size * 0.32) }} aria-hidden>
      {symbol.slice(0, 3).toUpperCase() || "?"}
    </span>
  );
}

/** The square artwork on a launch tile: the token's image, or its ticker on a flat tile. */
export function TokenArt({ logo, symbol }: { logo?: string; symbol: string }) {
  const [failed, setFailed] = useState(false);
  const src = resolveMedia(logo);
  if (src && !failed) return <img className="art" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
  return (
    <span className="art art-fallback" style={{ background: toneFor(symbol) }} aria-hidden>
      {symbol.slice(0, 3).toUpperCase() || "?"}
    </span>
  );
}

export function PhaseBadge({ phase }: { phase: number }) {
  const tone = phase === 0 ? "green" : phase === 2 ? "blue" : phase === 1 ? "amber" : "red";
  return <span className={`badge badge-${tone}`}>{PHASE_LABEL[phase] ?? "Unknown"}</span>;
}

export function Change({ bps }: { bps: number }) {
  const up = bps >= 0;
  const text = bps >= 100_000 ? `${(bps / 10_000 + 1).toFixed(1)}x` : `${Math.abs(bps / 100).toFixed(Math.abs(bps) >= 10_000 ? 0 : 1)}%`;
  return (
    <span className={`change ${up ? "up" : "down"}`}>
      <span className="change-arrow" aria-hidden>
        {up ? "▲" : "▼"}
      </span>
      {text}
    </span>
  );
}

export function Progress({ bps, label, thin = false }: { bps: number; label?: string; thin?: boolean }) {
  const pct = Math.min(100, Math.max(0, bps / 100));
  return (
    <div className={`progress ${thin ? "thin" : ""}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? "Progress"}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function Skeleton({ height = 16, width = "100%", radius = 8 }: { height?: number | string; width?: number | string; radius?: number }) {
  return <span className="skeleton" style={{ height, width, borderRadius: radius }} aria-hidden />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function InfoDot({ title }: { title: string }) {
  return (
    <span className="info-dot" title={title} aria-label={title}>
      i
    </span>
  );
}
