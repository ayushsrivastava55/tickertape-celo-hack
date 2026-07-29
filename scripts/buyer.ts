/**
 * A buyer agent: calls the paid MCP server, signs the EIP-3009 authorization it
 * is challenged with, and retries with payment.
 *
 * This is the reference implementation of the client half of x402 `exact` on
 * Celo. We sign by hand with viem rather than using an x402 client library
 * because the published `x402` package's Network enum contains no Celo member,
 * so its client would reject these requirements before signing.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x... npm run buyer -- celo_gas
 *   BUYER_PRIVATE_KEY=0x... npm run buyer -- celo_balances '{"address":"0x..."}'
 */
import "dotenv/config";
import { createWalletClient, getAddress, http, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO_CHAIN_ID } from "../src/config.js";
import {
  encodePaymentPayload,
  PaymentRequirementsSchema,
  type PaymentRequirements,
} from "../src/x402/types.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";

const privateKey = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
if (!privateKey) {
  console.error(
    "BUYER_PRIVATE_KEY is not set. Use a throwaway key funded with a little " +
      "USDC on Celo — never a key holding real value.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const wallet = createWalletClient({
  account,
  chain: celo,
  transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
});

/** Random 32-byte nonce; EIP-3009 uses it for replay protection. */
function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}

/**
 * Signs an EIP-3009 TransferWithAuthorization for the challenged requirements.
 *
 * The EIP-712 domain name/version come from `requirements.extra`, because they
 * differ per token — USDC is ("USDC","2") while USDT is ("Tether USD","1") and
 * exposes no version() on-chain to discover it from.
 */
async function signAuthorization(requirements: PaymentRequirements) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: getAddress(requirements.payTo),
    value: BigInt(requirements.maxAmountRequired),
    // Backdated slightly to tolerate clock skew between buyer and facilitator.
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + requirements.maxTimeoutSeconds),
    nonce: randomNonce(),
  };

  const extra = (requirements.extra ?? {}) as { name?: string; version?: string };
  if (!extra.name || !extra.version) {
    throw new Error(
      "Payment requirements are missing extra.name/extra.version, so the EIP-712 " +
        "domain for the asset cannot be determined.",
    );
  }

  const signature = await wallet.signTypedData({
    account,
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: CELO_CHAIN_ID,
      verifyingContract: getAddress(requirements.asset),
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  return encodePaymentPayload({
    x402Version: 1,
    scheme: "exact",
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  });
}

async function rpc(
  method: string,
  params: Record<string, unknown> | undefined,
  paymentHeader?: string,
) {
  const res = await fetch(`${SERVER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(paymentHeader ? { "X-PAYMENT": paymentHeader } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function main() {
  const toolName = process.argv[2] ?? "celo_gas";
  const rawArgs = process.argv[3];
  const toolArgs = rawArgs ? JSON.parse(rawArgs) : {};

  console.log(`buyer   ${account.address}`);
  console.log(`server  ${SERVER_URL}`);

  const listed = await rpc("tools/list", {});
  const names = (listed.body.result?.tools ?? []).map((t: any) => t.name);
  console.log(`tools   ${names.join(", ")}`);
  if (!names.includes(toolName)) {
    throw new Error(`Server does not offer tool "${toolName}".`);
  }

  // First attempt with no payment: we expect a 402 carrying the terms.
  console.log(`\ncalling ${toolName} with no payment...`);
  const challenge = await rpc("tools/call", {
    name: toolName,
    arguments: toolArgs,
  });

  if (challenge.status !== 402) {
    console.log(
      `unexpected: got ${challenge.status} instead of 402.`,
      JSON.stringify(challenge.body, null, 2),
    );
    return;
  }

  const accepts = challenge.body.accepts ?? [];
  const requirements = PaymentRequirementsSchema.parse(accepts[0]);
  console.log(
    `402     price ${formatUnits(BigInt(requirements.maxAmountRequired), 6)} ` +
      `(asset ${requirements.asset}) on ${requirements.network} -> ${requirements.payTo}`,
  );

  console.log("signing EIP-3009 authorization...");
  const paymentHeader = await signAuthorization(requirements);

  console.log("retrying with X-PAYMENT...");
  const paid = await rpc(
    "tools/call",
    { name: toolName, arguments: toolArgs },
    paymentHeader,
  );

  if (paid.status !== 200) {
    console.error(`failed: ${paid.status}`, JSON.stringify(paid.body, null, 2));
    process.exitCode = 1;
    return;
  }

  const receipt = paid.body.result?._meta?.["x402/receipt"];
  console.log("\npaid + settled");
  if (receipt?.transaction) {
    console.log(`tx      https://celoscan.io/tx/${receipt.transaction}`);
  }
  console.log("\nresult:");
  console.log(JSON.stringify(paid.body.result?.structuredContent, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
