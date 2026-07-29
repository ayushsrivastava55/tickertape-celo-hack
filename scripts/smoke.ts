/**
 * Exercises every tool directly, bypassing the paywall, plus the facilitator
 * handshake. Run this after any change to confirm the chain reads still work
 * without spending USDC: `npm run smoke`.
 */
import "dotenv/config";
import {
  celoBalances,
  celoGas,
  celoTokenInfo,
  celoTransaction,
} from "../src/tools/celo.js";
import { x402Probe } from "../src/tools/x402probe.js";
import { getSupported } from "../src/x402/facilitator.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const j = (x: unknown) => JSON.stringify(x, null, 2);

let failures = 0;

async function step(label: string, fn: () => Promise<unknown>) {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    console.log(j(await fn()));
  } catch (error) {
    failures++;
    console.error(`FAILED: ${(error as Error).message}`);
  }
}

await step("facilitator /supported", () => getSupported());
await step("celo_gas", () => celoGas());
await step("celo_token_info (USDC)", () =>
  celoTokenInfo("0xcEBA9300f2b948710d2653dD7B07f33A8B32118C"),
);
await step("celo_balances (Mento cUSD contract, a known non-empty address)", () =>
  celoBalances("0x765DE816845861e75A25fCA122bb6898B8B1282a"),
);
await step("celo_balances (invalid input, expected to fail)", async () => {
  try {
    await celoBalances("not-an-address");
    throw new Error("expected a validation error but none was thrown");
  } catch (error) {
    return { rejectedAsExpected: (error as Error).message };
  }
});
await step("x402_probe (our own paid endpoint)", () =>
  x402Probe(`${SERVER_URL}/v1/tools/celo_gas`),
);
await step("x402_probe (a free endpoint)", () => x402Probe(`${SERVER_URL}/health`));

if (process.env.SMOKE_TX_HASH) {
  await step("celo_transaction", () => celoTransaction(process.env.SMOKE_TX_HASH!));
}

console.log(
  failures === 0
    ? "\nall smoke steps passed"
    : `\n${failures} smoke step(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
