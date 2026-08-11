import { searchPlaces } from "../services/places.js";
import { searchPaidDemand } from "../services/paidDemand.js";
import { searchRemotive } from "../services/remotive.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

function chunkText(t) {
  t = (t || "").toString();
  const out = [];

  for (let i = 0; i < t.length; i += 1900) {
    out.push({
      type: "text",
      text: {
        content: t.slice(i, i + 1900)
      }
    });
  }

  return out.length
    ? out
    : [
        {
          type: "text",
          text: {
            content: ""
          }
        }
      ];
}

// ============================================================
// SHOPIFY — autenticazione client_credentials (negozi Primavera '26)
// ============================================================

const SHOPIFY_API_VERSION = "2026-07";

let _shopifyTokenCache = {
  token: null,
  exp: 0
};

async function getShopifyToken() {
  if (
    _shopifyTokenCache.token &&
    Date.now() < _shopifyTokenCache.exp
  ) {
    return _shopifyTokenCache.token;
  }

  const store = process.env.SHOPIFY_STORE;
  const key = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!store || !key || !secret) {
    throw new Error(
      "SHOPIFY_STORE / SHOPIFY_API_KEY / SHOPIFY_API_SECRET mancanti"
    );
  }

  const r = await fetch(
    `https://${store}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        client_id: key,
        client_secret: secret,
        grant_type: "client_credentials"
      })
    }
  );

  if (!r.ok) {
    const t = await r.text();

    throw new Error(
      `Shopify token error ${r.status}: ${t}`
    );
  }

  const data = await r.json();

  const token = data.access_token;

  const ttl =
    (data.expires_in
      ? data.expires_in
      : 86400) * 1000;

  _shopifyTokenCache = {
    token,
    exp:
      Date.now() +
      ttl -
      5 * 60 * 1000
  };

  return token;
}

async function shopifyFetch(
  path,
  options = {}
) {
  const store =
    process.env.SHOPIFY_STORE;

  const token =
    await getShopifyToken();

  const url =
    `https://${store}.myshopify.com/admin/api/` +
    `${SHOPIFY_API_VERSION}${path}`;

  const r = await fetch(
    url,
    {
      ...options,

      headers: {
        "X-Shopify-Access-Token":
          token,

        "Content-Type":
          "application/json",

        ...(options.headers || {})
      }
    }
  );

  const text =
    await r.text();

  let json;

  try {
    json =
      JSON.parse(text);
  } catch {
    json = text;
  }

  if (!r.ok) {
    throw new Error(
      `Shopify API ${r.status}: ${text}`
    );
  }

  return json;
}


// ============================================================
// HELIOS COMMERCE CORE v2
// Unico motore commerciale CORTEX per Shopify + Etsy.
// La logica resta in api/chat.js come richiesto.
// ============================================================

const HELIOS_VERSION = "2.8.4";
const HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS = 3;
const HELIOS_MIN_VISIBLE_MARGIN_PCT = 15;
const HELIOS_COLLECTIVE_TAG = "Shopify Collective";
const HELIOS_DEFAULT_INITIAL_CAPITAL = 5;
const HELIOS_AUTO_REINVEST_MAX_PCT = 20;
const HELIOS_THEME_API_VERSION = "2025-10";

const HELIOS_COLLECTIVE_VISION_SCHEMA = {
  name: "helios_collective_vision",
  strict: true,
  schema: {
    type: "object",
    properties: {
      coverage: { type: "string", enum: ["GOOD", "MIXED", "POOR", "EMPTY"] },
      confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
      candidates: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", minimum: 0 },
            title: { type: "string" },
            supplier: { type: "string" },
            price: { type: ["number", "null"] },
            marginPct: { type: ["number", "null"] },
            instantImport: { type: ["boolean", "null"] },
            fit: { type: "number", minimum: 0, maximum: 100 },
            risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "BLOCKED"] },
            why: { type: "string" }
          },
          required: [
            "index",
            "title",
            "supplier",
            "price",
            "marginPct",
            "instantImport",
            "fit",
            "risk",
            "why"
          ],
          additionalProperties: false
        }
      },
      recommendedIndex: { type: ["integer", "null"], minimum: 0 },
      reason: { type: "string" }
    },
    required: ["coverage", "confidence", "candidates", "recommendedIndex", "reason"],
    additionalProperties: false
  }
};

function heliosIsCollectiveProduct(product) {
  return (product?.tags || []).some(
    (tag) =>
      String(tag || "")
        .trim()
        .toLowerCase() ===
      HELIOS_COLLECTIVE_TAG.toLowerCase()
  );
}

function heliosNow() {
  return new Date().toISOString();
}

function heliosId(prefix = "H") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function heliosClamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function heliosRound(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function heliosSlug(value) {
  return (value || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function heliosSafeJson(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === "object") return raw;

  const text = String(raw).trim();
  const attempts = [
    text,
    text
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim()
  ];

  // Some multimodal/router models return a valid JSON object surrounded by
  // a short sentence or markdown. Extract the first balanced JSON object
  // without trying to repair invented/malformed fields.
  const source = attempts[1];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        attempts.push(source.slice(start, i + 1));
        break;
      }
    }
  }

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return fallback;
}

function heliosSelectedStores(body) {
  const raw = Array.isArray(body?.stores)
    ? body.stores
    : Array.isArray(body?.selectedStores)
    ? body.selectedStores
    : body?.store
    ? [body.store]
    : [];

  return [...new Set(raw.map((x) => String(x || "").trim().toUpperCase()))]
    .filter((x) => ["SHOPIFY", "ETSY"].includes(x));
}

function heliosActionCard({
  severity = "INFO",
  title = "HELIOS",
  message = "",
  reason = null,
  missionId = null,
  state = null,
  completed = [],
  pending = [],
  actions = [],
  context = null,
  details = null
} = {}) {
  return {
    type: "HELIOS_ACTION_CARD",
    severity,
    title,
    message,
    reason,
    missionId,
    state,
    completed,
    pending,
    actions,
    ...(context ? { context } : {}),
    ...(details ? { details } : {})
  };
}

function heliosShopifyAdminUrl(path = "") {
  const store = (process.env.SHOPIFY_STORE || "").trim();
  const base = store
    ? `https://admin.shopify.com/store/${store}`
    : "https://admin.shopify.com";
  return path ? `${base}/${String(path).replace(/^\/+/, "")}` : base;
}

function heliosCollectiveUrl(path = "") {
  const base = heliosShopifyAdminUrl("apps/merchant-to-merchant");
  return path ? `${base}/${String(path).replace(/^\/+/, "")}` : base;
}


function heliosUniqueStrings(values, limit = 20) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  ].slice(0, limit);
}

function heliosCollectiveSearchPlan(opportunity = {}, attempt = 0) {
  const raw =
    opportunity?.collectiveSearch &&
    typeof opportunity.collectiveSearch === "object"
      ? opportunity.collectiveSearch
      : {};

  const name = String(opportunity?.name || "trending product").trim();
  const low = `${name} ${opportunity?.category || ""} ${raw.query || ""}`.toLowerCase();

  // Shopify Collective Discovery is a keyword search, not an AI semantic search.
  // HELIOS therefore puts short, concrete, retailer-localized queries first.
  let localized = [];
  if (/cloth|microfiber|microfibre|cleaning cloth|panno|towel/.test(low)) {
    localized = ["panno microfibra", "panno pulizia", "panno bambu", "cleaning cloth"];
  } else if (/sponge|spugna/.test(low)) {
    localized = ["spugna pulizia", "spugna cucina", "spugna cellulosa", "cleaning sponge"];
  } else if (/surface cleaner|household cleaner|multi.?surface|deterg|pulizia|home care/.test(low)) {
    localized = ["detergente superfici", "detergente multiuso", "pulizia superfici", "surface cleaner"];
  } else if (/storage|organizer|organiser|salvaspazio|cassetti/.test(low)) {
    localized = ["organizer casa", "organizer cassetti", "contenitore salvaspazio", "storage organizer"];
  } else if (/travel|viaggio|packing/.test(low)) {
    localized = ["organizer viaggio", "accessori viaggio", "packing cubes", "travel organizer"];
  } else if (/pet|dog|cat|cane|gatto/.test(low)) {
    localized = ["accessori cane", "accessori gatto", "pet accessories", "dog accessories"];
  } else if (/bottle|borraccia|water bottle/.test(low)) {
    localized = ["borraccia riutilizzabile", "borraccia termica", "water bottle", "reusable bottle"];
  } else if (/lamp|light|lighting|lampada/.test(low)) {
    localized = ["lampada led", "luce led casa", "led lamp", "ambient light"];
  }

  const rawQueries = heliosUniqueStrings(
    [
      ...(Array.isArray(raw.localQueries) ? raw.localQueries : []),
      ...localized,
      raw.query,
      ...(Array.isArray(raw.alternatives) ? raw.alternatives : []),
      ...(Array.isArray(opportunity?.searchTerms) ? opportunity.searchTerms : []),
      name
    ],
    20
  );

  const queries = rawQueries.length ? rawQueries : [name];
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const boundedAttempt = Math.min(safeAttempt, HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS - 1);
  const activeQuery =
    queries[Math.min(boundedAttempt, queries.length - 1)] ||
    queries[0] ||
    name;

  const category = String(
    raw.category || opportunity?.category || opportunity?.market || "General"
  ).trim();

  const include = heliosUniqueStrings(
    [
      ...(Array.isArray(raw.include) ? raw.include : []),
      ...(Array.isArray(raw.includeTerms) ? raw.includeTerms : [])
    ],
    16
  );

  const exclude = heliosUniqueStrings(
    [
      ...(Array.isArray(raw.exclude) ? raw.exclude : []),
      ...(Array.isArray(raw.excludeTerms) ? raw.excludeTerms : [])
    ],
    20
  );

  return {
    query: activeQuery,
    primaryQuery: queries[0] || activeQuery,
    alternatives: queries.slice(1, HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS),
    allQueries: queries.slice(0, HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS),
    attempt: safeAttempt,
    attemptNumber: boundedAttempt + 1,
    maxAttempts: HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS,
    category,
    include,
    exclude,
    filters: {
      instantImport: true,
      importMode: "MANUAL",
      productState: "DRAFT",
      publish: false
    }
  };
}

function heliosOpportunityIntelligence(opportunity = {}, attempt = 0) {
  const collectiveSearch = heliosCollectiveSearchPlan(opportunity, attempt);

  return {
    name: opportunity?.name || "Opportunity",
    rank: opportunity?.rank ?? null,
    score: opportunity?.heliosScore ?? null,
    currentDemand: opportunity?.currentDemand ?? null,
    growthPotential: opportunity?.growthPotential ?? null,
    breakoutConfidence: opportunity?.breakoutConfidence ?? null,
    marketSaturation: opportunity?.marketSaturation ?? null,
    competition: opportunity?.competition || null,
    verdict: opportunity?.verdict || null,
    risk: opportunity?.risk || null,
    market: opportunity?.market || "Global",
    language: opportunity?.language || "English",
    whyNow: opportunity?.whyNow || "",
    evidence: Array.isArray(opportunity?.evidence)
      ? opportunity.evidence.slice(0, 8)
      : [],
    collectiveSearch
  };
}

function heliosCollectiveWaitingCard({
  mission,
  opportunity,
  title = "SHOPIFY COLLECTIVE IMPORT REQUIRED",
  message = "",
  reason = "SHOPIFY_COLLECTIVE_CONNECTION_UI_REQUIRED",
  attempt = 0,
  completed = ["GLOBAL MARKET SCAN", "OPPORTUNITY RANKING"],
  pending = ["COLLECTIVE IMPORT", "PRODUCT MATCH", "QUALITY GATE", "PUBLISH"]
} = {}) {
  const intelligence = heliosOpportunityIntelligence(opportunity || {}, attempt);
  const plan = intelligence.collectiveSearch;

  const defaultMessage =
    `HELIOS ha scelto “${intelligence.name}”. ` +
    `In Shopify Collective cerca “${plan.query}” (tentativo ${plan.attemptNumber}/${plan.maxAttempts}), usa Instant Import e la categoria indicata quando disponibile. ` +
    `NON scegliere tu il prodotto: invia uno screenshot dei risultati nella chat HELIOS. HELIOS confronterà tutti i prodotti visibili e ti dirà esattamente quale importare.`;

  return heliosActionCard({
    severity: "ACTION_REQUIRED",
    title,
    message: message || defaultMessage,
    reason,
    missionId: mission?.id || null,
    state: "WAITING",
    completed,
    pending,
    context: {
      opportunity: intelligence,
      collectiveSearch: plan
    },
    details: {
      category: plan.category,
      include: plan.include,
      exclude: plan.exclude,
      exactSearch: plan.query,
      searchAttempt: plan.attemptNumber,
      maxSearchAttempts: plan.maxAttempts
    },
    actions: [
      {
        id: "COPY_SEARCH",
        label: "COPY SEARCH",
        type: "LOCAL",
        value: plan.query
      },
      {
        id: "OPEN_COLLECTIVE",
        label: "OPEN COLLECTIVE",
        type: "LINK",
        url: heliosCollectiveUrl()
      },
      {
        id: "ANALYZE_COLLECTIVE_RESULTS",
        label: "ANALYZE RESULTS",
        type: "LOCAL"
      },
      {
        id: "NEXT_SEARCH",
        label: "NEXT SEARCH",
        type: "BACKEND"
      },
      {
        id: "NEXT_OPPORTUNITY",
        label: "NEXT OPPORTUNITY",
        type: "BACKEND"
      },
      {
        id: "VIEW_OPPORTUNITY",
        label: "VIEW OPPORTUNITY",
        type: "LOCAL"
      },
      {
        id: "CHECK_IMPORT_RESUME",
        label: "CHECK IMPORT & RESUME",
        type: "LOCAL"
      }
    ]
  });
}

async function shopifyGraphQL(query, variables = {}, version = SHOPIFY_API_VERSION) {
  const store = process.env.SHOPIFY_STORE;
  const token = await getShopifyToken();

  if (!store) {
    throw new Error("SHOPIFY_STORE mancante");
  }

  const r = await fetch(
    `https://${store}.myshopify.com/admin/api/${version}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const payload = await r.json().catch(() => null);

  if (!r.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${r.status}: ${
        payload?.errors?.[0]?.message || JSON.stringify(payload || {})
      }`
    );
  }

  if (Array.isArray(payload?.errors) && payload.errors.length) {
    const msg = payload.errors.map((e) => e.message).filter(Boolean).join(" | ");
    const err = new Error(`Shopify GraphQL: ${msg}`);
    err.graphqlErrors = payload.errors;
    throw err;
  }

  return payload?.data || {};
}

async function heliosShopifyScopes() {
  const q = `
    query HeliosScopes {
      currentAppInstallation {
        accessScopes { handle }
      }
    }
  `;

  const d = await shopifyGraphQL(q);
  return (d?.currentAppInstallation?.accessScopes || [])
    .map((x) => x?.handle)
    .filter(Boolean);
}

async function heliosShopifyPaymentsStatus() {
  const scopes = await heliosShopifyScopes().catch(() => []);
  const canRead = scopes.includes("read_shopify_payments") ||
    scopes.includes("read_shopify_payments_accounts");

  if (!canRead) {
    return {
      status: "UNKNOWN_SCOPE_REQUIRED",
      activated: null,
      bankAccounts: [],
      balances: [],
      requiredScopes: ["read_shopify_payments_accounts"]
    };
  }

  try {
    const d = await shopifyGraphQL(`
      query HeliosPayments {
        shopifyPaymentsAccount {
          activated
          defaultCurrency
          country
          balance { amount currencyCode }
          bankAccounts(first: 10) {
            nodes {
              id
              bankName
              accountNumberLastDigits
              country
              currency
              status
            }
          }
        }
      }
    `);

    const a = d?.shopifyPaymentsAccount;
    if (!a) {
      return {
        status: "NOT_AVAILABLE",
        activated: false,
        bankAccounts: [],
        balances: []
      };
    }

    return {
      status: a.activated ? "ACTIVE" : "SETUP_REQUIRED",
      activated: Boolean(a.activated),
      currency: a.defaultCurrency || null,
      country: a.country || null,
      balances: (a.balance || []).map((x) => ({
        amount: Number(x.amount || 0),
        currency: x.currencyCode
      })),
      bankAccounts: (a.bankAccounts?.nodes || []).map((x) => ({
        id: x.id,
        bankName: x.bankName || null,
        last4: x.accountNumberLastDigits || null,
        country: x.country || null,
        currency: x.currency || null,
        status: x.status || null
      }))
    };
  } catch (error) {
    return {
      status: "UNKNOWN",
      activated: null,
      error: String(error?.message || error),
      bankAccounts: [],
      balances: []
    };
  }
}

async function heliosOnlineStorePublication() {
  const d = await shopifyGraphQL(`
    query HeliosPublications {
      publications(first: 50) {
        nodes {
          id
          name
          app { title }
          catalog { title }
        }
      }
    }
  `);

  const nodes = d?.publications?.nodes || [];
  return (
    nodes.find((p) => /online store|negozio online/i.test(`${p.name || ""} ${p.app?.title || ""} ${p.catalog?.title || ""}`)) ||
    null
  );
}

async function heliosMainTheme() {
  try {
    const d = await shopifyGraphQL(`
      query HeliosThemes {
        themes(first: 20, roles: [MAIN]) {
          nodes { id name role processing processingFailed }
        }
      }
    `, {}, HELIOS_THEME_API_VERSION);
    return d?.themes?.nodes?.[0] || null;
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

async function heliosCollectiveProducts({ limit = 100 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 100, 1), 250);

  const richQuery = `
    query HeliosCollectiveProducts($first: Int!) {
      products(first: $first, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          legacyResourceId
          title
          handle
          descriptionHtml
          vendor
          productType
          tags
          status
          totalInventory
          onlineStoreUrl
          createdAt
          updatedAt
          featuredMedia {
            ... on MediaImage {
              image { url altText width height }
            }
          }
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              title
              sku
              price
              compareAtPrice
              inventoryQuantity
              inventoryItem {
                id
                unitCost { amount currencyCode }
              }
            }
          }
        }
      }
    }
  `;

  const liteQuery = `
    query HeliosCollectiveProductsLite($first: Int!) {
      products(first: $first, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          legacyResourceId
          title
          handle
          descriptionHtml
          vendor
          productType
          tags
          status
          totalInventory
          onlineStoreUrl
          createdAt
          updatedAt
          featuredMedia {
            ... on MediaImage {
              image { url altText width height }
            }
          }
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              title
              sku
              price
              compareAtPrice
              inventoryQuantity
            }
          }
        }
      }
    }
  `;

  let nodes = [];
  let costReadable = true;

  try {
    const d = await shopifyGraphQL(richQuery, { first: max });
    nodes = d?.products?.nodes || [];
  } catch {
    costReadable = false;
    const d = await shopifyGraphQL(liteQuery, { first: max });
    nodes = d?.products?.nodes || [];
  }

  return nodes
    .filter((p) => (p.tags || []).some((t) => String(t).toLowerCase() === HELIOS_COLLECTIVE_TAG.toLowerCase()))
    .map((p) => {
      const variants = (p.variants?.nodes || []).map((v) => {
        const unitCost = v.inventoryItem?.unitCost
          ? Number(v.inventoryItem.unitCost.amount)
          : null;
        const retail = Number(v.price || 0);
        const marginEuro = unitCost != null ? retail - unitCost : null;
        const marginPct = unitCost != null && retail > 0
          ? ((retail - unitCost) / retail) * 100
          : null;
        return {
          id: v.id,
          legacyId: v.legacyResourceId || null,
          title: v.title,
          sku: v.sku || null,
          retailPrice: retail,
          compareAtPrice: v.compareAtPrice != null ? Number(v.compareAtPrice) : null,
          inventory: Number(v.inventoryQuantity || 0),
          supplierCost: unitCost,
          supplierCostCurrency: v.inventoryItem?.unitCost?.currencyCode || null,
          grossMarginEuro: marginEuro != null ? heliosRound(marginEuro) : null,
          grossMarginPct: marginPct != null ? heliosRound(marginPct, 1) : null
        };
      });

      const supplierTag = (p.tags || []).find((t) => String(t).toLowerCase() !== HELIOS_COLLECTIVE_TAG.toLowerCase()) || null;
      const image = p.featuredMedia?.image || null;

      return {
        id: p.id,
        legacyId: p.legacyResourceId || null,
        title: p.title,
        handle: p.handle,
        descriptionHtml: p.descriptionHtml || "",
        vendor: p.vendor || supplierTag || null,
        supplierTag,
        productType: p.productType || null,
        tags: p.tags || [],
        status: p.status,
        inventory: Number(p.totalInventory || 0),
        onlineStoreUrl: p.onlineStoreUrl || null,
        image: image
          ? {
              url: image.url,
              alt: image.altText || p.title,
              width: image.width || null,
              height: image.height || null
            }
          : null,
        variants,
        costReadable,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      };
    });
}

function heliosPhysicalScore(product, market = {}) {
  const v = product?.variants?.[0] || {};
  const parts = [];
  const retail = Number(v.retailPrice || 0);
  const cost = v.supplierCost != null ? Number(v.supplierCost) : null;
  const inventory = Number(product?.inventory || v.inventory || 0);
  const fit = heliosClamp(market?.fit ?? 50);
  const growth = heliosClamp(market?.growth ?? market?.growthPotential ?? 50);
  const breakout = heliosClamp(market?.breakout ?? market?.breakoutConfidence ?? 50);
  const demand = heliosClamp(market?.demand ?? market?.currentDemand ?? 50);
  const saturation = heliosClamp(market?.saturation ?? market?.marketSaturation ?? 50);

  // v2.8: il fit reale col prodotto pesa esplicitamente. Nelle versioni precedenti
  // un candidato scelto a 90-95/100 dalla Vision poteva essere bocciato perché
  // il punteggio commerciale ignorava completamente il fit e sovrappesava i
  // segnali di mercato stimati.
  parts.push({ key: "fit", weight: 30, value: fit });

  if (retail > 0 && cost != null) {
    const marginPct = ((retail - cost) / retail) * 100;
    parts.push({ key: "margin", weight: 20, value: heliosClamp((marginPct / 45) * 100) });
  }

  parts.push({ key: "inventory", weight: 10, value: heliosClamp((inventory / 80) * 100) });
  parts.push({ key: "demand", weight: 15, value: demand });
  parts.push({ key: "growth", weight: 10, value: growth });
  parts.push({ key: "breakout", weight: 5, value: breakout });
  parts.push({ key: "low_saturation", weight: 10, value: 100 - saturation });

  const totalWeight = parts.reduce((sum, x) => sum + x.weight, 0);
  const score = totalWeight
    ? parts.reduce((sum, x) => sum + x.value * x.weight, 0) / totalWeight
    : 0;

  const hardGates = {
    collectiveManaged: heliosIsCollectiveProduct(product),
    inventoryAvailable: inventory > 0,
    hasSellPrice: retail > 0,
    notArchived: product?.status !== "ARCHIVED",
    supplierLinked: Boolean(product?.vendor || product?.supplierTag)
  };

  const criticalPass = Object.values(hardGates).every(Boolean);
  const coverageSignals = [
    retail > 0,
    cost != null,
    inventory >= 0,
    market?.fit != null,
    market?.growth != null || market?.growthPotential != null,
    market?.demand != null || market?.currentDemand != null,
    market?.saturation != null || market?.marketSaturation != null
  ];
  const coverage = Math.round((coverageSignals.filter(Boolean).length / coverageSignals.length) * 100);

  return {
    heliosScore: Math.round(score),
    confidence: coverage >= 80 ? "HIGH" : coverage >= 55 ? "MEDIUM" : "LOW",
    coverage,
    fit,
    hardGates,
    criticalPass,
    economics: {
      retailPrice: retail || null,
      supplierCost: cost,
      shippingCost: null,
      shippingStatus: "COLLECTIVE_RATE_AT_CHECKOUT",
      grossMarginEuro: cost != null ? heliosRound(retail - cost) : null,
      grossMarginPct: cost != null && retail > 0 ? heliosRound(((retail - cost) / retail) * 100, 1) : null,
      note: "La spedizione Collective può dipendere dalla tariffa del fornitore e viene validata nel flusso checkout; se non esposta via API resta un dato a confidenza ridotta."
    },
    market: { demand, growth, breakout, saturation, fit }
  };
}

async function heliosWebSignal(query, { max = 6, deep = false } = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return { ok: false, error: "TAVILY_API_KEY mancante", query, results: [] };
  }

  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: deep ? "advanced" : "basic",
        max_results: Math.min(Math.max(max, 1), 10),
        include_answer: true
      })
    });
    const d = await r.json();
    if (!r.ok) {
      return { ok: false, error: d?.error || `Tavily HTTP ${r.status}`, query, results: [] };
    }
    return {
      ok: true,
      query,
      answer: d.answer || null,
      results: (d.results || []).map((x) => ({
        title: x.title || "",
        url: x.url || "",
        content: String(x.content || "").slice(0, 900),
        score: x.score || null
      }))
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), query, results: [] };
  }
}

