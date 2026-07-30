/**
 * Obtains an x402 facilitator API key by signing an ownership challenge.
 *
 * The facilitator's /settle endpoint requires an `X-API-Key` header. This is
 * undocumented in docs.celo.org — the key is issued by the dashboard at
 * x402.celo.org, whose frontend calls the endpoints used below. We reproduce
 * that flow headlessly so no wallet needs importing into a browser.
 *
 * Signing costs no gas and sends no transaction: it is an EIP-191 personal_sign
 * over a fixed challenge string, used only to prove wallet control.
 *
 * The key is written to .env as FACILITATOR_API_KEY and never printed in full.
 *
 * Run: npm run get-key
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const AUTH_HOST = "https://x402.celo.org";
const ENV_PATH = new URL("../.env", import.meta.url).pathname;

/** Exact template from the dashboard bundle. Any deviation fails signature check. */
function challenge(domain: string, address: string, nonce: string): string {
  return (
    `${domain} wants you to create an x402 API key.\n\n` +
    `Address: ${address}\n` +
    `Nonce: ${nonce}\n\n` +
    `Signing this message proves you control this wallet. ` +
    `It costs no gas and sends no transaction.`
  );
}

const privateKey = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!privateKey) {
  console.error("SELLER_PRIVATE_KEY is not set in .env. Run `npm run new-wallets` first.");
  process.exit(1);
}
const account = privateKeyToAccount(privateKey);

const cfg = (await (await fetch(`${AUTH_HOST}/api/config`)).json()) as {
  authDomain: string;
  pricePerTxMicro: number;
  freeCredits?: { mainnet?: number; testnet?: number };
};

const { nonce } = (await (
  await fetch(`${AUTH_HOST}/api/keys/nonce?address=${account.address}`)
).json()) as { nonce: string };

const message = challenge(cfg.authDomain, account.address, nonce);
const signature = await account.signMessage({ message });

const res = await fetch(`${AUTH_HOST}/api/keys`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: account.address, nonce, signature }),
});

const body = (await res.json()) as Record<string, unknown>;

if (!res.ok) {
  console.error(`Key issuance failed (${res.status}):`, JSON.stringify(body));
  process.exit(1);
}

const apiKey =
  (body.apiKey as string) ?? (body.key as string) ?? (body.api_key as string);
if (!apiKey) {
  console.error("No key field in response:", JSON.stringify(body));
  process.exit(1);
}

let env = readFileSync(ENV_PATH, "utf8");
env = /^FACILITATOR_API_KEY=.*$/m.test(env)
  ? env.replace(/^FACILITATOR_API_KEY=.*$/m, `FACILITATOR_API_KEY=${apiKey}`)
  : env.trimEnd() + `\nFACILITATOR_API_KEY=${apiKey}\n`;
writeFileSync(ENV_PATH, env);

const credits = body.credits ?? body.creditsRemaining;
console.log(`key issued for ${account.address}`);
console.log(`  stored in .env as FACILITATOR_API_KEY (${apiKey.slice(0, 12)}…)`);
console.log(`  price per settlement: $${(cfg.pricePerTxMicro / 1e6).toFixed(6)}`);
if (credits !== undefined) console.log(`  credits: ${credits}`);
else if (cfg.freeCredits?.mainnet) console.log(`  free mainnet credits: ${cfg.freeCredits.mainnet}`);
