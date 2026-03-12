import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Stripe from "stripe";
import { z } from "zod";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY environment variable is required");
}
const stripe = new Stripe(stripeSecretKey);

/** "redirect" = Stripe hosted checkout URL; "instant" = OpenAI instant checkout modal. Default: redirect. */
const CHECKOUT_TYPE = (process.env.CHECKOUT_TYPE || "redirect").toLowerCase();

/** Stripe network/merchant ID for instant checkout (payment_provider.merchant_id). */
const MERCHANT_ID = process.env.MERCHANT_ID || "";
const productsCarouselUri = "ui://products-carousel.html";
const productsCarouselHTML = readFileSync("ui/products-carousel.html", "utf8");
const productDetailUri = "ui://product-detail.html";
const productDetailHTML = readFileSync("ui/product-detail.html", "utf8");

/** Cart per ChatGPT conversation session. Key: _meta["openai/session"]; value: { items, currency }. Cleared to empty after checkout. */
const sessionCarts = new Map();

function getOrCreateCart(sessionId) {
  if (!sessionId) return null;
  let cart = sessionCarts.get(sessionId);
  if (!cart) {
    cart = { items: [], currency: "usd" };
    sessionCarts.set(sessionId, cart);
  }
  return cart;
}

function getCart(sessionId) {
  return sessionId ? sessionCarts.get(sessionId) : null;
}

function clearCart(sessionId) {
  if (sessionId) sessionCarts.set(sessionId, { items: [], currency: "usd" });
}