async function heliosAIJson(
  prompt,
  { temperature = 0.15, maxTokens = 5000 } = {}
) {
  const diagnostics = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature,
                maxOutputTokens: maxTokens,
                responseMimeType: "application/json"
              }
            })
          }
        );

        const rawBody = await r.text();
        const d = heliosSafeJson(rawBody, {}) || {};

        if (r.ok) {
          const raw = (d?.candidates?.[0]?.content?.parts || [])
            .map((x) => x.text || "")
            .join("")
            .trim();
          const parsed = heliosSafeJson(raw);
          if (parsed) {
            return {
              ok: true,
              provider: "gemini",
              model: MODEL,
              data: parsed,
              diagnostics
            };
          }
          diagnostics.push({
            provider: "gemini",
            model: MODEL,
            status: r.status,
            error: raw ? "INVALID_JSON_OUTPUT" : "EMPTY_OUTPUT"
          });
        } else {
          diagnostics.push({
            provider: "gemini",
            model: MODEL,
            status: r.status,
            error: String(d?.error?.message || `HTTP ${r.status}`).slice(0, 500)
          });
        }

        if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
          await wait(700);
          continue;
        }
        break;
      } catch (error) {
        diagnostics.push({
          provider: "gemini",
          model: MODEL,
          status: null,
          error: String(error?.message || error).slice(0, 500)
        });
        if (attempt === 0) {
          await wait(500);
          continue;
        }
      }
    }
  } else {
    diagnostics.push({ provider: "gemini", configured: false, error: "GEMINI_API_KEY_MISSING" });
  }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    try {
      const orModel = process.env.OPENROUTER_MODEL || "openrouter/free";
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${orKey}`,
          "HTTP-Referer": process.env.CORTEX_PUBLIC_URL || "https://cortex.local",
          "X-Title": "CORTEX HELIOS"
        },
        body: JSON.stringify({
          model: orModel,
          messages: [
            {
              role: "system",
              content: "Return only one valid JSON object. Do not use markdown fences or prose outside JSON."
            },
            { role: "user", content: prompt }
          ],
          temperature,
          max_tokens: maxTokens,
          stream: false
        })
      });

      const rawBody = await r.text();
      const d = heliosSafeJson(rawBody, {}) || {};
      if (r.ok) {
        const raw = d?.choices?.[0]?.message?.content;
        const content = Array.isArray(raw)
          ? raw.map((x) => x?.text || x?.content || "").join("")
          : String(raw || "");
        const parsed = heliosSafeJson(content);
        if (parsed) {
          return {
            ok: true,
            provider: "openrouter",
            model: d?.model || orModel,
            data: parsed,
            diagnostics
          };
        }
        diagnostics.push({
          provider: "openrouter",
          model: d?.model || orModel,
          status: r.status,
          error: content ? "INVALID_JSON_OUTPUT" : "EMPTY_OUTPUT"
        });
      } else {
        diagnostics.push({
          provider: "openrouter",
          model: orModel,
          status: r.status,
          error: String(d?.error?.message || d?.message || `HTTP ${r.status}`).slice(0, 500)
        });
      }
    } catch (error) {
      diagnostics.push({
        provider: "openrouter",
        model: process.env.OPENROUTER_MODEL || "openrouter/free",
        status: null,
        error: String(error?.message || error).slice(0, 500)
      });
    }
  } else {
    diagnostics.push({ provider: "openrouter", configured: false, error: "OPENROUTER_API_KEY_MISSING" });
  }

  // Third provider: use Groq as a true HELIOS JSON fallback, mirroring the
  // main CORTEX router. JSON Object Mode prevents malformed structured output.
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const groqModel = process.env.GROQ_JSON_MODEL || "openai/gpt-oss-120b";
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [
            {
              role: "system",
              content: "Return exactly one valid JSON object and nothing else."
            },
            { role: "user", content: prompt }
          ],
          temperature,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          stream: false
        })
      });

      const rawBody = await r.text();
      const d = heliosSafeJson(rawBody, {}) || {};
      if (r.ok) {
        const raw = d?.choices?.[0]?.message?.content;
        const content = Array.isArray(raw)
          ? raw.map((x) => x?.text || x?.content || "").join("")
          : String(raw || "");
        const parsed = heliosSafeJson(content);
        if (parsed) {
          return {
            ok: true,
            provider: "groq",
            model: d?.model || groqModel,
            data: parsed,
            diagnostics
          };
        }
        diagnostics.push({
          provider: "groq",
          model: d?.model || groqModel,
          status: r.status,
          error: content ? "INVALID_JSON_OUTPUT" : "EMPTY_OUTPUT"
        });
      } else {
        diagnostics.push({
          provider: "groq",
          model: groqModel,
          status: r.status,
          error: String(d?.error?.message || d?.message || `HTTP ${r.status}`).slice(0, 500)
        });
      }
    } catch (error) {
      diagnostics.push({
        provider: "groq",
        model: process.env.GROQ_JSON_MODEL || "openai/gpt-oss-120b",
        status: null,
        error: String(error?.message || error).slice(0, 500)
      });
    }
  } else {
    diagnostics.push({ provider: "groq", configured: false, error: "GROQ_API_KEY_MISSING" });
  }

  const summary = diagnostics
    .map((x) => `${x.provider}:${x.status ?? "NA"}:${x.error || "UNKNOWN"}`)
    .join(" | ")
    .slice(0, 1400);

  return {
    ok: false,
    provider: null,
    error: `HELIOS JSON provider unavailable. ${summary}`,
    diagnostics
  };
}

async function heliosAIJsonWithImage(
  prompt,
  imageBase64,
  mediaType = "image/png",
  { temperature = 0.05, maxTokens = 4500 } = {}
) {
  const image = String(imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!image) {
    return { ok: false, provider: null, error: "Immagine Collective mancante" };
  }
  if (image.length > 7_000_000) {
    return { ok: false, provider: null, error: "Screenshot troppo grande: usa un'immagine sotto circa 5 MB." };
  }

  const diagnostics = [];
  const normalizedMediaType = mediaType || "image/png";
  const imageUrl = `data:${normalizedMediaType};base64,${image}`;
  const compactPrompt = String(prompt || "").slice(0, 16000);

  const parseOpenAICompatibleContent = (payload) => {
    const raw = payload?.choices?.[0]?.message?.content;
    const content = Array.isArray(raw)
      ? raw.map((x) => x?.text || x?.content || "").join("")
      : String(raw || "");
    return { content, parsed: heliosSafeJson(content) };
  };

  const pushDiagnostic = ({ provider, model, status = null, error, attempt = null }) => {
    diagnostics.push({
      provider,
      model: model || null,
      status,
      error: String(error || "UNKNOWN").slice(0, 500),
      ...(attempt ? { attempt } : {})
    });
  };

  // PROVIDER 1 — GEMINI VISION
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: compactPrompt },
                  {
                    inline_data: {
                      mime_type: normalizedMediaType,
                      data: image
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              temperature,
              maxOutputTokens: Math.min(maxTokens, 1600),
              responseMimeType: "application/json"
            }
          })
        }
      );
      const rawBody = await r.text();
      const d = heliosSafeJson(rawBody, {}) || {};
      if (r.ok) {
        const raw = (d?.candidates?.[0]?.content?.parts || [])
          .map((x) => x.text || "")
          .join("")
          .trim();
        const parsed = heliosSafeJson(raw);
        if (parsed) {
          return {
            ok: true,
            provider: "gemini",
            model: MODEL,
            data: parsed,
            diagnostics,
            fallbackUsed: false
          };
        }
        pushDiagnostic({
          provider: "gemini",
          model: MODEL,
          status: r.status,
          error: raw ? "INVALID_JSON_OUTPUT" : "EMPTY_OUTPUT"
        });
      } else {
        pushDiagnostic({
          provider: "gemini",
          model: MODEL,
          status: r.status,
          error: d?.error?.message || `HTTP ${r.status}`
        });
      }
    } catch (error) {
      pushDiagnostic({
        provider: "gemini",
        model: MODEL,
        error: error?.message || error
      });
    }
  } else {
    diagnostics.push({ provider: "gemini", configured: false, error: "GEMINI_API_KEY_MISSING" });
  }

  // PROVIDER 2 — OPENROUTER VISION
  // First try strict Structured Outputs. require_parameters prevents routing to
  // an endpoint that silently ignores json_schema.
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    const orVisionModel = process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || "openrouter/free";
    const baseMessages = [
      {
        role: "user",
        content: [
          { type: "text", text: compactPrompt },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }
    ];

    const openRouterAttempts = [
      {
        name: "structured",
        extra: {
          response_format: {
            type: "json_schema",
            json_schema: HELIOS_COLLECTIVE_VISION_SCHEMA
          },
          provider: { require_parameters: true }
        }
      },
      {
        name: "json_object",
        extra: {
          response_format: { type: "json_object" }
        }
      },
      {
        name: "parser_fallback",
        extra: {}
      }
    ];

    for (const attempt of openRouterAttempts) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${orKey}`,
            "HTTP-Referer": process.env.CORTEX_PUBLIC_URL || "https://cortex.local",
            "X-Title": "CORTEX HELIOS Collective Vision"
          },
          body: JSON.stringify({
            model: orVisionModel,
            messages: baseMessages,
            temperature,
            max_tokens: Math.min(maxTokens, 1400),
            stream: false,
            ...attempt.extra
          })
        });
        const rawBody = await r.text();
        const d = heliosSafeJson(rawBody, {}) || {};
        if (r.ok) {
          const { content, parsed } = parseOpenAICompatibleContent(d);
          if (parsed) {
            return {
              ok: true,
              provider: "openrouter",
              model: d?.model || orVisionModel,
              data: parsed,
              diagnostics,
              fallbackUsed: true,
              providerAttempt: attempt.name
            };
          }
          pushDiagnostic({
            provider: "openrouter",
            model: d?.model || orVisionModel,
            status: r.status,
            error: content ? "INVALID_JSON_OUTPUT" : "EMPTY_OUTPUT",
            attempt: attempt.name
          });
        } else {
          pushDiagnostic({
            provider: "openrouter",
            model: orVisionModel,
            status: r.status,
            error: d?.error?.message || d?.message || `HTTP ${r.status}`,
            attempt: attempt.name
          });
        }
      } catch (error) {
        pushDiagnostic({
          provider: "openrouter",
          model: orVisionModel,
          error: error?.message || error,
          attempt: attempt.name
        });
      }
    }
  } else {
    diagnostics.push({ provider: "openrouter", configured: false, error: "OPENROUTER_API_KEY_MISSING" });
  }

  // PROVIDER 3 — GROQ VISION (Qwen 3.6 27B)
  // Qwen supports image input + JSON Object Mode. reasoning_effort:none keeps
  // the multimodal request compact. If JSON mode itself triggers failed_generation,
  // retry once without response_format and parse the first valid JSON object locally.
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    const groqVisionModel = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
    const groqMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${compactPrompt}\nReturn exactly one valid JSON object. Do not add markdown or commentary.`
          },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }
    ];

    const groqAttempts = [
      { name: "json_object", responseFormat: { type: "json_object" } },
      { name: "parser_fallback", responseFormat: null }
    ];

    for (const attempt of groqAttempts) {
      try {
        const payload = {
          model: groqVisionModel,
          messages: groqMessages,
          temperature,
          max_completion_tokens: Math.min(maxTokens, 1200),
          reasoning_effort: "none",
          stream: false
        };
        if (attempt.responseFormat) payload.response_format = attempt.responseFormat;

        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${groqKey}`
          },
          body: JSON.stringify(payload)
        });
        const rawBody = await r.text();
        const d = heliosSafeJson(rawBody, {}) || {};
        if (r.ok) {
          const { content, parsed } = parseOpenAICompatibleContent(d);
          if (parsed) {
            return {
              ok: true,
              provider: "groq",
              model: d?.model || groqVisionModel,
              data: parsed,
              diagnostics,
              fallbackUsed: true,
              providerAttempt: attempt.name
            };
          }
          pushDiagnostic({
            provider: "groq",
            model: d?.model || groqVisionModel,
            status: r.status,
            error: content ? "INVALID_JSON_OUTPUT" : "EMPTY_OUTPUT",
            attempt: attempt.name
          });
        } else {
          pushDiagnostic({
            provider: "groq",
            model: groqVisionModel,
            status: r.status,
            error: d?.error?.message || d?.message || `HTTP ${r.status}`,
            attempt: attempt.name
          });
        }
      } catch (error) {
        pushDiagnostic({
          provider: "groq",
          model: groqVisionModel,
          error: error?.message || error,
          attempt: attempt.name
        });
      }
    }
  } else {
    diagnostics.push({ provider: "groq", configured: false, error: "GROQ_API_KEY_MISSING" });
  }

  const summary = diagnostics
    .map((x) => `${x.provider}${x.attempt ? `/${x.attempt}` : ""}:${x.status ?? "NA"}:${x.error || "UNKNOWN"}`)
    .join(" | ")
    .slice(0, 1800);

  return {
    ok: false,
    provider: null,
    error: `HELIOS vision provider unavailable. ${summary}`,
    diagnostics
  };
}

function heliosMissionOpportunityList(mission) {
  return (Array.isArray(mission?.marketScan?.opportunities)
    ? mission.marketScan.opportunities
    : [])
    .filter(
      (o) =>
        Array.isArray(o?.channelFit) &&
        o.channelFit.includes("SHOPIFY") &&
        o.risk !== "BLOCKED" &&
        o.verdict !== "REJECT"
    );
}

function heliosOpportunityKey(opportunity) {
  return String(opportunity?.name || "")
    .trim()
    .toLowerCase();
}

function heliosOpportunityFamily(opportunity) {
  const text = `${opportunity?.name || ""} ${opportunity?.category || ""} ${opportunity?.market || ""}`
    .toLowerCase();
  if (/clean|deterg|pulizi|spugn|microfibr|laundry|lavagg|household cleaner|surface cleaner/.test(text)) return "CLEANING";
  if (/beauty|cosmetic|skin|hair|makeup|profum|shampoo|conditioner/.test(text)) return "BEAUTY";
  if (/pet|dog|cat|animali|cane|gatto/.test(text)) return "PET";
  if (/travel|viagg|luggage|bag|organizer|packing/.test(text)) return "TRAVEL";
  if (/kitchen|cucina|food storage|bottle|utensil|cook/.test(text)) return "KITCHEN";
  if (/tech|electronic|charger|cable|phone|computer|smart/.test(text)) return "TECH";
  if (/fitness|sport|wellness|yoga|recovery/.test(text)) return "FITNESS_WELLNESS";
  if (/home|casa|decor|storage|organizer|lighting/.test(text)) return "HOME";
  if (/accessor|wallet|jewel|watch|fashion|apparel|shoe/.test(text)) return "ACCESSORIES";
  if (/hobby|craft|garden|outdoor|camp/.test(text)) return "HOBBY_OUTDOOR";
  return String(opportunity?.category || opportunity?.name || "OTHER")
    .trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 48) || "OTHER";
}

function heliosNormalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function heliosRecommendationMatchScore(product, recommendation) {
  if (!product || !recommendation) return 0;
  const pTitle = heliosNormalizeMatchText(product.title);
  const rTitle = heliosNormalizeMatchText(recommendation.title);
  const pSupplier = heliosNormalizeMatchText(product.vendor || product.supplierTag);
  const rSupplier = heliosNormalizeMatchText(recommendation.supplier);
  const rTokens = new Set(rTitle.split(/\s+/).filter((x) => x.length >= 3));
  const pTokens = new Set(pTitle.split(/\s+/).filter((x) => x.length >= 3));
  const overlap = [...rTokens].filter((x) => pTokens.has(x)).length;
  const titleCoverage = rTokens.size ? overlap / rTokens.size : 0;
  let score = titleCoverage * 75;
  if (pTitle && rTitle && (pTitle.includes(rTitle) || rTitle.includes(pTitle))) score = Math.max(score, 88);
  if (rSupplier && pSupplier && (pSupplier.includes(rSupplier) || rSupplier.includes(pSupplier))) score += 20;
  const recPrice = Number(recommendation.price);
  const actualPrice = Number(product?.variants?.[0]?.retailPrice);
  if (Number.isFinite(recPrice) && recPrice > 0 && Number.isFinite(actualPrice) && Math.abs(actualPrice - recPrice) <= Math.max(0.5, recPrice * 0.08)) score += 5;
  return heliosClamp(score);
}

function heliosFindExpectedImportedProduct(products, recommendation) {
  if (!recommendation || !Array.isArray(products) || !products.length) return null;
  const ranked = products
    .map((product) => ({ product, score: heliosRecommendationMatchScore(product, recommendation) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 58 ? ranked[0] : null;
}

function heliosAdvanceOpportunity(
  incomingMission,
  { reason = "COLLECTIVE_COVERAGE_FAILED" } = {}
) {
  const mission = JSON.parse(JSON.stringify(incomingMission || {}));
  mission.pipelines = mission.pipelines || {};
  const shopPipe = mission.pipelines.SHOPIFY || {};
  mission.pipelines.SHOPIFY = shopPipe;

  const current = shopPipe.opportunity || null;
  const currentKey = heliosOpportunityKey(current);
  const rejected = new Set(
    (Array.isArray(shopPipe.rejectedOpportunityKeys)
      ? shopPipe.rejectedOpportunityKeys
      : [])
      .map(String)
      .filter(Boolean)
  );
  if (currentKey) rejected.add(currentKey);
  shopPipe.rejectedOpportunityKeys = [...rejected];
  const cooldownFamilies = new Set(
    (Array.isArray(mission.marketCooldownFamilies) ? mission.marketCooldownFamilies : [])
      .map((x) => String(x || "").toUpperCase())
  );
  if (current) cooldownFamilies.add(heliosOpportunityFamily(current));
  mission.marketCooldownFamilies = [...cooldownFamilies];

  const candidates = heliosMissionOpportunityList(mission);
  const next = candidates.find((o) => !rejected.has(heliosOpportunityKey(o))) || null;

  if (!next) {
    mission.status = "WAITING";
    mission.checkpoint = "MARKET_RESCAN_REQUIRED";
    mission.updatedAt = heliosNow();
    mission.decisionRequired = {
      type: "OWNER_ACTION",
      store: "SHOPIFY",
      reason: "Le opportunità disponibili non hanno trovato copertura sufficiente in Collective."
    };

    shopPipe.status = "WAITING";
    shopPipe.step = "MARKET_RESCAN_REQUIRED";
    shopPipe.reason = reason;

    return {
      ok: true,
      mission,
      rotated: false,
      exhausted: true,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "COLLECTIVE COVERAGE EXHAUSTED",
        message:
          "HELIOS ha esaurito le opportunità Shopify valide della scansione corrente senza trovare copertura Collective sufficiente. Avvia una nuova scansione mercato: non devi scegliere manualmente una nicchia.",
        reason: "MARKET_RESCAN_REQUIRED",
        missionId: mission.id,
        state: "WAITING",
        actions: [
          { id: "RETRY_SCAN", label: "NEW MARKET SCAN", type: "BACKEND" },
          { id: "STOP", label: "TERMINA", type: "BACKEND" }
        ]
      })
    };
  }

  const previousName = current?.name || null;
  shopPipe.opportunity = next;
  shopPipe.collectiveSearchAttempt = 0;
  shopPipe.autoCandidateRetries = 0;
  shopPipe.candidateCount = 0;
  shopPipe.status = "WAITING";
  shopPipe.step = "WAITING_FOR_COLLECTIVE";
  shopPipe.progress = 34;
  shopPipe.reason = "NEW_OPPORTUNITY_SELECTED";
  delete shopPipe.product;
  delete shopPipe.match;
  delete shopPipe.score;
  delete shopPipe.optimization;
  delete shopPipe.qualityGate;
  delete shopPipe.matchDiagnostics;
  delete shopPipe.expectedImport;
  delete shopPipe.expectedImportDetected;
  delete shopPipe.recommendedCollectiveCandidate;

  mission.status = "WAITING";
  mission.checkpoint = "WAITING_FOR_COLLECTIVE";
  mission.progress = Math.max(28, Math.min(42, Number(mission.progress || 28)));
  mission.updatedAt = heliosNow();
  mission.decisionRequired = {
    type: "OWNER_ACTION",
    store: "SHOPIFY",
    reason:
      "Shopify Collective richiede l'apertura della sua UI per visualizzare i risultati Discovery. HELIOS sceglierà il prodotto dopo lo screenshot."
  };
  mission.events = [
    ...(Array.isArray(mission.events) ? mission.events : []),
    {
      at: heliosNow(),
      type: "OPPORTUNITY_ROTATED",
      from: previousName,
      to: next.name || null,
      reason
    }
  ];

  return {
    ok: true,
    mission,
    rotated: true,
    exhausted: false,
    opportunity: heliosOpportunityIntelligence(next, 0),
    actionCard: heliosCollectiveWaitingCard({
      mission,
      opportunity: next,
      attempt: 0,
      title: "NEXT OPPORTUNITY SELECTED",
      message:
        `HELIOS ha scartato “${previousName || "l'opportunità precedente"}” per copertura Collective insufficiente e ha scelto autonomamente “${next.name || "la prossima opportunità"}”. ` +
        `Apri Collective con la query indicata e invia uno screenshot dei risultati: HELIOS selezionerà il prodotto da importare.`,
      reason: "NEXT_OPPORTUNITY_SELECTED"
    })
  };
}

function heliosMissionNextSearch(incomingMission, reason = "COLLECTIVE_RESULTS_WEAK") {
  const mission = JSON.parse(JSON.stringify(incomingMission || {}));
  const shopPipe = mission?.pipelines?.SHOPIFY;
  if (!shopPipe?.opportunity) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "OPPORTUNITY REQUIRED",
        message: "HELIOS non può generare la ricerca successiva senza un'opportunità Shopify attiva.",
        reason: "MISSION_OPPORTUNITY_MISSING",
        missionId: mission?.id || null
      })
    };
  }

  const nextAttempt = Number(shopPipe.collectiveSearchAttempt || 0) + 1;
  if (nextAttempt >= HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS) {
    return heliosAdvanceOpportunity(mission, { reason: "COLLECTIVE_SEARCH_LIMIT_REACHED" });
  }

  shopPipe.collectiveSearchAttempt = nextAttempt;
  shopPipe.status = "WAITING";
  shopPipe.step = "WAITING_FOR_COLLECTIVE";
  shopPipe.reason = reason;
  mission.status = "WAITING";
  mission.checkpoint = "WAITING_FOR_COLLECTIVE";
  mission.updatedAt = heliosNow();

  const plan = heliosCollectiveSearchPlan(shopPipe.opportunity, nextAttempt);
  mission.events = [
    ...(Array.isArray(mission.events) ? mission.events : []),
    {
      at: heliosNow(),
      type: "COLLECTIVE_SEARCH_ADVANCED",
      attempt: nextAttempt,
      query: plan.query,
      reason
    }
  ];

  return {
    ok: true,
    mission,
    searchAdvanced: true,
    opportunity: heliosOpportunityIntelligence(shopPipe.opportunity, nextAttempt),
    actionCard: heliosCollectiveWaitingCard({
      mission,
      opportunity: shopPipe.opportunity,
      attempt: nextAttempt,
      title: "NEXT COLLECTIVE SEARCH",
      message:
        `HELIOS ha scartato i risultati precedenti e passa automaticamente al tentativo ${plan.attemptNumber}/${plan.maxAttempts}. ` +
        `Cerca “${plan.query}”, applica Instant Import e invia lo screenshot dei risultati. Non scegliere tu il prodotto.`,
      reason
    })
  };
}

async function heliosAnalyzeCollectiveResultsScreenshot(body = {}) {
  const incoming = body.mission || null;
  if (!incoming?.id) {
    return { ok: false, error: "mission mancante" };
  }

  const mission = JSON.parse(JSON.stringify(incoming));
  const shopPipe = mission?.pipelines?.SHOPIFY;
  const opportunity =
    shopPipe?.opportunity ||
    mission?.marketScan?.opportunities?.find?.(
      (o) => Array.isArray(o?.channelFit) && o.channelFit.includes("SHOPIFY")
    ) ||
    null;

  if (!shopPipe || !opportunity) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "SHOPIFY OPPORTUNITY REQUIRED",
        message: "Non c'è una missione Shopify con opportunità attiva da confrontare con lo screenshot.",
        reason: "MISSION_OPPORTUNITY_MISSING",
        missionId: mission.id
      })
    };
  }

  const attempt = Number(shopPipe.collectiveSearchAttempt || 0);
  const plan = heliosCollectiveSearchPlan(opportunity, attempt);
  const prompt = `
Sei HELIOS Collective Vision.

Stai guardando UNO SCREENSHOT REALE della pagina Shopify Collective Discovery del proprietario.
Devi scegliere tu quale prodotto il proprietario deve importare. Il proprietario NON deve fare valutazioni commerciali.

OPPORTUNITA CORRENTE:
${JSON.stringify(heliosOpportunityIntelligence(opportunity, attempt))}

PIANO DI RICERCA ATTIVO:
${JSON.stringify(plan)}

REGOLE:
- Analizza solo prodotti realmente VISIBILI nello screenshot. Non inventare prodotti, prezzi, margini, fornitori o disponibilità.
- Trascrivi il titolo esattamente per quanto leggibile.
- Valuta coerenza semantica con l'opportunità, margine visibile, prezzo, Instant Import e rischi evidenti.
- Un prodotto con keyword simili ma categoria sbagliata deve essere rifiutato.
- Se il requisito eco/biodegradabile/reusable non è dimostrabile dal titolo/packaging visibile, non inventarlo: abbassa confidence e fit.
- Preferisci Instant Import quando visibile.
- Non scegliere un prodotto con fit < 65.
- Se il margine percentuale è VISIBILE e inferiore al ${HELIOS_MIN_VISIBLE_MARGIN_PCT}%, NON scegliere quel prodotto, anche se il fit è alto.
- Se il margine non è visibile, non inventarlo: puoi ancora valutare il prodotto, ma abbassa confidence.
- Se nessun prodotto supera insieme coerenza, rischio e margine minimo visibile, recommendedIndex deve essere null.
- Restituisci SOLO JSON.

FORMATO:
{
  "coverage":"GOOD|MIXED|POOR|EMPTY",
  "confidence":"HIGH|MEDIUM|LOW",
  "candidates":[
    {
      "index":0,
      "title":"",
      "supplier":"",
      "price":null,
      "marginPct":null,
      "instantImport":null,
      "fit":0,
      "risk":"LOW|MEDIUM|HIGH|BLOCKED",
      "why":""
    }
  ],
  "recommendedIndex":null,
  "reason":""
}
`;

  const ai = await heliosAIJsonWithImage(
    prompt,
    body.imageBase64 || body.image || "",
    body.mediaType || body.mime || "image/png",
    { temperature: 0.02, maxTokens: 1200 }
  );

  if (!ai.ok) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "COLLECTIVE SCREENSHOT ANALYSIS PAUSED",
        message: "HELIOS non è riuscito ad analizzare lo screenshot. Nessun prodotto è stato selezionato o pubblicato.",
        reason: ai.error,
        missionId: mission.id,
        details: {
          providerChain: ["gemini", "openrouter", "groq"],
          diagnostics: ai.diagnostics || []
        },
        actions: [
          { id: "ANALYZE_COLLECTIVE_RESULTS", label: "RETRY SCREENSHOT", type: "LOCAL" },
          { id: "NEXT_SEARCH", label: "NEXT SEARCH", type: "BACKEND" }
        ]
      })
    };
  }

  const raw = ai.data || {};
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .map((c, i) => ({
      index: Number.isFinite(Number(c.index)) ? Number(c.index) : i,
      title: String(c.title || "").slice(0, 220),
      supplier: String(c.supplier || "").slice(0, 160),
      price: Number.isFinite(Number(c.price)) ? Number(c.price) : null,
      marginPct: Number.isFinite(Number(c.marginPct)) ? Number(c.marginPct) : null,
      instantImport:
        typeof c.instantImport === "boolean" ? c.instantImport : null,
      fit: heliosClamp(c.fit),
      risk: ["LOW", "MEDIUM", "HIGH", "BLOCKED"].includes(String(c.risk).toUpperCase())
        ? String(c.risk).toUpperCase()
        : "MEDIUM",
      why: String(c.why || "").slice(0, 500)
    }))
    .filter((c) => c.title);

  const recommendedIndex = Number.isFinite(Number(raw.recommendedIndex))
    ? Number(raw.recommendedIndex)
    : null;
  const recommended =
    recommendedIndex != null
      ? candidates.find((c) => c.index === recommendedIndex) || candidates[recommendedIndex] || null
      : null;

  shopPipe.lastCollectiveScreenshot = {
    at: heliosNow(),
    attempt,
    query: plan.query,
    coverage: raw.coverage || null,
    confidence: raw.confidence || null,
    candidateCount: candidates.length,
    provider: ai.provider || null,
    model: ai.model || null,
    fallbackUsed: Boolean(ai.fallbackUsed),
    providerAttempt: ai.providerAttempt || null
  };
  mission.updatedAt = heliosNow();
  mission.events = [
    ...(Array.isArray(mission.events) ? mission.events : []),
    {
      at: heliosNow(),
      type: "COLLECTIVE_SCREENSHOT_ANALYZED",
      attempt,
      query: plan.query,
      coverage: raw.coverage || null,
      candidateCount: candidates.length,
      recommended: recommended?.title || null,
      provider: ai.provider || null,
      model: ai.model || null,
      fallbackUsed: Boolean(ai.fallbackUsed),
      providerAttempt: ai.providerAttempt || null
    }
  ];

  const visibleMarginPass =
    recommended?.marginPct == null ||
    Number(recommended.marginPct) >= HELIOS_MIN_VISIBLE_MARGIN_PCT;

  if (
    recommended &&
    recommended.fit >= 65 &&
    recommended.risk !== "BLOCKED" &&
    visibleMarginPass
  ) {
    shopPipe.status = "WAITING";
    shopPipe.step = "OWNER_IMPORT_RECOMMENDED_PRODUCT";
    shopPipe.reason = "COLLECTIVE_UI_IMPORT_REQUIRED";
    shopPipe.recommendedCollectiveCandidate = recommended;
    shopPipe.expectedImport = {
      ...recommended,
      selectedAt: heliosNow(),
      attempt,
      query: plan.query
    };
    mission.status = "WAITING";
    mission.checkpoint = "OWNER_IMPORT_RECOMMENDED_PRODUCT";
    mission.decisionRequired = {
      type: "OWNER_ACTION",
      store: "SHOPIFY",
      reason: "Shopify Collective richiede il click Importazione istantanea nella UI."
    };

    return {
      ok: true,
      mission,
      provider: ai.provider,
      model: ai.model || null,
      analysis: {
        coverage: raw.coverage || "MIXED",
        confidence: raw.confidence || "MEDIUM",
        candidates,
        recommended
      },
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "IMPORT THIS PRODUCT",
        message:
          `HELIOS ha analizzato ${candidates.length} risultati visibili e ha scelto “${recommended.title}”` +
          `${recommended.supplier ? ` di ${recommended.supplier}` : ""}. ` +
          `Fit ${Math.round(recommended.fit)}/100${recommended.marginPct != null ? ` · margine visibile ${recommended.marginPct}%` : ""}. ` +
          `Apri quel risultato e premi Importazione istantanea. Poi torna su CORTEX: HELIOS rileverà la bozza e continuerà da solo.`,
        reason: "COLLECTIVE_PRODUCT_RECOMMENDED",
        missionId: mission.id,
        state: "WAITING",
        context: {
          opportunity: heliosOpportunityIntelligence(opportunity, attempt),
          collectiveSearch: plan,
          recommendedCandidate: recommended,
          visibleCandidates: candidates
        },
        actions: [
          { id: "OPEN_COLLECTIVE", label: "OPEN COLLECTIVE", type: "LINK", url: heliosCollectiveUrl() },
          { id: "ANALYZE_COLLECTIVE_RESULTS", label: "NEW SCREENSHOT", type: "LOCAL" },
          { id: "NEXT_SEARCH", label: "NEXT SEARCH", type: "BACKEND" },
          { id: "NEXT_OPPORTUNITY", label: "NEXT OPPORTUNITY", type: "BACKEND" }
        ]
      })
    };
  }

  const rejectReason =
    recommended &&
    recommended.marginPct != null &&
    Number(recommended.marginPct) < HELIOS_MIN_VISIBLE_MARGIN_PCT
      ? "VISIBLE_MARGIN_BELOW_MINIMUM"
      : "NO_VALID_VISIBLE_COLLECTIVE_RESULT";

  const advanced = heliosMissionNextSearch(mission, rejectReason);
  return {
    ...advanced,
    provider: ai.provider,
    model: ai.model || null,
    analysis: {
      coverage: raw.coverage || "POOR",
      confidence: raw.confidence || "MEDIUM",
      candidates,
      recommended: null,
      reason:
        rejectReason === "VISIBLE_MARGIN_BELOW_MINIMUM"
          ? `Il candidato migliore ha un margine visibile inferiore al ${HELIOS_MIN_VISIBLE_MARGIN_PCT}% e non viene importato.`
          : String(raw.reason || "Nessun risultato visibile supera i criteri minimi HELIOS.").slice(0, 600)
    },
    autoAdvanced: true
  };
}

async function heliosManagedProductVault() {
  const d = await shopifyGraphQL(`
    query HeliosManagedProducts {
      products(first: 100, query: "tag:HELIOS", sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          legacyResourceId
          title
          handle
          descriptionHtml
          vendor
          productType
          tags
          status
          totalInventory
          onlineStoreUrl
          createdAt
          updatedAt
          featuredMedia {
            ... on MediaImage {
              image { url altText width height }
            }
          }
          variants(first: 20) {
            nodes {
              id
              legacyResourceId
              title
              sku
              price
              compareAtPrice
              inventoryQuantity
            }
          }
          managed: metafield(namespace: "helios", key: "managed") { value }
          scoreMeta: metafield(namespace: "helios", key: "score") { value }
          growthMeta: metafield(namespace: "helios", key: "growth") { value }
          marginMeta: metafield(namespace: "helios", key: "margin_pct") { value }
          missionMeta: metafield(namespace: "helios", key: "mission_id") { value }
        }
      }
    }
  `);

  return (d?.products?.nodes || []).map((p) => {
    const v = p?.variants?.nodes?.[0] || {};
    const image = p?.featuredMedia?.image || null;
    return {
      id: p.id,
      legacyId: p.legacyResourceId || null,
      title: p.title,
      handle: p.handle,
      descriptionHtml: p.descriptionHtml || "",
      supplier: p.vendor || "Shopify Collective",
      vendor: p.vendor || null,
      productType: p.productType || null,
      tags: p.tags || [],
      status: p.status || null,
      inventory: Number(p.totalInventory || 0),
      price: v.price != null ? Number(v.price) : null,
      compareAtPrice: v.compareAtPrice != null ? Number(v.compareAtPrice) : null,
      image: image
        ? {
            url: image.url,
            alt: image.altText || p.title,
            width: image.width || null,
            height: image.height || null
          }
        : null,
      storeUrl: p.onlineStoreUrl || null,
      onlineStoreUrl: p.onlineStoreUrl || null,
      score: Number.isFinite(Number(p?.scoreMeta?.value)) ? Number(p.scoreMeta.value) : null,
      growth: Number.isFinite(Number(p?.growthMeta?.value)) ? Number(p.growthMeta.value) : null,
      margin: Number.isFinite(Number(p?.marginMeta?.value)) ? Number(p.marginMeta.value) : null,
      missionId: p?.missionMeta?.value || null,
      managed: p?.managed?.value === "true",
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    };
  });
}

async function heliosProductPerformance() {
  const [vault, shopRes, ordersRes] = await Promise.all([
    heliosManagedProductVault(),
    shopifyFetch("/shop.json"),
    shopifyFetch(
      "/orders.json?status=any&limit=250&fields=id,name,currency,financial_status,created_at,line_items"
    )
  ]);

  const shop = shopRes?.shop || {};
  const currency = shop.currency || "EUR";
  const orders = Array.isArray(ordersRes?.orders) ? ordersRes.orders : [];
  const byId = new Map(vault.map((p) => [String(p.legacyId || ""), { ...p, unitsSold: 0, grossRevenue: 0, orderIds: new Set() }]));

  for (const order of orders) {
    for (const li of Array.isArray(order?.line_items) ? order.line_items : []) {
      const row = byId.get(String(li?.product_id || ""));
      if (!row) continue;
      const qty = Number(li?.quantity || 0);
      const price = Number(li?.price || 0);
      const discount = Number(li?.total_discount || 0);
      row.unitsSold += qty;
      row.grossRevenue += Math.max(0, price * qty - discount);
      row.orderIds.add(order.id);
    }
  }

  const products = [...byId.values()].map((row) => {
    const revenue = heliosRound(row.grossRevenue || 0) || 0;
    const ordersCount = row.orderIds.size;
    const label = row.unitsSold >= 10 || revenue >= 250
      ? "WINNER"
      : row.unitsSold > 0
      ? "SELLING"
      : "TESTING";
    const out = {
      ...row,
      grossRevenue: revenue,
      orders: ordersCount,
      label
    };
    delete out.orderIds;
    return out;
  });

  return {
    currency,
    products,
    totals: {
      liveProducts: vault.filter((p) => p.status === "ACTIVE").length,
      unitsSold: products.reduce((s, p) => s + Number(p.unitsSold || 0), 0),
      grossRevenue: heliosRound(products.reduce((s, p) => s + Number(p.grossRevenue || 0), 0)) || 0,
      orders: new Set(
        orders
          .filter((o) =>
            (Array.isArray(o?.line_items) ? o.line_items : []).some((li) => byId.has(String(li?.product_id || "")))
          )
          .map((o) => o.id)
      ).size
    }
  };
}

