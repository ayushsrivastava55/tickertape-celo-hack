import express from "express";
import {
  DEFAULT_TOKEN,
  FACILITATOR_API_KEY,
  FACILITATOR_URL,
  PAY_TO,
  PORT,
  PUBLIC_BASE_URL,
  X402_NETWORK,
  X402_VERSION,
} from "./config.js";
import {
  handleMcpMessage,
  MCP_PROTOCOL_VERSION,
  priceLabel,
  SERVER_INFO,
  toolListing,
  type JsonRpcRequest,
} from "./mcp.js";
import { TOOLS, TOOLS_BY_NAME } from "./tools/registry.js";
import { getSupported } from "./x402/facilitator.js";
import { buildRequirements, gate, getLastKnownCredits } from "./x402/gate.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

function paymentHeaderOf(req: express.Request): string | undefined {
  const header = req.headers["x-payment"] ?? req.headers["payment-signature"];
  return Array.isArray(header) ? header[0] : header;
}

/** Free service card — the thing to point a marketplace listing at. */
app.get("/", (_req, res) => {
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description:
      "Paid MCP server providing Celo chain-intelligence tools to other agents, " +
      "metered per call over x402 stablecoin payments.",
    mcpEndpoint: `${PUBLIC_BASE_URL}/mcp`,
    restEndpoint: `${PUBLIC_BASE_URL}/v1/tools/{tool}`,
    payment: {
      protocol: "x402",
      x402Version: X402_VERSION,
      scheme: "exact",
      network: X402_NETWORK,
      chainId: 42220,
      facilitator: FACILITATOR_URL,
      asset: {
        symbol: DEFAULT_TOKEN.symbol,
        address: DEFAULT_TOKEN.address,
        decimals: DEFAULT_TOKEN.decimals,
      },
      payTo: PAY_TO,
    },
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      price: priceLabel(t.atomicPrice),
      atomicPrice: t.atomicPrice.toString(),
    })),
  });
});

/** Liveness plus a live check that the facilitator is actually reachable. */
app.get("/health", async (_req, res) => {
  try {
    const supported = await getSupported();
    res.json({
      status: "ok",
      facilitator: FACILITATOR_URL,
      apiKeyConfigured: Boolean(FACILITATOR_API_KEY),
      // null until the first settlement of this process: the facilitator has no
      // endpoint to query credits, it only reports them in settle responses.
      creditsRemaining: getLastKnownCredits(),
      supported,
    });
  } catch (error) {
    res.status(503).json({
      status: "degraded",
      facilitator: FACILITATOR_URL,
      error: (error as Error).message,
    });
  }
});

/** Machine-readable catalogue for agent discovery. Free. */
app.get("/.well-known/x402", (_req, res) => {
  res.json({
    x402Version: X402_VERSION,
    network: X402_NETWORK,
    facilitator: FACILITATOR_URL,
    payTo: PAY_TO,
    asset: DEFAULT_TOKEN.address,
    resources: TOOLS.map((t) => ({
      resource: `${PUBLIC_BASE_URL}/v1/tools/${t.name}`,
      description: t.description,
      maxAmountRequired: t.atomicPrice.toString(),
      scheme: "exact",
    })),
  });
});

/** MCP endpoint. Stateless streamable-HTTP: one JSON-RPC message per POST. */
app.post("/mcp", async (req, res) => {
  const body = req.body as JsonRpcRequest | JsonRpcRequest[];

  if (Array.isArray(body)) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "Batched requests are not supported: each call is priced and settled individually.",
      },
    });
    return;
  }

  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
    });
    return;
  }

  try {
    const outcome = await handleMcpMessage(body, paymentHeaderOf(req));
    if (outcome === null) {
      res.status(202).end();
      return;
    }
    if (outcome.headers) res.set(outcome.headers);
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: -32603, message: (error as Error).message },
    });
  }
});

app.get("/mcp", (_req, res) => {
  // No SSE stream: this server is stateless and never initiates messages.
  res.status(405)
    .set("Allow", "POST")
    .json({ error: "This MCP server is stateless. Use POST /mcp." });
});

/**
 * Plain REST access to the same tools, for buyers that speak x402 but not MCP.
 * Identical pricing and identical settle-after-success ordering.
 */
app.all("/v1/tools/:name", async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).set("Allow", "GET, POST").json({ error: "Use GET or POST." });
    return;
  }

  const tool = TOOLS_BY_NAME.get(req.params.name);
  if (!tool) {
    res.status(404).json({
      error: `Unknown tool: ${req.params.name}`,
      available: TOOLS.map((t) => t.name),
    });
    return;
  }

  const rawArgs =
    req.method === "GET" ? { ...req.query } : { ...(req.body ?? {}) };
  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    res.status(400).json({
      error: `Invalid arguments for ${tool.name}`,
      details: parsed.error.format(),
    });
    return;
  }

  const requirements = buildRequirements({
    resource: `${PUBLIC_BASE_URL}/v1/tools/${tool.name}`,
    description: tool.description,
    atomicAmount: tool.atomicPrice,
  });

  let gated;
  try {
    gated = await gate(paymentHeaderOf(req), requirements);
  } catch (error) {
    res.status(502).json({
      error: `Payment verification unavailable: ${(error as Error).message}`,
    });
    return;
  }

  if (!gated.ok) {
    res.status(402).json(gated.body);
    return;
  }

  let result: unknown;
  try {
    result = await tool.run(parsed.data);
  } catch (error) {
    // Not charged: settle() was never called.
    res.status(400).json({ error: (error as Error).message, charged: false });
    return;
  }

  let transaction: string | null = null;
  try {
    ({ transaction } = await gated.settle());
  } catch (error) {
    res.status(402).json({ error: (error as Error).message, charged: false });
    return;
  }

  const receipt = {
    success: true,
    transaction,
    network: X402_NETWORK,
    payer: gated.payer,
    amount: tool.atomicPrice.toString(),
    asset: DEFAULT_TOKEN.address,
  };

  res
    .set(
      "X-PAYMENT-RESPONSE",
      Buffer.from(JSON.stringify(receipt), "utf8").toString("base64"),
    )
    .json({ result, payment: receipt });
});

app.listen(PORT, () => {
  console.log(`${SERVER_INFO.name} v${SERVER_INFO.version}`);
  console.log(`  listening        http://localhost:${PORT}`);
  console.log(`  public base URL  ${PUBLIC_BASE_URL}`);
  console.log(`  MCP endpoint     POST ${PUBLIC_BASE_URL}/mcp`);
  console.log(`  MCP protocol     ${MCP_PROTOCOL_VERSION}`);
  console.log(`  facilitator      ${FACILITATOR_URL}`);
  console.log(`  paying to        ${PAY_TO}`);
  console.log(
    `  settling in      ${DEFAULT_TOKEN.symbol} (${DEFAULT_TOKEN.address})`,
  );
  console.log(`  tools            ${TOOLS.length}`);
  for (const tool of TOOLS) {
    console.log(
      `    - ${tool.name.padEnd(18)} ${priceLabel(tool.atomicPrice).padStart(8)}`,
    );
  }
});
