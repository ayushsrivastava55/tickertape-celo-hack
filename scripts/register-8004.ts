/**
 * Registers the agent in the ERC-8004 Identity Registry on Celo mainnet.
 *
 * Mints an ERC-721 identity owned by the seller/agent wallet and returns an
 * agentId, which the hackathon submission requires as `erc8004Url`.
 *
 * Metadata is embedded as a `data:` base64 URI rather than hosted over https.
 * Celo's own guidance is that an https metadata URI is not content-addressed and
 * can be silently mutated after registration, which 8004scan's validator flags.
 * A data URI stores the card fully on-chain, so the URI *is* the integrity check
 * and no pinning service is needed. The card can be replaced later with
 * setAgentURI once a public deploy URL exists.
 *
 * Run: npm run register-8004         (simulate only)
 *      npm run register-8004 -- --send   (actually broadcast)
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO_RPC_URL } from "../src/config.js";

const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;

/** Minimal ABI: the registry is ERC-721 with overloaded register(). */
const REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

const privateKey = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!privateKey) {
  console.error("SELLER_PRIVATE_KEY missing. Run `npm run new-wallets` first.");
  process.exit(1);
}
const account = privateKeyToAccount(privateKey);

const publicClient = createPublicClient({ chain: celo, transport: http(CELO_RPC_URL) });
const wallet = createWalletClient({ account, chain: celo, transport: http(CELO_RPC_URL) });

const REPO = "https://github.com/ayushsrivastava55/tickertape-celo-hack";
const publicBase = process.env.PUBLIC_BASE_URL ?? "";
const isLocal = !publicBase || publicBase.includes("localhost");

/** Spec-compliant registration card. Field names follow eip-8004 registration-v1. */
const card = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Tickertape",
  description:
    "A paid MCP server on Celo. Serves chain-intelligence tools (balances, token " +
    "metadata, gas, transaction lookups, and x402 endpoint discovery) to other " +
    "agents, metered per call and settled in USDC over x402 through Celo's " +
    "facilitator. No API keys and no signup: callers pay per request from $0.0002.",
  services: [
    // Only advertise the MCP endpoint once it is genuinely reachable — a dead
    // endpoint in the card is worse than an absent one for reputation scoring.
    ...(isLocal ? [] : [{ name: "MCP", endpoint: `${publicBase}/mcp` }]),
    { name: "web", endpoint: REPO },
  ],
  supportedTrust: ["reputation"],
};

const agentURI =
  "data:application/json;base64," +
  Buffer.from(JSON.stringify(card), "utf8").toString("base64");

const send = process.argv.includes("--send");

console.log(`registry   ${IDENTITY_REGISTRY}`);
console.log(`owner      ${account.address}`);
console.log(`card bytes ${agentURI.length}`);
if (isLocal) {
  console.log(
    `note       PUBLIC_BASE_URL is unset or localhost, so no MCP service is\n` +
      `           advertised. Re-run setAgentURI after deploying.`,
  );
}

const balance = await publicClient.getBalance({ address: account.address });
console.log(`balance    ${formatUnits(balance, 18)} CELO`);

// Simulate first: this reverts locally rather than burning gas on a bad call.
const { result: simulatedAgentId, request } = await publicClient.simulateContract({
  account,
  address: IDENTITY_REGISTRY,
  abi: REGISTRY_ABI,
  functionName: "register",
  args: [agentURI],
});

const gas = await publicClient.estimateContractGas({
  account,
  address: IDENTITY_REGISTRY,
  abi: REGISTRY_ABI,
  functionName: "register",
  args: [agentURI],
});
const gasPrice = await publicClient.getGasPrice();
console.log(`sim agentId ${simulatedAgentId}`);
console.log(`est gas     ${gas} @ ${formatUnits(gasPrice, 9)} gwei`);
console.log(`est cost    ${formatUnits(gas * gasPrice, 18)} CELO`);

if (!send) {
  console.log(`\nSimulation only. Re-run with --send to broadcast.`);
  process.exit(0);
}

const hash = await wallet.writeContract(request);
console.log(`\nbroadcast  ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`status     ${receipt.status}`);
console.log(`gas used   ${receipt.gasUsed}`);

// Read the minted id back from chain state rather than trusting the simulation.
const agentId = simulatedAgentId;
const owner = await publicClient
  .readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "ownerOf", args: [agentId] })
  .catch(() => null);

console.log(`\nagentId    ${agentId}`);
console.log(`owner      ${owner ?? "(could not read)"}`);
console.log(`tx         https://celoscan.io/tx/${hash}`);
console.log(`8004scan   https://8004scan.io/agents/celo/${agentId}`);
console.log(`nft        https://celoscan.io/nft/${IDENTITY_REGISTRY}/${agentId}`);
