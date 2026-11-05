import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useBalance } from "wagmi";
import { decodeEventLog, parseEther, toHex, zeroAddress, type Address } from "viem";
import { useQuery } from "@tanstack/react-query";

import { ConnectButton } from "../components/ConnectButton";
import { Skeleton, TokenAvatar } from "../components/ui";
import { chain, reader } from "../config/wagmi";
import { abis, deployment } from "../generated/contracts";
import { useProtocol, type LaunchConfigView } from "../lib/data";
import { formatCompact, formatEth, formatPercent } from "../lib/format";
import { useTx } from "../lib/tx";

const C = deployment.contracts;
const LIMITS = { name: 64, symbol: 16, logo: 512, description: 2048, link: 256 };
const BPS = 10_000n;

/** Tokens the very first buy of a launch receives, before any other trade. */
function firstBuyTokens(config: LaunchConfigView, grossWei: bigint, creatorFeeBps: number): bigint {
  const net = (grossWei * (BPS - BigInt(config.tradeFeeBps) - BigInt(creatorFeeBps))) / BPS;
  return (net * config.supply) / (config.virtualQuote + net);
}

/** Largest opening buy a tax-exempt creator may make while the window is open. */
function maxOpeningBuy(config: LaunchConfigView, capBps: number, creatorFeeBps: number): bigint {
  const cap = (config.supply * BigInt(capBps)) / BPS;
  if (cap === 0n || cap >= config.supply) return 0n;
  const net = (config.virtualQuote * cap) / (config.supply - cap);
  return (net * BPS) / (BPS - BigInt(config.tradeFeeBps) - BigInt(creatorFeeBps));
}

