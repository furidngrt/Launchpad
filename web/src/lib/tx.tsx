import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWriteContract } from "wagmi";
import { BaseError, type Abi, type Address, type TransactionReceipt } from "viem";

import { reader } from "../config/wagmi";
import { deployment } from "../generated/contracts";

type ToastKind = "pending" | "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  hash?: string;
}

interface ToastApi {
  push: (toast: Omit<Toast, "id">) => number;
  update: (id: number, toast: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const schedule = useCallback(
    (id: number, kind: ToastKind) => {
      if (kind === "success" || kind === "error" || kind === "info") setTimeout(() => dismiss(id), 7000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push: (toast) => {
        const id = next.current++;
        setToasts((all) => [...all.slice(-3), { ...toast, id }]);
        schedule(id, toast.kind);
        return id;
      },
      update: (id, toast) => {
        setToasts((all) => all.map((t) => (t.id === id ? { ...t, ...toast } : t)));
        if (toast.kind) schedule(id, toast.kind);
      },
      dismiss,
    }),
    [dismiss, schedule],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-dot" aria-hidden />
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.detail && <span>{t.detail}</span>}
              {t.hash && (
                <a href={`${deployment.explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              )}
            </div>
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("ToastProvider missing");
  return api;
}

export function errorMessage(error: unknown): string {
  if (error instanceof BaseError) {
    const reason = error.walk((e) => (e as { data?: { errorName?: string } }).data?.errorName !== undefined) as
      | { data?: { errorName?: string } }
      | null;
    if (reason?.data?.errorName) return humanizeError(reason.data.errorName);
    if (/user rejected|denied/i.test(error.shortMessage)) return "You rejected the request in your wallet.";
    return error.shortMessage;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

const ERRORS: Record<string, string> = {
  SlippageExceeded: "The price moved past your slippage limit. Try again or allow more slippage.",
  AlreadySettled: "This launch has finished its curve. Trade it in the pool instead.",
  OpeningAllocationExceeded: "Exempt wallets have reached their opening allowance. Wait for the opening window to close.",
  NotWhitelisted: "Launching is restricted to approved wallets right now.",
  LaunchFeeNotPaid: "The launch fee changed. Refresh and try again.",
  EconomicsChanged: "The launch terms changed since you loaded the page. Refresh and try again.",
  CreatorFeeTooHigh: "That creator fee is above the protocol's cap.",
  MetadataTooLong: "One of the text fields is too long.",
  OperatorRequired: "This sweep includes a buyback, which only the protocol operator can run.",
  NoBalance: "There is nothing to claim.",
  NativeValueMismatch: "The amount sent did not match the amount entered.",
};

function humanizeError(name: string): string {
  return ERRORS[name] ?? `The contract rejected the transaction (${name}).`;
}

export interface WriteRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gas?: bigint;
}

/** Sends a transaction, follows it to a receipt, and keeps the user informed. */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const send = useCallback(
    async (label: string, request: WriteRequest): Promise<TransactionReceipt | undefined> => {
      setBusy(true);
      const id = toast.push({ kind: "pending", title: label, detail: "Confirm in your wallet" });
      try {
        const hash = await writeContractAsync({
          ...request,
          args: request.args ?? [],
          chainId: deployment.chainId,
        } as Parameters<typeof writeContractAsync>[0]);
        toast.update(id, { kind: "pending", detail: "Waiting for confirmation", hash });
        const receipt = await reader.waitForTransactionReceipt({ hash, pollingInterval: 2_000 });
        if (receipt.status !== "success") throw new Error("The transaction reverted.");
        toast.update(id, { kind: "success", detail: "Confirmed", hash });
        await queryClient.invalidateQueries();
        return receipt;
      } catch (error) {
        toast.update(id, { kind: "error", detail: errorMessage(error) });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [writeContractAsync, toast, queryClient],
  );

  return { send, busy };
}
