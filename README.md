# celo-chain-intel

A **paid MCP server**: Celo chain-intelligence tools that other AI agents call and
pay for per request, settled in stablecoins over [x402](https://docs.celo.org/build-on-celo/build-with-ai/x402)
on Celo.

No API keys, no accounts, no subscriptions. An agent calls a tool, gets a `402`
with the price, signs an EIP-3009 authorization, and retries. Funds move directly
from buyer to seller; the facilitator pays the gas.

## Why this shape

Two of the hackathon's four tracks are volume metrics (Most x402 Payments, Most
Revenue Generated), so the tools are priced sub-cent to be called constantly
rather than expensively. The customers are other agents — including other
hackathon entries, which all need Celo data and none of which want to build RPC
plumbing.

## Tools

| Tool | Price | What it does |
|---|---|---|
| `celo_gas` | $0.0002 | Gas price, latest block, cost of an ERC20 transfer |
| `celo_token_info` | $0.0005 | ERC20 name / symbol / decimals / supply |
| `celo_balances` | $0.001 | CELO + USDC/USDT/cUSD/cEUR balances, flagging which are x402-settleable |
| `celo_transaction` | $0.001 | Transaction summary by hash |
| `x402_probe` | $0.002 | Given any URL, report whether it is x402-payable and on what terms — **without paying** |

`x402_probe` is the one with no equivalent elsewhere. x402 has no discovery
mechanism: the only way to learn an endpoint's price is to call it and read the
`402`. This does that safely and normalises the answer, including whether Celo's
facilitator can actually settle those terms.

## Quick start

```bash
npm install
cp .env.example .env
# set PAY_TO_ADDRESS to the Celo address that should receive payments
npm run dev
```

Then, free of charge:

```bash
curl localhost:3000/                    # service card: tools + prices
curl localhost:3000/health              # also checks the facilitator is live
curl -X POST localhost:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Trigger a payment challenge:

```bash
curl -i "localhost:3000/v1/tools/celo_gas"   # -> 402 with the terms
```

Pay it end to end (needs a throwaway key holding a little USDC on Celo):

```bash
BUYER_PRIVATE_KEY=0x... npm run buyer -- celo_gas
BUYER_PRIVATE_KEY=0x... npm run buyer -- celo_balances '{"address":"0x..."}'
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the server with reload |
| `npm run smoke` | Exercise every tool against live Celo. Spends nothing |
| `npm run verify-sig` | Prove the EIP-3009 payload + EIP-712 domain are correct, using an unfunded key. Spends nothing |
| `npm run buyer` | Full buy: 402 → sign → retry → settle. **Spends USDC** |
| `npm run typecheck` | `tsc --noEmit` |

## How payment works here

```
agent → tools/call (no X-PAYMENT)
      ← 402 + accepts[] (scheme, network, asset, amount, payTo, EIP-712 domain)
  agent signs EIP-3009 TransferWithAuthorization
agent → tools/call with X-PAYMENT: base64(payload)
      → facilitator /verify   (off-chain: signature + balance simulation)
      → run the tool
      → facilitator /settle   (on-chain: facilitator submits, pays gas)
      ← result + X-PAYMENT-RESPONSE receipt
```

**The tool runs before settlement, deliberately.** A tool that throws never calls
`settle()`, so a failing call costs the buyer nothing. If the tool succeeds but
settlement fails, the result is withheld rather than given away — the response is
a `402`, not a silent freebie.

`initialize`, `tools/list` and `ping` are always free: a buyer has to be able to
discover what exists and what it costs before paying for anything.

## Findings that contradict the published docs

These were verified against the live facilitator on 2026-07-29 and each one
would otherwise have silently broken the build.

1. **The documented facilitator URL is wrong.** `docs.celo.org` says
   `https://x402.celo.org`. That host serves the marketing SPA — it returns
   `text/html` for `GET /supported` and `405` for `POST /verify`. The JSON API is
   at **`https://api.x402.celo.org`**. `src/x402/facilitator.ts` detects a
   non-JSON response and says so explicitly, because the natural failure mode is
   an opaque `JSON.parse` error.

2. **`upto` (dynamic/metered pricing) is not supported.** Live `/supported`
   advertises only `scheme: "exact"`. The docs' per-token metered-billing example
   cannot work against this facilitator today.

3. **No testnet.** `/supported` lists only `eip155:42220` (v2) and `celo` (v1),
   despite the docs describing Celo Sepolia support. End-to-end settlement
   testing requires mainnet — which is why the sub-cent pricing and the two
   spend-nothing verification scripts exist.

4. **`x402-express@1.2.0` cannot target Celo at all.** Its `Network` enum is
   `abstract, base, base-sepolia, avalanche, avalanche-fuji, iotex, solana,
   solana-devnet, sei, sei-testnet, polygon, polygon-amoy, peaq, story, educhain,
   skale-base-sepolia` — no `celo`, no `eip155:42220`. The docs' `x402-express`
   snippet fails Zod validation before any request is made. Same applies to the
   `x402` client library, which is why `scripts/buyer.ts` signs with viem
   directly. This server implements the protocol against the facilitator's HTTP
   API instead.

5. **The USDC address in the docs has an invalid EIP-55 checksum.**
   `0xcEBA9300f2b948710d2653dD7B07f33A8B32118C` — correct is
   `0xcebA9300f2b948710d2653dD7B07f33A8B32118C`. `getAddress()` normalises it
   silently, so this only surfaces at a strict validation boundary.

6. **cUSD cannot be used for x402 payments.** Mento's `StableTokenV2` implements
   only EIP-2612 `permit`, not the EIP-3009 `transferWithAuthorization` the
   facilitator settles with. Celo's flagship stablecoin is therefore unusable as
   an x402 asset; settlement uses USDC. `celo_balances` still reports cUSD but
   flags `x402Settleable: false`.

Also worth knowing: `/verify` answers with **HTTP 400** and a well-formed verdict
body when a payment is bad. Treating non-2xx as a transport error turns an
underfunded buyer into a confusing `502`; `post()` distinguishes a verdict from a
real failure so the buyer gets a `402` naming the reason.

## Verification status

| Piece | Status |
|---|---|
| Free MCP discovery (`initialize`, `tools/list`, `ping`) | Verified |
| All five tools against live Celo mainnet | Verified via `npm run smoke` |
| `402` challenge on both MCP and REST, with correct terms | Verified |
| EIP-3009 payload + EIP-712 domain accepted by the facilitator | Verified via `npm run verify-sig` — rejected only for `insufficient_funds`, meaning signature recovery and payload parsing both succeeded |
| Underfunded buyer receives a clean `402` naming the reason | Verified |
| **On-chain settlement moving real funds** | **Not yet run** — needs a funded key. This is the one path no test here covers. |

## Deployment note

`PUBLIC_BASE_URL` must match the URL buyers actually call. Payment requirements
bind the signed authorization to the `resource` URL, so leaving it as
`localhost:3000` behind a tunnel or deploy will fail at settlement.

## Listing copy

For the marketplace form:

> **celo-chain-intel** — A paid MCP server giving AI agents instant Celo chain
> intelligence: balances, token metadata, gas, transaction lookups, and x402
> endpoint discovery. No API keys and no signup — agents pay per call in
> stablecoins over x402, from $0.0002. Includes `x402_probe`, which tells an
> agent what any endpoint charges before it commits to paying.

Contact and logo still need to be supplied by you.