export function Create() {
  const navigate = useNavigate();
  const { address, isConnected, chainId } = useAccount();
  const { data: protocol, isLoading } = useProtocol();
  const { data: balance } = useBalance({ address, chainId: chain.id });
  const { send, busy } = useTx();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [social, setSocial] = useState("");
  const [configId, setConfigId] = useState<number | null>(null);
  const [creatorFeeBps, setCreatorFeeBps] = useState(0);
  const [buyback, setBuyback] = useState(false);
  const [devBuy, setDevBuy] = useState("");

  const { data: canLaunch } = useQuery({
    queryKey: ["canLaunch", address],
    enabled: !!address,
    queryFn: () => reader.readContract({ address: C.LaunchFactory, abi: abis.LaunchFactory, functionName: "canLaunch", args: [address as Address] }) as Promise<boolean>,
  });

  const configs = protocol?.configs.filter((c) => c.enabled) ?? [];
  const selected = configs.find((c) => c.id === configId) ?? configs.find((c) => c.label === "reference") ?? configs[0];

  const devBuyWei = useMemo(() => {
    if (!devBuy.trim()) return 0n;
    try {
      return parseEther(devBuy.replace(",", "."));
    } catch {
      return -1n;
    }
  }, [devBuy]);

  const openingActive = (protocol?.openingTaxStartBps ?? 0) > 0;
  const maxDevBuy = selected && protocol && openingActive ? maxOpeningBuy(selected, protocol.openingExemptCapBps, creatorFeeBps) : undefined;
  const expectedTokens = selected && devBuyWei > 0n ? firstBuyTokens(selected, devBuyWei, creatorFeeBps) : 0n;
  const launchFee = protocol?.launchFee ?? 0n;
  const total = launchFee + (devBuyWei > 0n ? devBuyWei : 0n);

  const errors: string[] = [];
  if (!name.trim()) errors.push("Give the token a name.");
  if (!symbol.trim()) errors.push("Give the token a symbol.");
  if (name.length > LIMITS.name || symbol.length > LIMITS.symbol || logo.length > LIMITS.logo || description.length > LIMITS.description || website.length > LIMITS.link || social.length > LIMITS.link) {
    errors.push("One of the fields is too long.");
  }
  if (devBuyWei < 0n) errors.push("The opening buy is not a valid amount.");
  if (maxDevBuy !== undefined && devBuyWei > maxDevBuy) errors.push(`The opening buy can be at most ${formatEth(maxDevBuy, 4)} ETH while the opening window is open.`);
  if (balance && total > balance.value) errors.push("Your balance does not cover the launch fee and opening buy.");

  const ready = isConnected && chainId === chain.id && canLaunch !== false && errors.length === 0 && !!selected;

  async function submit() {
    if (!selected || !address) return;
    const expectedEconomics = (await reader.readContract({
      address: C.LaunchFactory,
      abi: abis.LaunchFactory,
      functionName: "previewEconomics",
      args: [BigInt(selected.id), zeroAddress],
    })) as `0x${string}`;
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const params = {
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      logo: logo.trim(),
      description: description.trim(),
      website: website.trim(),
      social: social.trim(),
      feeRecipient: address,
      creatorFeeBps,
      buybackEnabled: buyback,
      expectedEconomics,
      salt,
    };

    const receipt =
      devBuyWei > 0n
        ? await send(`Launch ${params.symbol}`, {
            address: C.LaunchRouter,
            abi: abis.LaunchRouter,
            functionName: "launchAndBuy",
            args: [params, BigInt(selected.id), zeroAddress, devBuyWei, (expectedTokens * 98n) / 100n, address, []],
            value: launchFee + devBuyWei,
          })
        : await send(`Launch ${params.symbol}`, {
            address: C.LaunchFactory,
            abi: abis.LaunchFactory,
            functionName: "launch",
            args: [params, BigInt(selected.id), zeroAddress],
            value: launchFee,
          });
    if (!receipt) return;

    for (const log of receipt.logs) {
      try {
        const event = decodeEventLog({ abi: abis.LaunchFactory, data: log.data, topics: log.topics });
        if (event.eventName === "LaunchCreated") {
          navigate(`/token/${(event.args as unknown as { token: Address }).token}`);
          return;
        }
      } catch {
        /* a log from another contract */
      }
    }
    navigate("/");
  }

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Create a launch</h1>
        <p className="muted">
          Your token starts on a bonding curve that holds its whole supply. You receive no allocation; buy at the opening price like everyone else.
        </p>
      </div>

      <div className="create-layout">
        <form
          className="create-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) submit();
          }}
        >
          <div className="card form-section">
            <h3>Token</h3>
            <div className="field-row">
              <Field label="Name" count={name.length} max={LIMITS.name}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind" maxLength={LIMITS.name} />
              </Field>
              <Field label="Symbol" count={symbol.length} max={LIMITS.symbol}>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/\s/g, ""))} placeholder="NWD" maxLength={LIMITS.symbol} />
              </Field>
            </div>
            <Field label="Image URL" hint="https:// or ipfs:// link to a square image" count={logo.length} max={LIMITS.logo}>
              <input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="ipfs://…" maxLength={LIMITS.logo} />
            </Field>
            <Field label="Description" count={description.length} max={LIMITS.description}>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="What is this token about?" maxLength={LIMITS.description} />
            </Field>
            <div className="field-row">
              <Field label="Website" count={website.length} max={LIMITS.link}>
                <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" maxLength={LIMITS.link} />
              </Field>
              <Field label="Social link" count={social.length} max={LIMITS.link}>
                <input value={social} onChange={(e) => setSocial(e.target.value)} placeholder="https://x.com/…" maxLength={LIMITS.link} />
              </Field>
            </div>
          </div>

          <div className="card form-section">
            <h3>Curve terms</h3>
            {isLoading ? (
              <Skeleton height={96} />
            ) : (
              <div className="config-options">
                {configs.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`config-option ${selected?.id === c.id ? "active" : ""}`}
                    onClick={() => setConfigId(c.id)}
                    aria-pressed={selected?.id === c.id}
                  >
                    <div className="row-between">
                      <strong>{c.label === "reference" ? "Standard" : c.label === "smoke-test" ? "Small test" : c.label}</strong>
                      <span className="badge badge-neutral">{formatPercent(c.tradeFeeBps)} fee</span>
                    </div>
                    <div className="config-figures">
                      <span>
                        <span className="muted">Opens at</span> {formatEth(c.openValuation, 3)} ETH
                      </span>
                      <span>
                        <span className="muted">Graduates at</span> {formatEth(c.graduationValuation, 3)} ETH
                      </span>
                      <span>
                        <span className="muted">Target</span> {formatEth(c.graduationTarget, 3)} ETH
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="card form-section">
            <h3>Creator settings</h3>
            <div className="field">
              <div className="row-between">
                <span className="field-label">Creator fee</span>
                <strong className="mono">{formatPercent(creatorFeeBps, 2)}</strong>
              </div>
              <input
                type="range"
                min={0}
                max={protocol?.maxCreatorFeeBps ?? 1000}
                step={25}
                value={creatorFeeBps}
                onChange={(e) => setCreatorFeeBps(Number(e.target.value))}
                aria-label="Creator fee"
              />
              <span className="field-hint">
                Charged on every curve trade on top of the {selected ? formatPercent(selected.tradeFeeBps) : "1%"} trade fee and paid to you in full. Fixed once the token launches.
              </span>
            </div>

            <label className="toggle">
              <input type="checkbox" checked={buyback} onChange={(e) => setBuyback(e.target.checked)} />
              <span className="toggle-track" aria-hidden>
                <span className="toggle-thumb" />
              </span>
              <span>
                <strong>Buy back and lock</strong>
                <span className="field-hint block">
                  Spends half of your share of the trade fee buying your token back and vests it over five years instead of paying it to you.
                </span>
              </span>
            </label>

            <Field
              label="Opening buy (optional)"
              hint={
                maxDevBuy !== undefined
                  ? `Bought in the same transaction, so nobody can front-run it. Up to ${formatEth(maxDevBuy, 4)} ETH while the opening window is open.`
                  : "Bought in the same transaction, so nobody can front-run it."
              }
            >
              <div className="amount-input">
                <input inputMode="decimal" value={devBuy} onChange={(e) => setDevBuy(e.target.value)} placeholder="0.0" />
                <span className="amount-unit">ETH</span>
              </div>
            </Field>
            {expectedTokens > 0n && (
              <p className="field-hint">
                About {formatCompact(expectedTokens)} {symbol || "tokens"}, {selected ? formatPercent(Number((expectedTokens * 10_000n) / selected.supply), 2) : ""} of supply.
              </p>
            )}
          </div>

          <div className="card form-section summary">
            <div className="row-between">
              <span className="muted">Launch fee</span>
              <span className="mono">{formatEth(launchFee, 6)} ETH</span>
            </div>
            <div className="row-between">
              <span className="muted">Opening buy</span>
              <span className="mono">{formatEth(devBuyWei > 0n ? devBuyWei : 0n, 6)} ETH</span>
            </div>
            <div className="row-between total">
              <span>Total</span>
              <strong className="mono">{formatEth(total, 6)} ETH</strong>
            </div>

            {errors.length > 0 && (name || symbol || devBuy) && (
              <ul className="form-errors">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {canLaunch === false && <p className="notice notice-warn">Launching is currently limited to approved wallets.</p>}

            {!isConnected || chainId !== chain.id ? (
              <ConnectButton block />
            ) : (
              <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={!ready || busy}>
                {busy ? "Launching…" : "Launch token"}
              </button>
            )}
            <p className="field-hint">The terms you see are pinned: if they change before your transaction lands, it reverts instead of launching on different terms.</p>
          </div>
        </form>

        <aside className="create-preview">
          <div className="sticky">
            <span className="stat-label">Preview</span>
            <div className="card launch-card preview-card">
              <div className="launch-card-head">
                <TokenAvatar logo={logo} symbol={symbol || "?"} />
                <div className="launch-card-title">
                  <strong className="truncate">{name || "Your token"}</strong>
                  <span className="muted mono">${symbol || "SYMBOL"}</span>
                </div>
              </div>
              <p className="muted small preview-description">{description || "Your description appears here."}</p>
              <div className="launch-card-stats">
                <div>
                  <span className="stat-label">Opens at</span>
                  <span className="stat-value-sm">{selected ? `${formatEth(selected.openValuation, 3)} ETH` : "—"}</span>
                </div>
                <div>
                  <span className="stat-label">Graduates at</span>
                  <span className="stat-value-sm">{selected ? `${formatEth(selected.graduationValuation, 3)} ETH` : "—"}</span>
                </div>
              </div>
              <div className="detail-list">
                <div>
                  <span className="muted">Total cost to traders</span>
                  <span className="mono">{selected ? formatPercent(selected.tradeFeeBps + creatorFeeBps, 2) : "—"}</span>
                </div>
                <div>
                  <span className="muted">Your allocation</span>
                  <span className="mono">None</span>
                </div>
                <div>
                  <span className="muted">Liquidity</span>
                  <span className="mono">Locked forever</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, hint, count, max, children }: { label: string; hint?: string; count?: number; max?: number; children: React.ReactNode }) {
  return (
    <label className="field">
      <div className="row-between">
        <span className="field-label">{label}</span>
        {max !== undefined && <span className={`counter ${count !== undefined && count > max * 0.9 ? "warn" : ""}`}>{count}/{max}</span>}
      </div>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
