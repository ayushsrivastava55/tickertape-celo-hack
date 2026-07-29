import "dotenv/config";
import { getAddress, type Address } from "viem";

/**
 * The facilitator's real API base.
 *
 * NOTE: docs.celo.org documents `https://x402.celo.org` for this, but that host
 * serves the marketing SPA — it returns `text/html` for GET /supported and 405
 * for POST /verify. The JSON API lives on the `api.` subdomain. Verified against
 * a live GET /supported on 2026-07-29.
 */
export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://api.x402.celo.org";

export const CELO_RPC_URL = process.env.CELO_RPC_URL ?? "https://forno.celo.org";

export const PORT = Number(process.env.PORT ?? 3000);

/**
 * Public base URL of this server. Used to build the `resource` field in payment
 * requirements, which the facilitator binds the signed authorization to — so it
 * MUST match the URL the buyer actually called. Behind a proxy/tunnel, set this
 * explicitly or settlement will fail with a recipient/resource mismatch.
 */
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * x402 network identifier.
 *
 * The live facilitator advertises two kinds:
 *   { x402Version: 2, scheme: "exact", network: "eip155:42220" }
 *   { x402Version: 1, scheme: "exact", network: "celo" }
 *
 * We speak v1 / "celo" because that is what the widely-deployed x402 client
 * libraries can actually parse. Only the `exact` scheme is supported — `upto`
 * (dynamic/metered pricing) is NOT offered by this facilitator despite
 * appearing in the docs, so per-token metered billing is not possible today.
 */
export const X402_VERSION = 1 as const;
export const X402_NETWORK = "celo" as const;
export const CELO_CHAIN_ID = 42220;

export type TokenSpec = {
  symbol: string;
  address: Address;
  decimals: number;
  /** EIP-712 domain values used for the EIP-3009 authorization signature. */
  eip712: { name: string; version: string };
};

/**
 * Tokens the facilitator can settle. Settlement uses EIP-3009
 * `transferWithAuthorization`, so a token must implement it to appear here.
 *
 * Deliberately excluded: cUSD / USDm (0x765DE816845861e75A25fCA122bb6898B8B1282a).
 * Mento's StableTokenV2 implements only EIP-2612 `permit`, not EIP-3009, so it
 * cannot be settled by this facilitator even though it is Celo's flagship
 * stablecoin. Do not add it back without confirming on-chain support.
 */
export const TOKENS: Record<string, TokenSpec> = {
  USDC: {
    symbol: "USDC",
    address: getAddress("0xcEBA9300f2b948710d2653dD7B07f33A8B32118C"),
    decimals: 6,
    eip712: { name: "USDC", version: "2" },
  },
  USDT: {
    symbol: "USDT",
    address: getAddress("0x48065fbbE25f71C9282ddf5e1cD6D6A887483D5e"),
    decimals: 6,
    // USDT exposes no version() on-chain; its domain resolves to this pair.
    eip712: { name: "Tether USD", version: "1" },
  },
};

export const DEFAULT_TOKEN = TOKENS.USDC!;

/** Address that receives tool payments. */
export const PAY_TO: Address = (() => {
  const raw = process.env.PAY_TO_ADDRESS;
  if (!raw) {
    throw new Error(
      "PAY_TO_ADDRESS is not set. Copy .env.example to .env and set it to the " +
        "Celo address that should receive payments.",
    );
  }
  return getAddress(raw);
})();

/** How long a buyer's signed authorization stays valid. */
export const MAX_TIMEOUT_SECONDS = Number(
  process.env.MAX_TIMEOUT_SECONDS ?? 120,
);
