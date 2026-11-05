import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { chain } from "../config/wagmi";
import { deployment } from "../generated/contracts";
import { useBlockNumber } from "../lib/data";
import { ConnectButton } from "./ConnectButton";
import { Logo } from "./ui";

type Theme = "light" | "dark";

function readTheme(): Theme {
  try {
    return localStorage.getItem("theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("theme", theme);
  } catch {
    /* storage unavailable */
  }
}

function SearchBox({ autoFocus = false, onDone }: { autoFocus?: boolean; onDone?: () => void }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [value, setValue] = useState(params.get("q") ?? "");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(params.get("q") ?? "");
  }, [params]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !/input|textarea|select/i.test(target.tagName)) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (/^0x[0-9a-fA-F]{40}$/.test(q)) navigate(`/token/${q}`);
        else navigate(q ? `/?q=${encodeURIComponent(q)}` : "/");
        input.current?.blur();
        onDone?.();
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
        <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={input}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search tokens or paste an address"
        aria-label="Search tokens"
      />
      <kbd>/</kbd>
    </form>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
    setSearching(false);
  }, [location.pathname, location.search]);

  return (
    <header className="header">
      <div className="container header-inner">
        <div className="header-left">
          <Link to="/" className="brand" aria-label="Launchpad home">
            <Logo />
            <span>Launchpad</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
              Tokens
            </NavLink>
            <NavLink to="/portfolio" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
              Portfolio
            </NavLink>
            <NavLink to="/how-it-works" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
              How it works
            </NavLink>
          </nav>
        </div>

        <div className="header-search">
          <SearchBox />
        </div>

        <div className="header-actions">
          <button className="icon-button only-mobile" onClick={() => setSearching((v) => !v)} aria-label="Search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <Link to="/create" className="btn btn-primary btn-sm only-desktop">
            Launch a token
          </Link>
          <ConnectButton compact />
          <button className="icon-button only-mobile" onClick={() => setOpen((v) => !v)} aria-label="Menu" aria-expanded={open}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              {open ? (
                <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {searching && (
        <div className="mobile-search only-mobile">
          <div className="container">
            <SearchBox autoFocus onDone={() => setSearching(false)} />
          </div>
        </div>
      )}

      {open && (
        <div className="mobile-sheet only-mobile">
          <div className="container">
            <NavLink to="/" end className="sheet-link">
              Tokens
            </NavLink>
            <NavLink to="/portfolio" className="sheet-link">
              Portfolio
            </NavLink>
            <NavLink to="/how-it-works" className="sheet-link">
              How it works
            </NavLink>
            <Link to="/create" className="btn btn-primary btn-block sheet-cta">
              Launch a token
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const { data: block } = useBlockNumber();

  useEffect(() => applyTheme(theme), [theme]);

  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-left">
          <span className={`status-dot ${block ? "live" : ""}`} aria-hidden />
          <span>{chain.name}</span>
          <span className="muted mono">{block ? `#${block.toLocaleString("en-US")}` : "connecting…"}</span>
        </div>
        <div className="footer-right">
          <a href={`${deployment.explorer}/address/${deployment.contracts.LaunchFactory}#code`} target="_blank" rel="noreferrer">
            Contracts
          </a>
          <Link to="/how-it-works">How it works</Link>
          <div className="theme-switch" role="group" aria-label="Theme">
            <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")} aria-label="Dark theme" title="Dark">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              </svg>
            </button>
            <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")} aria-label="Light theme" title="Light">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div className="container footer-legal">
        <p>
          Unaudited software on a test network. Launch tokens are volatile and can lose all their value. Names and symbols are not verified; the token address is the
          only identifier that cannot be copied. Charts by TradingView Lightweight Charts.
        </p>
      </div>
    </footer>
  );
}