async function heliosGlobalMarketScan(stores, objective = "", options = {}) {
  const targets = stores.length ? stores.join(" + ") : "SHOPIFY";
  const baseObjective =
    objective ||
    "Trova le opportunità commerciali globali con il miglior rapporto domanda/crescita/saturazione e rischio contenuto.";
  const avoidFamilies = new Set(
    (Array.isArray(options?.avoidOpportunityFamilies) ? options.avoidOpportunityFamilies : [])
      .map((x) => String(x || "").trim().toUpperCase())
      .filter(Boolean)
  );

  const queries = [];

  if (stores.includes("SHOPIFY")) {
    queries.push(
      "2026 fast growing consumer product trends ecommerce emerging demand low saturation global",
      "2026 breakout physical products ecommerce trend rising searches consumer demand Europe",
      "2026 product trends home lifestyle travel tech accessories beauty pet ecommerce"
    );
  }

  if (stores.includes("ETSY")) {
    queries.push(
      "2026 Etsy digital product trends rising demand printable templates planners global",
      "2026 digital download consumer trends low competition templates workbooks planners"
    );
  }

  const signals = await Promise.all(
    [...new Set(queries)]
      .slice(0, 5)
      .map((q) => heliosWebSignal(q, { max: 6, deep: true }))
  );

  const sourcePayload = signals.map((s) => ({
    query: s.query,
    answer: s.answer || null,
    results: (s.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score
    }))
  }));

  const prompt = `
Sei HELIOS Commerce Intelligence di CORTEX.

Devi scegliere opportunità commerciali reali e sostenibili per i canali autorizzati: ${targets}.

Obiettivo proprietario:
${baseObjective}

REGOLE:
- Non inventare dati precisi non presenti nelle fonti.
- Distingui Current Demand, Growth Velocity e Market Saturation.
- Breakout Confidence misura la probabilità che il trend sia nella fase iniziale di accelerazione.
- Evita armi, sostanze regolamentate, farmaci, prodotti medici ad alto rischio, claims sanitari, contraffazioni, prodotti IP/trademark dipendenti, prodotti illegali o ad alto rischio reputazionale.
- Per SHOPIFY preferisci famiglie di prodotti fisici che possano realisticamente esistere in cataloghi multi-brand/Shopify Collective e che funzionino in uno store umbrella multi-nicchia.
- DIVERSITY GATE: restituisci almeno 6 opportunità SHOPIFY appartenenti a macro-famiglie differenti. Non più di UNA opportunità per la stessa macro-famiglia (es. cleaning, beauty, pet, travel, kitchen, tech, home organization, accessories, hobby/outdoor, fitness/wellness).
- Evita le macro-famiglie in cooldown da missioni fallite: ${JSON.stringify([...avoidFamilies])}. Se la lista contiene CLEANING, non proporre detergenti, panni, spugne, laundry o surface cleaner.
- Per ETSY preferisci prodotti digitali originali che HELIOS possa creare integralmente con alta qualità.
- Una opportunità con score attuale inferiore può vincere se Growth e Breakout sono forti e la saturazione è bassa.
- Per ogni opportunità SHOPIFY genera anche un piano di ricerca Collective MOLTO PRECISO:
  - query: una frase breve, concreta e non ambigua, idealmente 2-6 parole;
  - alternatives: query alternative realmente utili;
  - localQueries: 3 query MOLTO BREVI in italiano (1-4 parole) pensate per il motore keyword di Collective in un negozio italiano;
  - category: categoria commerciale;
  - include: parole/concetti che devono essere coerenti;
  - exclude: parole/concetti che devono essere esclusi per evitare falsi positivi.
- La query Collective deve descrivere il prodotto fisico, non un concetto generico. Esempio: meglio "eco household surface cleaner" che "eco friendly cleaning".
- Restituisci solo JSON.

FORMATO:
{
  "marketScope": "GLOBAL",
  "sourceConfidence": "HIGH|MEDIUM|LOW",
  "opportunities": [
    {
      "rank": 1,
      "name": "",
      "channelFit": ["SHOPIFY"],
      "market": "",
      "language": "",
      "category": "",
      "currentDemand": 0,
      "growthPotential": 0,
      "breakoutConfidence": 0,
      "marketSaturation": 0,
      "competition": "LOW|MEDIUM|HIGH",
      "risk": "LOW|MEDIUM|HIGH|BLOCKED",
      "heliosScore": 0,
      "verdict": "STRONG_NOW|EMERGING|BREAKOUT|WATCH|REJECT",
      "whyNow": "",
      "searchTerms": [""],
      "collectiveSearch": {
        "query": "",
        "alternatives": [""],
        "localQueries": [""],
        "category": "",
        "include": [""],
        "exclude": [""]
      },
      "evidence": [
        {
          "title": "",
          "url": "",
          "signal": ""
        }
      ]
    }
  ]
}

FONTI WEB:
${JSON.stringify(sourcePayload).slice(0, 26000)}
`;

  const ai = await heliosAIJson(prompt, {
    temperature: 0.1,
    maxTokens: 7000
  });

  if (!ai.ok) {
    return {
      ok: false,
      error: ai.error,
      signals,
      opportunities: []
    };
  }

  const out = ai.data || {};

  const opportunities = (
    Array.isArray(out.opportunities)
      ? out.opportunities
      : []
  )
    .map((o, i) => {
      const channelFit = Array.isArray(o.channelFit)
        ? o.channelFit
            .map((x) => String(x).toUpperCase())
            .filter((x) => stores.includes(x))
        : [];

      const searchTerms = Array.isArray(o.searchTerms)
        ? heliosUniqueStrings(o.searchTerms, 12)
        : [];

      const rawCollective =
        o?.collectiveSearch &&
        typeof o.collectiveSearch === "object"
          ? o.collectiveSearch
          : {};

      const collectiveSearch = channelFit.includes("SHOPIFY")
        ? {
            query:
              String(
                rawCollective.query ||
                searchTerms[0] ||
                o.name ||
                ""
              )
                .trim()
                .slice(0, 160),
            alternatives: heliosUniqueStrings(
              [
                ...(Array.isArray(rawCollective.alternatives)
                  ? rawCollective.alternatives
                  : []),
                ...searchTerms.slice(1)
              ],
              8
            ),
            localQueries: heliosUniqueStrings(
              Array.isArray(rawCollective.localQueries)
                ? rawCollective.localQueries
                : [],
              6
            ),
            category:
              String(
                rawCollective.category ||
                o.category ||
                o.market ||
                "General"
              )
                .trim()
                .slice(0, 120),
            include: heliosUniqueStrings(
              [
                ...(Array.isArray(rawCollective.include)
                  ? rawCollective.include
                  : []),
                ...(Array.isArray(rawCollective.includeTerms)
                  ? rawCollective.includeTerms
                  : [])
              ],
              16
            ),
            exclude: heliosUniqueStrings(
              [
                ...(Array.isArray(rawCollective.exclude)
                  ? rawCollective.exclude
                  : []),
                ...(Array.isArray(rawCollective.excludeTerms)
                  ? rawCollective.excludeTerms
                  : [])
              ],
              20
            )
          }
        : null;

      return {
        rank: Number(o.rank) || i + 1,
        name: String(o.name || "Opportunità").slice(0, 140),
        channelFit,
        market: o.market || "Global",
        language: o.language || "English",
        category:
          String(o.category || collectiveSearch?.category || "")
            .trim()
            .slice(0, 120),
        currentDemand: heliosClamp(o.currentDemand),
        growthPotential: heliosClamp(o.growthPotential),
        breakoutConfidence: heliosClamp(o.breakoutConfidence),
        marketSaturation: heliosClamp(o.marketSaturation),
        competition: ["LOW", "MEDIUM", "HIGH"].includes(
          String(o.competition).toUpperCase()
        )
          ? String(o.competition).toUpperCase()
          : "MEDIUM",
        risk: ["LOW", "MEDIUM", "HIGH", "BLOCKED"].includes(
          String(o.risk).toUpperCase()
        )
          ? String(o.risk).toUpperCase()
          : "MEDIUM",
        heliosScore: heliosClamp(o.heliosScore),
        verdict: [
          "STRONG_NOW",
          "EMERGING",
          "BREAKOUT",
          "WATCH",
          "REJECT"
        ].includes(String(o.verdict).toUpperCase())
          ? String(o.verdict).toUpperCase()
          : "WATCH",
        whyNow: String(o.whyNow || "").slice(0, 800),
        searchTerms,
        collectiveSearch,
        evidence: Array.isArray(o.evidence)
          ? o.evidence.slice(0, 8)
          : []
      };
    })
    .filter(
      (o) =>
        o.risk !== "BLOCKED" &&
        o.verdict !== "REJECT" &&
        o.channelFit.length
    )
    .sort((a, b) => {
      const aDyn =
        a.heliosScore * 0.55 +
        a.growthPotential * 0.25 +
        a.breakoutConfidence * 0.2;

      const bDyn =
        b.heliosScore * 0.55 +
        b.growthPotential * 0.25 +
        b.breakoutConfidence * 0.2;

      return bDyn - aDyn;
    });

  const diversified = [];
  const seenFamilies = new Set();
  for (const opportunity of opportunities) {
    const family = heliosOpportunityFamily(opportunity);
    if (avoidFamilies.has(family) || seenFamilies.has(family)) continue;
    diversified.push({ ...opportunity, family });
    seenFamilies.add(family);
    if (diversified.length >= 10) break;
  }

  return {
    ok: true,
    provider: ai.provider,
    marketScope: out.marketScope || "GLOBAL",
    sourceConfidence: out.sourceConfidence || "MEDIUM",
    signals,
    opportunities: diversified
  };
}

async function heliosRankCollectiveCandidates(opportunity, products) {
  const compact = products.slice(0, 160).map((p, index) => ({
    index,
    id: p.id,
    title: p.title,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    inventory: p.inventory,
    retail: p.variants?.[0]?.retailPrice ?? null,
    supplierCost: p.variants?.[0]?.supplierCost ?? null,
    marginPct: p.variants?.[0]?.grossMarginPct ?? null
  }));

  const prompt = `
Sei HELIOS Supplier/Product Matcher.
Opportunità commerciale selezionata:
${JSON.stringify(opportunity)}

Prodotti Shopify Collective già importati come BOZZA nel negozio:
${JSON.stringify(compact).slice(0, 42000)}

Scegli i migliori candidati semanticamente coerenti con l'opportunità. Non forzare un match: se nessun prodotto è realmente adatto, restituisci emptyMatch=true.
Valuta anche inventario e margine quando disponibile. Non inventare costi o spedizione.
Restituisci solo JSON:
{
  "emptyMatch": false,
  "matches": [
    {
      "index": 0,
      "fit": 0,
      "reason": "",
      "demand": 0,
      "growth": 0,
      "breakout": 0,
      "saturation": 0
    }
  ]
}
`;

  const ai = await heliosAIJson(prompt, { temperature: 0.05, maxTokens: 4200 });
  if (!ai.ok) return { emptyMatch: true, matches: [], error: ai.error };

  const matches = (Array.isArray(ai.data?.matches) ? ai.data.matches : [])
    .filter((m) => Number.isInteger(Number(m.index)) && products[Number(m.index)])
    .map((m) => ({
      index: Number(m.index),
      fit: heliosClamp(m.fit),
      reason: String(m.reason || "").slice(0, 500),
      demand: heliosClamp(m.demand ?? opportunity.currentDemand),
      growth: heliosClamp(m.growth ?? opportunity.growthPotential),
      breakout: heliosClamp(m.breakout ?? opportunity.breakoutConfidence),
      saturation: heliosClamp(m.saturation ?? opportunity.marketSaturation)
    }))
    .sort((a, b) => b.fit - a.fit);

  return {
    emptyMatch: Boolean(ai.data?.emptyMatch) || !matches.length || matches[0].fit < 70,
    matches
  };
}

async function heliosOptimizeCollectiveListing(product, opportunity, options = {}) {
  const repairContext =
    options?.repairContext &&
    typeof options.repairContext === "object"
      ? options.repairContext
      : null;

  const prompt = `
Sei HELIOS Listing Intelligence.
Ottimizza questo prodotto Shopify Collective per conversione e SEO, mantenendo informazioni vere e senza modificare dati tecnici non verificati.
${repairContext
  ? `Questa è una SELF-REPAIR pass. La versione precedente non ha superato il Quality Gate. Correggi qualità, completezza, SEO, chiarezza e valore percepito senza inventare fatti. Quality Gate precedente: ${JSON.stringify(repairContext).slice(0, 3000)}`
  : ""}
NON modificare prezzo, inventario, SKU, vendor o attributi sincronizzati dal fornitore.
NON fare claim medici o non verificati.
Mantieni il prodotto adatto a uno store umbrella multi-nicchia.

OPPORTUNITA:
${JSON.stringify(opportunity)}

PRODOTTO:
${JSON.stringify({
  title: product.title,
  descriptionHtml: product.descriptionHtml,
  vendor: product.vendor,
  productType: product.productType,
  tags: product.tags,
  variants: product.variants
}).slice(0, 18000)}

Restituisci solo JSON:
{
  "title": "",
  "descriptionHtml": "",
  "productType": "",
  "tags": [""],
  "seo": {"title":"","description":""},
  "collection": {"title":"","handle":"","descriptionHtml":""},
  "commerceShield": {"risk":"LOW|MEDIUM|HIGH|BLOCKED","reasons":[]},
  "quality": {"content":0,"visual":0,"usability":0,"perceivedValue":0,"listing":0,"seo":0}
}
`;

  const ai = await heliosAIJson(prompt, { temperature: 0.2, maxTokens: 5200 });
  if (!ai.ok) return { ok: false, error: ai.error };

  const d = ai.data || {};
  const risk = ["LOW", "MEDIUM", "HIGH", "BLOCKED"].includes(String(d?.commerceShield?.risk).toUpperCase())
    ? String(d.commerceShield.risk).toUpperCase()
    : "MEDIUM";

  return {
    ok: true,
    provider: ai.provider,
    listing: {
      title: String(d.title || product.title).slice(0, 255),
      descriptionHtml: String(d.descriptionHtml || product.descriptionHtml || "").slice(0, 60000),
      productType: String(d.productType || product.productType || "").slice(0, 255),
      tags: [...new Set([...(product.tags || []), ...(Array.isArray(d.tags) ? d.tags : []), "HELIOS"])]
        .map(String)
        .slice(0, 250),
      seo: {
        title: String(d?.seo?.title || d.title || product.title).slice(0, 70),
        description: String(d?.seo?.description || "").slice(0, 320)
      }
    },
    collection: {
      title: String(d?.collection?.title || opportunity.name || product.productType || "Featured").slice(0, 120),
      handle: heliosSlug(d?.collection?.handle || d?.collection?.title || opportunity.name || product.productType || "featured"),
      descriptionHtml: String(d?.collection?.descriptionHtml || "").slice(0, 5000)
    },
    commerceShield: {
      risk,
      reasons: Array.isArray(d?.commerceShield?.reasons) ? d.commerceShield.reasons.slice(0, 10).map(String) : []
    },
    quality: {
      content: heliosClamp(d?.quality?.content),
      visual: heliosClamp(d?.quality?.visual),
      usability: heliosClamp(d?.quality?.usability),
      perceivedValue: heliosClamp(d?.quality?.perceivedValue),
      listing: heliosClamp(d?.quality?.listing),
      seo: heliosClamp(d?.quality?.seo)
    }
  };
}


function heliosCatalogLaunchScore(product) {
  const v = product?.variants?.[0] || {};
  const retail = Number(v.retailPrice || 0);
  const cost = v.supplierCost != null ? Number(v.supplierCost) : null;
  const inventory = Number(product?.inventory || v.inventory || 0);
  const marginPct =
    Number.isFinite(Number(v.grossMarginPct))
      ? Number(v.grossMarginPct)
      : cost != null && retail > 0
      ? ((retail - cost) / retail) * 100
      : null;

  const marginValue =
    marginPct == null ? 35 :
    marginPct >= 40 ? 100 :
    marginPct >= 30 ? 92 :
    marginPct >= 25 ? 86 :
    marginPct >= 20 ? 78 :
    marginPct >= 15 ? 66 :
    marginPct >= 10 ? 48 : 25;

  const inventoryValue =
    inventory >= 50 ? 100 :
    inventory >= 20 ? 94 :
    inventory >= 10 ? 86 :
    inventory >= 5 ? 76 :
    inventory >= 1 ? 62 : 0;

  const completenessParts = [
    Boolean(product?.title),
    Boolean(product?.descriptionHtml),
    Boolean(product?.image?.url),
    Boolean(product?.vendor || product?.supplierTag),
    retail > 0
  ];
  const completeness = Math.round(
    (completenessParts.filter(Boolean).length / completenessParts.length) * 100
  );

  // Catalog Launch non deve fingere una domanda di mercato che non abbiamo misurato.
  // Preferisce prodotti semplici da vendere e penalizza soltanto categorie che meritano
  // una verifica Commerce Shield più severa; la decisione finale resta al gate AI.
  const riskyText = `${product?.title || ''} ${product?.productType || ''}`.toLowerCase();
  const regulatedRiskHint = /(acido|percarbonato|candeggina|bleach|disinfett|alcol|solvente|pestic|biocid|chemical|chimic)/i.test(riskyText);
  const simplicityValue = regulatedRiskHint ? 55 : 92;
  const supplierValue = heliosIsCollectiveProduct(product) && (product?.vendor || product?.supplierTag) ? 100 : 40;

  const score =
    marginValue * 0.34 +
    inventoryValue * 0.20 +
    completeness * 0.20 +
    supplierValue * 0.16 +
    simplicityValue * 0.10;

  const hardGates = {
    collectiveManaged: heliosIsCollectiveProduct(product),
    inventoryAvailable: inventory > 0,
    hasSellPrice: retail > 0,
    notArchived: product?.status !== 'ARCHIVED',
    supplierLinked: Boolean(product?.vendor || product?.supplierTag)
  };

  return {
    heliosScore: Math.round(score),
    confidence: cost != null ? 'HIGH' : 'MEDIUM',
    coverage: Math.round((completeness + (cost != null ? 100 : 55)) / 2),
    fit: null,
    mode: 'CATALOG_LAUNCH',
    hardGates,
    criticalPass: Object.values(hardGates).every(Boolean),
    economics: {
      retailPrice: retail || null,
      supplierCost: cost,
      shippingCost: null,
      shippingStatus: 'COLLECTIVE_RATE_AT_CHECKOUT',
      grossMarginEuro: cost != null ? heliosRound(retail - cost) : null,
      grossMarginPct: marginPct != null ? heliosRound(marginPct, 1) : null,
      note: 'Catalog Launch usa solo dati Shopify/Collective disponibili; nessuna domanda di mercato viene inventata.'
    },
    market: {
      fit: null,
      demand: null,
      growth: null,
      breakout: null,
      saturation: null
    },
    diagnostics: {
      marginValue,
      inventoryValue,
      completeness,
      simplicityValue,
      regulatedRiskHint
    }
  };
}

function heliosCatalogLaunchQualityGate({ product, score, optimization }) {
  const hard = {
    collectiveManaged: heliosIsCollectiveProduct(product),
    supplierLinked: Boolean(product?.vendor || product?.supplierTag),
    inventory: Number(product?.inventory || 0) > 0,
    validPrice: Number(product?.variants?.[0]?.retailPrice || 0) > 0,
    commerceShield: optimization?.commerceShield?.risk !== 'BLOCKED',
    completeListing: Boolean(optimization?.listing?.title && optimization?.listing?.descriptionHtml)
  };

  const q = optimization?.quality || {};
  const weighted = [
    [q.content, 0.22],
    [q.visual, 0.08],
    [q.usability, 0.14],
    [q.perceivedValue, 0.14],
    [q.listing, 0.26],
    [q.seo, 0.16]
  ].filter(([value]) => Number.isFinite(Number(value)));
  const weightTotal = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  const qualityAverage = weightTotal
    ? weighted.reduce((sum, [value, weight]) => sum + Number(value) * weight, 0) / weightTotal
    : 0;

  const commercial = Number(score?.heliosScore || 0);
  const margin = Number(score?.economics?.grossMarginPct ?? 0);
  const risk = String(optimization?.commerceShield?.risk || 'MEDIUM').toUpperCase();
  const hardPass = Object.values(hard).every(Boolean);
  const marginPass = Number.isFinite(margin) && margin >= 15;
  const commercialPass = commercial >= 58 && marginPass;
  const pass = hardPass && qualityAverage >= 60 && commercialPass && risk !== 'HIGH';

  return {
    pass,
    hardPass,
    hardGates: hard,
    qualityAverage: Math.round(qualityAverage),
    commercialScore: commercial,
    fit: null,
    marginPct: Number.isFinite(margin) ? heliosRound(margin, 1) : null,
    confidence: score?.confidence || 'LOW',
    risk,
    mode: 'CATALOG_LAUNCH',
    status: pass ? 'PASS' : hardPass ? 'REJECTED' : 'BLOCKED',
    reasons: [
      ...Object.entries(hard).filter(([,value]) => !value).map(([key]) => key),
      ...(marginPass ? [] : ['margin_below_15_pct']),
      ...(qualityAverage >= 60 ? [] : ['listing_quality_below_60']),
      ...(commercial >= 58 ? [] : ['catalog_commercial_score_below_58']),
      ...(risk === 'HIGH' ? ['commerce_shield_high_risk'] : [])
    ]
  };
}

function heliosQualityGate({ product, score, optimization }) {
  const hard = {
    collectiveManaged: heliosIsCollectiveProduct(product),
    supplierLinked: Boolean(product?.vendor || product?.supplierTag),
    inventory: Number(product?.inventory || 0) > 0,
    validPrice: Number(product?.variants?.[0]?.retailPrice || 0) > 0,
    commerceShield: optimization?.commerceShield?.risk !== "BLOCKED",
    completeListing: Boolean(optimization?.listing?.title && optimization?.listing?.descriptionHtml)
  };

  const q = optimization?.quality || {};
  const weighted = [
    [q.content, 0.20],
    [q.visual, 0.08],
    [q.usability, 0.14],
    [q.perceivedValue, 0.14],
    [q.listing, 0.28],
    [q.seo, 0.16]
  ].filter(([value]) => Number.isFinite(Number(value)));
  const weightTotal = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  const qualityAverage = weightTotal
    ? weighted.reduce((sum, [value, weight]) => sum + Number(value) * weight, 0) / weightTotal
    : 0;

  const commercial = Number(score?.heliosScore || 0);
  const fit = Number(score?.fit ?? score?.market?.fit ?? 0);
  const margin = Number(score?.economics?.grossMarginPct ?? 0);
  const confidence = score?.confidence || "LOW";
  const risk = String(optimization?.commerceShield?.risk || "MEDIUM").toUpperCase();
  const hardPass = Object.values(hard).every(Boolean);

  // Calibrato per un test commerciale reale: un prodotto fortemente coerente,
  // con margine/stock reali e rischio non HIGH, non viene più bloccato solo perché
  // i segnali di mercato secondari sono conservativi. Gli hard gate restano intatti.
  const commercialPass = commercial >= 55 || (fit >= 85 && margin >= 18 && commercial >= 50);
  const pass = hardPass && fit >= 70 && qualityAverage >= 60 && commercialPass && risk !== "HIGH";

  return {
    pass,
    hardPass,
    hardGates: hard,
    qualityAverage: Math.round(qualityAverage),
    commercialScore: commercial,
    fit: Math.round(fit),
    marginPct: Number.isFinite(margin) ? heliosRound(margin, 1) : null,
    confidence,
    risk,
    status: pass ? "PASS" : hardPass ? "REPAIR_OR_DECISION" : "BLOCKED"
  };
}

async function heliosUpsertCollection(collection, productId, publish = false) {
  const handle = heliosSlug(collection?.handle || collection?.title || "featured");
  const find = await shopifyGraphQL(`
    query HeliosFindCollection($query: String!) {
      collections(first: 10, query: $query) {
        nodes { id title handle }
      }
    }
  `, { query: `handle:${handle}` });

  let col = (find?.collections?.nodes || []).find((x) => x.handle === handle) || null;

  if (!col) {
    const created = await shopifyGraphQL(`
      mutation HeliosCollectionCreate($input: CollectionInput!) {
        collectionCreate(input: $input) {
          collection { id title handle }
          userErrors { field message }
        }
      }
    `, {
      input: {
        title: collection?.title || "Featured",
        handle,
        descriptionHtml: collection?.descriptionHtml || "",
        products: [productId]
      }
    });

    const errors = created?.collectionCreate?.userErrors || [];
    if (errors.length) {
      throw new Error(`Collection create: ${errors.map((x) => x.message).join(" | ")}`);
    }
    col = created?.collectionCreate?.collection || null;
  } else {
    const added = await shopifyGraphQL(`
      mutation HeliosCollectionAdd($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) {
          collection { id title handle }
          userErrors { field message }
        }
      }
    `, { id: col.id, productIds: [productId] });

    const errors = added?.collectionAddProducts?.userErrors || [];
    const meaningful = errors.filter((x) => !/already exists|already.*collection/i.test(x.message || ""));
    if (meaningful.length) {
      throw new Error(`Collection add: ${meaningful.map((x) => x.message).join(" | ")}`);
    }
  }

  if (publish && col?.id) {
    const pub = await heliosOnlineStorePublication();
    if (pub?.id) {
      await shopifyGraphQL(`
        mutation HeliosPublishCollection($id: ID!, $publicationId: ID!) {
          publishablePublish(id: $id, input: { publicationId: $publicationId }) {
            userErrors { field message }
          }
        }
      `, { id: col.id, publicationId: pub.id });
    }
  }

  return col;
}

async function heliosApplyCollectiveListing(
  product,
  optimization,
  { publish = false, intelligence = {}, missionId = null } = {}
) {
  const p = optimization.listing;
  const update = await shopifyGraphQL(`
    mutation HeliosProductUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id title handle status tags productType
          seo { title description }
          onlineStoreUrl
        }
        userErrors { field message }
      }
    }
  `, {
    product: {
      id: product.id,
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      productType: p.productType,
      tags: p.tags,
      seo: p.seo,
      status: publish ? "ACTIVE" : "DRAFT",
      metafields: [
        {
          namespace: "helios",
          key: "managed",
          type: "boolean",
          value: "true"
        },
        {
          namespace: "helios",
          key: "last_optimized_at",
          type: "single_line_text_field",
          value: heliosNow()
        },
        {
          namespace: "helios",
          key: "score",
          type: "single_line_text_field",
          value: String(intelligence?.score ?? intelligence?.heliosScore ?? "")
        },
        {
          namespace: "helios",
          key: "growth",
          type: "single_line_text_field",
          value: String(intelligence?.growth ?? intelligence?.growthPotential ?? "")
        },
        {
          namespace: "helios",
          key: "margin_pct",
          type: "single_line_text_field",
          value: String(intelligence?.margin ?? intelligence?.grossMarginPct ?? "")
        },
        {
          namespace: "helios",
          key: "mission_id",
          type: "single_line_text_field",
          value: String(missionId || "")
        }
      ]
    }
  });

  const errors = update?.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(`Product update: ${errors.map((x) => x.message).join(" | ")}`);
  }

  const updated = update?.productUpdate?.product;

  let publication = null;
  if (publish && updated?.id) {
    const pub = await heliosOnlineStorePublication();
    if (!pub?.id) throw new Error("Pubblicazione Online Store non trovata");

    const published = await shopifyGraphQL(`
      mutation HeliosPublishProduct($id: ID!, $publicationId: ID!) {
        publishablePublish(id: $id, input: { publicationId: $publicationId }) {
          publishable { publishedOnPublication(publicationId: $publicationId) }
          userErrors { field message }
        }
      }
    `, { id: updated.id, publicationId: pub.id });

    const pubErrors = published?.publishablePublish?.userErrors || [];
    if (pubErrors.length) {
      throw new Error(`Product publish: ${pubErrors.map((x) => x.message).join(" | ")}`);
    }
    publication = pub;
  }

  return { product: updated, publication };
}

function heliosBrandSectionLiquid() {
  return String.raw`{% comment %} CORTEX HELIOS generated section {% endcomment %}
<section class="helios-home" style="--h-bg: {{ section.settings.bg }}; --h-fg: {{ section.settings.fg }}; --h-accent: {{ section.settings.accent }};">
  <div class="helios-hero">
    <p class="helios-kicker">{{ section.settings.kicker }}</p>
    <h1>{{ section.settings.heading }}</h1>
    <p class="helios-sub">{{ section.settings.subheading }}</p>
    {% if section.settings.cta_label != blank and section.settings.cta_link != blank %}
      <a class="helios-cta" href="{{ section.settings.cta_link }}">{{ section.settings.cta_label }}</a>
    {% endif %}
  </div>
  <div class="helios-grid">
    {% for block in section.blocks %}
      {% assign c = collections[block.settings.collection] %}
      {% if c != blank %}
        <a class="helios-card" href="{{ c.url }}" {{ block.shopify_attributes }}>
          {% if c.featured_image %}
            {{ c.featured_image | image_url: width: 900 | image_tag: loading: 'lazy', alt: c.title }}
          {% endif %}
          <div class="helios-card-copy"><span>{{ c.title }}</span><small>{{ c.products_count }} prodotti</small></div>
        </a>
      {% endif %}
    {% endfor %}
  </div>
</section>
<style>
.helios-home{background:var(--h-bg);color:var(--h-fg);padding:clamp(28px,5vw,80px) clamp(18px,4vw,64px);font-family:inherit}.helios-hero{max-width:980px;margin:0 auto 48px;text-align:center}.helios-kicker{text-transform:uppercase;letter-spacing:.18em;font-size:12px;opacity:.66}.helios-home h1{font-size:clamp(42px,8vw,92px);line-height:.95;letter-spacing:-.045em;margin:18px 0}.helios-sub{font-size:clamp(16px,2vw,22px);max-width:720px;margin:0 auto;opacity:.76}.helios-cta{display:inline-block;margin-top:26px;padding:14px 22px;border-radius:999px;background:var(--h-accent);color:var(--h-bg);text-decoration:none;font-weight:700}.helios-grid{max-width:1240px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}.helios-card{position:relative;min-height:320px;border-radius:24px;overflow:hidden;background:color-mix(in srgb,var(--h-fg) 8%,transparent);color:inherit;text-decoration:none}.helios-card img{width:100%;height:100%;min-height:320px;object-fit:cover;display:block;transition:transform .6s cubic-bezier(.2,.7,.2,1)}.helios-card:hover img{transform:scale(1.035)}.helios-card-copy{position:absolute;left:16px;right:16px;bottom:16px;background:color-mix(in srgb,var(--h-bg) 80%,transparent);backdrop-filter:blur(14px);padding:14px 16px;border-radius:16px;display:flex;justify-content:space-between;gap:12px;align-items:center}.helios-card-copy span{font-weight:700}.helios-card-copy small{opacity:.65}
</style>
{% schema %}
{
  "name": "HELIOS Home",
  "settings": [
    {"type":"text","id":"kicker","label":"Kicker","default":"Curated by HELIOS"},
    {"type":"text","id":"heading","label":"Titolo","default":"Discover what matters next"},
    {"type":"textarea","id":"subheading","label":"Sottotitolo","default":"A multi-niche store curated around products with real demand, utility and momentum."},
    {"type":"text","id":"cta_label","label":"CTA","default":"Explore"},
    {"type":"url","id":"cta_link","label":"Link CTA"},
    {"type":"color","id":"bg","label":"Sfondo","default":"#f4f1ea"},
    {"type":"color","id":"fg","label":"Testo","default":"#111111"},
    {"type":"color","id":"accent","label":"Accent","default":"#111111"}
  ],
  "blocks": [
    {"type":"collection","name":"Collection","settings":[{"type":"collection","id":"collection","label":"Collection"}]}
  ],
  "max_blocks": 8,
  "presets": [{"name":"HELIOS Home"}]
}
{% endschema %}`;
}

