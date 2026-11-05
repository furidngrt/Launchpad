import { http, createConfig } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { createPublicClient, http as viemHttp } from "viem";

export const RPC_URL: string = import.meta.env.VITE_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

export const chain = sepolia;

/** Wallet configuration. Browser wallets announce themselves (EIP-6963), so
 * every installed extension appears without listing them one by one. */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [sepolia.id]: http(RPC_URL) },
});

/** Reads go through one public client that batches calls with Multicall3. */
export const reader = createPublicClient({
  chain: sepolia,
  transport: viemHttp(RPC_URL, { retryCount: 3, retryDelay: 600 }),
  batch: { multicall: { wait: 16 } },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
