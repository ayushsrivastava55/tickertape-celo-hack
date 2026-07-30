import { FACILITATOR_API_KEY, FACILITATOR_URL } from "../config.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "./types.js";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // /settle requires this; /verify does not. Undocumented in docs.celo.org —
      // the key comes from the x402.celo.org dashboard (see scripts/get-facilitator-key.ts).
      ...(FACILITATOR_API_KEY ? { "X-API-Key": FACILITATOR_API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  // Guard against the docs' wrong host: x402.celo.org serves an HTML SPA, which
  // would otherwise surface as an opaque JSON.parse failure.
  if (!contentType.includes("application/json")) {
    throw new Error(
      `Facilitator ${path} returned ${res.status} ${contentType || "no content-type"} ` +
        `instead of JSON. Is FACILITATOR_URL correct? ` +
        `It must be the API host (https://api.x402.celo.org), not https://x402.celo.org. ` +
        `Body starts: ${text.slice(0, 120)}`,
    );
  }

  if (process.env.X402_DEBUG === "1") {
    console.log(`[x402 debug] ${path} -> ${res.status} ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text) as T;

  // A rejected payment is a normal outcome, not a transport failure: the
  // facilitator answers /verify with HTTP 400 and /settle with a non-2xx while
  // still returning a well-formed verdict body (e.g. insufficient_funds).
  // Those must reach the caller as data so the buyer gets a 402 explaining the
  // reason, rather than being flattened into a 502. Only genuinely unusable
  // responses throw.
  const isVerdict =
    json !== null &&
    typeof json === "object" &&
    ("isValid" in json || "success" in json);

  if (!res.ok && !isVerdict) {
    throw new Error(
      `Facilitator ${path} failed with ${res.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/** Off-chain signature + simulation check. Does not move funds. */
export function verifyPayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
  return post<VerifyResponse>("/verify", {
    x402Version: paymentPayload.x402Version,
    paymentPayload,
    paymentRequirements,
  });
}

/**
 * Submits the buyer's authorization on-chain. The facilitator pays gas and never
 * custodies funds — value moves directly from payer to `payTo`.
 */
export function settlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
  return post<SettleResponse>("/settle", {
    x402Version: paymentPayload.x402Version,
    paymentPayload,
    paymentRequirements,
  });
}

export type SupportedResponse = {
  kinds: { x402Version: number; scheme: string; network: string }[];
  extensions?: unknown[];
  signers?: Record<string, string[]>;
};

export async function getSupported(): Promise<SupportedResponse> {
  const res = await fetch(`${FACILITATOR_URL}/supported`);
  if (!res.ok) {
    throw new Error(`Facilitator /supported failed with ${res.status}`);
  }
  return (await res.json()) as SupportedResponse;
}