async function heliosGenerateBrandBlueprint(context = {}) {
  const prompt = `
Sei HELIOS Brand & Store Architect.
Crea l'identità di uno store Shopify PRINCIPALE multi-nicchia, premium e credibile. Non deve essere legato a un solo prodotto o trend.
Deve poter contenere Tech, Home, Lifestyle, Travel, Beauty, Accessories, Pet, Wellness e future nicchie senza sembrare un marketplace caotico.
Il brand deve essere originale, pronunciabile internazionalmente, breve e non dipendere da trademark noti.
Non affermare disponibilità legale del marchio: segnala sempre che la verifica trademark/domain è separata.

CONTESTO:
${JSON.stringify(context).slice(0, 10000)}

Restituisci solo JSON:
{
  "brandName":"",
  "tagline":"",
  "positioning":"",
  "tone":[""],
  "palette":{"background":"#","foreground":"#","accent":"#"},
  "home":{"kicker":"","heading":"","subheading":"","ctaLabel":"Explore"},
  "collections":[{"title":"Tech","handle":"tech"}],
  "seo":{"title":"","description":""},
  "trademarkCheckRequired":true
}
`;
  const ai = await heliosAIJson(prompt, { temperature: 0.55, maxTokens: 3200 });
  if (!ai.ok) return { ok: false, error: ai.error };
  return { ok: true, provider: ai.provider, blueprint: ai.data };
}

async function heliosApplyBrandTheme(blueprint, { confirm = false } = {}) {
  if (!confirm) {
    return {
      ok: false,
      requiresConfirmation: true,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "BRAND DEPLOYMENT REQUIRES CONFIRMATION",
        message: "HELIOS ha preparato il nuovo stile dello store. La scrittura del tema modifica la homepage pubblica e richiede una conferma esplicita.",
        reason: "STRUCTURAL_STORE_CHANGE",
        actions: [
          { id: "CONFIRM_BRAND_DEPLOY", label: "APPLY BRAND", type: "BACKEND", payload: { confirm: true } },
          { id: "OPEN_THEME", label: "OPEN SHOPIFY THEME", type: "LINK", url: heliosShopifyAdminUrl("themes") }
        ]
      })
    };
  }

  const scopes = await heliosShopifyScopes();
  if (!scopes.includes("write_themes")) {
    return {
      ok: false,
      requiresOwnerAction: true,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "SHOPIFY THEME PERMISSION REQUIRED",
        message: "HELIOS può generare il brand e il sito, ma l'app CORTEX non ha ancora lo scope write_themes necessario per scrivere il tema.",
        reason: "MISSING_WRITE_THEMES_SCOPE_OR_EXEMPTION",
        actions: [
          { id: "OPEN_APPS", label: "OPEN SHOPIFY APPS", type: "LINK", url: heliosShopifyAdminUrl("settings/apps") },
          { id: "VIEW_PLAN", label: "VIEW BRAND PLAN", type: "LOCAL" }
        ]
      })
    };
  }

  const theme = await heliosMainTheme();
  if (!theme?.id) {
    return {
      ok: false,
      requiresOwnerAction: true,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "THEME ACCESS NOT AVAILABLE",
        message: "HELIOS non riesce a leggere il tema principale. Shopify può richiedere anche l'esenzione specifica per la modifica dei theme files.",
        reason: theme?.error || "THEME_NOT_FOUND",
        actions: [{ id: "OPEN_THEME", label: "OPEN THEMES", type: "LINK", url: heliosShopifyAdminUrl("themes") }]
      })
    };
  }

  const collections = Array.isArray(blueprint?.collections) ? blueprint.collections.slice(0, 8) : [];
  const blocks = {};
  const blockOrder = [];
  collections.forEach((c, i) => {
    const id = `collection_${i + 1}`;
    blocks[id] = {
      type: "collection",
      settings: { collection: heliosSlug(c.handle || c.title) }
    };
    blockOrder.push(id);
  });

  const sectionSettings = {
    kicker: blueprint?.home?.kicker || "Curated by HELIOS",
    heading: blueprint?.home?.heading || blueprint?.brandName || "Discover what matters next",
    subheading: blueprint?.home?.subheading || blueprint?.positioning || "",
    cta_label: blueprint?.home?.ctaLabel || "Explore",
    cta_link: "/collections/all",
    bg: blueprint?.palette?.background || "#f4f1ea",
    fg: blueprint?.palette?.foreground || "#111111",
    accent: blueprint?.palette?.accent || "#111111"
  };

  const indexJson = JSON.stringify({
    sections: {
      helios_home: {
        type: "helios-home",
        blocks,
        block_order: blockOrder,
        settings: sectionSettings
      }
    },
    order: ["helios_home"]
  });

  try {
    const d = await shopifyGraphQL(`
      mutation HeliosThemeFiles($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $themeId, files: $files) {
          upsertedThemeFiles { filename }
          job { id }
          userErrors { field message }
        }
      }
    `, {
      themeId: theme.id,
      files: [
        {
          filename: "sections/helios-home.liquid",
          body: { type: "TEXT", value: heliosBrandSectionLiquid() }
        },
        {
          filename: "templates/index.json",
          body: { type: "TEXT", value: indexJson }
        }
      ]
    }, HELIOS_THEME_API_VERSION);

    const errors = d?.themeFilesUpsert?.userErrors || [];
    if (errors.length) {
      return {
        ok: false,
        requiresOwnerAction: true,
        actionCard: heliosActionCard({
          severity: "ACTION_REQUIRED",
          title: "SHOPIFY BLOCKED THEME WRITE",
          message: "Il brand è pronto ma Shopify ha rifiutato la scrittura del tema.",
          reason: errors.map((x) => x.message).join(" | "),
          actions: [
            { id: "OPEN_THEME", label: "OPEN THEMES", type: "LINK", url: heliosShopifyAdminUrl("themes") },
            { id: "VIEW_BRAND", label: "VIEW BRAND PLAN", type: "LOCAL" }
          ]
        })
      };
    }

    return {
      ok: true,
      theme,
      files: d?.themeFilesUpsert?.upsertedThemeFiles || [],
      job: d?.themeFilesUpsert?.job || null
    };
  } catch (error) {
    return {
      ok: false,
      requiresOwnerAction: true,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "THEME API AUTHORIZATION REQUIRED",
        message: "HELIOS ha generato il sito ma Shopify richiede permessi/esenzione per modificare i theme files.",
        reason: String(error?.message || error),
        actions: [{ id: "OPEN_THEME", label: "OPEN THEMES", type: "LINK", url: heliosShopifyAdminUrl("themes") }]
      })
    };
  }
}

async function heliosAnalyzeCollectiveCandidates({
  mission,
  products,
  trigger = "MISSION",
  autoPublish = true
} = {}) {
  const shopPipe = mission?.pipelines?.SHOPIFY;

  if (!shopPipe) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "CRITICAL",
        title: "SHOPIFY PIPELINE MISSING",
        message: "La missione non contiene una pipeline Shopify valida.",
        reason: "SHOPIFY_PIPELINE_MISSING",
        missionId: mission?.id || null
      })
    };
  }

  const opportunity =
    shopPipe.opportunity ||
    mission?.marketScan?.opportunities?.find?.(
      (o) =>
        Array.isArray(o?.channelFit) &&
        o.channelFit.includes("SHOPIFY")
    ) ||
    mission?.marketScan?.opportunities?.[0] ||
    null;

  if (!opportunity) {
    mission.status = "WAITING";
    mission.checkpoint = "OPPORTUNITY_REQUIRED";
    mission.updatedAt = heliosNow();

    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "OPPORTUNITY REQUIRED",
        message:
          "HELIOS non può analizzare i candidati Collective perché la missione non contiene un'opportunità selezionata.",
        reason: "MISSION_OPPORTUNITY_MISSING",
        missionId: mission.id,
        actions: [
          {
            id: "RETRY_SCAN",
            label: "RETRY SCAN",
            type: "BACKEND"
          }
        ]
      })
    };
  }

  shopPipe.opportunity = opportunity;

  const allProducts = Array.isArray(products) ? products : [];
  const rejectedIds = new Set(
    Array.isArray(shopPipe.rejectedProductIds)
      ? shopPipe.rejectedProductIds
      : []
  );

  const hasCollectiveBaseline = Array.isArray(
    shopPipe.collectiveSnapshot?.ids
  );

  const baselineIds = new Set(
    hasCollectiveBaseline
      ? shopPipe.collectiveSnapshot.ids
      : []
  );

  const usable = allProducts.filter(
    (p) =>
      p?.id &&
      !rejectedIds.has(p.id) &&
      p.status !== "ARCHIVED"
  );

  const newlyImported = usable.filter(
    (p) => !baselineIds.has(p.id)
  );

  const draftCandidates = usable.filter(
    (p) => p.status === "DRAFT"
  );

  // Se HELIOS aveva indicato un prodotto preciso dallo screenshot, al ritorno
  // prova prima a riconoscere QUEL prodotto tra i nuovi import. Questo impedisce
  // che vecchie bozze o altri fornitori facciano ripartire il ranking da zero.
  const expectedMatch = heliosFindExpectedImportedProduct(
    newlyImported.length ? newlyImported : usable,
    shopPipe.expectedImport || shopPipe.recommendedCollectiveCandidate || null
  );

  // Se la missione ha catturato un baseline Collective, HELIOS analizza SOLO
  // prodotti importati dopo quel checkpoint. Se trova il prodotto raccomandato,
  // lo pinna come unico candidato del checkpoint corrente.
  const candidates = expectedMatch?.product
    ? [expectedMatch.product]
    : newlyImported.length
    ? newlyImported
    : hasCollectiveBaseline
    ? []
    : draftCandidates.length
    ? draftCandidates
    : usable;

  if (expectedMatch?.product) {
    shopPipe.expectedImportDetected = {
      productId: expectedMatch.product.id,
      title: expectedMatch.product.title,
      vendor: expectedMatch.product.vendor || null,
      matchScore: Math.round(expectedMatch.score),
      detectedAt: heliosNow()
    };
  }

  shopPipe.candidateCount = candidates.length;
  shopPipe.collectiveTotal = allProducts.length;
  shopPipe.lastCollectiveCheckAt = heliosNow();

  mission.events = [
    ...(Array.isArray(mission.events) ? mission.events : []),
    {
      at: heliosNow(),
      type: "COLLECTIVE_CANDIDATE_CHECK",
      trigger,
      totalCollectiveProducts: allProducts.length,
      eligibleCandidates: candidates.length,
      newlyImported: newlyImported.length,
      expectedImport: shopPipe.expectedImport?.title || null,
      expectedImportDetected: shopPipe.expectedImportDetected?.title || null
    }
  ];

  if (!candidates.length) {
    shopPipe.status = "WAITING";
    shopPipe.step = "WAITING_FOR_COLLECTIVE";
    shopPipe.progress = Math.max(Number(shopPipe.progress || 0), 34);
    shopPipe.reason = "NO_NEW_COLLECTIVE_CANDIDATES";

    mission.status = "WAITING";
    mission.checkpoint = "WAITING_FOR_COLLECTIVE";
    mission.progress = Math.max(Number(mission.progress || 0), 28);
    mission.updatedAt = heliosNow();

    mission.decisionRequired = {
      type: "OWNER_ACTION",
      store: "SHOPIFY",
      reason:
        "Shopify Collective richiede l'azione iniziale nella UI per cercare/importare o connettere il fornitore."
    };

    const attempt = Number(shopPipe.collectiveSearchAttempt || 0);

    return {
      ok: true,
      mission,
      actionCard: heliosCollectiveWaitingCard({
        mission,
        opportunity,
        attempt
      })
    };
  }

  shopPipe.status = "ACTIVE";
  shopPipe.step = "ANALYZING_COLLECTIVE_CANDIDATES";
  shopPipe.progress = Math.max(Number(shopPipe.progress || 0), 42);
  shopPipe.reason = null;

  mission.status = "ACTIVE";
  mission.checkpoint = "ANALYZING_COLLECTIVE_CANDIDATES";
  mission.progress = Math.max(Number(mission.progress || 0), 42);
  mission.updatedAt = heliosNow();
  mission.decisionRequired = null;

  const match = await heliosRankCollectiveCandidates(
    opportunity,
    candidates
  );

  if (match.error) {
    shopPipe.status = "WAITING";
    shopPipe.step = "PRODUCT_MATCH_RETRY";
    shopPipe.reason = match.error;

    mission.status = "WAITING";
    mission.checkpoint = "PRODUCT_MATCH_RETRY";
    mission.updatedAt = heliosNow();

    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "PRODUCT MATCH PAUSED",
        message:
          "HELIOS ha rilevato i prodotti Collective ma l'analisi semantica non è stata completata. Nessun prodotto è stato pubblicato.",
        reason: match.error,
        missionId: mission.id,
        state: "WAITING",
        actions: [
          {
            id: "CHECK_IMPORT_RESUME",
            label: "RETRY ANALYSIS",
            type: "LOCAL"
          }
        ]
      })
    };
  }

  if (match.emptyMatch) {
    const rejectedNow = candidates
      .map((p) => p.id)
      .filter(Boolean);

    shopPipe.rejectedProductIds = [
      ...new Set([
        ...(Array.isArray(shopPipe.rejectedProductIds)
          ? shopPipe.rejectedProductIds
          : []),
        ...rejectedNow
      ])
    ];

    shopPipe.collectiveSnapshot = {
      capturedAt: heliosNow(),
      ids: allProducts.map((p) => p.id).filter(Boolean)
    };

    shopPipe.collectiveSearchAttempt =
      Number(shopPipe.collectiveSearchAttempt || 0) + 1;

    shopPipe.status = "WAITING";
    shopPipe.step = "BETTER_COLLECTIVE_MATCH_REQUIRED";
    shopPipe.progress = 38;
    shopPipe.reason = "SUPPLIER_CATALOG_MISMATCH";
    shopPipe.matchDiagnostics = match;

    mission.status = "WAITING";
    mission.checkpoint = "BETTER_COLLECTIVE_MATCH_REQUIRED";
    mission.progress = Math.max(Number(mission.progress || 0), 38);
    mission.updatedAt = heliosNow();

    mission.decisionRequired = {
      type: "OWNER_ACTION",
      store: "SHOPIFY",
      reason:
        "I candidati importati non sono abbastanza coerenti con l'opportunità."
    };

    const nextAttempt = Number(shopPipe.collectiveSearchAttempt || 0);

    if (nextAttempt >= HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS) {
      return heliosAdvanceOpportunity(mission, {
        reason: "COLLECTIVE_CANDIDATE_MATCH_LIMIT_REACHED"
      });
    }

    const nextPlan = heliosCollectiveSearchPlan(
      opportunity,
      nextAttempt
    );

    return {
      ok: true,
      mission,
      candidateCount: candidates.length,
      rejectedProductIds: rejectedNow,
      actionCard: heliosCollectiveWaitingCard({
        mission,
        opportunity,
        attempt: nextAttempt,
        title: "NO STRONG COLLECTIVE MATCH",
        message:
          `HELIOS ha analizzato ${candidates.length} candidati e li ha scartati perché non abbastanza coerenti con “${opportunity.name || "l'opportunità corrente"}”. ` +
          `Prossima ricerca consigliata: “${nextPlan.query}”.`,
        reason: "SUPPLIER_CATALOG_MISMATCH",
        completed: [
          "GLOBAL MARKET SCAN",
          "OPPORTUNITY RANKING",
          "CANDIDATE ANALYSIS"
        ],
        pending: [
          "BETTER COLLECTIVE IMPORT",
          "PRODUCT MATCH",
          "QUALITY GATE",
          "PUBLISH"
        ]
      })
    };
  }

  const bestMatch = match.matches[0];
  const product = candidates[bestMatch.index];

  if (!product) {
    shopPipe.status = "WAITING";
    shopPipe.step = "PRODUCT_MATCH_RETRY";
    shopPipe.reason = "MATCH_INDEX_INVALID";

    mission.status = "WAITING";
    mission.checkpoint = "PRODUCT_MATCH_RETRY";
    mission.updatedAt = heliosNow();

    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "PRODUCT MATCH RETRY",
        message:
          "Il ranking ha restituito un candidato non più disponibile. HELIOS non pubblica e ripeterà il controllo.",
        reason: "MATCH_INDEX_INVALID",
        missionId: mission.id,
        actions: [
          {
            id: "CHECK_IMPORT_RESUME",
            label: "CHECK AGAIN",
            type: "LOCAL"
          }
        ]
      })
    };
  }

  const score = heliosPhysicalScore(
    product,
    bestMatch
  );

  let optimization =
    await heliosOptimizeCollectiveListing(
      product,
      opportunity
    );

  shopPipe.product = {
    id: product.id,
    legacyId: product.legacyId,
    title: product.title,
    vendor: product.vendor,
    status: product.status,
    inventory: product.inventory,
    image: product.image,
    descriptionHtml: product.descriptionHtml || "",
    onlineStoreUrl: product.onlineStoreUrl || null,
    variants: product.variants
  };

  shopPipe.match = bestMatch;
  shopPipe.score = score;
  shopPipe.progress = 56;
  shopPipe.lastEvaluatedImport = {
    ...(shopPipe.expectedImport || {}),
    productId: product.id,
    actualTitle: product.title,
    actualVendor: product.vendor || null,
    fit: Math.round(bestMatch.fit || 0),
    evaluatedAt: heliosNow()
  };

  if (!optimization.ok) {
    shopPipe.status = "WAITING";
    shopPipe.step = "LISTING_INTELLIGENCE_FAILED";
    shopPipe.reason = optimization.error;

    mission.status = "WAITING";
    mission.checkpoint = "LISTING_INTELLIGENCE_FAILED";
    mission.progress = 56;
    mission.updatedAt = heliosNow();

    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "LISTING INTELLIGENCE PAUSED",
        message:
          "HELIOS ha trovato il prodotto ma non completa la listing finché l'ottimizzazione non è sufficientemente affidabile.",
        reason: optimization.error,
        missionId: mission.id,
        actions: [
          {
            id: "CHECK_IMPORT_RESUME",
            label: "RETRY ANALYSIS",
            type: "LOCAL"
          }
        ]
      })
    };
  }

  let gate = heliosQualityGate({
    product,
    score,
    optimization
  });

  let repairAttempts = 0;

  while (
    !gate.pass &&
    gate.hardPass &&
    optimization?.commerceShield?.risk !== "HIGH" &&
    optimization?.commerceShield?.risk !== "BLOCKED" &&
    repairAttempts < 2
  ) {
    repairAttempts += 1;

    const repaired =
      await heliosOptimizeCollectiveListing(
        product,
        opportunity,
        {
          repairContext: {
            attempt: repairAttempts,
            gate,
            quality: optimization?.quality || null
          }
        }
      );

    if (!repaired?.ok) {
      break;
    }

    optimization = repaired;
    gate = heliosQualityGate({
      product,
      score,
      optimization
    });
  }

  shopPipe.qualityRepairAttempts =
    Number(shopPipe.qualityRepairAttempts || 0) +
    repairAttempts;

  shopPipe.optimization = optimization;
  shopPipe.qualityGate = gate;
  shopPipe.progress = 68;

  if (!gate.pass) {
    const hardBlocked =
      !gate.hardPass ||
      optimization?.commerceShield?.risk === "BLOCKED";

    if (hardBlocked) {
      shopPipe.rejectedProductIds = [
        ...new Set([
          ...(Array.isArray(shopPipe.rejectedProductIds)
            ? shopPipe.rejectedProductIds
            : []),
          product.id
        ])
      ];

      const autoCandidateRetries =
        Number(shopPipe.autoCandidateRetries || 0);

      const remainingCandidates =
        allProducts.filter(
          (p) =>
            p?.id &&
            !shopPipe.rejectedProductIds.includes(p.id) &&
            p.status !== "ARCHIVED"
        );

      if (
        !shopPipe.expectedImport &&
        remainingCandidates.length &&
        autoCandidateRetries < 3
      ) {
        shopPipe.autoCandidateRetries =
          autoCandidateRetries + 1;

        mission.events = [
          ...(Array.isArray(mission.events)
            ? mission.events
            : []),
          {
            at: heliosNow(),
            type: "COLLECTIVE_CANDIDATE_AUTO_REJECTED",
            productId: product.id,
            title: product.title,
            nextCandidateCount:
              remainingCandidates.length
          }
        ];

        return heliosAnalyzeCollectiveCandidates({
          mission,
          products: allProducts,
          trigger: "AUTO_REJECT_NEXT_CANDIDATE",
          autoPublish
        });
      }

      shopPipe.collectiveSnapshot = {
        capturedAt: heliosNow(),
        ids: allProducts.map((p) => p.id).filter(Boolean)
      };

      shopPipe.collectiveSearchAttempt =
        Number(shopPipe.collectiveSearchAttempt || 0) + 1;

      shopPipe.status = "WAITING";
      shopPipe.step = "QUALITY_REJECTED";
      shopPipe.reason = "QUALITY_HARD_GATE_REJECTED";

      mission.status = "WAITING";
      mission.checkpoint = "QUALITY_REJECTED";
      mission.progress = 68;
      mission.updatedAt = heliosNow();

      mission.decisionRequired = {
        type: "OWNER_ACTION",
        store: "SHOPIFY",
        reason: "Il candidato è stato scartato da un hard gate."
      };

      const nextAttempt = Number(
        shopPipe.collectiveSearchAttempt || 0
      );

      if (nextAttempt >= HELIOS_MAX_COLLECTIVE_SEARCH_ATTEMPTS) {
        return heliosAdvanceOpportunity(mission, {
          reason: "COLLECTIVE_QUALITY_LIMIT_REACHED"
        });
      }

      return {
        ok: true,
        mission,
        rejectedProduct: shopPipe.product,
        actionCard: heliosCollectiveWaitingCard({
          mission,
          opportunity,
          attempt: nextAttempt,
          title: "CANDIDATE REJECTED BY QUALITY GATE",
          message:
            `VALUTAZIONE COMPLETATA — “${product.title}” NON È STATO PUBBLICATO. ` +
            `Fit ${Math.round(bestMatch.fit || 0)}/100 · HELIOS Score ${Math.round(score.heliosScore || 0)}/100 · ` +
            `Quality ${Math.round(gate.qualityAverage || 0)}/100 · Risk ${optimization?.commerceShield?.risk || "MEDIUM"}. ` +
            `Motivo: ${Object.entries(gate.hardGates || {}).filter(([,v]) => !v).map(([k]) => k).join(", ") || optimization?.commerceShield?.reasons?.join(", ") || "hard gate non superato"}. ` +
            `Il prodotto resta in BOZZA. HELIOS ha preparato il prossimo tentativo senza metterlo online.`,
          reason: "QUALITY_HARD_GATE_REJECTED",
          context: {
            product: shopPipe.product,
            evaluation: { fit: bestMatch.fit, heliosScore: score.heliosScore, qualityAverage: gate.qualityAverage, risk: optimization?.commerceShield?.risk, hardGates: gate.hardGates }
          },
          completed: [
            "SUPPLIER DETECTED",
            "PRODUCT MATCH",
            "COMMERCE SHIELD"
          ],
          pending: [
            "BETTER COLLECTIVE IMPORT",
            "QUALITY GATE",
            "PUBLISH"
          ]
        })
      };
    }

    shopPipe.status = "WAITING";
    shopPipe.step = "QUALITY_DECISION";
    shopPipe.reason = "QUALITY_REPAIR_REQUIRED";

    mission.status = "WAITING";
    mission.checkpoint = "QUALITY_DECISION";
    mission.progress = 68;
    mission.updatedAt = heliosNow();

    mission.decisionRequired = {
      type: "QUALITY_GATE",
      store: "SHOPIFY",
      reason: "QUALITY_REPAIR_REQUIRED"
    };

    return {
      ok: true,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "QUALITY REPAIR REQUIRED",
        message:
          `VALUTAZIONE COMPLETATA — “${product.title}” non è ancora LIVE. Fit ${Math.round(bestMatch.fit || 0)}/100 · HELIOS Score ${Math.round(score.heliosScore || 0)}/100 · Quality ${Math.round(gate.qualityAverage || 0)}/100. HELIOS ha già eseguito i tentativi di self-repair disponibili e non pubblicherà finché il gate non passa.`,
        reason: JSON.stringify(gate.hardGates),
        missionId: mission.id,
        state: "WAITING",
        context: {
          product: shopPipe.product,
          qualityGate: gate
        },
        actions: [
          {
            id: "CHECK_IMPORT_RESUME",
            label: "SELF-REPAIR & RETRY",
            type: "LOCAL"
          },
          {
            id: "VIEW_PRODUCT",
            label: "VIEW PRODUCT",
            type: "LOCAL"
          }
        ]
      })
    };
  }

  shopPipe.status = "READY_TO_PUBLISH";
  shopPipe.expectedImport = null;
  shopPipe.recommendedCollectiveCandidate = null;
  shopPipe.step = "QUALITY_GATE_PASSED";
  shopPipe.progress = 78;
  shopPipe.reason = null;

  mission.status = "ACTIVE";
  mission.checkpoint = "SHOPIFY_READY_TO_PUBLISH";
  mission.progress = 78;
  mission.updatedAt = heliosNow();
  mission.decisionRequired = null;

  mission.events.push({
    at: heliosNow(),
    type: "COLLECTIVE_PRODUCT_SELECTED",
    productId: product.id,
    title: product.title,
    vendor: product.vendor,
    fit: bestMatch.fit,
    heliosScore: score.heliosScore
  });

  const shouldAutoPublish =
    autoPublish &&
    mission?.policy?.autoPublishFirstProduct !== false &&
    (
      !mission?.policy?.firstProductCompleted ||
      mission?.policy?.autoPublishNextProductAuthorized === true
    );

  if (shouldAutoPublish) {
    const published =
      await heliosPublishMissionProduct(
        mission,
        {
          store: "SHOPIFY"
        }
      );

    if (published?.ok && published?.mission) {
      published.mission.policy = {
        ...(published.mission.policy || {}),
        firstProductCompleted: true,
        autoPublishNextProductAuthorized: false
      };

      published.autoPublished = true;
      published.resumeTrigger = trigger;
    }

    return published;
  }

  return {
    ok: true,
    mission,
    candidateCount: candidates.length,
    selectedProduct: shopPipe.product,
    selectedMatch: bestMatch,
    score,
    actionCard: heliosActionCard({
      severity: "IMPORTANT",
      title: "COLLECTIVE PRODUCT SELECTED",
      message:
        `HELIOS ha scelto “${product.title}” (${product.vendor || "Shopify Collective"}) tra ${candidates.length} candidati. ` +
        "Quality Gate superato: il prodotto è pronto per la pubblicazione.",
      reason: "SHOPIFY_READY_TO_PUBLISH",
      missionId: mission.id,
      state: "CHECKPOINT",
      completed: [
        "SUPPLIER DETECTED",
        "PRODUCT MATCH",
        "LISTING INTELLIGENCE",
        "COMMERCE SHIELD",
        "QUALITY GATE"
      ],
      pending: ["PUBLISH"],
      context: {
        product: shopPipe.product,
        opportunity: heliosOpportunityIntelligence(
          opportunity,
          Number(shopPipe.collectiveSearchAttempt || 0)
        )
      },
      actions: [
        {
          id: "VIEW_PRODUCT",
          label: "VIEW PRODUCT",
          type: "LOCAL"
        }
      ]
    })
  };
}

function heliosNewMission(stores, objective = "") {
  return {
    id: heliosId("HM"),
    version: HELIOS_VERSION,
    status: "ACTIVE",
    mode: "FULL_AUTO",
    selectedStores: stores,
    objective:
      objective ||
      "Find the highest-value commercial opportunity.",
    createdAt: heliosNow(),
    updatedAt: heliosNow(),
    checkpoint: "SMART_LAUNCH",
    progress: 5,
    capital: {
      initialPersonalCap:
        HELIOS_DEFAULT_INITIAL_CAPITAL,
      personalSpent: 0,
      availableGeneratedProfit: 0,
      autoReinvestMaxPct:
        HELIOS_AUTO_REINVEST_MAX_PCT
    },
    policy: {
      autoPublishFirstProduct: true,
      firstProductCompleted: false,
      checkpointAfterEachPublishedProduct: true,
      neverPublishBlockedProduct: true
    },
    pipelines: {},
    events: [
      {
        at: heliosNow(),
        type: "MISSION_STARTED",
        stores
      }
    ],
    decisionRequired: null
  };
}

