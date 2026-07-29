import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
} from "viem";
import { celo } from "viem/chains";
import { CELO_RPC_URL, TOKENS } from "../config.js";

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC_URL),
});

/** Stablecoins worth reporting on, including ones x402 cannot settle. */
const TRACKED: { symbol: string; address: Address; decimals: number }[] = [
  ...Object.values(TOKENS).map((t) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
  })),
  {
    symbol: "cUSD",
    address: getAddress("0x765DE816845861e75A25fCA122bb6898B8B1282a"),
    decimals: 18,
  },
  {
    symbol: "cEUR",
    address: getAddress("0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73"),
    decimals: 18,
  },
];

function requireAddress(value: string, label = "address"): Address {
  // strict: false skips EIP-55 checksum enforcement and validates shape only.
  // Callers legitimately pass lowercase addresses, and mixed-case addresses in
  // the wild are often mis-checksummed — Celo's own docs list USDC as
  // 0xcEBA9300... whose checksum is invalid. We normalise instead of rejecting.
  if (!isAddress(value, { strict: false })) {
    throw new Error(`Invalid ${label}: ${value} is not a valid EVM address.`);
  }
  return getAddress(value);
}

export async function celoBalances(addressInput: string) {
  const address = requireAddress(addressInput);

  const [native, ...tokenResults] = await Promise.all([
    publicClient.getBalance({ address }),
    ...TRACKED.map((token) =>
      publicClient
        .readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        })
        .catch(() => null),
    ),
  ]);

  return {
    address,
    chain: "celo",
    chainId: celo.id,
    native: {
      symbol: "CELO",
      raw: native.toString(),
      formatted: formatUnits(native, 18),
    },
    tokens: TRACKED.map((token, i) => {
      const raw = tokenResults[i] as bigint | null;
      return {
        symbol: token.symbol,
        address: token.address,
        raw: raw === null ? null : raw.toString(),
        formatted: raw === null ? null : formatUnits(raw, token.decimals),
        // Surfaced so callers know what they can actually be paid in.
        x402Settleable: token.symbol in TOKENS,
      };
    }),
  };
}

export async function celoTokenInfo(addressInput: string) {
  const address = requireAddress(addressInput, "token address");

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "name",
    }),
    publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "totalSupply",
    }),
  ]);

  return {
    address,
    name,
    symbol,
    decimals,
    totalSupply: {
      raw: totalSupply.toString(),
      formatted: formatUnits(totalSupply, decimals),
    },
  };
}

export async function celoGas() {
  const [gasPrice, block] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient.getBlock(),
  ]);

  return {
    chain: "celo",
    gasPrice: {
      wei: gasPrice.toString(),
      gwei: formatUnits(gasPrice, 9),
    },
    // A plain ERC20 transfer is the useful reference point for a payments agent.
    estimatedErc20TransferCost: {
      gasUnits: 65000,
      celo: formatUnits(gasPrice * 65000n, 18),
    },
    latestBlock: {
      number: block.number.toString(),
      timestamp: block.timestamp.toString(),
    },
  };
}

export async function celoTransaction(hashInput: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashInput)) {
    throw new Error(`Invalid transaction hash: ${hashInput}`);
  }
  const hash = hashInput as `0x${string}`;

  const [tx, receipt] = await Promise.all([
    publicClient.getTransaction({ hash }),
    publicClient.getTransactionReceipt({ hash }).catch(() => null),
  ]);

  return {
    hash,
    from: tx.from,
    to: tx.to,
    value: {
      raw: tx.value.toString(),
      celo: formatUnits(tx.value, 18),
    },
    blockNumber: tx.blockNumber?.toString() ?? null,
    status: receipt?.status ?? "pending",
    gasUsed: receipt?.gasUsed?.toString() ?? null,
    logCount: receipt?.logs.length ?? null,
    explorer: `https://celoscan.io/tx/${hash}`,
  };
}