function createMcpServer() {
  const server = new McpServer({ name: "my-mcp-server", version: "1.0.0" });

  async function createCheckoutSession(priceIds) {
    const lineItems = priceIds.map((price) => ({ price, quantity: 1 }));
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: "https://chat.openai.com/",
    });
    return session;
  }

  /**
   * Parse checkout session id from instant checkout: "priceId1,priceId2::uuid"
   * Returns { priceIds: string[], uuid: string }.
   */
  function parseCheckoutSessionId(checkoutSessionId) {
    const [front, uuid] = String(checkoutSessionId).split("::");
    const priceIds = front ? front.split(",").filter(Boolean) : [];
    return { priceIds, uuid: uuid || "" };
  }

  /** Build a checkout session id for instant checkout (used by complete_checkout). */
  function createCheckoutSessionId() {
    return (
      "session_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2)
    );
  }

  /**
   * Build line items for instant checkout from cart only (no Stripe API calls).
   * Returns array of { priceId, title, amount, currency } or null if cart doesn't match.
   */
  function getLineItemsFromCart(priceIds, cart) {
    if (!cart?.items?.length || priceIds.length === 0) return null;
    if (!priceIds.every((id) => cart.items.some((i) => i.priceId === id))) return null;
    return priceIds.map((id) => {
      const item = cart.items.find((i) => i.priceId === id);
      return {
        priceId: id,
        title: item.title ?? id,
        amount: item.amount ?? 0,
        currency: item.currency ?? "usd",
      };
    });
  }

  const getTax = () => 0;

  /** Fetch all active products (Stripe list is paginated, default 10 per page). */
  async function listAllActiveProducts(expand = []) {
    const all = [];
    let hasMore = true;
    let startingAfter;
    while (hasMore) {
      const params = { active: true, limit: 100 };
      if (expand.length) params.expand = expand;
      if (startingAfter) params.starting_after = startingAfter;
      const res = await stripe.products.list(params);
      all.push(...res.data);
      hasMore = res.has_more && res.data.length > 0;
      if (hasMore) startingAfter = res.data[res.data.length - 1].id;
    }
    return all;
  }

  server.registerTool(
    "buy-products",
    {
      title: "Buy products",
      description:
        "Create a Stripe hosted checkout session for the user's cart (or pass priceIds). Use when the user wants to checkout, pay, or buy items in cart.",
      inputSchema: {
        priceIds: z.array(z.string()).optional(),
      },
      _meta: {
        "openai/requireUserConfirmation": false,
      },
    },
    async (args, extra) => {
      const sessionId = extra?._meta?.["openai/session"];
      const cart = getCart(sessionId);
      let ids = args.priceIds && args.priceIds.length > 0 ? args.priceIds : [];
      if (ids.length === 0 && cart && cart.items.length > 0) {
        ids = cart.items.map((i) => i.priceId);
      }
      if (ids.length === 0) {
        return {
          content: [{ type: "text", text: "Cart is empty — nothing to check out." }],
        };
      }

      if (CHECKOUT_TYPE === "instant") {
        const selectedProducts = getLineItemsFromCart(ids, cart);
        if (!selectedProducts?.length) {
          return {
            content: [{ type: "text", text: "Cart is empty — nothing to check out." }],
          };
        }
        const totalAmount = selectedProducts.reduce((sum, p) => sum + (p.amount || 0), 0);
        const tax = 0;
        const checkoutSessionId = `${ids.join(",")}::${createCheckoutSessionId()}`;
        const currency = (selectedProducts[0]?.currency || "usd").toUpperCase();
        const requestCheckoutPayload = {
          id: checkoutSessionId,
          payment_mode: "test",
          payment_provider: {
            provider: "stripe",
            merchant_id: MERCHANT_ID,
            supported_payment_methods: ["card"],
          },
          status: "ready_for_payment",
          currency,
          line_items: selectedProducts.map((product) => ({
            id: product.priceId,
            item: { id: product.priceId, quantity: 1 },
            base_amount: product.amount,
            subtotal: product.amount,
            tax: 0,
            total: (product.amount || 0) + 0,
          })),
          totals: [
            ...selectedProducts.map((p) => ({
              type: "items_base_amount",
              display_text: p.title || p.priceId,
              amount: p.amount,
            })),
            { type: "subtotal", display_text: "Subtotal", amount: totalAmount },
            { type: "tax", display_text: "Tax", amount: tax },
            { type: "total", display_text: "Total", amount: totalAmount + tax },
          ],
          fulfillment_options: [],
          fulfillment_address: null,
          messages: [],
          links: [{ type: "terms_of_service", url: "https://example.com/terms" }],
        };
        clearCart(sessionId);
        return {
          content: [{ type: "text", text: "Opening checkout…" }],
          structuredContent: {
            checkoutMode: "instant",
            requestCheckoutPayload,
          },
        };
      }

      // redirect (default)
      const session = await createCheckoutSession(ids);
      clearCart(sessionId);
      const url = session.url || "";
      return {
        content: [
          {
            type: "text",
            text: `Complete your purchase here:\n\n${url}`,
          },
        ],
        structuredContent: {
          checkoutMode: "redirect",
          checkoutSessionId: session.id,
          checkoutSessionUrl: url,
        },
      };
    }
  );

  server.registerTool(
    "add-to-cart",
    {
      title: "Add to cart",
      description: "Add a product to the shopping cart. Cart is managed per conversation.",
      inputSchema: {
        priceId: z.string(),
        title: z.string(),
        amount: z.number().nullable(),
        currency: z.string().nullable(),
      },
    },
    async (args, extra) => {
      const { priceId, title, amount, currency } = args;
      const sessionId = extra?._meta?.["openai/session"];
      const cart = getOrCreateCart(sessionId);
      if (!cart) {
        return {
          content: [{ type: "text", text: "Unable to add to cart (no session)." }],
          structuredContent: { cartId: null, items: [], itemCount: 0, subtotal: 0, currency: "usd" },
        };
      }
      cart.items.push({ priceId, title, amount, currency });
      const cartCurrency =
        currency || cart.items.find((i) => i.currency)?.currency || "usd";
      cart.currency = cartCurrency;
      const itemCount = cart.items.length;
      const subtotal = cart.items.reduce((s, i) => s + (i.amount ?? 0), 0);
      return {
        content: [
          {
            type: "text",
            text: `Added "${title}" to cart. Cart now has ${itemCount} item${itemCount !== 1 ? "s" : ""}.`,
          },
        ],
        structuredContent: {
          cartId: sessionId,
          items: cart.items,
          itemCount,
          subtotal,
          currency: cartCurrency,
        },
      };
    }
  );

  server.registerTool(
    "get-cart",
    {
      title: "Get cart",
      description: "Retrieve the current conversation's shopping cart. Returns items, count, and subtotal.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const sessionId = extra?._meta?.["openai/session"];
      const cart = getCart(sessionId);
      const empty = {
        content: [{ type: "text", text: "Cart not found or empty." }],
        structuredContent: { cartId: sessionId ?? null, items: [], itemCount: 0, subtotal: 0, currency: "usd" },
      };
      if (!cart || cart.items.length === 0) return empty;
      const itemCount = cart.items.length;
      const subtotal = cart.items.reduce((s, i) => s + (i.amount ?? 0), 0);
      const currency = cart.items.find((i) => i.currency)?.currency || "usd";
      return {
        content: [
          { type: "text", text: `Cart has ${itemCount} item${itemCount !== 1 ? "s" : ""}.` },
        ],
        structuredContent: { cartId: sessionId, items: cart.items, itemCount, subtotal, currency },
      };
    }
  );

  server.registerTool(
    "get-current-cart",
    {
      title: "Get current cart",
      description: "Retrieve the current conversation's shopping cart.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const sessionId = extra?._meta?.["openai/session"];
      const cart = getCart(sessionId);
      const empty = {
        content: [{ type: "text", text: "No cart yet." }],
        structuredContent: { cartId: sessionId ?? null, items: [], itemCount: 0, subtotal: 0, currency: "usd" },
      };
      if (!cart || cart.items.length === 0) return empty;
      const itemCount = cart.items.length;
      const subtotal = cart.items.reduce((s, i) => s + (i.amount ?? 0), 0);
      const currency = cart.items.find((i) => i.currency)?.currency || "usd";
      return {
        content: [
          { type: "text", text: `Cart has ${itemCount} item${itemCount !== 1 ? "s" : ""}.` },
        ],
        structuredContent: {
          cartId: sessionId,
          items: cart.items,
          itemCount,
          subtotal,
          currency,
        },
      };
    }
  );

  server.registerTool(
    "list-categories",
    {
      title: "List categories",
      description:
        "Returns a distinct list of product categories. Use this when the user wants to see what categories are available before browsing products.",
    },
    async () => {
      const products = await listAllActiveProducts();
      const categories = [
        ...new Set(
          products
            .filter(
              (p) =>
                p.metadata &&
                typeof p.metadata.category === "string" &&
                p.metadata.category.trim() !== ""
            )
            .map((p) => String(p.metadata.category).trim())
            .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
        ),
      ];
      return {
        content: [
          {
            type: "text",
            text: `Available categories: ${categories.join(", ") || "none (no products have a category set in metadata)"}.`,
          },
        ],
        structuredContent: { categories },
      };
    }
  );

  server.registerTool(
    "discover-by-category",
    {
      title: "Discover products by category",
      description: "Returns products in the given category. Cart for this conversation is included automatically.",
      inputSchema: { category: z.string() },
      _meta: { "openai/outputTemplate": productsCarouselUri },
    },
    async (args, extra) => {
      const sessionId = extra?._meta?.["openai/session"];
      const { category } = args;
      const normalizedCategory = String(category).trim();
      const products = await listAllActiveProducts(["data.default_price"]);
      const inCategory = products
        .filter((p) => {
          const cat =
            p.metadata && typeof p.metadata.category === "string"
              ? String(p.metadata.category).trim()
              : "";
          return (
            cat !== "" &&
            cat.localeCompare(normalizedCategory, "en", { sensitivity: "base" }) === 0
          );
        })
        .filter((p) => p.default_price)
        .map((p) => {
          const price =
            typeof p.default_price === "object" ? p.default_price : null;
          const priceId =
            typeof p.default_price === "string"
              ? p.default_price
              : price?.id ?? p.default_price;
          return {
            priceId,
            title: p.name,
            description: p.description ?? "",
            image:
              Array.isArray(p.images) && p.images.length > 0
                ? p.images[0]
                : null,
            amount: price?.unit_amount ?? null,
            currency: price?.currency ?? null,
          };
        });
      const cart = getCart(sessionId);
      const cartPayload =
        cart && cart.items.length > 0
          ? (() => {
              const itemCount = cart.items.length;
              const subtotal = cart.items.reduce((s, i) => s + (i.amount ?? 0), 0);
              const currency = cart.items.find((i) => i.currency)?.currency || "usd";
              return {
                cartId: sessionId,
                items: cart.items,
                itemCount,
                subtotal,
                currency,
              };
            })()
          : { cartId: sessionId ?? null, items: [], itemCount: 0, subtotal: 0, currency: "usd" };
      return {
        content: [],
        structuredContent: { products: inCategory },
        _meta: { cart: cartPayload },
      };
    }
  );

  const billingAddressSchema = z.object({
    name: z.string(),
    line_one: z.string(),
    line_two: z.string().nullable(),
    city: z.string(),
    state: z.string(),
    country: z.string(),
    postal_code: z.string(),
    phone_number: z.string().nullable(),
  });

  server.registerTool(
    "complete_checkout",
    {
      title: "Complete checkout",
      description:
        "Complete the checkout and process the payment (instant checkout)",
      inputSchema: {
        checkout_session_id: z.string(),
        buyer: z
          .object({
            name: z.string().nullable(),
            email: z.string().nullable(),
            phone_number: z.string().nullable(),
          })
          .nullable(),
        payment_data: z.object({
          token: z.string(),
          provider: z.string(),
          billing_address: billingAddressSchema.nullable(),
        }),
      },
    },
    async ({ checkout_session_id, buyer, payment_data }) => {
      const { priceIds } = parseCheckoutSessionId(checkout_session_id);
      if (!priceIds.length) {
        throw new Error("Invalid checkout_session_id: no price IDs");
      }
      const prices = await Promise.all(
        priceIds.map((id) => stripe.prices.retrieve(id))
      );
      const totalAmount = prices.reduce(
        (sum, p) => sum + (p.unit_amount ?? 0),
        0
      );
      const tax = getTax();
      const currency = prices[0]?.currency ?? "usd";

      await stripe.paymentIntents.create({
        amount: totalAmount + tax,
        currency,
        confirm: true,
        shared_payment_granted_token: payment_data.token,
      });

      return {
        content: [],
        structuredContent: {
          id: checkout_session_id,
          status: "completed",
          currency,
          buyer,
          line_items: [],
          order: {
            id: "123",
            checkout_session_id,
            permalink_url: "",
          },
        },
      };
    }
  );

  /**
   * Fetch full product details by priceId from Stripe. Use this so the detail
   * view always gets server-authoritative data and can be extended with more
   * fields (e.g. specs, reviews) without changing carousel or model payloads.
   */
  async function getProductDetailByPriceId(priceId) {
    if (!priceId || String(priceId).trim() === "") return null;
    try {
      const price = await stripe.prices.retrieve(priceId, {
        expand: ["product"],
      });
      const product =
        price.product && typeof price.product === "object"
          ? price.product
          : null;
      if (!product) return null;
      return {
        priceId: price.id,
        title: product.name,
        description: product.description ?? "",
        image:
          Array.isArray(product.images) && product.images.length > 0
            ? product.images[0]
            : null,
        amount: price.unit_amount ?? null,
        currency: price.currency ?? null,
        // Extensible: add more fields here later (e.g. metadata, images[], reviews)
        metadata: product.metadata ?? null,
        images: product.images ?? [],
      };
    } catch {
      return null;
    }
  }

  server.registerTool(
    "view-product-detail",
    {
      title: "View product details",
      description:
        "Shows full product details in a fullscreen view. Called from the product carousel when a user taps a product card.",
      inputSchema: {
        priceId: z.string().nullable(),
        title: z.string(),
        description: z.string(),
        image: z.string().nullable(),
        amount: z.number().nullable(),
        currency: z.string().nullable(),
      },
      _meta: {
        ui: { resourceUri: productDetailUri },
        "openai/outputTemplate": productDetailUri,
        "openai/toolInvocation/invoking": "Loading product…",
        "openai/toolInvocation/invoked": "Product details",
      },
    },
    async (product) => {
      // Prefer server-fetched details when we have a priceId so the UI can
      // reuse one source of truth and we can add more details later.
      const full =
        product.priceId != null
          ? await getProductDetailByPriceId(product.priceId)
          : null;
      const payload = full ?? product;
      return {
        structuredContent: payload,
        content: [
          {
            type: "text",
            text: `Showing details for ${payload.title}.`,
          },
        ],
      };
    }
  );

  server.registerResource(
    "products-carousel-widget",
    productsCarouselUri,
    {},
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html+skybridge",
          text: productsCarouselHTML,
          _meta: {
            "openai/widgetCSP": {
              resource_domains: ["https://files.stripe.com"],
              redirect_domains: ["https://checkout.stripe.com"],
            },
          },
        },
      ],
    })
  );

  server.registerResource(
    "product-detail-widget",
    productDetailUri,
    {},
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html+skybridge",
          text: productDetailHTML,
          _meta: {
            "openai/widgetCSP": {
              resource_domains: ["https://files.stripe.com"],
            },
          },
        },
      ],
    })
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Stripe checkout MCP server");
    return;
  }

  if (req.method === "GET" && url.pathname === "/products-carousel.html") {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(productsCarouselHTML);
    return;
  }

  if (req.method === "GET" && url.pathname === "/product-detail.html") {
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(productDetailHTML);
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(
    `MCP server listening on http://localhost:${port}${MCP_PATH}`
  );
});