async function heliosRunMissionStart(body) {
  const stores = heliosSelectedStores(body);

  if (!stores.length) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "NO STORE SELECTED",
        message:
          "Seleziona almeno uno store nella card HELIOS prima di avviare la missione.",
        reason: "STORE_SELECTION_REQUIRED",
        actions: [
          {
            id: "SELECT_STORE",
            label: "SELECT STORE",
            type: "LOCAL"
          }
        ]
      })
    };
  }

  const mission = heliosNewMission(
    stores,
    body.objective || ""
  );

  if (stores.includes("ETSY")) {
    const etsyReady = Boolean(
      process.env.ETSY_API_KEY &&
      process.env.ETSY_SHARED_SECRET &&
      process.env.ETSY_ACCESS_TOKEN &&
      process.env.ETSY_SHOP_ID
    );

    mission.pipelines.ETSY = etsyReady
      ? {
          status: "READY",
          step: "MARKET_SCAN",
          progress: 5
        }
      : {
          status: "WAITING",
          step: "CONNECT_STORE",
          progress: 0,
          reason: "ETSY_NOT_CONNECTED"
        };
  }

  if (stores.includes("SHOPIFY")) {
    mission.pipelines.SHOPIFY = {
      status: "ACTIVE",
      step: "MARKET_SCAN",
      progress: 5,
      collectiveSearchAttempt: 0,
      rejectedProductIds: []
    };
  }

  const scan = await heliosGlobalMarketScan(
    stores,
    mission.objective,
    { avoidOpportunityFamilies: body?.avoidOpportunityFamilies || [] }
  );

  if (
    !scan.ok ||
    !scan.opportunities.length ||
    scan.sourceConfidence === "LOW"
  ) {
    mission.status = "WAITING";
    mission.checkpoint = "MARKET_SCAN_FAILED";
    mission.progress = 10;
    mission.updatedAt = heliosNow();

    mission.decisionRequired = {
      type: "CONFIGURATION_OR_DATA",
      reason:
        scan.error ||
        (scan.sourceConfidence === "LOW"
          ? "LOW_MARKET_SOURCE_CONFIDENCE"
          : "INSUFFICIENT_MARKET_EVIDENCE")
    };

    return {
      ok: false,
      mission,
      scan,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "MARKET INTELLIGENCE PAUSED",
        message:
          "HELIOS non ha abbastanza segnali affidabili per scegliere un'opportunità senza inventare dati.",
        reason:
          scan.error ||
          (scan.sourceConfidence === "LOW"
            ? "LOW_MARKET_SOURCE_CONFIDENCE"
            : "INSUFFICIENT_MARKET_EVIDENCE"),
        missionId: mission.id,
        state: "WAITING",
        actions: [
          {
            id: "RETRY_SCAN",
            label: "RETRY SCAN",
            type: "BACKEND"
          }
        ]
      })
    };
  }

  mission.marketScan = {
    sourceConfidence: scan.sourceConfidence,
    opportunities: scan.opportunities.slice(0, 10)
  };

  mission.checkpoint = "OPPORTUNITY_SELECTED";
  mission.progress = 28;
  mission.updatedAt = heliosNow();

  for (const store of stores) {
    const opp = scan.opportunities.find(
      (o) =>
        Array.isArray(o.channelFit) &&
        o.channelFit.includes(store)
    );

    if (!opp) {
      mission.pipelines[store] = {
        status: "WAITING",
        step: "NO_VALID_OPPORTUNITY",
        progress: 20,
        reason: "NO_VALID_OPPORTUNITY"
      };

      continue;
    }

    mission.pipelines[store] = {
      ...(mission.pipelines[store] || {}),
      status:
        store === "ETSY" &&
        mission.pipelines[store]?.reason ===
          "ETSY_NOT_CONNECTED"
          ? "WAITING"
          : "ACTIVE",
      step: "OPPORTUNITY_SELECTED",
      progress: 28,
      opportunity: opp
    };
  }

  if (stores.includes("SHOPIFY")) {
    const shopPipe =
      mission.pipelines.SHOPIFY;

    const products =
      await heliosCollectiveProducts({
        limit: 200
      });

    shopPipe.collectiveSnapshot = {
      capturedAt: heliosNow(),
      ids: products.map((p) => p.id).filter(Boolean)
    };

    // Ogni nuova missione parte da un baseline dei prodotti Collective già
    // presenti. HELIOS non riutilizza automaticamente bozze importate da missioni
    // precedenti: aspetta un nuovo import esplicitamente associato alla ricerca
    // corrente, così il Product Match è deterministico e idempotente.
    shopPipe.status = "WAITING";
    shopPipe.step = "WAITING_FOR_COLLECTIVE";
    shopPipe.progress = 34;
    shopPipe.reason = products.length
      ? "WAITING_FOR_NEW_COLLECTIVE_IMPORT"
      : "NO_COLLECTIVE_PRODUCTS_IMPORTED";
    shopPipe.preexistingCollectiveProducts = products.length;

    mission.status = stores.every(
      (s) => mission.pipelines[s]?.status === "WAITING"
    )
      ? "WAITING"
      : "ACTIVE";

    mission.checkpoint = "WAITING_FOR_COLLECTIVE";
    mission.updatedAt = heliosNow();
    mission.decisionRequired = {
      type: "OWNER_ACTION",
      store: "SHOPIFY",
      reason:
        "Shopify Collective richiede l'azione iniziale nella UI per importare il prodotto indicato da HELIOS."
    };

    return {
      ok: true,
      mission,
      scan,
      opportunity: heliosOpportunityIntelligence(
        shopPipe.opportunity,
        0
      ),
      ignoredPreexistingCollectiveProducts: products.length,
      actionCard: heliosCollectiveWaitingCard({
        mission,
        opportunity: shopPipe.opportunity,
        attempt: 0
      }),
      smartLaunch: {
        globalMarket: true,
        selectedStores: stores,
        fullAuto: true,
        initialCapitalCap: HELIOS_DEFAULT_INITIAL_CAPITAL,
        objective: mission.objective
      }
    };
  }

  return {
    ok: true,
    mission,
    scan,
    smartLaunch: {
      globalMarket: true,
      selectedStores: stores,
      fullAuto: true,
      initialCapitalCap:
        HELIOS_DEFAULT_INITIAL_CAPITAL,
      objective: mission.objective
    }
  };
}


async function heliosRetryMissionScan(body) {
  const incoming = body?.mission || null;
  if (!incoming?.id) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "MISSION REQUIRED",
        message: "Non esiste una missione HELIOS da riprovare.",
        reason: "MISSION_MISSING"
      })
    };
  }

  const stores = Array.isArray(incoming.selectedStores)
    ? incoming.selectedStores.map((x) => String(x || "").toUpperCase()).filter(Boolean)
    : heliosSelectedStores(body);

  const avoidOpportunityFamilies = [
    ...new Set([
      ...(Array.isArray(incoming.marketCooldownFamilies) ? incoming.marketCooldownFamilies : []),
      ...(Array.isArray(incoming?.pipelines?.SHOPIFY?.rejectedOpportunityKeys)
        ? incoming.pipelines.SHOPIFY.rejectedOpportunityKeys.map((name) => heliosOpportunityFamily({ name }))
        : [])
    ].map((x) => String(x || "").toUpperCase()).filter(Boolean))
  ];

  const result = await heliosRunMissionStart({
    stores,
    objective: incoming.objective || body?.objective || "Find the highest-value compliant commercial opportunity across diverse product categories.",
    avoidOpportunityFamilies
  });

  if (result?.mission) {
    const oldEvents = Array.isArray(incoming.events) ? incoming.events : [];
    const generatedEvents = Array.isArray(result.mission.events)
      ? result.mission.events.filter((e) => e?.type !== "MISSION_STARTED")
      : [];

    result.mission.id = incoming.id;
    result.mission.createdAt = incoming.createdAt || result.mission.createdAt;
    result.mission.version = HELIOS_VERSION;
    result.mission.events = [
      ...oldEvents,
      { at: heliosNow(), type: "MARKET_SCAN_RETRIED" },
      ...generatedEvents
    ];
    result.mission.marketCooldownFamilies = avoidOpportunityFamilies;
    result.mission.updatedAt = heliosNow();
  }

  if (result?.actionCard) {
    result.actionCard.missionId = incoming.id;
  }

  return {
    ...result,
    retried: true,
    previousMissionId: incoming.id
  };
}

async function heliosResumeMission(body) {
  const incoming = body?.mission || null;

  if (!incoming?.id) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "MISSION REQUIRED",
        message:
          "Non esiste una missione HELIOS da riprendere.",
        reason: "MISSION_MISSING"
      })
    };
  }

  const mission =
    JSON.parse(
      JSON.stringify(incoming)
    );

  const stores =
    Array.isArray(
      mission.selectedStores
    )
      ? mission.selectedStores
          .map((x) =>
            String(x).toUpperCase()
          )
      : heliosSelectedStores(body);

  if (!stores.includes("SHOPIFY")) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "CRITICAL",
        title: "SHOPIFY NOT AUTHORIZED",
        message:
          "La missione corrente non autorizza Shopify.",
        reason:
          "STORE_NOT_ENABLED_FOR_MISSION",
        missionId: mission.id
      })
    };
  }

  mission.selectedStores = stores;
  mission.pipelines =
    mission.pipelines || {};

  mission.pipelines.SHOPIFY =
    mission.pipelines.SHOPIFY || {
      status: "ACTIVE",
      step: "OPPORTUNITY_SELECTED",
      progress: 28,
      collectiveSearchAttempt: 0,
      rejectedProductIds: []
    };

  const shopPipe =
    mission.pipelines.SHOPIFY;

  const opportunity =
    shopPipe.opportunity ||
    mission.marketScan?.opportunities?.find?.(
      (o) =>
        Array.isArray(o?.channelFit) &&
        o.channelFit.includes("SHOPIFY")
    ) ||
    mission.marketScan?.opportunities?.[0] ||
    null;

  if (!opportunity) {
    mission.status = "WAITING";
    mission.checkpoint =
      "OPPORTUNITY_REQUIRED";
    mission.updatedAt = heliosNow();

    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "OPPORTUNITY REQUIRED",
        message:
          "HELIOS non può riprendere il matching Collective perché la missione non contiene l'opportunità selezionata.",
        reason:
          "MISSION_OPPORTUNITY_MISSING",
        missionId: mission.id,
        actions: [
          {
            id: "RETRY_SCAN",
            label: "RETRY SCAN",
            type: "BACKEND"
          }
        ]
      })
    };
  }

  shopPipe.opportunity = opportunity;

  if (
    shopPipe.status === "LIVE" &&
    shopPipe.live?.id
  ) {
    return {
      ok: true,
      mission,
      idempotent: true,
      message:
        "La missione ha già pubblicato il prodotto Shopify e si trova al checkpoint successivo.",
      checkpoint: {
        required: true,
        actions: [
          {
            id: "CONTINUE",
            label: "CONTINUA",
            type: "BACKEND"
          },
          {
            id: "STOP",
            label: "TERMINA",
            type: "BACKEND"
          }
        ]
      }
    };
  }

  const products =
    await heliosCollectiveProducts({
      limit: body?.limit || 200
    });

  const analyzed =
    await heliosAnalyzeCollectiveCandidates({
      mission,
      products,
      trigger:
        body?.trigger ||
        "OWNER_RETURN",
      autoPublish:
        body?.autoPublish !== false
    });

  return {
    ...analyzed,
    resumed: true,
    opportunity:
      heliosOpportunityIntelligence(
        opportunity,
        Number(
          analyzed?.mission?.pipelines
            ?.SHOPIFY
            ?.collectiveSearchAttempt ||
            shopPipe.collectiveSearchAttempt ||
            0
        )
      )
  };
}


async function heliosEvaluateImportedCatalog(body = {}) {
  const incoming = body?.mission || null;

  if (!incoming?.id) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "MISSION REQUIRED",
        message: "Avvia o riprendi una missione HELIOS prima di rivalutare il catalogo importato.",
        reason: "MISSION_MISSING"
      })
    };
  }

  const mission = JSON.parse(JSON.stringify(incoming));
  const stores = Array.isArray(mission.selectedStores)
    ? mission.selectedStores.map((x) => String(x).toUpperCase())
    : heliosSelectedStores(body);

  if (!stores.includes("SHOPIFY")) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "CRITICAL",
        title: "SHOPIFY NOT AUTHORIZED",
        message: "La missione corrente non autorizza Shopify.",
        reason: "STORE_NOT_ENABLED_FOR_MISSION",
        missionId: mission.id
      })
    };
  }

  mission.selectedStores = stores;
  mission.pipelines = mission.pipelines || {};
  mission.pipelines.SHOPIFY = mission.pipelines.SHOPIFY || {
    status: "ACTIVE",
    step: "CATALOG_LAUNCH",
    progress: 42,
    collectiveSearchAttempt: 0,
    rejectedProductIds: []
  };

  const shopPipe = mission.pipelines.SHOPIFY;
  const products = await heliosCollectiveProducts({
    limit: body?.limit || 200
  });
  const imported = products.filter(
    (p) => p?.id && p.status !== "ARCHIVED"
  );

  if (!imported.length) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "NO IMPORTED PRODUCTS",
        message: "Non ci sono prodotti Shopify Collective importati da rivalutare.",
        reason: "NO_COLLECTIVE_PRODUCTS_IMPORTED",
        missionId: mission.id
      })
    };
  }

  // v2.8.2 — CATALOG LAUNCH MODE
  // Questa azione esplicita NON valuta i prodotti contro la nicchia/opportunità
  // corrente. Valuta invece ogni import già presente sulla sua idoneità intrinseca
  // a essere venduto: economia reale, stock, fornitore, Commerce Shield, qualità
  // listing e integrità Shopify. È il comportamento richiesto da EVALUATE & PUBLISH.
  shopPipe.status = "ACTIVE";
  shopPipe.step = "CATALOG_LAUNCH_EVALUATION";
  shopPipe.progress = Math.max(Number(shopPipe.progress || 0), 48);
  shopPipe.reason = null;
  shopPipe.catalogLaunchMode = true;
  shopPipe.expectedImport = null;
  shopPipe.recommendedCollectiveCandidate = null;
  shopPipe.expectedImportDetected = null;
  shopPipe.autoCandidateRetries = 0;
  shopPipe.qualityRepairAttempts = 0;

  mission.status = "ACTIVE";
  mission.checkpoint = "CATALOG_LAUNCH_EVALUATION";
  mission.progress = Math.max(Number(mission.progress || 0), 48);
  mission.decisionRequired = null;
  mission.updatedAt = heliosNow();
  mission.events = [
    ...(Array.isArray(mission.events) ? mission.events : []),
    {
      at: heliosNow(),
      type: "CATALOG_LAUNCH_EVALUATION_STARTED",
      productCount: imported.length
    }
  ];

  // Pre-ranking deterministico: riduce costi AI e dà precedenza ai candidati con
  // economia/stock/listing più solidi. I prodotti chimici non vengono bloccati qui:
  // ricevono solo una penalizzazione prudenziale e passano comunque dal Commerce Shield.
  const ranked = imported
    .map((product) => ({ product, score: heliosCatalogLaunchScore(product) }))
    .sort((a, b) => Number(b.score?.heliosScore || 0) - Number(a.score?.heliosScore || 0));

  const evaluations = [];
  const passing = [];

  for (const item of ranked) {
    const product = item.product;
    const score = item.score;
    const context = {
      name: product?.productType || product?.title || "Catalog Product",
      category: product?.productType || null,
      mode: "CATALOG_LAUNCH",
      objective: "Valuta e ottimizza questo prodotto già importato per uno store multi-nicchia, senza inventare segnali di mercato."
    };

    let optimization = await heliosOptimizeCollectiveListing(
      product,
      context,
      { catalogLaunch: true }
    );

    if (!optimization?.ok) {
      evaluations.push({
        productId: product.id,
        title: product.title,
        vendor: product.vendor || null,
        status: "REJECTED",
        heliosScore: score.heliosScore,
        marginPct: score.economics?.grossMarginPct ?? null,
        inventory: product.inventory ?? null,
        risk: "UNKNOWN",
        reason: `LISTING_INTELLIGENCE_FAILED: ${optimization?.error || "AI unavailable"}`
      });
      continue;
    }

    let gate = heliosCatalogLaunchQualityGate({ product, score, optimization });
    let repairAttempts = 0;

    while (
      !gate.pass &&
      gate.hardPass &&
      optimization?.commerceShield?.risk !== "HIGH" &&
      optimization?.commerceShield?.risk !== "BLOCKED" &&
      repairAttempts < 2
    ) {
      repairAttempts += 1;
      const repaired = await heliosOptimizeCollectiveListing(
        product,
        context,
        {
          catalogLaunch: true,
          repairContext: {
            attempt: repairAttempts,
            gate,
            quality: optimization?.quality || null
          }
        }
      );
      if (!repaired?.ok) break;
      optimization = repaired;
      gate = heliosCatalogLaunchQualityGate({ product, score, optimization });
    }

    const evaluation = {
      productId: product.id,
      title: product.title,
      vendor: product.vendor || null,
      status: gate.pass ? "PASS" : "REJECTED",
      heliosScore: score.heliosScore,
      marginPct: score.economics?.grossMarginPct ?? null,
      inventory: product.inventory ?? null,
      quality: gate.qualityAverage,
      risk: gate.risk,
      reasons: gate.reasons || [],
      repairAttempts
    };
    evaluations.push(evaluation);

    if (gate.pass) {
      passing.push({ product, score, optimization, gate, evaluation });
    }
  }

  shopPipe.catalogEvaluations = evaluations;
  shopPipe.rejectedProductIds = evaluations
    .filter((x) => x.status !== "PASS")
    .map((x) => x.productId)
    .filter(Boolean);
  mission.updatedAt = heliosNow();

  if (!passing.length) {
    shopPipe.status = "WAITING";
    shopPipe.step = "CATALOG_NO_ELIGIBLE_PRODUCT";
    shopPipe.progress = 68;
    shopPipe.reason = "NO_IMPORTED_PRODUCT_PASSED_CATALOG_LAUNCH";

    mission.status = "WAITING";
    mission.checkpoint = "CATALOG_NO_ELIGIBLE_PRODUCT";
    mission.progress = Math.max(Number(mission.progress || 0), 68);
    mission.decisionRequired = {
      type: "CATALOG_REVIEW",
      store: "SHOPIFY",
      reason: "Nessun prodotto importato ha superato tutti i gate Catalog Launch."
    };
    mission.events.push({
      at: heliosNow(),
      type: "CATALOG_LAUNCH_EVALUATION_COMPLETED",
      productCount: imported.length,
      eligibleCount: 0
    });

    const summary = evaluations
      .map((x) => `${x.title}: ${x.status} · Score ${x.heliosScore} · Margin ${x.marginPct ?? "?"}% · Risk ${x.risk}${x.reasons?.length ? ` · ${x.reasons.join(", ")}` : ""}`)
      .join(" | ")
      .slice(0, 4000);

    return {
      ok: true,
      mission,
      catalogEvaluation: true,
      catalogLaunchMode: true,
      evaluatedProductCount: imported.length,
      catalogEvaluations: evaluations,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "NO IMPORTED PRODUCT IS READY TO SELL",
        message:
          `HELIOS ha completato il Catalog Launch su ${imported.length} prodotti già importati. Nessuno ha superato TUTTI i gate, quindi nessuno è stato messo online. ${summary}`,
        reason: "NO_IMPORTED_PRODUCT_PASSED_CATALOG_LAUNCH",
        missionId: mission.id,
        state: "WAITING",
        completed: ["CATALOG READ", "ECONOMICS", "COMMERCE SHIELD", "LISTING QUALITY", "QUALITY GATE"],
        pending: ["NEW ELIGIBLE PRODUCT"],
        context: { evaluations },
        actions: [
          { id: "VIEW_PRODUCTS", label: "VIEW PRODUCTS", type: "LOCAL" },
          { id: "RETRY_SCAN", label: "NEW MARKET SCAN", type: "BACKEND" }
        ]
      })
    };
  }

  // Pubblica il migliore idoneo. Gli altri PASS restano pronti ma il checkpoint
  // dopo il primo prodotto rimane rispettato: nessuna pubblicazione multipla incontrollata.
  passing.sort((a, b) => {
    const aValue = Number(a.score.heliosScore || 0) * 0.7 + Number(a.gate.qualityAverage || 0) * 0.3;
    const bValue = Number(b.score.heliosScore || 0) * 0.7 + Number(b.gate.qualityAverage || 0) * 0.3;
    return bValue - aValue;
  });
  const winner = passing[0];

  shopPipe.product = {
    id: winner.product.id,
    legacyId: winner.product.legacyId,
    title: winner.product.title,
    vendor: winner.product.vendor,
    status: winner.product.status,
    inventory: winner.product.inventory,
    image: winner.product.image,
    descriptionHtml: winner.product.descriptionHtml || "",
    onlineStoreUrl: winner.product.onlineStoreUrl || null,
    variants: winner.product.variants
  };
  shopPipe.score = winner.score;
  shopPipe.match = {
    fit: null,
    growth: null,
    breakout: null,
    saturation: null,
    demand: null,
    reason: "CATALOG_LAUNCH_INTRINSIC_ELIGIBILITY"
  };
  shopPipe.optimization = winner.optimization;
  shopPipe.qualityGate = winner.gate;
  shopPipe.status = "READY_TO_PUBLISH";
  shopPipe.step = "CATALOG_LAUNCH_READY_TO_PUBLISH";
  shopPipe.progress = 82;
  shopPipe.reason = null;

  mission.status = "ACTIVE";
  mission.checkpoint = "CATALOG_LAUNCH_READY_TO_PUBLISH";
  mission.progress = Math.max(Number(mission.progress || 0), 82);
  mission.decisionRequired = null;
  mission.updatedAt = heliosNow();
  mission.events.push({
    at: heliosNow(),
    type: "CATALOG_LAUNCH_WINNER_SELECTED",
    productId: winner.product.id,
    title: winner.product.title,
    heliosScore: winner.score.heliosScore,
    marginPct: winner.score.economics?.grossMarginPct ?? null,
    quality: winner.gate.qualityAverage,
    eligibleCount: passing.length
  });

  const published = await heliosPublishMissionProduct(mission, { store: "SHOPIFY" });
  if (published?.mission) {
    published.mission.pipelines.SHOPIFY.catalogEvaluations = evaluations;
    published.mission.pipelines.SHOPIFY.catalogLaunchMode = true;
    published.mission.events = [
      ...(published.mission.events || []),
      {
        at: heliosNow(),
        type: "CATALOG_LAUNCH_EVALUATION_COMPLETED",
        productCount: imported.length,
        eligibleCount: passing.length,
        publishedProductId: winner.product.id
      }
    ];
  }

  return {
    ...published,
    catalogEvaluation: true,
    catalogLaunchMode: true,
    evaluatedProductCount: imported.length,
    catalogEvaluations: evaluations,
    eligibleProductCount: passing.length,
    selectedCatalogProduct: winner.evaluation
  };
}

async function heliosPublishMissionProduct(mission, { store = "SHOPIFY" } = {}) {
  const target = String(store || "SHOPIFY").toUpperCase();
  if (!mission?.selectedStores?.includes(target)) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "CRITICAL",
        title: "STORE NOT AUTHORIZED",
        message: `${target} non è stato selezionato per questa missione. HELIOS non eseguirà operazioni sul canale.`,
        reason: "STORE_NOT_ENABLED_FOR_MISSION",
        missionId: mission?.id || null
      })
    };
  }

  if (target !== "SHOPIFY") {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "ETSY NOT CONNECTED YET",
        message: "La pipeline Etsy verrà attivata appena lo shop Etsy è aperto e OAuth è collegato.",
        reason: "ETSY_PENDING_SETUP",
        missionId: mission?.id || null
      })
    };
  }

  const pipe = mission?.pipelines?.SHOPIFY;

  if (
    pipe?.status === "LIVE" &&
    pipe?.live?.id
  ) {
    return {
      ok: true,
      mission,
      idempotent: true,
      result: pipe.live,
      checkpoint: {
        required: true,
        message:
          "Il prodotto Shopify è già stato pubblicato per questa missione. HELIOS non ripete la pubblicazione.",
        actions: [
          {
            id: "CONTINUE",
            label: "CONTINUA",
            type: "BACKEND"
          },
          {
            id: "STOP",
            label: "TERMINA",
            type: "BACKEND"
          }
        ]
      }
    };
  }

  if (!pipe || pipe.status !== "READY_TO_PUBLISH" || !pipe.product?.id || !pipe.optimization) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "PRODUCT NOT READY",
        message: "HELIOS non pubblica perché la pipeline Shopify non ha completato Opportunity → Supplier → Quality Gate.",
        reason: pipe?.step || "PIPELINE_INCOMPLETE",
        missionId: mission?.id || null
      })
    };
  }

  if (!pipe.qualityGate?.pass) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "CRITICAL",
        title: "QUALITY GATE NOT PASSED",
        message: "Pubblicazione bloccata da HELIOS Commerce Shield / Quality Gate.",
        reason: "QUALITY_GATE_REQUIRED",
        missionId: mission.id
      })
    };
  }

  const current = (await heliosCollectiveProducts({ limit: 200 }))
    .find((p) => p.id === pipe.product.id);

  if (!current) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "CRITICAL",
        title: "COLLECTIVE PRODUCT NO LONGER AVAILABLE",
        message: "Il prodotto selezionato non è più presente nel catalogo Collective importato. HELIOS non pubblicherà una copia scollegata dal fornitore.",
        reason: "PRODUCT_REMOVED_OR_UNSELLABLE",
        missionId: mission.id,
        actions: [{ id: "REPLACE_PRODUCT", label: "FIND REPLACEMENT", type: "BACKEND" }]
      })
    };
  }

  if (Number(current.inventory || 0) <= 0) {
    return {
      ok: false,
      actionCard: heliosActionCard({
        severity: "IMPORTANT",
        title: "STOCK CHANGED",
        message: "Il prodotto è arrivato a stock zero prima della pubblicazione. HELIOS lo sostituisce invece di vendere senza copertura.",
        reason: "OUT_OF_STOCK",
        missionId: mission.id,
        actions: [{ id: "REPLACE_PRODUCT", label: "FIND REPLACEMENT", type: "BACKEND" }]
      })
    };
  }

  try {
    const applied = await heliosApplyCollectiveListing(
      current,
      pipe.optimization,
      {
        publish: true,
        missionId: mission.id,
        intelligence: {
          score: pipe.score?.heliosScore ?? null,
          growth: pipe.match?.growth ?? pipe.opportunity?.growthPotential ?? null,
          margin: pipe.score?.economics?.grossMarginPct ?? null
        }
      }
    );
    const collection = await heliosUpsertCollection(pipe.optimization.collection, current.id, true);

    const updatedMission = JSON.parse(JSON.stringify(mission));
    updatedMission.status = "CHECKPOINT";
    updatedMission.checkpoint = "PRODUCT_PUBLISHED";
    updatedMission.progress = 100;
    updatedMission.updatedAt = heliosNow();
    updatedMission.pipelines.SHOPIFY.status = "LIVE";
    updatedMission.pipelines.SHOPIFY.step = "PRODUCT_PUBLISHED";
    updatedMission.pipelines.SHOPIFY.progress = 100;
    updatedMission.pipelines.SHOPIFY.live = {
      id: applied.product?.id || current.id,
      title: applied.product?.title || pipe.optimization.listing.title,
      handle: applied.product?.handle || current.handle,
      onlineStoreUrl: applied.product?.onlineStoreUrl || current.onlineStoreUrl || null,
      collection
    };

    updatedMission.policy = {
      ...(updatedMission.policy || {}),
      firstProductCompleted: true
    };

    updatedMission.events = [
      ...(updatedMission.events || []),
      { at: heliosNow(), type: "PRODUCT_PUBLISHED", store: "SHOPIFY", productId: current.id }
    ];

    return {
      ok: true,
      mission: updatedMission,
      result: updatedMission.pipelines.SHOPIFY.live,
      chatCard: {
        type: "HELIOS_PRODUCT_CARD",
        status: "LIVE",
        channel: "SHOPIFY",
        title: applied.product?.title || pipe.optimization.listing.title,
        score: pipe.score?.heliosScore ?? null,
        growth: pipe.match?.growth ?? null,
        margin: pipe.score?.economics?.grossMarginPct ?? null,
        supplier: current.vendor || current.supplierTag || "Collective",
        url: applied.product?.onlineStoreUrl || current.onlineStoreUrl || null,
        storeUrl: applied.product?.onlineStoreUrl || current.onlineStoreUrl || null,
        adminUrl: heliosShopifyAdminUrl(`products/${current.legacyId || ""}`),
        image: current.image || pipe.product?.image || null,
        descriptionHtml: pipe.optimization?.listing?.descriptionHtml || current.descriptionHtml || "",
        price: current.variants?.[0]?.retailPrice ?? null,
        inventory: current.inventory ?? null,
        actions: [
          { id: "VIEW_PRODUCT", label: "VEDI PRODOTTO", type: "LOCAL" },
          { id: "FULL_ANALYSIS", label: "ANALISI COMPLETA", type: "LOCAL" },
          { id: "SHOPIFY", label: "SHOPIFY ↗", type: "LINK", url: heliosShopifyAdminUrl(`products/${current.legacyId || ""}`) }
        ]
      },
      checkpoint: {
        required: true,
        message: "Primo prodotto completato. Per creare/pubblicare un altro prodotto la missione richiede CONTINUA, come da regola HELIOS.",
        actions: [
          { id: "CONTINUE", label: "CONTINUA", type: "BACKEND" },
          { id: "STOP", label: "TERMINA", type: "BACKEND" }
        ]
      }
    };
  } catch (error) {
    return {
      ok: false,
      mission,
      actionCard: heliosActionCard({
        severity: "ACTION_REQUIRED",
        title: "SHOPIFY PUBLISH PAUSED",
        message: "HELIOS ha fermato la missione nel punto esatto della pubblicazione.",
        reason: String(error?.message || error),
        missionId: mission.id,
        state: "WAITING",
        completed: ["MARKET", "SUPPLIER", "LISTING", "QUALITY GATE"],
        pending: ["PUBLISH"],
        actions: [
          { id: "OPEN_PRODUCT", label: "OPEN SHOPIFY", type: "LINK", url: heliosShopifyAdminUrl(`products/${pipe.product.legacyId || ""}`) },
          { id: "RETRY_PUBLISH", label: "RETRY", type: "BACKEND" }
        ]
      })
    };
  }
}


