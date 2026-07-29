/**
 * Proves our EIP-3009 payload and EIP-712 domain are correct WITHOUT spending
 * anything.
 *
 * Signs a real authorization with a freshly generated (unfunded) key and sends it
 * to the facilitator's /verify. A reply of `insufficient_funds` is the success
 * case: it means the facilitator parsed the payload, recovered the signer from
 * the signature, and got all the way to the balance check. A signature or
 * payload error would mean our domain or field encoding is wrong.
 *
 * Run: npm run verify-sig
 */
import "dotenv/config";
import { createWalletClient, getAddress, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO_CHAIN_ID, DEFAULT_TOKEN, PAY_TO } from "../src/config.js";
import { verifyPayment } from "../src/x402/facilitator.js";
import { buildRequirements } from "../src/x402/gate.js";
import { decodePaymentPayload, encodePaymentPayload } from "../src/x402/types.js";

const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({
  account,
  chain: celo,
  transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
});

const requirements = buildRequirements({
  resource: "http://localhost:3000/v1/tools/celo_gas",
  description: "signature format check",
  atomicAmount: 200n,
});

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}

const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: account.address,
  to: getAddress(requirements.payTo),
  value: BigInt(requirements.maxAmountRequired),
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + requirements.maxTimeoutSeconds),
  nonce: randomNonce(),
};

const signature = await wallet.signTypedData({
  account,
  domain: {
    name: DEFAULT_TOKEN.eip712.name,
    version: DEFAULT_TOKEN.eip712.version,
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

const header = encodePaymentPayload({
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

console.log(`signer (unfunded, throwaway)  ${account.address}`);
console.log(`asset                         ${requirements.asset}`);
console.log(`payTo                         ${PAY_TO}`);
console.log(`network                       ${requirements.network}`);
console.log(`header bytes                  ${header.length}`);

// Round-trip the header through our own decoder to catch encoding drift.
decodePaymentPayload(header);

const result = await verifyPayment(decodePaymentPayload(header), requirements);
console.log(`\nfacilitator /verify ->`, JSON.stringify(result));

const reason = result.invalidReason ?? "";
const recoveredCorrectly =
  result.payer?.toLowerCase() === account.address.toLowerCase();

if (reason.includes("insufficient_funds")) {
  console.log(
    `\nPASS — payload and EIP-712 domain accepted; rejected only for an empty balance.` +
      (recoveredCorrectly
        ? `\n       Facilitator recovered the signer address correctly.`
        : `\n       NOTE: facilitator did not echo the expected payer.`),
  );
  process.exit(0);
}

if (reason.includes("signature") || reason.includes("payload")) {
  console.error(
    `\nFAIL — the facilitator rejected the payload itself (${reason}).\n` +
      `       The EIP-712 domain or field encoding is wrong.`,
  );
  process.exit(1);
}

console.log(
  `\nINCONCLUSIVE — unexpected reason "${reason}". Inspect the response above.`,
);
process.exit(1);
