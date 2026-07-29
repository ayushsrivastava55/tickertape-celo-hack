import { formatUnits } from "viem";
import { DEFAULT_TOKEN, PUBLIC_BASE_URL } from "./config.js";
import { TOOLS, TOOLS_BY_NAME } from "./tools/registry.js";
import { buildRequirements, gate } from "./x402/gate.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = {
  name: "celo-chain-intel",
  version: "0.1.0",
};

type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function priceLabel(atomic: bigint): string {
  return `$${formatUnits(atomic, DEFAULT_TOKEN.decimals)}`;
}

function toolListing() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    // Price belongs in the description so an LLM deciding whether to call the
    // tool can see the cost, not just the payment layer.
    description: `${tool.description} [Costs ${priceLabel(tool.atomicPrice)} ${DEFAULT_TOKEN.symbol} on Celo via x402.]`,
    inputSchema: tool.jsonSchema,
    _meta: {
      "x402/price": {
        atomicAmount: tool.atomicPrice.toString(),
        asset: DEFAULT_TOKEN.address,
        symbol: DEFAULT_TOKEN.symbol,
        decimals: DEFAULT_TOKEN.decimals,
        display: priceLabel(tool.atomicPrice),
        network: "celo",
      },
    },
  }));
}

export type McpOutcome = {
  /** HTTP status to send. 402 when payment is required. */
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

/**
 * Handles one MCP JSON-RPC message.
 *
 * `initialize`, `tools/list` and `ping` are free — a buyer must be able to
 * discover what exists and what it costs before paying. Only `tools/call` is
 * metered.
 */
export async function handleMcpMessage(
  message: JsonRpcRequest,
  paymentHeader: string | undefined,
): Promise<McpOutcome | null> {
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize":
      return {
        status: 200,
        body: ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Celo chain-intelligence tools. tools/list is free. Every tools/call " +
            "requires an x402 payment: call once without an X-PAYMENT header to " +
            "receive the payment requirements in the 402 body, sign the EIP-3009 " +
            "authorization, then retry with the X-PAYMENT header.",
        }),
      };

    // Notifications carry no id and get no response body.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return { status: 200, body: ok(id, {}) };

    case "tools/list":
      return { status: 200, body: ok(id, { tools: toolListing() }) };

    case "tools/call":
      return handleToolCall(id, message.params ?? {}, paymentHeader);

    default:
      return {
        status: 200,
        body: err(id, -32601, `Method not found: ${message.method}`),
      };
  }
}

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown>,
  paymentHeader: string | undefined,
): Promise<McpOutcome> {
  const name = params.name as string | undefined;
  if (!name) {
    return { status: 200, body: err(id, -32602, "Missing tool name") };
  }

  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    return { status: 200, body: err(id, -32602, `Unknown tool: ${name}`) };
  }

  const parsedArgs = tool.inputSchema.safeParse(params.arguments ?? {});
  if (!parsedArgs.success) {
    return {
      status: 200,
      body: err(id, -32602, `Invalid arguments for ${name}`, parsedArgs.error.format()),
    };
  }

  const requirements = buildRequirements({
    resource: `${PUBLIC_BASE_URL}/mcp#${name}`,
    description: `MCP tool call: ${name}`,
    atomicAmount: tool.atomicPrice,
  });

  let gated;
  try {
    gated = await gate(paymentHeader, requirements);
  } catch (error) {
    // Facilitator unreachable or misconfigured — surface it rather than
    // silently serving paid work for free.
    return {
      status: 502,
      body: err(id, -32000, `Payment verification unavailable: ${(error as Error).message}`),
    };
  }

  if (!gated.ok) {
    return { status: 402, body: gated.body };
  }

  // Run the priced work BEFORE settling, so a tool failure costs the buyer
  // nothing. The signed authorization stays valid for maxTimeoutSeconds.
  let result: unknown;
  try {
    result = await tool.run(parsedArgs.data);
  } catch (error) {
    return {
      status: 200,
      body: ok(id, {
        content: [
          { type: "text", text: `Tool error: ${(error as Error).message}` },
        ],
        isError: true,
        _meta: { "x402/charged": false },
      }),
    };
  }

  let transaction: string | null = null;
  try {
    ({ transaction } = await gated.settle());
  } catch (error) {
    // Work succeeded but funds did not move. Withhold the result — returning it
    // would mean giving away the product for free.
    return {
      status: 402,
      body: err(id, -32000, `Payment settlement failed: ${(error as Error).message}`),
    };
  }

  const receipt = {
    success: true,
    transaction,
    network: "celo",
    payer: gated.payer,
    amount: tool.atomicPrice.toString(),
    asset: DEFAULT_TOKEN.address,
    ...(transaction ? { explorer: `https://celoscan.io/tx/${transaction}` } : {}),
  };

  return {
    status: 200,
    headers: {
      "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt), "utf8").toString(
        "base64",
      ),
    },
    body: ok(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      _meta: { "x402/charged": true, "x402/receipt": receipt },
    }),
  };
}

export { toolListing, priceLabel };