export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res
      .status(200)
      .end();
  }

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({
        error: "Usa POST"
      });
  }

  try {
    const body =
      req.body || {};

    // ============================================================
    // CORTEX — VOCE (ElevenLabs TTS)
    // ============================================================
    if (body.action === "tts") {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) {
        return res.status(500).json({ error: "ELEVENLABS_API_KEY mancante" });
      }
      const text = (body.text || "").toString().trim().slice(0, 800);
      if (!text) {
        return res.status(400).json({ error: "text mancante" });
      }
      const voiceId = (body.voiceId || "EXAVITQu4vr4xnSDxMaL").toString();
      const vs = body.voice_settings || {};
      const stability = typeof vs.stability === "number" ? vs.stability : 0.55;
      const similarity = typeof vs.similarity_boost === "number" ? vs.similarity_boost : 0.85;
      const style = typeof vs.style === "number" ? vs.style : 0.25;
      const speed = typeof body.speed === "number" ? Math.min(Math.max(body.speed, 0.7), 1.2) : 1.0;
      try {
        const r = await fetch(
          "https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId),
          {
            method: "POST",
            headers: {
              "xi-api-key": key,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text,
              model_id: "eleven_multilingual_v2",
              voice_settings: { stability, similarity_boost: similarity, style, use_speaker_boost: true, speed },
            }),
          }
        );
        if (!r.ok) {
          const t = await r.text();
          return res.status(r.status).json({ error: "Errore ElevenLabs", detail: t.slice(0, 300) });
        }
        const buf = Buffer.from(await r.arrayBuffer());
        return res.status(200).json({ ok: true, audio: buf.toString("base64"), mime: "audio/mpeg" });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // IRIDE — RICERCA FOTO PEXELS
    // ============================================================

    if (
      body.action === "pexels"
    ) {
      const pk =
        process.env.PEXELS_API_KEY;

      if (!pk) {
        return res
          .status(500)
          .json({
            error:
              "PEXELS_API_KEY mancante"
          });
      }

      const query =
        encodeURIComponent(
          body.query || "business"
        );

      const per =
        Math.min(
          Math.max(
            parseInt(
              body.per_page
            ) || 9,
            1
          ),
          15
        );

      const pr =
        await fetch(
          `https://api.pexels.com/v1/search?query=${query}&per_page=${per}&orientation=landscape`,
          {
            headers: {
              Authorization: pk
            }
          }
        );

      const pd =
        await pr.json();

      if (!pr.ok) {
        return res
          .status(pr.status)
          .json({
            error:
              pd?.error ||
              "Errore Pexels"
          });
      }

      const photos =
        (pd.photos || [])
          .map((p) => ({
            src:
              p.src?.large ||
              p.src?.medium,

            thumb:
              p.src?.tiny,

            alt:
              p.alt || "",

            author:
              p.photographer || "",

            url:
              p.url || ""
          }));

      return res
        .status(200)
        .json({
          photos
        });
    }

    // ============================================================
    // PULSUS / LUMEN — GENERAZIONE VIDEO
    // ============================================================

    if (
      body.action === "video"
    ) {
      const ck =
        process.env.CREATOMATE_API_KEY;

      const pk =
        process.env.PEXELS_API_KEY;

      if (!ck) {
        return res
          .status(500)
          .json({
            error:
              "CREATOMATE_API_KEY mancante"
          });
      }

      if (!pk) {
        return res
          .status(500)
          .json({
            error:
              "PEXELS_API_KEY mancante"
          });
      }

      const script =
        (body.script || "")
          .toString()
          .trim();

      if (!script) {
        return res
          .status(400)
          .json({
            error:
              "script mancante (il testo da leggere)"
          });
      }

      const query =
        (
          body.query ||
          "abstract background"
        )
          .toString()
          .trim();

      const voiceId =
        (
          body.voiceId ||
          "XrExE9yKIg1WjnnlVkGX"
        )
          .toString()
          .trim();

      const per = 15;

      const vr =
        await fetch(
          `https://api.pexels.com/videos/search?query=${encodeURIComponent(
            query
          )}&orientation=portrait&per_page=${per}`,
          {
            headers: {
              Authorization:
                pk
            }
          }
        );

      const vd =
        await vr.json();

      if (!vr.ok) {
        return res
          .status(vr.status)
          .json({
            error:
              vd?.error ||
              "Errore Pexels video"
          });
      }

      const videos =
        vd.videos || [];

      if (!videos.length) {
        return res
          .status(404)
          .json({
            error:
              `Nessuna clip Pexels per "${query}"`
          });
      }

      const pick =
        videos[
          Math.floor(
            Math.random() *
              videos.length
          )
        ];

      const files =
        (
          pick.video_files ||
          []
        )
          .filter(
            (f) =>
              f.file_type ===
                "video/mp4" &&
              (f.height || 0) >=
                (f.width || 0)
          )
          .sort(
            (a, b) =>
              (b.height || 0) -
              (a.height || 0)
          );

      const bgUrl =
        files.length
          ? files[0].link
          : pick.video_files?.[0]
              ?.link || null;

      if (!bgUrl) {
        return res
          .status(404)
          .json({
            error:
              "Nessun file mp4 utilizzabile da Pexels"
          });
      }

      const source = {
        output_format:
          "mp4",

        width:
          1080,

        height:
          1920,

        elements: [
          {
            type:
              "video",

            track:
              1,

            source:
              bgUrl,

            fit:
              "cover",

            loop:
              true,

            volume:
              "0%"
          },

          {
            type:
              "audio",

            id:
              "voce",

            track:
              2,

            source:
              script,

            provider:
              `elevenlabs model_id=eleven_multilingual_v2 voice_id=${voiceId}`
          },

          {
            type:
              "text",

            track:
              3,

            transcript_source:
              "voce",

            transcript_effect:
              "highlight",

            transcript_maximum_length:
              1,

            y:
              "80%",

            width:
              "90%",

            height:
              "35%",

            x_alignment:
              "50%",

            y_alignment:
              "50%",

            font_family:
              "Montserrat",

            font_weight:
              "700",

            font_size:
              "9 vmin",

            fill_color:
              "#ffffff",

            stroke_color:
              "#000000",

            stroke_width:
              "1.6 vmin",

            background_color:
              "rgba(0,0,0,0)",

            text_transform:
              "uppercase"
          }
        ]
      };

      const cr =
        await fetch(
          "https://api.creatomate.com/v1/renders",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              Authorization:
                `Bearer ${ck}`
            },

            body:
              JSON.stringify({
                source
              })
          }
        );

      const cd =
        await cr.json();

      if (!cr.ok) {
        return res
          .status(cr.status)
          .json({
            error:
              "Errore Creatomate",

            details:
              cd
          });
      }

      const render =
        Array.isArray(cd)
          ? cd[0]
          : cd;

      return res
        .status(200)
        .json({
          ok:
            true,

          status:
            render.status,

          id:
            render.id,

          url:
            render.url,

          background_used:
            bgUrl,

          voice_used:
            voiceId
        });
    }

    // ============================================================
    // STATO RENDER VIDEO
    // ============================================================

    if (
      body.action ===
      "video_status"
    ) {
      const ck =
        process.env
          .CREATOMATE_API_KEY;

      if (!ck) {
        return res
          .status(500)
          .json({
            error:
              "CREATOMATE_API_KEY mancante"
          });
      }

      const id =
        (body.id || "")
          .toString()
          .trim();

      if (!id) {
        return res
          .status(400)
          .json({
            error:
              "id mancante"
          });
      }

      const sr =
        await fetch(
          "https://api.creatomate.com/v1/renders/" +
            encodeURIComponent(
              id
            ),
          {
            headers: {
              Authorization:
                `Bearer ${ck}`
            }
          }
        );

      const sd =
        await sr.json();

      if (!sr.ok) {
        return res
          .status(sr.status)
          .json({
            error:
              "Errore stato Creatomate",

            details:
              sd
          });
      }

      return res
        .status(200)
        .json({
          ok:
            true,

          status:
            sd.status ||
            "unknown",

          url:
            sd.status ===
            "succeeded"
              ? sd.url ||
                null
              : null,

          error_message:
            sd.error_message ||
            null
        });
    }

    // ============================================================
    // NERVUS — DATI DI MERCATO
    // ============================================================

    if (
      body.action === "market"
    ) {
      const symbol =
        (body.symbol || "")
          .toString()
          .trim()
          .toUpperCase();

      if (!symbol) {
        return res
          .status(400)
          .json({
            error:
              "symbol mancante"
          });
      }

      const cleanSymbol =
        symbol.replace(
          /[^A-Z]/g,
          ""
        );

      const isCrypto =
        /USDT$|BUSD$|BTC$|ETH$/.test(
          cleanSymbol
        );

      try {
        if (isCrypto) {
          const s =
            cleanSymbol;

          const [t24, kl] =
            await Promise.all([
              fetch(
                "https://api.binance.com/api/v3/ticker/24hr?symbol=" +
                  s
              ).then((r) =>
                r.json()
              ),

              fetch(
                "https://api.binance.com/api/v3/klines?symbol=" +
                  s +
                  "&interval=1h&limit=24"
              ).then((r) =>
                r.json()
              )
            ]);

          if (t24.code) {
            return res
              .status(400)
              .json({
                error:
                  "Simbolo crypto non valido su Binance: " +
                  s
              });
          }

          const closes =
            Array.isArray(kl)
              ? kl.map(
                  (c) =>
                    Number(
                      c[4]
                    )
                )
              : [];

          return res
            .status(200)
            .json({
              ok:
                true,

              source:
                "Binance (live)",

              symbol:
                s,

              price:
                Number(
                  t24.lastPrice
                ),

              changePct:
                Number(
                  t24.priceChangePercent
                ),

              high24h:
                Number(
                  t24.highPrice
                ),

              low24h:
                Number(
                  t24.lowPrice
                ),

              volume:
                Number(
                  t24.volume
                ),

              closes1h:
                closes
            });
        }

        const key =
          process.env
            .TWELVEDATA_API_KEY;

        if (!key) {
          return res
            .status(500)
            .json({
              error:
                "TWELVEDATA_API_KEY mancante"
            });
        }

        const q =
          await fetch(
            "https://api.twelvedata.com/quote?symbol=" +
              encodeURIComponent(
                symbol
              ) +
              "&apikey=" +
              key
          ).then((r) =>
            r.json()
          );

        if (
          q.status ===
            "error" ||
          q.code
        ) {
          return res
            .status(400)
            .json({
              error:
                q.message ||
                "Simbolo non trovato su Twelve Data"
            });
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Twelve Data (ritardato ~ore)",

            symbol,

            price:
              Number(
                q.close
              ),

            changePct:
              Number(
                q.percent_change
              ),

            high24h:
              Number(
                q.high
              ),

            low24h:
              Number(
                q.low
              ),

            volume:
              q.volume
                ? Number(
                    q.volume
                  )
                : null,

            name:
              q.name ||
              null,

            exchange:
              q.exchange ||
              null
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // OCULUS — RICERCA PROSPECT GOOGLE PLACES
    // ============================================================

    if (
      body.action === "places"
    ) {
      return searchPlaces(
        body,
        res
      );
    }

    // ============================================================
    // OCULUS — DOMANDA ATTIVA
    // ============================================================

    if (
      body.action ===
      "paid_demand"
    ) {
      return searchPaidDemand(
        body,
        res
      );
    }

    // ============================================================
    // NERVUS — CANDELE STORICHE
    // ============================================================

    if (
      body.action ===
      "market_series"
    ) {
      const key =
        process.env
          .TWELVEDATA_API_KEY;

      if (!key) {
        return res
          .status(500)
          .json({
            error:
              "TWELVEDATA_API_KEY mancante"
          });
      }

      const symbol =
        (body.symbol || "")
          .toString()
          .trim()
          .toUpperCase();

      if (!symbol) {
        return res
          .status(400)
          .json({
            error:
              "symbol mancante"
          });
      }

      const outputsize =
        Math.min(
          Math.max(
            parseInt(
              body.outputsize
            ) || 60,
            20
          ),
          200
        );

      const allowedInt = [
        "1min",
        "5min",
        "15min",
        "30min",
        "45min",
        "1h",
        "2h",
        "4h",
        "1day",
        "1week"
      ];

      const interval =
        allowedInt.includes(
          String(
            body.interval
          )
        )
          ? String(
              body.interval
            )
          : "1day";

      try {
        const qUrl =
          "https://api.twelvedata.com/quote?symbol=" +
          encodeURIComponent(
            symbol
          ) +
          "&apikey=" +
          key;

        const tsUrl =
          "https://api.twelvedata.com/time_series?symbol=" +
          encodeURIComponent(
            symbol
          ) +
          "&interval=" +
          interval +
          "&outputsize=" +
          outputsize +
          "&order=ASC&apikey=" +
          key;

        const [q, ts] =
          await Promise.all([
            fetch(
              qUrl
            ).then((r) =>
              r.json()
            ),

            fetch(
              tsUrl
            ).then((r) =>
              r.json()
            )
          ]);

        if (
          ts.status ===
            "error" ||
          ts.code
        ) {
          return res
            .status(400)
            .json({
              error:
                ts.message ||
                "Simbolo non valido su Twelve Data"
            });
        }

        const values =
          Array.isArray(
            ts.values
          )
            ? ts.values
            : [];

        const candles =
          values.map(
            (v) => ({
              time:
                v.datetime,

              open:
                Number(
                  v.open
                ),

              high:
                Number(
                  v.high
                ),

              low:
                Number(
                  v.low
                ),

              close:
                Number(
                  v.close
                ),

              volume:
                v.volume !=
                null
                  ? Number(
                      v.volume
                    )
                  : null
            })
          );

        const quote =
          q &&
          !q.code &&
          q.status !==
            "error"
            ? {
                price:
                  q.close !=
                  null
                    ? Number(
                        q.close
                      )
                    : null,

                changePct:
                  q.percent_change !=
                  null
                    ? Number(
                        q.percent_change
                      )
                    : null,

                high:
                  q.high !=
                  null
                    ? Number(
                        q.high
                      )
                    : null,

                low:
                  q.low !=
                  null
                    ? Number(
                        q.low
                      )
                    : null,

                volume:
                  q.volume !=
                  null
                    ? Number(
                        q.volume
                      )
                    : null,

                name:
                  q.name ||
                  null,

                exchange:
                  q.exchange ||
                  null
              }
            : null;

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Twelve Data",

            symbol,

            quote,

            candles
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // NERVUS — CANDELE ALPHA VANTAGE
    // ============================================================

    if (
      body.action ===
      "market_av"
    ) {
      const key =
        process.env
          .ALPHAVANTAGE_API_KEY;

      if (!key) {
        return res
          .status(500)
          .json({
            error:
              "ALPHAVANTAGE_API_KEY mancante"
          });
      }

      const symbol =
        (body.symbol || "")
          .toString()
          .trim()
          .toUpperCase();

      if (!symbol) {
        return res
          .status(400)
          .json({
            error:
              "symbol mancante"
          });
      }

      const isFx =
        symbol.includes(
          "/"
        );

      try {
        let candles = [];
        let quote = null;

        if (isFx) {
          const parts =
            symbol.split(
              "/"
            );

          const from =
            parts[0];

          const to =
            parts[1] ||
            "USD";

          const url =
            "https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=" +
            encodeURIComponent(
              from
            ) +
            "&to_symbol=" +
            encodeURIComponent(
              to
            ) +
            "&outputsize=compact&apikey=" +
            key;

          const d =
            await fetch(
              url
            ).then((r) =>
              r.json()
            );

          if (
            d.Note ||
            d.Information
          ) {
            return res
              .status(429)
              .json({
                error:
                  "Limite Alpha Vantage raggiunto, riprova più tardi."
              });
          }

          const ts =
            d[
              "Time Series FX (Daily)"
            ] || {};

          candles =
            Object.keys(ts)
              .sort()
              .map(
                (time) => ({
                  time,

                  open:
                    Number(
                      ts[time][
                        "1. open"
                      ]
                    ),

                  high:
                    Number(
                      ts[time][
                        "2. high"
                      ]
                    ),

                  low:
                    Number(
                      ts[time][
                        "3. low"
                      ]
                    ),

                  close:
                    Number(
                      ts[time][
                        "4. close"
                      ]
                    ),

                  volume:
                    null
                })
              );

          if (
            candles.length
          ) {
            const last =
              candles[
                candles.length -
                  1
              ];

            const prev =
              candles[
                candles.length -
                  2
              ] || last;

            quote = {
              price:
                last.close,

              changePct:
                prev.close
                  ? ((last.close -
                      prev.close) /
                      prev.close) *
                    100
                  : null,

              high:
                last.high,

              low:
                last.low,

              volume:
                null,

              name:
                from +
                "/" +
                to
            };
          }
        } else {
          const tsUrl =
            "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=" +
            encodeURIComponent(
              symbol
            ) +
            "&outputsize=compact&apikey=" +
            key;

          const qUrl =
            "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=" +
            encodeURIComponent(
              symbol
            ) +
            "&apikey=" +
            key;

          const [
            tsRes,
            qRes
          ] =
            await Promise.all(
              [
                fetch(
                  tsUrl
                ).then(
                  (r) =>
                    r.json()
                ),

                fetch(
                  qUrl
                ).then(
                  (r) =>
                    r.json()
                )
              ]
            );

          if (
            tsRes.Note ||
            tsRes.Information
          ) {
            return res
              .status(429)
              .json({
                error:
                  "Limite Alpha Vantage raggiunto, riprova più tardi."
              });
          }

          const ts =
            tsRes[
              "Time Series (Daily)"
            ] || {};

          candles =
            Object.keys(ts)
              .sort()
              .map(
                (time) => ({
                  time,

                  open:
                    Number(
                      ts[time][
                        "1. open"
                      ]
                    ),

                  high:
                    Number(
                      ts[time][
                        "2. high"
                      ]
                    ),

                  low:
                    Number(
                      ts[time][
                        "3. low"
                      ]
                    ),

                  close:
                    Number(
                      ts[time][
                        "4. close"
                      ]
                    ),

                  volume:
                    ts[time][
                      "5. volume"
                    ] != null
                      ? Number(
                          ts[time][
                            "5. volume"
                          ]
                        )
                      : null
                })
              );

          const gq =
            qRes[
              "Global Quote"
            ] || {};

          const gqPrice =
            gq[
              "05. price"
            ] != null
              ? Number(
                  gq[
                    "05. price"
                  ]
                )
              : null;

          const gqChange =
            gq[
              "10. change percent"
            ] != null
              ? parseFloat(
                  gq[
                    "10. change percent"
                  ]
                )
              : null;

          quote = {
            price:
              gqPrice !=
              null
                ? gqPrice
                : candles.length
                ? candles[
                    candles.length -
                      1
                  ].close
                : null,

            changePct:
              gqChange,

            high:
              gq[
                "03. high"
              ] != null
                ? Number(
                    gq[
                      "03. high"
                    ]
                  )
                : null,

            low:
              gq[
                "04. low"
              ] != null
                ? Number(
                    gq[
                      "04. low"
                    ]
                  )
                : null,

            volume:
              gq[
                "06. volume"
              ] != null
                ? Number(
                    gq[
                      "06. volume"
                    ]
                  )
                : null,

            name:
              symbol
          };
        }

        if (!candles.length) {
          return res
            .status(400)
            .json({
              error:
                "Nessun dato Alpha Vantage per " +
                symbol
            });
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Alpha Vantage",

            symbol,

            quote,

            candles
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // TAVILY — RICERCA WEB REALE (HELIOS / CODEX)
    // ============================================================

    if (
      body.action ===
      "websearch"
    ) {
      const key =
        process.env
          .TAVILY_API_KEY;

      if (!key) {
        return res
          .status(500)
          .json({
            error:
              "TAVILY_API_KEY mancante"
          });
      }

      const query =
        (body.query || "")
          .toString()
          .trim();

      if (!query) {
        return res
          .status(400)
          .json({
            error:
              "query mancante"
          });
      }

      const max =
        Math.min(
          Math.max(
            parseInt(
              body.max_results
            ) || 6,
            1
          ),
          10
        );

      try {
        const r =
          await fetch(
            "https://api.tavily.com/search",
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  api_key:
                    key,

                  query,

                  search_depth:
                    body.deep
                      ? "advanced"
                      : "basic",

                  max_results:
                    max,

                  include_answer:
                    true
                })
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          return res
            .status(
              r.status
            )
            .json({
              error:
                d?.error ||
                "Errore Tavily"
            });
        }

        const results =
          (d.results || [])
            .map(
              (x) => ({
                title:
                  x.title ||
                  "",

                url:
                  x.url ||
                  "",

                content:
                  (
                    x.content ||
                    ""
                  )
                    .toString()
                    .slice(
                      0,
                      500
                    ),

                score:
                  x.score ||
                  null
              })
            );

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Tavily",

            query,

            answer:
              d.answer ||
              null,

            results
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // FIRECRAWL — SCRAPING SITO / URL (CODEX)
    // ============================================================

    if (
      body.action ===
      "scrape"
    ) {
      const key =
        process.env
          .FIRECRAWL_API_KEY;

      if (!key) {
        return res
          .status(500)
          .json({
            error:
              "FIRECRAWL_API_KEY mancante"
          });
      }

      const url =
        (body.url || "")
          .toString()
          .trim();

      if (
        !url ||
        !/^https?:\/\//.test(
          url
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "url mancante o non valido (deve iniziare con http/https)"
          });
      }

      try {
        const r =
          await fetch(
            "https://api.firecrawl.dev/v1/scrape",
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json",

                Authorization:
                  `Bearer ${key}`
              },

              body:
                JSON.stringify({
                  url,

                  formats: [
                    "markdown"
                  ],

                  onlyMainContent:
                    true
                })
            }
          );

        const d =
          await r.json();

        if (
          !r.ok ||
          d.success ===
            false
        ) {
          return res
            .status(
              r.status ||
                502
            )
            .json({
              error:
                d?.error ||
                "Errore Firecrawl"
            });
        }

        const data =
          d.data || {};

        const md =
          (
            data.markdown ||
            ""
          ).toString();

        const meta =
          data.metadata ||
          {};

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Firecrawl",

            url,

            title:
              meta.title ||
              meta.ogTitle ||
              url,

            description:
              meta.description ||
              "",

            markdown:
              md.slice(
                0,
                12000
              ),

            truncated:
              md.length >
              12000
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // COINDESK DATA — PREZZO/INDICE BTC
    // ============================================================

    if (
      body.action ===
      "coindesk"
    ) {
      const key =
        process.env
          .COINDESK_API_KEY;

      if (!key) {
        return res
          .status(500)
          .json({
            error:
              "COINDESK_API_KEY mancante"
          });
      }

      const fsym =
        (
          body.symbol ||
          "BTC"
        )
          .toString()
          .trim()
          .toUpperCase()
          .replace(
            /USDT?$/,
            ""
          );

      const tsym =
        (
          body.vs ||
          "USD"
        )
          .toString()
          .trim()
          .toUpperCase();

      try {
        const r =
          await fetch(
            "https://min-api.cryptocompare.com/data/pricemultifull?fsyms=" +
              encodeURIComponent(
                fsym
              ) +
              "&tsyms=" +
              encodeURIComponent(
                tsym
              ),
            {
              headers: {
                authorization:
                  "Apikey " +
                  key
              }
            }
          );

        const d =
          await r.json();

        if (
          d.Response ===
          "Error"
        ) {
          return res
            .status(400)
            .json({
              error:
                d.Message ||
                "Errore CoinDesk Data"
            });
        }

        const raw =
          d?.RAW?.[fsym]?.[
            tsym
          ];

        if (!raw) {
          return res
            .status(404)
            .json({
              error:
                "Nessun dato CoinDesk per " +
                fsym +
                "/" +
                tsym
            });
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "CoinDesk Data",

            symbol:
              fsym +
              "/" +
              tsym,

            price:
              raw.PRICE ??
              null,

            changePct:
              raw.CHANGEPCT24HOUR ??
              null,

            high:
              raw.HIGH24HOUR ??
              null,

            low:
              raw.LOW24HOUR ??
              null,

            volume:
              raw.TOTALVOLUME24HTO ??
              null,

            supply:
              raw.SUPPLY ??
              null,

            mktcap:
              raw.MKTCAP ??
              null
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // HELIOS v2 — CAPABILITIES / STORE REGISTRY
    // ============================================================
    if (body.action === "helios_capabilities" || body.action === "helios_channels") {
      const stores = [];
      const requestedStores = heliosSelectedStores(body);

      // Shopify
      let shopify = {
        id: "SHOPIFY",
        connected: false,
        status: "NOT_CONNECTED",
        mode: "PHYSICAL_COLLECTIVE",
        enabledForMission: requestedStores.includes("SHOPIFY"),
        capabilities: {},
        scopes: [],
        actionCard: null
      };

      try {
        const [scopes, shopRes, products] = await Promise.all([
          heliosShopifyScopes(),
          shopifyGraphQL(`
            query HeliosShopOverview {
              shop {
                name
                myshopifyDomain
                primaryDomain { url host }
                currencyCode
                billingAddress { countryCodeV2 }
              }
            }
          `),
          heliosCollectiveProducts({ limit: 100 })
        ]);

        const payments = await heliosShopifyPaymentsStatus();
        const mainTheme = await heliosMainTheme();

        shopify = {
          ...shopify,
          connected: true,
          status: "CONNECTED",
          scopes,
          store: {
            name: shopRes?.shop?.name || process.env.SHOPIFY_STORE,
            myshopifyDomain: shopRes?.shop?.myshopifyDomain || `${process.env.SHOPIFY_STORE}.myshopify.com`,
            primaryDomain: shopRes?.shop?.primaryDomain?.url || null,
            currency: shopRes?.shop?.currencyCode || null,
            country: shopRes?.shop?.billingAddress?.countryCodeV2 || null
          },
          payments,
          collective: {
            installedAndUsable: true,
            importedCandidates: products.length,
            note: "Collective Discovery/inviti/accettazioni richiedono la UI Shopify; i prodotti condivisi da fornitori collegati possono essere importati automaticamente e gestiti da HELIOS."
          },
          theme: mainTheme,
          capabilities: {
            readStore: true,
            readProducts: scopes.includes("read_products") || scopes.includes("write_products"),
            writeProducts: scopes.includes("write_products"),
            publishProducts: scopes.includes("write_publications"),
            manageCollections: scopes.includes("write_products"),
            managePages: scopes.includes("write_online_store_pages") || scopes.includes("write_content"),
            manageNavigation: scopes.includes("write_online_store_navigation"),
            readThemes: scopes.includes("read_themes") || scopes.includes("write_themes"),
            writeThemes: scopes.includes("write_themes"),
            readPayments: scopes.includes("read_shopify_payments") || scopes.includes("read_shopify_payments_accounts")
          }
        };
      } catch (error) {
        shopify = {
          ...shopify,
          status: "ERROR",
          error: String(error?.message || error)
        };
      }

      stores.push(shopify);

      // Etsy
      const etsyEnv = {
        apiKey: Boolean(process.env.ETSY_API_KEY),
        sharedSecret: Boolean(process.env.ETSY_SHARED_SECRET),
        accessToken: Boolean(process.env.ETSY_ACCESS_TOKEN),
        shopId: Boolean(process.env.ETSY_SHOP_ID)
      };
      const etsyConnected = Object.values(etsyEnv).every(Boolean);
      stores.push({
        id: "ETSY",
        connected: etsyConnected,
        status: etsyConnected ? "CONNECTED" : "WAITING_SETUP",
        mode: "DIGITAL",
        enabledForMission: requestedStores.includes("ETSY"),
        configuration: etsyEnv,
        capabilities: {
          marketScan: true,
          digitalFactory: true,
          publish: etsyConnected,
          fileUpload: etsyConnected,
          orderMonitoring: etsyConnected
        },
        actionCard:
          etsyConnected || !requestedStores.includes("ETSY")
            ? null
            : heliosActionCard({
              severity: "IMPORTANT",
              title: "ETSY WAITING SETUP",
              message: "Lo shop Etsy non è ancora collegato a HELIOS. Completa l'apertura dello shop e poi OAuth/API.",
              reason: "ETSY_SHOP_NOT_CONNECTED",
              actions: [
                { id: "OPEN_ETSY", label: "OPEN ETSY", type: "LINK", url: "https://www.etsy.com/your/shops/me/dashboard" }
              ]
            })
      });

      return res.status(200).json({
        ok: true,
        heliosVersion: HELIOS_VERSION,
        stores,
        missionRules: {
          storeSelectionRequired: true,
          multiStoreAllowed: true,
          unselectedStoresAreBlocked: true,
          firstProductFullAutoAfterDeploy: true,
          checkpointAfterEachPublishedProduct: true,
          initialPersonalCapitalCap: HELIOS_DEFAULT_INITIAL_CAPITAL,
          maxAutoReinvestmentPct: HELIOS_AUTO_REINVEST_MAX_PCT
        }
      });
    }

    // ============================================================
    // HELIOS v2 — SHOPIFY PERMISSIONS / READINESS
    // ============================================================
    if (body.action === "helios_shopify_permissions") {
      try {
        const scopes = await heliosShopifyScopes();
        const payments = await heliosShopifyPaymentsStatus();
        const theme = await heliosMainTheme();
        const publication = await heliosOnlineStorePublication().catch(() => null);

        const required = {
          products: ["write_products"],
          publications: ["write_publications"],
          paymentsRead: ["read_shopify_payments_accounts"],
          pages: ["write_online_store_pages"],
          navigation: ["write_online_store_navigation"],
          themes: ["write_themes"]
        };

        const status = Object.fromEntries(
          Object.entries(required).map(([key, arr]) => [
            key,
            {
              ready: arr.some((scope) => scopes.includes(scope)) ||
                (key === "paymentsRead" && scopes.includes("read_shopify_payments")) ||
                (key === "pages" && scopes.includes("write_content")),
              acceptedScopes: arr
            }
          ])
        );

        return res.status(200).json({
          ok: true,
          scopes,
          status,
          payments,
          onlineStorePublication: publication,
          theme,
          notes: {
            collectiveDiscoveryApi: false,
            collectiveInvitationsApi: false,
            themeWriteNeedsShopifyExemption: true
          }
        });
      } catch (error) {
        return res.status(500).json({ error: String(error?.message || error) });
      }
    }

    // ============================================================
    // HELIOS v2 — COLLECTIVE PRODUCT VAULT / CANDIDATES
    // ============================================================
    if (body.action === "helios_collective_candidates") {
      const stores = heliosSelectedStores(body);
      if (stores.length && !stores.includes("SHOPIFY")) {
        return res.status(403).json({
          error: "SHOPIFY non è autorizzato per questa missione",
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "STORE NOT AUTHORIZED",
            message: "La missione non include Shopify.",
            reason: "STORE_NOT_ENABLED_FOR_MISSION"
          })
        });
      }

      try {
        const products = await heliosCollectiveProducts({ limit: body.limit || 150 });
        const scored = products.map((product) => ({
          ...product,
          intelligence: heliosPhysicalScore(product, body.market || {})
        }));

        return res.status(200).json({
          ok: true,
          source: "Shopify Collective imported products",
          count: scored.length,
          products: scored
        });
      } catch (error) {
        return res.status(500).json({ error: String(error?.message || error) });
      }
    }

    // ============================================================
    // HELIOS v2 — GLOBAL MARKET INTELLIGENCE
    // ============================================================
    if (body.action === "helios_market_scan") {
      const stores = heliosSelectedStores(body);
      if (!stores.length) {
        return res.status(400).json({
          error: "Seleziona almeno uno store",
          actionCard: heliosActionCard({
            severity: "ACTION_REQUIRED",
            title: "NO STORE SELECTED",
            message: "HELIOS non avvia una scansione commerciale senza sapere su quali store è autorizzato a lavorare.",
            reason: "STORE_SELECTION_REQUIRED"
          })
        });
      }

      const scan = await heliosGlobalMarketScan(stores, body.objective || "", { avoidOpportunityFamilies: body.avoidOpportunityFamilies || [] });
      return res.status(scan.ok ? 200 : 503).json(scan);
    }

    // ============================================================
    // HELIOS v2 — BRAND / STORE ARCHITECT
    // ============================================================
    if (body.action === "helios_brand_plan") {
      const stores = heliosSelectedStores(body);
      if (stores.length && !stores.includes("SHOPIFY")) {
        return res.status(403).json({
          error: "SHOPIFY non selezionato",
          actionCard: heliosActionCard({
            severity: "ACTION_REQUIRED",
            title: "SHOPIFY NOT SELECTED",
            message: "Seleziona Shopify nella card HELIOS prima di chiedere la creazione del sito Shopify.",
            reason: "STORE_NOT_ENABLED_FOR_MISSION"
          })
        });
      }

      const result = await heliosGenerateBrandBlueprint({
        objective: body.objective || "Store principale multi-nicchia",
        opportunities: body.opportunities || body.marketScan?.opportunities || [],
        currentBrand: body.currentBrand || null,
        preferences: body.preferences || null
      });

      return res.status(result.ok ? 200 : 503).json(result);
    }

    if (body.action === "helios_brand_apply") {
      const stores = heliosSelectedStores(body);
      if (!stores.includes("SHOPIFY")) {
        return res.status(403).json({
          error: "SHOPIFY non autorizzato",
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "STORE NOT AUTHORIZED",
            message: "HELIOS non modifica il sito Shopify se Shopify non è selezionato per la missione.",
            reason: "STORE_NOT_ENABLED_FOR_MISSION"
          })
        });
      }

      const blueprint = body.blueprint || null;
      if (!blueprint) {
        return res.status(400).json({ error: "blueprint mancante" });
      }

      const result = await heliosApplyBrandTheme(blueprint, { confirm: body.confirm === true });
      return res.status(result.ok ? 200 : result.requiresConfirmation ? 409 : 424).json(result);
    }

    // ============================================================
    // HELIOS v2 — MISSION ENGINE / SMART LAUNCH
    // ============================================================
    if (body.action === "helios_mission_start") {
      try {
        const result = await heliosRunMissionStart(body);
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({
          error: String(error?.message || error),
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "HELIOS MISSION ERROR",
            message: "La missione è stata fermata senza eseguire nuove pubblicazioni.",
            reason: String(error?.message || error),
            actions: [{ id: "RETRY", label: "RETRY", type: "BACKEND" }]
          })
        });
      }
    }

    if (body.action === "helios_mission_retry_scan") {
      try {
        const result = await heliosRetryMissionScan(body);
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({
          error: String(error?.message || error),
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "HELIOS RETRY ERROR",
            message: "HELIOS non è riuscito a ripetere il Market Scan. Nessun prodotto è stato pubblicato.",
            reason: String(error?.message || error),
            missionId: body?.mission?.id || null,
            actions: [{ id: "RETRY_SCAN", label: "RETRY SCAN", type: "BACKEND" }]
          })
        });
      }
    }

    if (body.action === "helios_ai_health") {
      const configured = {
        gemini: Boolean(process.env.GEMINI_API_KEY),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY)
      };
      const probe = await heliosAIJson(
        'Return exactly this JSON object: {"ok":true,"service":"helios"}',
        { temperature: 0, maxTokens: 256 }
      );

      const providerStatus = {
        gemini: configured.gemini ? "UNTESTED" : "UNAVAILABLE",
        openrouter: configured.openrouter ? "UNTESTED" : "UNAVAILABLE",
        groq: configured.groq ? "UNTESTED" : "UNAVAILABLE"
      };
      for (const d of probe.diagnostics || []) {
        if (!d?.provider || !(d.provider in providerStatus)) continue;
        providerStatus[d.provider] = d.configured === false ? "UNAVAILABLE" : "DEGRADED";
      }
      if (probe.ok && probe.provider && probe.provider in providerStatus) {
        providerStatus[probe.provider] = "AVAILABLE";
      }

      const visionConfigured = {
        gemini: configured.gemini,
        openrouter: configured.openrouter,
        groq: configured.groq
      };

      return res.status(probe.ok ? 200 : 503).json({
        ok: probe.ok,
        heliosVersion: HELIOS_VERSION,
        configured,
        provider: probe.provider || null,
        model: probe.model || null,
        diagnostics: probe.diagnostics || [],
        providerStatus,
        json: {
          ok: probe.ok,
          chain: ["gemini", "openrouter", "groq"],
          provider: probe.provider || null,
          model: probe.model || null
        },
        vision: {
          chain: ["gemini", "openrouter", "groq"],
          configured: visionConfigured,
          openrouterModel: process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || "openrouter/free",
          groqModel: process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b",
          note: "Vision viene verificata realmente durante l'analisi screenshot; un errore Gemini non blocca HELIOS se un fallback riesce."
        },
        error: probe.ok ? null : probe.error
      });
    }

    if (body.action === "helios_mission_status") {
      const mission = body.mission || null;

      if (!mission?.id) {
        return res.status(400).json({
          error: "mission mancante"
        });
      }

      const shopPipe =
        mission?.pipelines?.SHOPIFY ||
        null;

      const opportunity =
        shopPipe?.opportunity ||
        mission?.marketScan?.opportunities?.find?.(
          (o) =>
            Array.isArray(o?.channelFit) &&
            o.channelFit.includes("SHOPIFY")
        ) ||
        null;

      const waitingForCollective = [
        "WAITING_FOR_COLLECTIVE",
        "SUPPLIER_CONNECTION_REQUIRED",
        "BETTER_COLLECTIVE_MATCH_REQUIRED",
        "BETTER_SUPPLIER_REQUIRED",
        "QUALITY_REJECTED",
        "PRODUCT_MATCH_RETRY",
        "OWNER_IMPORT_RECOMMENDED_PRODUCT",
        "MARKET_RESCAN_REQUIRED"
      ].includes(
        String(
          mission?.checkpoint ||
          shopPipe?.step ||
          ""
        )
      );

      return res.status(200).json({
        ok: true,
        heliosVersion: HELIOS_VERSION,
        mission: {
          id: mission.id,
          status: mission.status || null,
          checkpoint: mission.checkpoint || null,
          progress: Number(mission.progress || 0),
          selectedStores: Array.isArray(mission.selectedStores)
            ? mission.selectedStores
            : [],
          decisionRequired: mission.decisionRequired || null,
          updatedAt: mission.updatedAt || null
        },
        shopify: shopPipe
          ? {
              status: shopPipe.status || null,
              step: shopPipe.step || null,
              progress: Number(shopPipe.progress || 0),
              candidateCount: Number(shopPipe.candidateCount || 0),
              collectiveTotal: Number(shopPipe.collectiveTotal || 0),
              searchAttempt: Number(shopPipe.collectiveSearchAttempt || 0),
              rejectedProductIds: Array.isArray(shopPipe.rejectedProductIds)
                ? shopPipe.rejectedProductIds
                : [],
              product: shopPipe.product || null,
              live: shopPipe.live || null
            }
          : null,
        waitingForCollective,
        shouldAutoResumeOnFocus: waitingForCollective,
        opportunity: opportunity
          ? heliosOpportunityIntelligence(
              opportunity,
              Number(shopPipe?.collectiveSearchAttempt || 0)
            )
          : null
      });
    }

    if (body.action === "helios_opportunity_intelligence") {
      const mission = body.mission || null;

      const opportunity =
        body.opportunity ||
        mission?.pipelines?.SHOPIFY?.opportunity ||
        mission?.marketScan?.opportunities?.find?.(
          (o) =>
            Array.isArray(o?.channelFit) &&
            o.channelFit.includes("SHOPIFY")
        ) ||
        mission?.marketScan?.opportunities?.[0] ||
        null;

      if (!opportunity) {
        return res.status(400).json({
          error: "opportunity mancante"
        });
      }

      const attempt =
        Number(
          body.attempt ??
          mission?.pipelines?.SHOPIFY?.collectiveSearchAttempt ??
          0
        ) || 0;

      return res.status(200).json({
        ok: true,
        opportunity:
          heliosOpportunityIntelligence(
            opportunity,
            attempt
          )
      });
    }


    if (body.action === "helios_mission_evaluate_imports") {
      try {
        const result = await heliosEvaluateImportedCatalog(body);
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({
          error: String(error?.message || error),
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "CATALOG EVALUATION ERROR",
            message: "HELIOS ha fermato la rivalutazione del catalogo senza pubblicare stati parziali.",
            reason: String(error?.message || error),
            missionId: body?.mission?.id || null,
            actions: [
              { id: "EVALUATE_IMPORTED_PRODUCTS", label: "RETRY EVALUATION", type: "BACKEND" }
            ]
          })
        });
      }
    }

    if (body.action === "helios_mission_resume") {
      try {
        const result = await heliosResumeMission(body);
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({
          error: String(error?.message || error),
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "MISSION RESUME ERROR",
            message: "HELIOS non ha modificato né pubblicato prodotti perché il resume della missione non è riuscito.",
            reason: String(error?.message || error),
            missionId: body?.mission?.id || null,
            actions: [{ id: "CHECK_IMPORT_RESUME", label: "RETRY CHECK", type: "LOCAL" }]
          })
        });
      }
    }


    if (body.action === "helios_collective_results_analyze") {
      try {
        const result = await heliosAnalyzeCollectiveResultsScreenshot(body);
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({
          error: String(error?.message || error),
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "COLLECTIVE VISION ERROR",
            message: "HELIOS non ha selezionato né pubblicato alcun prodotto perché l'analisi dello screenshot non è riuscita.",
            reason: String(error?.message || error),
            missionId: body?.mission?.id || null,
            actions: [
              { id: "ANALYZE_COLLECTIVE_RESULTS", label: "RETRY SCREENSHOT", type: "LOCAL" },
              { id: "NEXT_SEARCH", label: "NEXT SEARCH", type: "BACKEND" }
            ]
          })
        });
      }
    }

    if (body.action === "helios_mission_next_search") {
      const mission = body.mission || null;
      if (!mission?.id) return res.status(400).json({ error: "mission mancante" });
      try {
        const result = heliosMissionNextSearch(mission, body.reason || "OWNER_REQUESTED_NEXT_SEARCH");
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({ error: String(error?.message || error) });
      }
    }

    if (body.action === "helios_mission_next_opportunity") {
      const mission = body.mission || null;
      if (!mission?.id) return res.status(400).json({ error: "mission mancante" });
      try {
        const result = heliosAdvanceOpportunity(mission, {
          reason: body.reason || "OWNER_REQUESTED_NEXT_OPPORTUNITY"
        });
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({ error: String(error?.message || error) });
      }
    }

    if (body.action === "helios_product_vault") {
      try {
        const products = await heliosManagedProductVault();
        return res.status(200).json({
          ok: true,
          source: "Shopify HELIOS managed products",
          count: products.length,
          products
        });
      } catch (error) {
        return res.status(500).json({ error: String(error?.message || error) });
      }
    }

    if (body.action === "helios_performance") {
      try {
        const data = await heliosProductPerformance();
        return res.status(200).json({ ok: true, ...data });
      } catch (error) {
        return res.status(500).json({ error: String(error?.message || error) });
      }
    }

    if (body.action === "helios_mission_continue") {
      const mission = body.mission || null;
      if (!mission?.id) return res.status(400).json({ error: "mission mancante" });
      const continued = JSON.parse(JSON.stringify(mission));
      continued.policy = {
        ...(continued.policy || {}),
        autoPublishNextProductAuthorized: true
      };
      const result = heliosAdvanceOpportunity(continued, {
        reason: "OWNER_CONTINUE_AFTER_PRODUCT"
      });
      return res.status(result.ok ? 200 : 409).json(result);
    }

    if (body.action === "helios_mission_stop") {
      const mission = body.mission || null;
      if (!mission?.id) return res.status(400).json({ error: "mission mancante" });
      const stopped = {
        ...mission,
        status: "TERMINATED",
        checkpoint: "OWNER_STOPPED",
        decisionRequired: null,
        updatedAt: heliosNow(),
        events: [
          ...(Array.isArray(mission.events) ? mission.events : []),
          { at: heliosNow(), type: "MISSION_TERMINATED_BY_OWNER" }
        ]
      };
      return res.status(200).json({ ok: true, mission: stopped });
    }

    if (body.action === "helios_mission_publish") {
      const mission = body.mission || null;
      if (!mission?.id) {
        return res.status(400).json({ error: "mission mancante" });
      }

      try {
        const result = await heliosPublishMissionProduct(mission, {
          store: body.store || "SHOPIFY"
        });
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        return res.status(500).json({
          error: String(error?.message || error),
          actionCard: heliosActionCard({
            severity: "CRITICAL",
            title: "PUBLISH ERROR",
            message: "HELIOS ha fermato la pubblicazione per evitare uno stato parziale o duplicato.",
            reason: String(error?.message || error),
            missionId: mission.id
          })
        });
      }
    }

    if (body.action === "helios_mission_abort") {
      const mission = body.mission || {};
      const aborted = {
        ...mission,
        status: "ABORTED",
        checkpoint: mission.checkpoint || "UNKNOWN",
        updatedAt: heliosNow(),
        events: [
          ...(Array.isArray(mission.events) ? mission.events : []),
          { at: heliosNow(), type: "MISSION_ABORTED" }
        ]
      };
      return res.status(200).json({ ok: true, mission: aborted });
    }


    // ============================================================
    // HELIOS — SHOPIFY DASHBOARD
    // ============================================================

    if (
      body.action ===
      "shopify_dashboard"
    ) {
      try {
        const [
          shopRes,
          countRes,
          ordersRes
        ] =
          await Promise.all([
            shopifyFetch(
              "/shop.json"
            ),

            shopifyFetch(
              "/products/count.json"
            ),

            shopifyFetch(
              "/orders.json?status=any&limit=50&fields=id,name,total_price,currency,financial_status,created_at,line_items"
            )
          ]);

        const shop =
          shopRes.shop ||
          {};

        const orders =
          ordersRes.orders ||
          [];

        let vendite = 0;

        for (
          const o of orders
        ) {
          vendite +=
            parseFloat(
              o.total_price ||
                0
            ) || 0;
        }

        const recenti =
          orders
            .slice(
              0,
              8
            )
            .map(
              (o) => ({
                nome:
                  o.name,

                totale:
                  parseFloat(
                    o.total_price ||
                      0
                  ) || 0,

                stato:
                  o.financial_status ||
                  "",

                data:
                  o.created_at
              })
            );

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Shopify",

            negozio: {
              nome:
                shop.name ||
                process.env
                  .SHOPIFY_STORE,

              dominio:
                shop.domain ||
                null,

              valuta:
                shop.currency ||
                "EUR",

              email:
                shop.email ||
                null,

              paese:
                shop.country_name ||
                null
            },

            prodotti:
              countRes.count ||
              0,

            ordini:
              orders.length,

            vendite:
              Math.round(
                vendite *
                  100
              ) / 100,

            recenti
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // HELIOS — SHOPIFY PRODOTTI
    // ============================================================

    if (
      body.action ===
      "shopify_products"
    ) {
      try {
        const d =
          await shopifyFetch(
            "/products.json?limit=20"
          );

        const prodotti =
          (
            d.products ||
            []
          ).map(
            (p) => ({
              id:
                p.id,

              titolo:
                p.title,

              stato:
                p.status,

              prezzo:
                p.variants &&
                p.variants[0]
                  ? p
                      .variants[0]
                      .price
                  : null,

              immagine:
                p.image
                  ? p.image
                      .src
                  : null,

              handle:
                p.handle
            })
          );

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Shopify",

            prodotti
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // HELIOS — SHOPIFY CREA PRODOTTO
    // ============================================================

    if (
      body.action ===
      "shopify_create"
    ) {
      const p =
        body.prodotto ||
        {};

      if (!p.titolo) {
        return res
          .status(400)
          .json({
            error:
              "titolo prodotto mancante"
          });
      }

      try {
        const payload = {
          product: {
            title:
              p.titolo,

            body_html:
              p.descrizione ||
              "",

            vendor:
              p.brand ||
              "CORTEX",

            product_type:
              p.categoria ||
              "",

            tags:
              p.tags ||
              "",

            status:
              p.pubblica
                ? "active"
                : "draft",

            variants: [
              {
                price:
                  p.prezzo !=
                  null
                    ? String(
                        p.prezzo
                      )
                    : "0.00"
              }
            ],

            images:
              Array.isArray(
                p.immagini
              )
                ? p.immagini.map(
                    (src) => ({
                      src
                    })
                  )
                : []
          }
        };

        const d =
          await shopifyFetch(
            "/products.json",
            {
              method:
                "POST",

              body:
                JSON.stringify(
                  payload
                )
            }
          );

        const prod =
          d.product ||
          {};

        return res
          .status(200)
          .json({
            ok:
              true,

            source:
              "Shopify",

            id:
              prod.id,

            titolo:
              prod.title,

            handle:
              prod.handle,

            admin_url:
              `https://${process.env.SHOPIFY_STORE}.myshopify.com/admin/products/${prod.id}`
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // HELIOS — STORE STATUS v2 (Shopify reale, senza falsi proxy)
    // ============================================================
    if (body.action === "helios_store_status") {
      try {
        const [shopRes, countRes, ordersRes, payments, collectiveProducts, scopes] = await Promise.all([
          shopifyFetch("/shop.json"),
          shopifyFetch("/products/count.json"),
          shopifyFetch("/orders.json?status=any&limit=100&fields=id,financial_status,fulfillment_status,total_price"),
          heliosShopifyPaymentsStatus(),
          heliosCollectiveProducts({ limit: 100 }).catch(() => []),
          heliosShopifyScopes().catch(() => [])
        ]);

        const shop = shopRes.shop || {};
        const orders = ordersRes.orders || [];
        const paidOrders = orders.filter((o) => (o.financial_status || "") === "paid").length;

        let storefront = "UNKNOWN";
        try {
          const dom = shop.domain || (process.env.SHOPIFY_STORE + ".myshopify.com");
          const sr = await fetch("https://" + dom + "/", { redirect: "follow" });
          const finalUrl = sr.url || "";
          const html = (await sr.text()).slice(0, 5000).toLowerCase();
          if (
            finalUrl.includes("/password") ||
            html.includes('name="password"') ||
            html.includes("opening soon") ||
            html.includes("store is not available")
          ) {
            storefront = "LOCKED";
          } else if (sr.ok) {
            storefront = "LIVE";
          }
        } catch {
          storefront = "UNKNOWN";
        }

        const hasCollectiveCandidates = collectiveProducts.length > 0;
        const collective = hasCollectiveCandidates
          ? "READY_WITH_IMPORTED_PRODUCTS"
          : "READY_NO_SUPPLIER_PRODUCTS";

        return res.status(200).json({
          ok: true,
          source: "Shopify",
          heliosVersion: HELIOS_VERSION,
          store: {
            connected: true,
            name: shop.name || process.env.SHOPIFY_STORE,
            domain: shop.domain || null,
            myshopifyDomain: shop.myshopify_domain || null,
            currency: shop.currency || null,
            country: shop.country_name || null,
            countryCode: (shop.country_code || "").toUpperCase() || null,
            plan: shop.plan_display_name || shop.plan_name || null
          },
          products: countRes.count || 0,
          collectiveProducts: collectiveProducts.length,
          orders: orders.length,
          paidOrders,
          payments,
          scopes,
          statuses: {
            api: "CONNECTED",
            storefront,
            payments: payments.status,
            collective,
            suppliers: hasCollectiveCandidates ? "CONNECTED" : "WAITING_SUPPLIER_CONNECTION",
            fulfillment: hasCollectiveCandidates ? "COLLECTIVE_MANAGED" : "WAITING_PRODUCT",
            themeAutomation: scopes.includes("write_themes") ? "SCOPE_PRESENT" : "PERMISSION_REQUIRED_FOR_THEME_WRITE"
          },
          notes: [
            "Shopify Payments viene verificato tramite shopifyPaymentsAccount quando lo scope lo consente; non viene più dedotto dalla presenza di ordini pagati.",
            "Shopify Collective supporta l'Italia/EUR; HELIOS non applica più il vecchio filtro US/CA.",
            "Discovery e connessione fornitori Collective richiedono la UI Shopify perché non esiste una API pubblica per inviti/accettazioni."
          ]
        });
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    }

    // ============================================================
    // HELIOS — STORE READINESS v2
    // Distingue infrastruttura pronta da catalogo/supplier ancora da popolare.
    // ============================================================
    if (body.action === "helios_store_readiness") {
      try {
        const [shopRes, countRes, payments, collectiveProducts, scopes] = await Promise.all([
          shopifyFetch("/shop.json"),
          shopifyFetch("/products/count.json"),
          heliosShopifyPaymentsStatus(),
          heliosCollectiveProducts({ limit: 100 }).catch(() => []),
          heliosShopifyScopes().catch(() => [])
        ]);

        const shop = shopRes.shop || {};
        const productCount = countRes.count || 0;

        let storefront = "UNKNOWN";
        try {
          const dom = shop.domain || (process.env.SHOPIFY_STORE + ".myshopify.com");
          const sr = await fetch("https://" + dom + "/", { redirect: "follow" });
          const finalUrl = sr.url || "";
          const html = (await sr.text()).slice(0, 5000).toLowerCase();
          if (
            finalUrl.includes("/password") ||
            html.includes('name="password"') ||
            html.includes("opening soon")
          ) storefront = "LOCKED";
          else if (sr.ok) storefront = "LIVE";
        } catch {
          storefront = "UNKNOWN";
        }

        const paymentReady = payments.status === "ACTIVE";
        const paymentUnknownOnlyBecauseScope = payments.status === "UNKNOWN_SCOPE_REQUIRED";
        const collectiveReady = true; // configurato nel negozio; la presenza prodotti dipende dai fornitori collegati.
        const supplierReady = collectiveProducts.length > 0;

        const infrastructureChecks = [
          { key: "api", label: "Shopify API", ok: true, weight: 20 },
          { key: "storefront", label: "Storefront pubblico", ok: storefront === "LIVE", weight: 20 },
          {
            key: "payments",
            label: "Shopify Payments",
            ok: paymentReady,
            unknown: paymentUnknownOnlyBecauseScope,
            weight: 25
          },
          { key: "collective", label: "Shopify Collective", ok: collectiveReady, weight: 20 },
          { key: "graphql", label: "HELIOS GraphQL commerce layer", ok: scopes.includes("write_products"), weight: 15 }
        ];

        const total = infrastructureChecks.reduce((s, c) => s + c.weight, 0);
        const got = infrastructureChecks.reduce(
          (s, c) => s + (c.ok ? c.weight : c.unknown ? c.weight * 0.5 : 0),
          0
        );
        const infrastructureReadiness = Math.round((got / total) * 100);

        const missionChecks = [
          ...infrastructureChecks,
          { key: "supplier", label: "Prodotti da fornitori Collective collegati", ok: supplierReady, weight: 20 }
        ];
        const missionTotal = missionChecks.reduce((s, c) => s + c.weight, 0);
        const missionGot = missionChecks.reduce(
          (s, c) => s + (c.ok ? c.weight : c.unknown ? c.weight * 0.5 : 0),
          0
        );
        const missionReadiness = Math.round((missionGot / missionTotal) * 100);

        return res.status(200).json({
          ok: true,
          readiness: infrastructureReadiness,
          infrastructureReadiness,
          missionReadiness,
          productCount,
          collectiveProducts: collectiveProducts.length,
          checks: missionChecks.map((c) => ({
            key: c.key,
            label: c.label,
            status: c.ok
              ? "READY"
              : c.unknown
              ? "UNKNOWN_SCOPE_REQUIRED"
              : c.key === "storefront" && storefront === "LOCKED"
              ? "LOCKED"
              : c.key === "supplier"
              ? "WAITING_SUPPLIER_CONNECTION"
              : "NOT_READY"
          })),
          actionRequired: supplierReady
            ? null
            : heliosActionCard({
                severity: "IMPORTANT",
                title: "COLLECTIVE SUPPLIER NEEDED",
                message: "L'infrastruttura Shopify è pronta, ma HELIOS non ha ancora prodotti importati da un fornitore Collective collegato.",
                reason: "NO_COLLECTIVE_PRODUCTS_IMPORTED",
                actions: [
                  { id: "OPEN_COLLECTIVE", label: "OPEN COLLECTIVE", type: "LINK", url: heliosCollectiveUrl() }
                ]
              }),
          note: "La readiness non usa più ordini pagati come prova di configurazione Payments e non limita Collective a US/CA."
        });
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    }


    // ============================================================
    // HELIOS — SCORE PRODOTTO (modulare, calcolato in codice)
    // ============================================================
    if (body.action === "helios_score_product") {
      try {
        const p = body.product || {};
        const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
        const retail = num(p.retailPrice);
        const cost = num(p.wholesalePrice);
        const shipping = num(p.shippingCost);
        const trendPercent = num(p.trendPercent);      // es. +31 => 31
        const stock = num(p.stock);
        const deliveryDays = num(p.deliveryDays);
        const competition = (p.competition || "").toString().toUpperCase(); // LOW/MEDIUM/HIGH

        // economia
        let totalCost = null, marginEuro = null, marginPercent = null;
        if (retail != null && cost != null) {
          totalCost = cost + (shipping != null ? shipping : 0);
          marginEuro = Math.round((retail - totalCost) * 100) / 100;
          marginPercent = retail > 0 ? Math.round((marginEuro / retail) * 1000) / 10 : null;
        }

        // sotto-punteggi modulari 0..1 (null se dato assente)
        const parts = [];
        // margine (peso 35)
        let marginScore = null;
        if (marginPercent != null) {
          marginScore = Math.max(0, Math.min(1, marginPercent / 60)); // 60%+ = pieno
          parts.push({ key: "margin", weight: 35, value: marginScore });
        }
        // trend (peso 20)
        let trendScore = null;
        if (trendPercent != null) {
          trendScore = Math.max(0, Math.min(1, (trendPercent + 20) / 80)); // -20%..+60%
          parts.push({ key: "trend", weight: 20, value: trendScore });
        }
        // concorrenza (peso 15)
        let competitionScore = null;
        if (competition === "LOW" || competition === "MEDIUM" || competition === "HIGH") {
          competitionScore = competition === "LOW" ? 1 : competition === "MEDIUM" ? 0.6 : 0.25;
          parts.push({ key: "competition", weight: 15, value: competitionScore });
        }
        // stock (peso 15)
        let stockScore = null;
        if (stock != null) {
          stockScore = stock <= 0 ? 0 : Math.max(0.15, Math.min(1, stock / 200));
          parts.push({ key: "stock", weight: 15, value: stockScore });
        }
        // consegna (peso 15)
        let deliveryScore = null;
        if (deliveryDays != null) {
          deliveryScore = deliveryDays <= 3 ? 1 : deliveryDays <= 7 ? 0.7 : deliveryDays <= 14 ? 0.4 : 0.15;
          parts.push({ key: "delivery", weight: 15, value: deliveryScore });
        }

        const wTot = parts.reduce((s, x) => s + x.weight, 0);
        const wGot = parts.reduce((s, x) => s + x.weight * x.value, 0);
        const score = wTot > 0 ? Math.round((wGot / wTot) * 100) : null;

        // confidence in base a quanti dati abbiamo (su 5 dimensioni)
        const coverage = parts.length / 5;
        const confidence = coverage >= 0.8 ? "HIGH" : coverage >= 0.5 ? "MEDIUM" : "LOW";

        return res.status(200).json({
          ok: true,
          economics: { retail, wholesale: cost, shipping, totalCost, marginEuro, marginPercent },
          subScores: { marginScore, trendScore, competitionScore, stockScore, deliveryScore },
          heliosScore: score,           // null se non calcolabile
          confidence,                    // HIGH/MEDIUM/LOW
          coverage: Math.round(coverage * 100),
          missing: ["retailPrice","wholesalePrice","shippingCost","trendPercent","competition","stock","deliveryDays"]
            .filter((k) => body.product?.[k] == null),
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // OCULUS — INVIO EMAIL
    // ============================================================

    if (
      body.action ===
      "send_email"
    ) {
      const key =
        process.env
          .RESEND_API_KEY;

      if (!key) {
        return res
          .status(500)
          .json({
            error:
              "RESEND_API_KEY mancante"
          });
      }

      const to =
        (body.to || "")
          .toString()
          .trim();

      const subject =
        (body.subject || "")
          .toString()
          .trim();

      const html =
        (
          body.html ||
          ""
        ).toString();

      const from =
        (
          body.from ||
          "CORTEX <oculus@xstudioportfolio.it>"
        ).toString();

      const replyTo =
        (
          body.reply_to ||
          "alessiodifabrizio931@gmail.com"
        ).toString();

      if (
        !to ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(
          to
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "email destinatario non valida"
          });
      }

      if (
        !subject ||
        !html
      ) {
        return res
          .status(400)
          .json({
            error:
              "subject o html mancante"
          });
      }

      try {
        const r =
          await fetch(
            "https://api.resend.com/emails",
            {
              method:
                "POST",

              headers: {
                Authorization:
                  `Bearer ${key}`,

                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  from,
                  to,
                  subject,
                  html,
                  reply_to:
                    replyTo
                })
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          return res
            .status(
              r.status
            )
            .json({
              error:
                d?.message ||
                "Errore Resend",

              detail:
                d
            });
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            id:
              d.id,

            to
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // OCULUS — TROVA EMAIL DA SITO
    // ============================================================

    if (
      body.action ===
      "find_email"
    ) {
      let url =
        (body.url || "")
          .toString()
          .trim();

      if (!url) {
        return res
          .status(400)
          .json({
            error:
              "url mancante"
          });
      }

      if (
        !/^https?:\/\//.test(
          url
        )
      ) {
        url =
          "https://" +
          url;
      }

      const rx =
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

      const bad =
        /(example\.|sentry|wixpress|\.png|\.jpg|\.gif|@2x|u003e|domain\.com)/i;

      const tryFetch =
        async (u) => {
          try {
            const r =
              await fetch(
                u,
                {
                  headers: {
                    "User-Agent":
                      "Mozilla/5.0 CORTEX"
                  }
                }
              );

            if (!r.ok) {
              return null;
            }

            const html =
              await r.text();

            const found =
              (
                html.match(
                  rx
                ) || []
              ).filter(
                (e) =>
                  !bad.test(
                    e
                  )
              );

            return found.length
              ? found[0]
              : null;
          } catch {
            return null;
          }
        };

      try {
        let email =
          await tryFetch(
            url
          );

        if (!email) {
          const base =
            url.replace(
              /\/+$/,
              ""
            );

          for (
            const p of [
              "/contatti",
              "/contact",
              "/contaters",
              "/chi-siamo"
            ]
          ) {
            email =
              await tryFetch(
                base + p
              );

            if (email) {
              break;
            }
          }
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            email:
              email ||
              null,

            url
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // OCULUS — REMOTIVE
    // ============================================================

    if (
      body.action ===
      "remoteok"
    ) {
      return searchRemotive(
        body,
        res
      );
    }

    // ============================================================
    // NOTION — FUNZIONI COMUNI
    // ============================================================

    const notionH =
      () => ({
        Authorization:
          `Bearer ${process.env.NOTION_TOKEN}`,

        "Notion-Version":
          "2022-06-28",

        "Content-Type":
          "application/json"
      });

    const readProp =
      (p) => {
        if (!p) {
          return null;
        }

        switch (p.type) {
          case "title":
            return (
              p.title ||
              []
            )
              .map(
                (t) =>
                  t.plain_text
              )
              .join("");

          case "rich_text":
            return (
              p.rich_text ||
              []
            )
              .map(
                (t) =>
                  t.plain_text
              )
              .join("");

          case "number":
            return p.number;

          case "select":
            return p.select
              ? p.select
                  .name
              : null;

          case "multi_select":
            return (
              p.multi_select ||
              []
            )
              .map(
                (s) =>
                  s.name
              )
              .join(
                ", "
              );

          case "date":
            return p.date
              ? p.date
                  .start
              : null;

          case "email":
            return (
              p.email ||
              null
            );

          case "phone_number":
            return (
              p.phone_number ||
              null
            );

          case "checkbox":
            return p.checkbox;

          case "url":
            return (
              p.url ||
              null
            );

          default:
            return null;
        }
      };

    const norm =
      (s) =>
        (s || "")
          .toString()
          .toLowerCase()
          .normalize(
            "NFD"
          )
          .replace(
            /[\u0300-\u036f]/g,
            ""
          )
          .trim();

    const findProp =
      (
        schemaProps,
        aliases
      ) => {
        const keys =
          Object.keys(
            schemaProps ||
              {}
          );

        for (
          const a of
          aliases
        ) {
          const t =
            norm(a);

          const k =
            keys.find(
              (k) =>
                norm(k) ===
                t
            );

          if (k) {
            return k;
          }
        }

        return null;
      };

    const notionQuery =
      async (dbId) => {
        const r =
          await fetch(
            `https://api.notion.com/v1/databases/${dbId}/query`,
            {
              method:
                "POST",

              headers:
                notionH(),

              body:
                JSON.stringify({
                  page_size:
                    100
                })
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          throw new Error(
            d?.message ||
              "Errore query Notion"
          );
        }

        return (
          d.results ||
          []
        );
      };

    const notionSchema =
      async (dbId) => {
        const r =
          await fetch(
            `https://api.notion.com/v1/databases/${dbId}`,
            {
              headers:
                notionH()
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          throw new Error(
            d?.message ||
              "Errore schema Notion"
          );
        }

        return (
          d.properties ||
          {}
        );
      };

    // ============================================================
    // ATLAS — LEGGI CLIENTI
    // ============================================================

    if (
      body.action ===
      "atlas_read"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const dbId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!dbId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      try {
        const rows =
          await notionQuery(
            dbId
          );

        const clienti =
          rows.map(
            (pg) => {
              const pr =
                pg.properties ||
                {};

              const out =
                {};

              for (
                const [
                  k,
                  v
                ] of Object.entries(
                  pr
                )
              ) {
                out[k] =
                  readProp(
                    v
                  );
              }

              out._id =
                pg.id;

              return out;
            }
          );

        return res
          .status(200)
          .json({
            ok:
              true,

            clienti
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // ATLAS — SCRIVI CLIENTE
    // ============================================================

    if (
      body.action ===
      "atlas_write"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const dbId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!dbId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      const dati =
        body.dati ||
        {};

      try {
        const schema =
          await notionSchema(
            dbId
          );

        const props =
          {};

        const map = [
          {
            al: [
              "Nome",
              "Name"
            ],

            v:
              dati.nome
          },

          {
            al: [
              "Stato"
            ],

            v:
              dati.stato
          },

          {
            al: [
              "Telefono"
            ],

            v:
              dati.telefono
          },

          {
            al: [
              "Email"
            ],

            v:
              dati.email
          },

          {
            al: [
              "Servizio"
            ],

            v:
              dati.servizio
          },

          {
            al: [
              "Citta",
              "Città"
            ],

            v:
              dati.citta
          },

          {
            al: [
              "Tipo rinnovo"
            ],

            v:
              dati.tipoRinnovo
          },

          {
            al: [
              "Data rinnovo"
            ],

            v:
              dati.dataRinnovo
          },

          {
            al: [
              "Ultimo contatto"
            ],

            v:
              dati.ultimoContatto
          },

          {
            al: [
              "Prossima azione"
            ],

            v:
              dati.prossimaAzione
          },

          {
            al: [
              "Note"
            ],

            v:
              dati.note
          }
        ];

        for (
          const m of
          map
        ) {
          if (
            m.v == null ||
            m.v === ""
          ) {
            continue;
          }

          const key =
            findProp(
              schema,
              m.al
            );

          if (!key) {
            continue;
          }

          const realType =
            schema[key]
              .type;

          if (
            realType ===
            "title"
          ) {
            props[key] = {
              title: [
                {
                  text: {
                    content:
                      String(
                        m.v
                      ).slice(
                        0,
                        200
                      )
                  }
                }
              ]
            };
          } else if (
            realType ===
            "rich_text"
          ) {
            props[key] = {
              rich_text: [
                {
                  text: {
                    content:
                      String(
                        m.v
                      ).slice(
                        0,
                        1800
                      )
                  }
                }
              ]
            };
          } else if (
            realType ===
            "select"
          ) {
            props[key] = {
              select: {
                name:
                  String(
                    m.v
                  ).slice(
                    0,
                    100
                  )
              }
            };
          } else if (
            realType ===
            "email"
          ) {
            props[key] = {
              email:
                String(
                  m.v
                )
            };
          } else if (
            realType ===
            "phone_number"
          ) {
            props[key] = {
              phone_number:
                String(
                  m.v
                )
            };
          } else if (
            realType ===
            "date"
          ) {
            props[key] = {
              date: {
                start:
                  String(
                    m.v
                  )
              }
            };
          } else if (
            realType ===
            "number"
          ) {
            props[key] = {
              number:
                Number(
                  m.v
                )
            };
          }
        }

        const r =
          await fetch(
            "https://api.notion.com/v1/pages",
            {
              method:
                "POST",

              headers:
                notionH(),

              body:
                JSON.stringify({
                  parent: {
                    database_id:
                      dbId
                  },

                  properties:
                    props
                })
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          return res
            .status(
              r.status
            )
            .json({
              error:
                d?.message ||
                "Errore creazione cliente"
            });
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            url:
              d.url ||
              null
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // MIDAS / NOTION — SVUOTA DATABASE
    // ============================================================

    if (
      body.action ===
        "midas_clear" ||
      body.action ===
        "notion_clear"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const dbId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!dbId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      try {
        let archiviate =
          0;

        let totali =
          0;

        for (
          let giro = 0;
          giro < 10;
          giro++
        ) {
          const rows =
            await notionQuery(
              dbId
            );

          if (
            !rows.length
          ) {
            break;
          }

          totali +=
            rows.length;

          for (
            const pg of
            rows
          ) {
            const r =
              await fetch(
                "https://api.notion.com/v1/pages/" +
                  pg.id,
                {
                  method:
                    "PATCH",

                  headers:
                    notionH(),

                  body:
                    JSON.stringify({
                      archived:
                        true
                    })
                }
              );

            if (r.ok) {
              archiviate++;
            }
          }
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            archiviate,

            totali
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // ATLAS — ELIMINA CLIENTE
    // ============================================================

    if (
      body.action ===
      "atlas_delete"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const pageId =
        (
          body.pageId ||
          ""
        )
          .toString()
          .trim();

      if (!pageId) {
        return res
          .status(400)
          .json({
            error:
              "pageId mancante"
          });
      }

      try {
        const r =
          await fetch(
            "https://api.notion.com/v1/pages/" +
              pageId,
            {
              method:
                "PATCH",

              headers:
                notionH(),

              body:
                JSON.stringify({
                  archived:
                    true
                })
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          return res
            .status(
              r.status
            )
            .json({
              error:
                d?.message ||
                "Errore eliminazione"
            });
        }

        return res
          .status(200)
          .json({
            ok:
              true
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // MIDAS — LEGGI CONTI
    // Solo entrate, uscite e saldo.
    // ============================================================

    if (
      body.action ===
      "midas_read"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const dbId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!dbId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      try {
        const schema =
          await notionSchema(
            dbId
          );

        const kImporto =
          findProp(
            schema,
            [
              "Importo"
            ]
          );

        const kTipo =
          findProp(
            schema,
            [
              "Tipo"
            ]
          );

        const kCategoria =
          findProp(
            schema,
            [
              "Categoria"
            ]
          );

        const kData =
          findProp(
            schema,
            [
              "Data"
            ]
          );

        const kRicorrenza =
          findProp(
            schema,
            [
              "Ricorrenza"
            ]
          );

        const kMesiDurata =
          findProp(
            schema,
            [
              "Mesi durata",
              "Mesi",
              "Durata"
            ]
          );

        const rows =
          await notionQuery(
            dbId
          );

        const isCampoFiscale =
          (nomeCampo) => {
            const n =
              norm(
                nomeCampo
              );

            return (
              n.includes(
                "fattur"
              ) ||
              n.includes(
                "ateco"
              ) ||
              n === "iva" ||
              n.includes(
                "partita iva"
              ) ||
              n.includes(
                "p iva"
              ) ||
              n.includes(
                "p.iva"
              ) ||
              n.includes(
                "inps"
              ) ||
              n.includes(
                "imposta"
              ) ||
              n.includes(
                "tass"
              ) ||
              n.includes(
                "fiscal"
              ) ||
              n.includes(
                "accanton"
              )
            );
          };

        const movimenti =
          rows.map(
            (pg) => {
              const pr =
                pg.properties ||
                {};

              const out =
                {};

              for (
                const [
                  k,
                  v
                ] of Object.entries(
                  pr
                )
              ) {
                if (
                  isCampoFiscale(
                    k
                  )
                ) {
                  continue;
                }

                out[k] =
                  readProp(
                    v
                  );
              }

              return out;
            }
          );

        const now =
          new Date();

        const meseCorrente =
          now.getFullYear() +
          "-" +
          String(
            now.getMonth() +
              1
          ).padStart(
            2,
            "0"
          );

        const mesiTrascorsi =
          (
            dataStart
          ) => {
            if (!dataStart) {
              return 1;
            }

            const d =
              new Date(
                dataStart
              );

            if (
              isNaN(d)
            ) {
              return 1;
            }

            let m =
              (
                now.getFullYear() -
                d.getFullYear()
              ) *
                12 +
              (
                now.getMonth() -
                d.getMonth()
              ) +
              1;

            return m < 1
              ? 0
              : m;
          };

        let entrate =
          0;

        let uscite =
          0;

        let entrateMese =
          0;

        let usciteMese =
          0;

        for (
          const m of
          movimenti
        ) {
          const impMensile =
            Number(
              kImporto
                ? m[
                    kImporto
                  ]
                : 0
            ) || 0;

          const tipo =
            norm(
              kTipo
                ? m[
                    kTipo
                  ]
                : ""
            );

          const cat =
            norm(
              kCategoria
                ? m[
                    kCategoria
                  ]
                : ""
            );

          const dataStr =
            kData
              ? m[
                  kData
                ]
              : null;

          const ric =
            norm(
              kRicorrenza
                ? m[
                    kRicorrenza
                  ]
                : ""
            );

          const isUnaTantum =
            ric.includes(
              "tantum"
            ) ||
            ric.includes(
              "una tantum"
            ) ||
            !ric;

          const mesiDur =
            isUnaTantum
              ? 1
              : Number(
                  kMesiDurata
                    ? m[
                        kMesiDurata
                      ]
                    : 0
                ) ||
                (
                  ric.includes(
                    "trimestr"
                  )
                    ? 3
                    : ric.includes(
                        "semestr"
                      )
                    ? 6
                    : ric.includes(
                        "annual"
                      )
                    ? 12
                    : ric.includes(
                        "mensile"
                      )
                    ? 12
                    : 1
                );

          const isUscita =
            tipo.includes(
              "uscita"
            ) ||
            cat.includes(
              "spesa"
            ) ||
            cat.includes(
              "fotografo"
            ) ||
            cat.includes(
              "videomaker"
            ) ||
            cat.includes(
              "modella"
            );

          const mesiOk =
            isUnaTantum
              ? 1
              : Math.min(
                  Math.max(
                    mesiTrascorsi(
                      dataStr
                    ),
                    1
                  ),
                  mesiDur
                );

          const maturato =
            impMensile *
            mesiOk;

          const attivaOra =
            isUnaTantum
              ? false
              : mesiTrascorsi(
                  dataStr
                ) <=
                  mesiDur &&
                mesiTrascorsi(
                  dataStr
                ) >= 1;

          const nelMeseCorrente =
            dataStr &&
            new Date(
              dataStr
            ).getFullYear() +
              "-" +
              String(
                new Date(
                  dataStr
                ).getMonth() +
                  1
              ).padStart(
                2,
                "0"
              ) ===
              meseCorrente;

          if (isUscita) {
            uscite +=
              Math.abs(
                maturato
              );

            if (attivaOra) {
              usciteMese +=
                Math.abs(
                  impMensile
                );
            } else if (
              nelMeseCorrente
            ) {
              usciteMese +=
                Math.abs(
                  impMensile
                );
            }
          } else {
            entrate +=
              Math.abs(
                maturato
              );

            if (attivaOra) {
              entrateMese +=
                Math.abs(
                  impMensile
                );
            } else if (
              nelMeseCorrente
            ) {
              entrateMese +=
                Math.abs(
                  impMensile
                );
            }
          }
        }

        const r2 =
          (n) =>
            Math.round(
              n * 100
            ) / 100;

        return res
          .status(200)
          .json({
            ok:
              true,

            movimenti,

            conti: {
              entrate:
                r2(
                  entrate
                ),

              uscite:
                r2(
                  uscite
                ),

              saldo:
                r2(
                  entrate -
                    uscite
                ),

              meseCorrente: {
                label:
                  meseCorrente,

                entrate:
                  r2(
                    entrateMese
                  ),

                uscite:
                  r2(
                    usciteMese
                  ),

                saldo:
                  r2(
                    entrateMese -
                      usciteMese
                  )
              }
            }
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // MIDAS — AGGIUNGI MOVIMENTO
    // ============================================================

    if (
      body.action ===
      "midas_write"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const dbId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!dbId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      const dati =
        body.dati ||
        {};

      try {
        const schema =
          await notionSchema(
            dbId
          );

        const props =
          {};

        const map = [
          {
            al: [
              "Descrizione",
              "Nome",
              "Name"
            ],

            v:
              dati.descrizione
          },

          {
            al: [
              "Tipo"
            ],

            v:
              dati.tipo
          },

          {
            al: [
              "Categoria"
            ],

            v:
              dati.categoria
          },

          {
            al: [
              "Cliente",
              "Clienti"
            ],

            v:
              dati.cliente
          },

          {
            al: [
              "Importo"
            ],

            v:
              dati.importo
          },

          {
            al: [
              "Stato"
            ],

            v:
              dati.stato
          },

          {
            al: [
              "Data"
            ],

            v:
              dati.data
          }
        ];

        for (
          const m of
          map
        ) {
          if (
            m.v == null ||
            m.v === ""
          ) {
            continue;
          }

          const key =
            findProp(
              schema,
              m.al
            );

          if (!key) {
            continue;
          }

          const realType =
            schema[key]
              .type;

          if (
            realType ===
            "title"
          ) {
            props[key] = {
              title: [
                {
                  text: {
                    content:
                      String(
                        m.v
                      ).slice(
                        0,
                        200
                      )
                  }
                }
              ]
            };
          } else if (
            realType ===
            "rich_text"
          ) {
            props[key] = {
              rich_text: [
                {
                  text: {
                    content:
                      String(
                        m.v
                      ).slice(
                        0,
                        1800
                      )
                  }
                }
              ]
            };
          } else if (
            realType ===
            "select"
          ) {
            props[key] = {
              select: {
                name:
                  String(
                    m.v
                  ).slice(
                    0,
                    100
                  )
              }
            };
          } else if (
            realType ===
            "number"
          ) {
            props[key] = {
              number:
                Number(
                  m.v
                )
            };
          } else if (
            realType ===
            "date"
          ) {
            props[key] = {
              date: {
                start:
                  String(
                    m.v
                  )
              }
            };
          }
        }

        const r =
          await fetch(
            "https://api.notion.com/v1/pages",
            {
              method:
                "POST",

              headers:
                notionH(),

              body:
                JSON.stringify({
                  parent: {
                    database_id:
                      dbId
                  },

                  properties:
                    props
                })
            }
          );

        const d =
          await r.json();

        if (!r.ok) {
          return res
            .status(
              r.status
            )
            .json({
              error:
                d?.message ||
                "Errore creazione movimento"
            });
        }

        return res
          .status(200)
          .json({
            ok:
              true,

            url:
              d.url ||
              null
          });
      } catch (e) {
        return res
          .status(500)
          .json({
            error:
              String(
                e.message ||
                  e
              )
          });
      }
    }

    // ============================================================
    // NOTION — CREA RELAZIONE
    // ============================================================

    if (
      body.action ===
      "notion"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const databaseId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!databaseId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      const dbr =
        await fetch(
          `https://api.notion.com/v1/databases/${databaseId}`,
          {
            headers:
              notionH()
          }
        );

      const db =
        await dbr.json();

      if (!dbr.ok) {
        return res
          .status(
            dbr.status
          )
          .json({
            error:
              db?.message ||
              "Errore lettura database Notion"
          });
      }

      let titleProp =
        "Name";

      for (
        const [
          k,
          v
        ] of Object.entries(
          db.properties ||
            {}
        )
      ) {
        if (
          v &&
          v.type ===
            "title"
        ) {
          titleProp =
            k;

          break;
        }
      }

      const title =
        (
          body.title ||
          "Relazione CORTEX"
        )
          .toString()
          .slice(
            0,
            200
          );

      const finalText =
        (
          body.finalText ||
          ""
        ).toString();

      const sections =
        Array.isArray(
          body.sections
        )
          ? body.sections
          : [];

      const h2 =
        (t) => ({
          object:
            "block",

          type:
            "heading_2",

          heading_2: {
            rich_text: [
              {
                type:
                  "text",

                text: {
                  content:
                    (
                      t ||
                      ""
                    )
                      .toString()
                      .slice(
                        0,
                        200
                      )
                }
              }
            ]
          }
        });

      const para =
        (t) => ({
          object:
            "block",

          type:
            "paragraph",

          paragraph: {
            rich_text:
              chunkText(
                t
              )
          }
        });

      const children = [
        h2(
          "Sintesi CORTEX"
        )
      ];

      if (finalText) {
        children.push(
          para(
            finalText
          )
        );
      }

      for (
        const s of
        sections
      ) {
        children.push(
          h2(
            (
              s.name ||
              "Organo"
            ) +
              (
                s.count
                  ? " (" +
                    s.count +
                    ")"
                  : ""
              )
          )
        );

        children.push(
          para(
            s.text ||
              ""
          )
        );
      }

      const payload = {
        parent: {
          database_id:
            databaseId
        },

        properties: {
          [titleProp]: {
            title: [
              {
                text: {
                  content:
                    title
                }
              }
            ]
          }
        },

        children:
          children.slice(
            0,
            100
          )
      };

      const pr =
        await fetch(
          "https://api.notion.com/v1/pages",
          {
            method:
              "POST",

            headers:
              notionH(),

            body:
              JSON.stringify(
                payload
              )
          }
        );

      const pd =
        await pr.json();

      if (!pr.ok) {
        return res
          .status(
            pr.status
          )
          .json({
            error:
              pd?.message ||
              "Errore creazione pagina Notion"
          });
      }

      return res
        .status(200)
        .json({
          ok:
            true,

          url:
            pd.url ||
            null
        });
    }

    // ============================================================
    // NOTION — SCRIVI LOG
    // ============================================================

    if (
      body.action === "log"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const databaseId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!databaseId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      const dbr =
        await fetch(
          `https://api.notion.com/v1/databases/${databaseId}`,
          {
            headers:
              notionH()
          }
        );

      const db =
        await dbr.json();

      if (!dbr.ok) {
        return res
          .status(
            dbr.status
          )
          .json({
            error:
              db?.message ||
              "Errore lettura database Notion"
          });
      }

      let titleProp =
        "Name";

      for (
        const [
          k,
          v
        ] of Object.entries(
          db.properties ||
            {}
        )
      ) {
        if (
          v.type ===
          "title"
        ) {
          titleProp =
            k;

          break;
        }
      }

      const line =
        (
          body.text ||
          ""
        )
          .toString()
          .slice(
            0,
            1800
          );

      const organo =
        (
          body.organo ||
          ""
        ).toString();

      const title =
        (
          organo
            ? organo +
              ": "
            : ""
        ) +
        line.slice(
          0,
          90
        );

      const payload = {
        parent: {
          database_id:
            databaseId
        },

        properties: {
          [titleProp]: {
            title: [
              {
                text: {
                  content:
                    title ||
                    "log"
                }
              }
            ]
          }
        },

        children: [
          {
            object:
              "block",

            type:
              "paragraph",

            paragraph: {
              rich_text:
                chunkText(
                  line
                )
            }
          }
        ]
      };

      const pr =
        await fetch(
          "https://api.notion.com/v1/pages",
          {
            method:
              "POST",

            headers:
              notionH(),

            body:
              JSON.stringify(
                payload
              )
          }
        );

      const pd =
        await pr.json();

      if (!pr.ok) {
        return res
          .status(
            pr.status
          )
          .json({
            error:
              pd?.message ||
              "Errore log Notion"
          });
      }

      return res
        .status(200)
        .json({
          ok:
            true
        });
    }

    // ============================================================
    // NOTION — LEGGI LOG
    // ============================================================

    if (
      body.action ===
      "log_read"
    ) {
      if (
        !process.env
          .NOTION_TOKEN
      ) {
        return res
          .status(500)
          .json({
            error:
              "NOTION_TOKEN mancante"
          });
      }

      const databaseId =
        (
          body.databaseId ||
          ""
        )
          .toString()
          .replace(
            /-/g,
            ""
          )
          .trim();

      if (!databaseId) {
        return res
          .status(400)
          .json({
            error:
              "databaseId mancante"
          });
      }

      const since =
        new Date();

      since.setHours(
        0,
        0,
        0,
        0
      );

      const pr =
        await fetch(
          `https://api.notion.com/v1/databases/${databaseId}/query`,
          {
            method:
              "POST",

            headers:
              notionH(),

            body:
              JSON.stringify({
                filter: {
                  timestamp:
                    "created_time",

                  created_time: {
                    on_or_after:
                      since.toISOString()
                  }
                },

                page_size:
                  100
              })
          }
        );

      const pd =
        await pr.json();

      if (!pr.ok) {
        return res
          .status(
            pr.status
          )
          .json({
            error:
              pd?.message ||
              "Errore lettura log"
          });
      }

      const items =
        (
          pd.results ||
          []
        )
          .map(
            (p) => {
              const props =
                p.properties ||
                {};

              let title =
                "";

              for (
                const v of
                Object.values(
                  props
                )
              ) {
                if (
                  v.type ===
                  "title"
                ) {
                  title =
                    (
                      v.title ||
                      []
                    )
                      .map(
                        (t) =>
                          t.plain_text
                      )
                      .join(
                        ""
                      );

                  break;
                }
              }

              return title;
            }
          )
          .filter(
            Boolean
          );

      return res
        .status(200)
        .json({
          items
        });
    }

    // ============================================================
    // CHAT DEGLI AGENTI
    // GEMINI → OPENROUTER → GROQ
    // ============================================================

    const {
      system,
      messages
    } = body;

    if (
      !Array.isArray(
        messages
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "messages mancante"
        });
    }

    const toGeminiContents =
      (
        inputMessages
      ) =>
        inputMessages.map(
          (m) => {
            const role =
              m.role ===
              "assistant"
                ? "model"
                : "user";

            const parts =
              [];

            if (
              typeof m.content ===
              "string"
            ) {
              parts.push({
                text:
                  m.content
              });
            } else if (
              Array.isArray(
                m.content
              )
            ) {
              for (
                const b of
                m.content
              ) {
                if (
                  b.type ===
                  "text"
                ) {
                  parts.push({
                    text:
                      b.text ||
                      ""
                  });
                } else if (
                  b.type ===
                    "image" &&
                  b.source
                    ?.data
                ) {
                  parts.push({
                    inline_data: {
                      mime_type:
                        b.source
                          .media_type ||
                        "image/jpeg",

                      data:
                        b.source
                          .data
                    }
                  });
                } else if (
                  b.type ===
                    "document" &&
                  b.source
                    ?.data
                ) {
                  parts.push({
                    inline_data: {
                      mime_type:
                        b.source
                          .media_type ||
                        "application/pdf",

                      data:
                        b.source
                          .data
                    }
                  });
                }
              }
            }

            if (
              !parts.length
            ) {
              parts.push({
                text: ""
              });
            }

            return {
              role,
              parts
            };
          }
        );

    const toOpenRouterMessages =
      (
        inputMessages
      ) => {
        const out =
          [];

        if (system) {
          out.push({
            role:
              "system",

            content:
              String(
                system
              )
          });
        }

        for (
          const m of
          inputMessages
        ) {
          const role =
            m.role ===
            "assistant"
              ? "assistant"
              : "user";

          if (
            typeof m.content ===
            "string"
          ) {
            out.push({
              role,

              content:
                m.content
            });

            continue;
          }

          if (
            !Array.isArray(
              m.content
            )
          ) {
            out.push({
              role,

              content:
                ""
            });

            continue;
          }

          const content =
            [];

          for (
            const b of
            m.content
          ) {
            if (
              b.type ===
              "text"
            ) {
              content.push({
                type:
                  "text",

                text:
                  b.text ||
                  ""
              });
            } else if (
              b.type ===
                "image" &&
              b.source
                ?.data
            ) {
              const mime =
                b.source
                  .media_type ||
                "image/jpeg";

              content.push({
                type:
                  "image_url",

                image_url: {
                  url:
                    `data:${mime};base64,${b.source.data}`
                }
              });
            } else if (
              b.type ===
                "document" &&
              b.source
                ?.data
            ) {
              content.push({
                type:
                  "text",

                text:
                  "[Documento PDF allegato: il provider di fallback potrebbe non poterlo leggere direttamente.]"
              });
            }
          }

          out.push({
            role,

            content:
              content.length
                ? content
                : ""
          });
        }

        return out;
      };

    const toGroqMessages =
      (
        inputMessages
      ) => {
        const flat =
          toOpenRouterMessages(
            inputMessages
          );

        return flat.map(
          (m) => {
            if (
              typeof m.content ===
              "string"
            ) {
              return m;
            }

            const text =
              (
                m.content ||
                []
              )
                .map(
                  (c) =>
                    typeof c ===
                    "string"
                      ? c
                      : c?.text ||
                        ""
                )
                .join(
                  " "
                )
                .trim();

            return {
              role:
                m.role,

              content:
                text
            };
          }
        );
      };

    // ============================================================
    // PROVIDER 1 — GEMINI
    // ============================================================

    const callGemini =
      async () => {
        const key =
          process.env
            .GEMINI_API_KEY;

        if (!key) {
          return {
            ok:
              false,

            status:
              503,

            error:
              "GEMINI_API_KEY mancante"
          };
        }

        const contents =
          toGeminiContents(
            messages
          );

        const gbody = {
          contents,

          generationConfig: {
            maxOutputTokens:
              8192,

            temperature:
              0.7
          }
        };

        if (system) {
          gbody.systemInstruction =
            {
              parts: [
                {
                  text:
                    system
                }
              ]
            };
        }

        const url =
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

        try {
          const r =
            await fetch(
              url,
              {
                method:
                  "POST",

                headers: {
                  "content-type":
                    "application/json"
                },

                body:
                  JSON.stringify(
                    gbody
                  )
              }
            );

          const data =
            await r.json();

          if (!r.ok) {
            return {
              ok:
                false,

              status:
                r.status,

              error:
                data?.error
                  ?.message ||
                "Errore Gemini",

              raw:
                data
            };
          }

          const text =
            (
              data
                ?.candidates?.[0]
                ?.content
                ?.parts ||
              []
            )
              .map(
                (p) =>
                  p.text ||
                  ""
              )
              .join(
                ""
              )
              .trim();

          if (!text) {
            return {
              ok:
                false,

              status:
                502,

              error:
                "Gemini non ha restituito testo"
            };
          }

          return {
            ok:
              true,

            provider:
              "gemini",

            model:
              MODEL,

            text
          };
        } catch (
          error
        ) {
          return {
            ok:
              false,

            status:
              503,

            error:
              error
                ?.message ||
              "Gemini non raggiungibile"
          };
        }
      };

    // ============================================================
    // PROVIDER 2 — OPENROUTER
    // ============================================================

    const callOpenRouter =
      async () => {
        const key =
          process.env
            .OPENROUTER_API_KEY;

        if (!key) {
          return {
            ok:
              false,

            status:
              503,

            error:
              "OPENROUTER_API_KEY mancante"
          };
        }

        try {
          const r =
            await fetch(
              "https://openrouter.ai/api/v1/chat/completions",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",

                  Authorization:
                    `Bearer ${key}`,

                  "HTTP-Referer":
                    process.env
                      .CORTEX_PUBLIC_URL ||
                    "https://cortex.local",

                  "X-Title":
                    "CORTEX"
                },

                body:
                  JSON.stringify({
                    model:
                      process.env
                        .OPENROUTER_MODEL ||
                      "openrouter/free",

                    messages:
                      toOpenRouterMessages(
                        messages
                      ),

                    temperature:
                      0.7,

                    max_tokens:
                      4096,

                    stream:
                      false
                  })
              }
            );

          const data =
            await r.json();

          if (!r.ok) {
            return {
              ok:
                false,

              status:
                r.status,

              error:
                data?.error
                  ?.message ||
                "Errore OpenRouter",

              raw:
                data
            };
          }

          let text =
            data
              ?.choices?.[0]
              ?.message
              ?.content;

          if (
            Array.isArray(
              text
            )
          ) {
            text =
              text
                .map(
                  (part) => {
                    if (
                      typeof part ===
                      "string"
                    ) {
                      return part;
                    }

                    return (
                      part?.text ||
                      part?.content ||
                      ""
                    );
                  }
                )
                .join(
                  ""
                );
          }

          text =
            (
              text ||
              ""
            )
              .toString()
              .trim();

          if (!text) {
            return {
              ok:
                false,

              status:
                502,

              error:
                "OpenRouter non ha restituito testo"
            };
          }

          return {
            ok:
              true,

            provider:
              "openrouter",

            model:
              data?.model ||
              process.env
                .OPENROUTER_MODEL ||
              "openrouter/free",

            text
          };
        } catch (
          error
        ) {
          return {
            ok:
              false,

            status:
              503,

            error:
              error
                ?.message ||
              "OpenRouter non raggiungibile"
          };
        }
      };

    // ============================================================
    // PROVIDER 3 — GROQ
    // ============================================================

    const callGroq =
      async () => {
        const key =
          process.env
            .GROQ_API_KEY;

        if (!key) {
          return {
            ok:
              false,

            status:
              503,

            error:
              "GROQ_API_KEY mancante"
          };
        }

        try {
          const r =
            await fetch(
              "https://api.groq.com/openai/v1/chat/completions",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",

                  Authorization:
                    `Bearer ${key}`
                },

                body:
                  JSON.stringify({
                    model:
                      process.env
                        .GROQ_MODEL ||
                      "llama-3.3-70b-versatile",

                    messages:
                      toGroqMessages(
                        messages
                      ),

                    temperature:
                      0.7,

                    max_tokens:
                      4096,

                    stream:
                      false
                  })
              }
            );

          const data =
            await r.json();

          if (!r.ok) {
            return {
              ok:
                false,

              status:
                r.status,

              error:
                data?.error
                  ?.message ||
                "Errore Groq",

              raw:
                data
            };
          }

          let text =
            data
              ?.choices?.[0]
              ?.message
              ?.content;

          if (
            Array.isArray(
              text
            )
          ) {
            text =
              text
                .map(
                  (part) =>
                    typeof part ===
                    "string"
                      ? part
                      : part?.text ||
                        ""
                )
                .join(
                  ""
                );
          }

          text =
            (
              text ||
              ""
            )
              .toString()
              .trim();

          if (!text) {
            return {
              ok:
                false,

              status:
                502,

              error:
                "Groq non ha restituito testo"
            };
          }

          return {
            ok:
              true,

            provider:
              "groq",

            model:
              data?.model ||
              process.env
                .GROQ_MODEL ||
              "llama-3.3-70b-versatile",

            text
          };
        } catch (
          error
        ) {
          return {
            ok:
              false,

            status:
              503,

            error:
              error
                ?.message ||
              "Groq non raggiungibile"
          };
        }
      };

    // ============================================================
    // CORTEX AI ROUTER
    // Gemini → OpenRouter → Groq
    // ============================================================

    const gemini =
      await callGemini();

    if (gemini.ok) {
      return res
        .status(200)
        .json({
          content: [
            {
              type:
                "text",

              text:
                gemini.text
            }
          ],

          provider:
            gemini.provider,

          model:
            gemini.model,

          fallback:
            false
        });
    }

    console.warn(
      "[CORTEX AI ROUTER] Gemini non disponibile:",
      gemini.status,
      gemini.error
    );

    const openrouter =
      await callOpenRouter();

    if (
      openrouter.ok
    ) {
      return res
        .status(200)
        .json({
          content: [
            {
              type:
                "text",

              text:
                openrouter.text
            }
          ],

          provider:
            openrouter.provider,

          model:
            openrouter.model,

          fallback:
            true,

          fallbackReason:
            gemini.error
        });
    }

    console.warn(
      "[CORTEX AI ROUTER] OpenRouter non disponibile:",
      openrouter.status,
      openrouter.error
    );

    const groq =
      await callGroq();

    if (groq.ok) {
      return res
        .status(200)
        .json({
          content: [
            {
              type:
                "text",

              text:
                groq.text
            }
          ],

          provider:
            groq.provider,

          model:
            groq.model,

          fallback:
            true,

          fallbackReason:
            openrouter.error ||
            gemini.error
        });
    }

    console.error(
      "[CORTEX AI ROUTER] Nessun motore disponibile:",
      "gemini=",
      gemini.error,
      "| openrouter=",
      openrouter.error,
      "| groq=",
      groq.error
    );

    return res
      .status(
        groq.status ||
          openrouter.status ||
          gemini.status ||
          503
      )
      .json({
        error:
          "Nessun motore AI disponibile in questo momento.",

        details: {
          gemini:
            gemini.error,

          openrouter:
            openrouter.error,

          groq:
            groq.error
        }
      });
  } catch (e) {
    return res
      .status(500)
      .json({
        error:
          String(
            e &&
            e.message
              ? e.message
              : e
          )
      });
  }
}
