import { z } from "zod";
import {
  celoBalances,
  celoGas,
  celoTokenInfo,
  celoTransaction,
} from "./celo.js";
import { x402Probe } from "./x402probe.js";

/**
 * Priced tool catalogue.
 *
 * Prices are atomic USDC (6 decimals) and deliberately sub-cent: the value here
 * is call volume from other agents, not margin per call. `atomicPrice` of 1000n
 * is $0.001.
 */
export type PricedTool = {
  name: string;
  description: string;
  atomicPrice: bigint;
  inputSchema: z.ZodType;
  /** JSON Schema shape for MCP clients. */
  jsonSchema: Record<string, unknown>;
  run: (args: any) => Promise<unknown>;
};

const addressSchema = z
  .string()
  .describe("An EVM address on Celo, 0x-prefixed.");

export const TOOLS: PricedTool[] = [
  {
    name: "celo_balances",
    description:
      "Get native CELO plus major stablecoin balances (USDC, USDT, cUSD, cEUR) for an address on Celo. Flags which balances can be used for x402 payments.",
    atomicPrice: 1000n,
    inputSchema: z.object({ address: addressSchema }),
    jsonSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "EVM address on Celo" },
      },
      required: ["address"],
    },
    run: ({ address }: { address: string }) => celoBalances(address),
  },
  {
    name: "celo_token_info",
    description:
      "Read ERC20 metadata (name, symbol, decimals, total supply) for a token contract on Celo.",
    atomicPrice: 500n,
    inputSchema: z.object({ address: addressSchema }),
    jsonSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "ERC20 contract address" },
      },
      required: ["address"],
    },
    run: ({ address }: { address: string }) => celoTokenInfo(address),
  },
  {
    name: "celo_gas",
    description:
      "Current Celo gas price, latest block, and the estimated cost of an ERC20 transfer.",
    atomicPrice: 200n,
    inputSchema: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    run: () => celoGas(),
  },
  {
    name: "celo_transaction",
    description:
      "Summarise a Celo transaction by hash: sender, recipient, value, status, gas used.",
    atomicPrice: 1000n,
    inputSchema: z.object({
      hash: z.string().describe("0x-prefixed 32-byte transaction hash"),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        hash: { type: "string", description: "Transaction hash" },
      },
      required: ["hash"],
    },
    run: ({ hash }: { hash: string }) => celoTransaction(hash),
  },
  {
    name: "x402_probe",
    description:
      "Given any URL, discover whether it is x402-payable and on what terms (scheme, network, asset, price, recipient) without paying. Also reports whether Celo's facilitator can settle those terms.",
    atomicPrice: 2000n,
    inputSchema: z.object({
      url: z.string().describe("Absolute http(s) URL to probe"),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to probe for x402 support" },
      },
      required: ["url"],
    },
    run: ({ url }: { url: string }) => x402Probe(url),
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
