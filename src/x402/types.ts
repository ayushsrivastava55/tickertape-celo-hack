import { z } from "zod";

/**
 * Wire types for x402 v1, `exact` scheme on EVM. Mirrors the schemas shipped in
 * the `x402` package so our hand-rolled server stays interoperable with standard
 * clients. We define them locally rather than importing because the published
 * `Network` enum has no Celo member (see note in ../config.ts).
 */

export const PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.string(),
  /** Atomic units of `asset`, as a decimal string. */
  maxAmountRequired: z.string(),
  resource: z.string(),
  description: z.string(),
  mimeType: z.string(),
  outputSchema: z.record(z.any()).optional(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  asset: z.string(),
  extra: z.record(z.any()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const ExactEvmPayloadAuthorizationSchema = z.object({
  from: z.string(),
  to: z.string(),
  value: z.string(),
  validAfter: z.string(),
  validBefore: z.string(),
  nonce: z.string(),
});
export type ExactEvmPayloadAuthorization = z.infer<
  typeof ExactEvmPayloadAuthorizationSchema
>;

export const ExactEvmPayloadSchema = z.object({
  signature: z.string(),
  authorization: ExactEvmPayloadAuthorizationSchema,
});

export const PaymentPayloadSchema = z.object({
  x402Version: z.number(),
  scheme: z.literal("exact"),
  network: z.string(),
  payload: ExactEvmPayloadSchema,
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string | null;
  /** Human-readable elaboration, e.g. "Onchain balance is not enough…". */
  invalidReasonDetails?: string | null;
  payer?: string | null;
};

export type SettleResponse = {
  success: boolean;
  errorReason?: string | null;
  transaction?: string | null;
  network?: string | null;
  payer?: string | null;
  /**
   * Prepaid credits left on the facilitator API key. One credit per settlement
   * at $0.001. There is no GET endpoint for this, so the settle response is the
   * only way to observe the balance.
   */
  credits?: number | null;
};

/** Body of a 402 response in v1 (requirements travel in the body). */
export type PaymentRequiredBody = {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
};

export function encodePaymentPayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodePaymentPayload(header: string): PaymentPayload {
  const json = Buffer.from(header, "base64").toString("utf8");
  return PaymentPayloadSchema.parse(JSON.parse(json));
}
