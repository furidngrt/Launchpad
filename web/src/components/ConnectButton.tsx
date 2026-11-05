import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { chain } from "../config/wagmi";
import { deployment } from "../generated/contracts";
import { formatEth, shortAddress } from "../lib/format";
import { CopyButton } from "./ui";

export function ConnectButton({ block = false, compact = false }: { block?: boolean; compact?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: balance } = useBalance({ address, chainId: chain.id, query: { refetchInterval: 15_000 } });
  const [modal, setModal] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  useEffect(() => {
    if (isConnected) setModal(false);
  }, [isConnected]);

  // Wallets that announce themselves are listed by name; the generic injected
  // entry is only shown when nothing announced itself.
  const announced = connectors.filter((c) => c.id !== "injected");
  const options = announced.length > 0 ? announced : connectors;

  if (!isConnected) {
    return (
      <>
        <button className={`btn ${block ? "btn-primary btn-block" : "btn-secondary btn-sm"}`} onClick={() => setModal(true)}>
          {compact ? "Connect" : "Connect wallet"}
        </button>
        {modal && (
          <div className="modal-backdrop" onClick={() => setModal(false)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>Connect a wallet</h3>
                <button className="btn btn-ghost btn-icon" onClick={() => setModal(false)} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="wallet-list">
                {options.map((connector) => (
                  <button
                    key={connector.uid}
                    className="wallet-option"
                    disabled={isPending}
                    onClick={() => connect({ connector, chainId: chain.id })}
                  >
                    {connector.icon ? <img src={connector.icon} alt="" width={28} height={28} /> : <span className="wallet-glyph" aria-hidden />}
                    <span>{connector.name === "Injected" ? "Browser wallet" : connector.name}</span>
                  </button>
                ))}
              </div>
              {error && <p className="form-error">{error.message.split("\n")[0]}</p>}
              <p className="modal-note">
                This app runs on {chain.name}. No wallet installed?{" "}
                <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                  Get MetaMask
                </a>
                .
              </p>
            </div>
          </div>
        )}
      </>
    );
  }

  if (chainId !== chain.id) {
    return (
      <button className={`btn btn-warning ${block ? "btn-block" : "btn-sm"}`} disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        {compact ? "Switch network" : `Switch to ${chain.name}`}
      </button>
    );
  }

  return (
    <div className="account" ref={menuRef}>
      <button className={`btn btn-secondary account-button ${block ? "btn-block" : "btn-sm"}`} onClick={() => setMenu((v) => !v)}>
        <span className="account-dot" aria-hidden />
        <span className="account-balance hide-sm">{balance ? `${formatEth(balance.value, 3)} ETH` : "…"}</span>
        <span className="account-address">{shortAddress(address)}</span>
      </button>
      {menu && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <span className="muted">Connected</span>
            <strong>{shortAddress(address)}</strong>
          </div>
          <div className="menu-row">
            <CopyButton value={address ?? ""} label="Copy address" />
            <a className="btn btn-ghost btn-xs" href={`${deployment.explorer}/address/${address}`} target="_blank" rel="noreferrer">
              Explorer
            </a>
          </div>
          <Link to="/portfolio" className="menu-item" onClick={() => setMenu(false)}>
            Portfolio and rewards
          </Link>
          <button className="menu-item danger" onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
