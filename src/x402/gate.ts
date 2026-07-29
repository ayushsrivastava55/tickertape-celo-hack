import {
  DEFAULT_TOKEN,
  MAX_TIMEOUT_SECONDS,
  PAY_TO,
  X402_NETWORK,
  X402_VERSION,
} from "../config.js";
import { settlePayment, verifyPayment } from "./facilitator.js";
import {
  decodePaymentPayload,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
} from "./types.js";

export function buildRequirements(opts: {
  /** Absolute URL of the thing being sold. Must match what the buyer called. */
  resource: string;
  description: string;
  /** Price in atomic units of the settlement token (USDC has 6 decimals). */
  atomicAmount: bigint;
  mimeType?: string;
  outputSchema?: Record<string, unknown>;
}): PaymentRequirements {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    maxAmountRequired: opts.atomicAmount.toString(),
    resource: opts.resource,
    description: opts.description,
    mimeType: opts.mimeType ?? "application/json",
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: DEFAULT_TOKEN.address,
    // The buyer needs the EIP-712 domain to produce a valid EIP-3009 signature.
    extra: {
      name: DEFAULT_TOKEN.eip712.name,
      version: DEFAULT_TOKEN.eip712.version,
    },
  };
}

export function paymentRequiredBody(
  requirements: PaymentRequirements,
  error = "X-PAYMENT header is required",
): PaymentRequiredBody {
  return {
    x402Version: X402_VERSION,
    error,
    accepts: [requirements],
  };
}

export type GateResult =
  | { ok: false; body: PaymentRequiredBody }
  | {
      ok: true;
      payer: string | null;
      payload: PaymentPayload;
      requirements: PaymentRequirements;
      /**
       * Moves the funds on-chain. Call this only once the priced work has
       * succeeded, so a failing tool never bills the buyer.
       */
      settle: () => Promise<{ transaction: string | null }>;
    };

/**
 * Off-chain half of the x402 handshake: parse the buyer's authorization and ask
 * the facilitator to validate it, without yet moving funds.
 */
export async function gate(
  paymentHeader: string | undefined,
  requirements: PaymentRequirements,
): Promise<GateResult> {
  if (!paymentHeader) {
    return { ok: false, body: paymentRequiredBody(requirements) };
  }

  let payload: PaymentPayload;
  try {
    payload = decodePaymentPayload(paymentHeader);
  } catch (err) {
    return {
      ok: false,
      body: paymentRequiredBody(
        requirements,
        `Malformed X-PAYMENT header: ${(err as Error).message}`,
      ),
    };
  }

  const verification = await verifyPayment(payload, requirements);
  if (!verification.isValid) {
    const reason = verification.invalidReason ?? "payment verification failed";
    return {
      ok: false,
      body: paymentRequiredBody(
        requirements,
        verification.invalidReasonDetails
          ? `${reason}: ${verification.invalidReasonDetails}`
          : reason,
      ),
    };
  }

  return {
    ok: true,
    payer: verification.payer ?? payload.payload.authorization.from,
    payload,
    requirements,
    settle: async () => {
      const result = await settlePayment(payload, requirements);
      if (!result.success) {
        throw new Error(
          `Settlement failed: ${result.errorReason ?? "unknown reason"}`,
        );
      }
      return { transaction: result.transaction ?? null };
    },
  };
}
