import { formatUnits } from "viem";
import { getSupported } from "../x402/facilitator.js";
import { PaymentRequirementsSchema } from "../x402/types.js";

/**
 * Discovery tool: given any URL, report whether it is x402-payable and on what
 * terms — without paying for it.
 *
 * This exists because the protocol has no discovery mechanism: an agent can only
 * learn an endpoint's price by calling it and reading the 402. Doing that blind
 * is risky, so we do it here and normalise the answer.
 */
export async function x402Probe(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  const res = await fetch(parsed.toString(), {
    method: "GET",
    // Deliberately no X-PAYMENT header: we want the 402 challenge itself.
    headers: { Accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status !== 402) {
    return {
      url: parsed.toString(),
      payable: false,
      status: res.status,
      reason:
        res.status < 400
          ? "Endpoint responded without requiring payment (it is free, or gated another way)."
          : `Endpoint returned ${res.status}; no x402 challenge present.`,
    };
  }

  // v2 puts requirements in a header; v1 puts them in the body. Try both.
  const headerChallenge =
    res.headers.get("payment-required") ?? res.headers.get("www-authenticate");

  let accepts: unknown[] = [];
  let x402Version: number | null = null;

  const bodyText = await res.text();
  try {
    const body = JSON.parse(bodyText) as {
      x402Version?: number;
      accepts?: unknown[];
    };
    x402Version = body.x402Version ?? null;
    accepts = body.accepts ?? [];
  } catch {
    // Body was not JSON — fall through to the header form below.
  }

  if (accepts.length === 0 && headerChallenge) {
    try {
      const decoded = JSON.parse(
        Buffer.from(headerChallenge, "base64").toString("utf8"),
      ) as { x402Version?: number; accepts?: unknown[] };
      x402Version = decoded.x402Version ?? x402Version;
      accepts = decoded.accepts ?? [];
    } catch {
      // Not base64 JSON either; report what we have rather than inventing terms.
    }
  }

  const supported = await getSupported().catch(() => null);
  const supportedKeys = new Set(
    (supported?.kinds ?? []).map((k) => `${k.scheme}:${k.network}`),
  );

  const offers = accepts.map((raw) => {
    const result = PaymentRequirementsSchema.safeParse(raw);
    if (!result.success) {
      return { valid: false as const, raw, error: result.error.message };
    }
    const r = result.data;
    return {
      valid: true as const,
      scheme: r.scheme,
      network: r.network,
      asset: r.asset,
      payTo: r.payTo,
      maxAmountRequired: r.maxAmountRequired,
      // Most x402 assets are 6-decimal stablecoins; flagged as an assumption
      // because requirements do not carry the asset's decimals.
      approxAmountAssuming6Decimals: formatUnits(
        BigInt(r.maxAmountRequired),
        6,
      ),
      description: r.description,
      maxTimeoutSeconds: r.maxTimeoutSeconds,
      settleableByCeloFacilitator: supportedKeys.has(
        `${r.scheme}:${r.network}`,
      ),
    };
  });

  return {
    url: parsed.toString(),
    payable: true,
    status: 402,
    x402Version,
    offerCount: offers.length,
    offers,
    celoFacilitatorSupports: supported?.kinds ?? null,
  };
}
