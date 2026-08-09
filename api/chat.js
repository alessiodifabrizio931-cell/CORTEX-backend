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
// SHOPIFY — autenticazione client_credentials
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
// ============================================================

const HELIOS_VERSION = "2.0.0";
const HELIOS_COLLECTIVE_TAG = "Shopify Collective";
const HELIOS_DEFAULT_INITIAL_CAPITAL = 5;
const HELIOS_AUTO_REINVEST_MAX_PCT = 20;
const HELIOS_THEME_API_VERSION = "2025-10";

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

try {
return JSON.parse(String(raw));
} catch {
const cleaned = String(raw)
.trim()
.replace(/^```json/i, "")
.replace(/^```/, "")
.replace(/```$/, "")
.trim();

try {
return JSON.parse(cleaned);
} catch {
return fallback;
}
}
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
actions = []
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
actions
};
}

function heliosShopifyAdminUrl(path = "") {
const store = (process.env.SHOPIFY_STORE || "").trim();

const base = store
? `https://admin.shopify.com/store/${store}`
: "https://admin.shopify.com";

return path
? `${base}/${String(path).replace(/^\/+/, "")}`
: base;
}

function heliosCollectiveUrl(path = "") {
const base =
heliosShopifyAdminUrl(
"apps/merchant-to-merchant"
);

return path
? `${base}/${String(path).replace(/^\/+/, "")}`
: base;
}

async function shopifyGraphQL(
query,
variables = {},
version = SHOPIFY_API_VERSION
) {
const store =
process.env.SHOPIFY_STORE;

const token =
await getShopifyToken();

if (!store) {
throw new Error(
"SHOPIFY_STORE mancante"
);
}

const r =
await fetch(
`https://${store}.myshopify.com/admin/api/${version}/graphql.json`,
{
method: "POST",
headers: {
"Content-Type":
"application/json",
"X-Shopify-Access-Token":
token
},
body:
JSON.stringify({
query,
variables
})
}
);

const payload =
await r.json()
.catch(() => null);

if (!r.ok) {
throw new Error(
`Shopify GraphQL HTTP ${r.status}: ${
payload?.errors?.[0]?.message ||
JSON.stringify(payload || {})
}`
);
}

if (
Array.isArray(payload?.errors) &&
payload.errors.length
) {
const msg =
payload.errors
.map((e) => e.message)
.filter(Boolean)
.join(" | ");

const err =
new Error(
`Shopify GraphQL: ${msg}`
);

err.graphqlErrors =
payload.errors;

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

const d =
await shopifyGraphQL(q);

return (
d?.currentAppInstallation
?.accessScopes || []
)
.map((x) => x?.handle)
.filter(Boolean);
}

async function heliosShopifyPaymentsStatus() {
const scopes =
await heliosShopifyScopes()
.catch(() => []);

const canRead =
scopes.includes(
"read_shopify_payments"
) ||
scopes.includes(
"read_shopify_payments_accounts"
);

if (!canRead) {
return {
status:
"UNKNOWN_SCOPE_REQUIRED",
activated:
null,
bankAccounts: [],
balances: [],
requiredScopes: [
"read_shopify_payments_accounts"
]
};
}

try {
const d =
await shopifyGraphQL(`
query HeliosPayments {
shopifyPaymentsAccount {
activated
defaultCurrency
country
balance {
amount
currencyCode
}
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

const a =
d?.shopifyPaymentsAccount;

if (!a) {
return {
status:
"NOT_AVAILABLE",
activated:
false,
bankAccounts: [],
balances: []
};
}

return {
status:
a.activated
? "ACTIVE"
: "SETUP_REQUIRED",

activated:
Boolean(a.activated),

currency:
a.defaultCurrency ||
null,

country:
a.country ||
null,

balances:
(a.balance || [])
.map((x) => ({
amount:
Number(
x.amount || 0
),
currency:
x.currencyCode
})),

bankAccounts:
(a.bankAccounts?.nodes || [])
.map((x) => ({
id:
x.id,

bankName:
x.bankName ||
null,

last4:
x.accountNumberLastDigits ||
null,

country:
x.country ||
null,

currency:
x.currency ||
null,

status:
x.status ||
null
}))
};

} catch (error) {

return {
status:
"UNKNOWN",

activated:
null,

error:
String(
error?.message ||
error
),

bankAccounts: [],
balances: []
};
}
}

async function heliosOnlineStorePublication() {
const d =
await shopifyGraphQL(`
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

const nodes =
d?.publications?.nodes || [];

return (
nodes.find(
(p) =>
/online store|negozio online/i
.test(
`${p.name || ""} ${
p.app?.title || ""
} ${
p.catalog?.title || ""
}`
)
) ||
null
);
}

async function heliosMainTheme() {
try {

const d =
await shopifyGraphQL(`
query HeliosThemes {
themes(first: 20, roles: [MAIN]) {
nodes {
id
name
role
processing
processingFailed
}
}
}
`,
{},
HELIOS_THEME_API_VERSION
);

return (
d?.themes?.nodes?.[0] ||
null
);

} catch (error) {

return {
error:
String(
error?.message ||
error
)
};
}
}

async function heliosCollectiveProducts({
limit = 100
} = {}) {

const max =
Math.min(
Math.max(
Number(limit) || 100,
1
),
250
);

const richQuery = `
query HeliosCollectiveProducts($first: Int!) {
products(
first: $first,
sortKey: UPDATED_AT,
reverse: true
) {
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
image {
url
altText
width
height
}
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
unitCost {
amount
currencyCode
}
}
}
}
}
}
}
`;

const liteQuery = `
query HeliosCollectiveProductsLite($first: Int!) {
products(
first: $first,
sortKey: UPDATED_AT,
reverse: true
) {
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
image {
url
altText
width
height
}
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

const d =
await shopifyGraphQL(
richQuery,
{
first: max
}
);

nodes =
d?.products?.nodes ||
[];

} catch {

costReadable =
false;

const d =
await shopifyGraphQL(
liteQuery,
{
first: max
}
);

nodes =
d?.products?.nodes ||
[];
}

return nodes

.filter(
(p) =>
(p.tags || [])
.some(
(t) =>
String(t)
.toLowerCase() ===
HELIOS_COLLECTIVE_TAG
.toLowerCase()
)
)

.map((p) => {

const variants =
(p.variants?.nodes || [])
.map((v) => {

const unitCost =
v.inventoryItem?.unitCost
? Number(
v.inventoryItem
.unitCost
.amount
)
: null;

const retail =
Number(
v.price || 0
);

const marginEuro =
unitCost != null
? retail - unitCost
: null;

const marginPct =
unitCost != null &&
retail > 0
? (
(retail - unitCost) /
retail
) * 100
: null;

return {
id:
v.id,

legacyId:
v.legacyResourceId ||
null,

title:
v.title,

sku:
v.sku ||
null,

retailPrice:
retail,

compareAtPrice:
v.compareAtPrice != null
? Number(
v.compareAtPrice
)
: null,

inventory:
Number(
v.inventoryQuantity ||
0
),

supplierCost:
unitCost,

supplierCostCurrency:
v.inventoryItem
?.unitCost
?.currencyCode ||
null,

grossMarginEuro:
marginEuro != null
? heliosRound(
marginEuro
)
: null,

grossMarginPct:
marginPct != null
? heliosRound(
marginPct,
1
)
: null
};
});

const supplierTag =
(p.tags || [])
.find(
(t) =>
String(t)
.toLowerCase() !==
HELIOS_COLLECTIVE_TAG
.toLowerCase()
) ||
null;

const image =
p.featuredMedia
?.image ||
null;

return {
id:
p.id,

legacyId:
p.legacyResourceId ||
null,

title:
p.title,

handle:
p.handle,

descriptionHtml:
p.descriptionHtml ||
"",

vendor:
p.vendor ||
supplierTag ||
null,

supplierTag,

productType:
p.productType ||
null,

tags:
p.tags ||
[],

status:
p.status,

inventory:
Number(
p.totalInventory ||
0
),

onlineStoreUrl:
p.onlineStoreUrl ||
null,

image:
image
? {
url:
image.url,

alt:
image.altText ||
p.title,

width:
image.width ||
null,

height:
image.height ||
null
}
: null,

variants,

costReadable,

createdAt:
p.createdAt,

updatedAt:
p.updatedAt
};
});
}

function heliosPhysicalScore(
product,
market = {}
) {

const v =
product?.variants?.[0] ||
{};

const parts = [];

const retail =
Number(
v.retailPrice || 0
);

const cost =
v.supplierCost != null
? Number(
v.supplierCost
)
: null;

const inventory =
Number(
product?.inventory ||
v.inventory ||
0
);

const growth =
heliosClamp(
market?.growth ??
market?.growthPotential ??
50
);

const breakout =
heliosClamp(
market?.breakout ??
market?.breakoutConfidence ??
50
);

const demand =
heliosClamp(
market?.demand ??
market?.currentDemand ??
50
);

const saturation =
heliosClamp(
market?.saturation ??
market?.marketSaturation ??
50
);

if (
retail > 0 &&
cost != null
) {

const marginPct =
(
(retail - cost) /
retail
) * 100;

parts.push({
key:
"margin",

weight:
25,

value:
heliosClamp(
(marginPct / 55) *
100
)
});
}

parts.push({
key:
"inventory",
weight:
15,
value:
heliosClamp(
(inventory / 150) *
100
)
});

parts.push({
key:
"demand",
weight:
20,
value:
demand
});

parts.push({
key:
"growth",
weight:
20,
value:
growth
});

parts.push({
key:
"breakout",
weight:
10,
value:
breakout
});

parts.push({
key:
"low_saturation",
weight:
10,
value:
100 - saturation
});

const totalWeight =
parts.reduce(
(s, x) =>
s + x.weight,
0
);

const score =
totalWeight
? parts.reduce(
(s, x) =>
s +
x.value *
x.weight,
0
) /
totalWeight
: 0;

const hardGates = {

collectiveManaged:
Boolean(
(product?.tags || [])
.includes(
HELIOS_COLLECTIVE_TAG
)
),

inventoryAvailable:
inventory > 0,

hasSellPrice:
retail > 0,

notArchived:
product?.status !==
"ARCHIVED",

supplierLinked:
Boolean(
product?.vendor ||
product?.supplierTag
)
};

const criticalPass =
Object.values(
hardGates
)
.every(Boolean);

const coverageSignals = [
retail > 0,
cost != null,
inventory >= 0,
market?.growth != null ||
market?.growthPotential != null,
market?.demand != null ||
market?.currentDemand != null,
market?.saturation != null ||
market?.marketSaturation != null
];

const coverage =
Math.round(
(
coverageSignals
.filter(Boolean)
.length /
coverageSignals.length
) *
100
);

return {

heliosScore:
Math.round(score),

confidence:
coverage >= 80
? "HIGH"
: coverage >= 55
? "MEDIUM"
: "LOW",

coverage,

hardGates,

criticalPass,

economics: {

retailPrice:
retail ||
null,

supplierCost:
cost,

shippingCost:
null,

shippingStatus:
"COLLECTIVE_RATE_AT_CHECKOUT",

grossMarginEuro:
cost != null
? heliosRound(
retail - cost
)
: null,

grossMarginPct:
cost != null &&
retail > 0
? heliosRound(
(
(retail - cost) /
retail
) * 100,
1
)
: null,

note:
"La spedizione Collective può dipendere dalla tariffa del fornitore e viene validata nel flusso checkout; se non esposta via API resta un dato a confidenza ridotta."
},

market: {
demand,
growth,
breakout,
saturation
}
};
}

async function heliosWebSignal(
query,
{
max = 6,
deep = false
} = {}
) {

const key =
process.env
.TAVILY_API_KEY;

if (!key) {

return {
ok:
false,

error:
"TAVILY_API_KEY mancante",

query,

results: []
};
}

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
deep
? "advanced"
: "basic",

max_results:
Math.min(
Math.max(
max,
1
),
10
),

include_answer:
true
})
}
);

const d =
await r.json();

if (!r.ok) {

return {
ok:
false,

error:
d?.error ||
`Tavily HTTP ${r.status}`,

query,

results: []
};
}

return {

ok:
true,

query,

answer:
d.answer ||
null,

results:
(d.results || [])
.map((x) => ({

title:
x.title ||
"",

url:
x.url ||
"",

content:
String(
x.content ||
""
)
.slice(
0,
900
),

score:
x.score ||
null
}))
};

} catch (error) {

return {

ok:
false,

error:
String(
error?.message ||
error
),

query,

results: []
};
}
}

async function heliosAIJson(
prompt,
{
temperature = 0.15,
maxTokens = 5000
} = {}
) {

const geminiKey =
process.env
.GEMINI_API_KEY;

if (geminiKey) {

try {

const r =
await fetch(
`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
{
method:
"POST",

headers: {
"Content-Type":
"application/json"
},

body:
JSON.stringify({
contents: [
{
role:
"user",

parts: [
{
text:
prompt
}
]
}
],

generationConfig: {
temperature,
maxOutputTokens:
maxTokens,
responseMimeType:
"application/json"
}
})
}
);

const d =
await r.json();

if (r.ok) {

const raw =
(
d?.candidates?.[0]
?.content
?.parts ||
[]
)
.map(
(x) =>
x.text ||
""
)
.join("")
.trim();

const parsed =
heliosSafeJson(raw);

if (parsed) {

return {
ok:
true,

provider:
"gemini",

data:
parsed
};
}
}

} catch {}
}

const orKey =
process.env
.OPENROUTER_API_KEY;

if (orKey) {

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
`Bearer ${orKey}`,

"HTTP-Referer":
process.env
.CORTEX_PUBLIC_URL ||
"https://cortex.local",

"X-Title":
"CORTEX HELIOS"
},

body:
JSON.stringify({

model:
process.env
.OPENROUTER_MODEL ||
"openrouter/free",

messages: [
{
role:
"user",
content:
prompt
}
],

temperature,

max_tokens:
maxTokens,

stream:
false
})
}
);

const d =
await r.json();

if (r.ok) {

const raw =
d?.choices?.[0]
?.message
?.content;

const text =
Array.isArray(raw)
? raw
.map(
(x) =>
x?.text ||
x?.content ||
""
)
.join("")
: String(
raw || ""
);

const parsed =
heliosSafeJson(
text
);

if (parsed) {

return {
ok:
true,

provider:
"openrouter",

data:
parsed
};
}
}

} catch {}
}

return {

ok:
false,

provider:
null,

error:
"Nessun provider AI disponibile per HELIOS JSON"
};
}

async function heliosGlobalMarketScan(
stores,
objective = ""
) {

const targets =
stores.length
? stores.join(
" + "
)
: "SHOPIFY";

const baseObjective =
objective ||
"Trova le opportunità commerciali globali con il miglior rapporto domanda/crescita/saturazione e rischio contenuto.";

const queries = [];

if (
stores.includes(
"SHOPIFY"
)
) {

queries.push(

"2026 fast growing consumer product trends ecommerce emerging demand low saturation global",

"2026 breakout physical products ecommerce trend rising searches consumer demand Europe",

"2026 product trends home lifestyle travel tech accessories beauty pet ecommerce"
);
}

if (
stores.includes(
"ETSY"
)
) {

queries.push(

"2026 Etsy digital product trends rising demand printable templates planners global",

"2026 digital download consumer trends low competition templates workbooks planners"
);
}

const signals =
await Promise.all(
[
...new Set(
queries
)
]
.slice(
0,
5
)
.map(
(q) =>
heliosWebSignal(
q,
{
max:
6,

deep:
true
}
)
)
);

const sourcePayload =
signals.map(
(s) => ({

query:
s.query,

answer:
s.answer ||
null,

results:
(s.results || [])
.map(
(r) => ({

title:
r.title,

url:
r.url,

content:
r.content,

score:
r.score
})
)
})
);

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
- Per SHOPIFY preferisci famiglie di prodotti fisici che possano realisticamente esistere in cataloghi multi-brand/Collective e che funzionino in uno store umbrella multi-nicchia.
- Per ETSY preferisci prodotti digitali originali che HELIOS possa creare integralmente con alta qualità.
- Una opportunità con score attuale inferiore può vincere se Growth e Breakout sono forti e la saturazione è bassa.
- Restituisci solo JSON.

FORMATO:
{
"marketScope":"GLOBAL",
"sourceConfidence":"HIGH|MEDIUM|LOW",
"opportunities":[
{
"rank":1,
"name":"",
"channelFit":["SHOPIFY"],
"market":"",
"language":"",
"currentDemand":0,
"growthPotential":0,
"breakoutConfidence":0,
"marketSaturation":0,
"competition":"LOW|MEDIUM|HIGH",
"risk":"LOW|MEDIUM|HIGH|BLOCKED",
"heliosScore":0,
"verdict":"STRONG_NOW|EMERGING|BREAKOUT|WATCH|REJECT",
"whyNow":"",
"searchTerms":[""],
"evidence":[
{
"title":"",
"url":"",
"signal":""
}
]
}
]
}

FONTI WEB:
${JSON.stringify(
sourcePayload
)
.slice(
0,
26000
)}
`;

const ai =
await heliosAIJson(
prompt,
{
temperature:
0.1,

maxTokens:
6500
}
);

if (!ai.ok) {

return {
ok:
false,

error:
ai.error,

signals,

opportunities: []
};
}

const out =
ai.data ||
{};

const opportunities =
(
Array.isArray(
out.opportunities
)
? out.opportunities
: []
)

.map(
(o, i) => ({

rank:
Number(
o.rank
) ||
i + 1,

name:
String(
o.name ||
"Opportunità"
)
.slice(
0,
140
),

channelFit:
Array.isArray(
o.channelFit
)
? o.channelFit
.map(
(x) =>
String(x)
.toUpperCase()
)
.filter(
(x) =>
stores.includes(x)
)
: [],

market:
o.market ||
"Global",

language:
o.language ||
"English",

currentDemand:
heliosClamp(
o.currentDemand
),

growthPotential:
heliosClamp(
o.growthPotential
),

breakoutConfidence:
heliosClamp(
o.breakoutConfidence
),

marketSaturation:
heliosClamp(
o.marketSaturation
),

competition:
[
"LOW",
"MEDIUM",
"HIGH"
]
.includes(
String(
o.competition
)
.toUpperCase()
)
? String(
o.competition
)
.toUpperCase()
: "MEDIUM",

risk:
[
"LOW",
"MEDIUM",
"HIGH",
"BLOCKED"
]
.includes(
String(
o.risk
)
.toUpperCase()
)
? String(
o.risk
)
.toUpperCase()
: "MEDIUM",

heliosScore:
heliosClamp(
o.heliosScore
),

verdict:
[
"STRONG_NOW",
"EMERGING",
"BREAKOUT",
"WATCH",
"REJECT"
]
.includes(
String(
o.verdict
)
.toUpperCase()
)
? String(
o.verdict
)
.toUpperCase()
: "WATCH",

whyNow:
String(
o.whyNow ||
""
)
.slice(
0,
800
),

searchTerms:
Array.isArray(
o.searchTerms
)
? o.searchTerms
.slice(
0,
12
)
.map(String)
: [],

evidence:
Array.isArray(
o.evidence
)
? o.evidence
.slice(
0,
8
)
: []
})
)

.filter(
(o) =>
o.risk !==
"BLOCKED" &&
o.verdict !==
"REJECT" &&
o.channelFit.length
)

.sort(
(a, b) => {

const aDyn =
a.heliosScore *
0.55 +
a.growthPotential *
0.25 +
a.breakoutConfidence *
0.2;

const bDyn =
b.heliosScore *
0.55 +
b.growthPotential *
0.25 +
b.breakoutConfidence *
0.2;

return (
bDyn -
aDyn
);
}
);

return {
ok:
true,

provider:
ai.provider,

marketScope:
out.marketScope ||
"GLOBAL",

sourceConfidence:
out.sourceConfidence ||
"MEDIUM",

signals,

opportunities
};
}

async function heliosRankCollectiveCandidates(
opportunity,
products
) {

const compact =
products
.slice(
0,
80
)
.map(
(p, index) => ({

index,

id:
p.id,

title:
p.title,

vendor:
p.vendor,

productType:
p.productType,

tags:
p.tags,

inventory:
p.inventory,

retail:
p.variants?.[0]
?.retailPrice ??
null,

supplierCost:
p.variants?.[0]
?.supplierCost ??
null,

marginPct:
p.variants?.[0]
?.grossMarginPct ??
null
})
);

const prompt = `
Sei HELIOS Supplier/Product Matcher.

Opportunità commerciale selezionata:
${JSON.stringify(
opportunity
)}

Prodotti Shopify Collective già importati come BOZZA nel negozio:
${JSON.stringify(
compact
)
.slice(
0,
22000
)}

Scegli i migliori candidati semanticamente coerenti con l'opportunità.

Non forzare un match: se nessun prodotto è realmente adatto, restituisci emptyMatch=true.

Valuta anche inventario e margine quando disponibile.

Non inventare costi o spedizione.

Restituisci solo JSON:

{
"emptyMatch":false,
"matches":[
{
"index":0,
"fit":0,
"reason":"",
"demand":0,
"growth":0,
"breakout":0,
"saturation":0
}
]
}
`;

const ai =
await heliosAIJson(
prompt,
{
temperature:
0.05,

maxTokens:
3200
}
);

if (!ai.ok) {

return {
emptyMatch:
true,

matches: [],

error:
ai.error
};
}

const matches =
(
Array.isArray(
ai.data?.matches
)
? ai.data.matches
: []
)

.filter(
(m) =>
Number.isInteger(
Number(
m.index
)
) &&
products[
Number(
m.index
)
]
)

.map(
(m) => ({

index:
Number(
m.index
),

fit:
heliosClamp(
m.fit
),

reason:
String(
m.reason ||
""
)
.slice(
0,
500
),

demand:
heliosClamp(
m.demand ??
opportunity.currentDemand
),

growth:
heliosClamp(
m.growth ??
opportunity.growthPotential
),

breakout:
heliosClamp(
m.breakout ??
opportunity.breakoutConfidence
),

saturation:
heliosClamp(
m.saturation ??
opportunity.marketSaturation
)
})
)

.sort(
(a, b) =>
b.fit -
a.fit
);

return {

emptyMatch:
Boolean(
ai.data?.emptyMatch
) ||
!matches.length ||
matches[0].fit <
55,

matches
};
}

async function heliosOptimizeCollectiveListing(
product,
opportunity
) {

const prompt = `
Sei HELIOS Listing Intelligence.

Ottimizza questo prodotto Shopify Collective per conversione e SEO, mantenendo informazioni vere e senza modificare dati tecnici non verificati.

NON modificare prezzo, inventario, SKU, vendor o attributi sincronizzati dal fornitore.

NON fare claim medici o non verificati.

Mantieni il prodotto adatto a uno store umbrella multi-nicchia.

OPPORTUNITA:
${JSON.stringify(
opportunity
)}

PRODOTTO:
${JSON.stringify({
title:
product.title,

descriptionHtml:
product.descriptionHtml,

vendor:
product.vendor,

productType:
product.productType,

tags:
product.tags,

variants:
product.variants
})
.slice(
0,
18000
)}

Restituisci solo JSON:

{
"title":"",
"descriptionHtml":"",
"productType":"",
"tags":[""],
"seo":{
"title":"",
"description":""
},
"collection":{
"title":"",
"handle":"",
"descriptionHtml":""
},
"commerceShield":{
"risk":"LOW|MEDIUM|HIGH|BLOCKED",
"reasons":[]
},
"quality":{
"content":0,
"visual":0,
"usability":0,
"perceivedValue":0,
"listing":0,
"seo":0
}
}
`;

const ai =
await heliosAIJson(
prompt,
{
temperature:
0.2,

maxTokens:
5200
}
);

if (!ai.ok) {

return {
ok:
false,

error:
ai.error
};
}

const d =
ai.data ||
{};

const risk =
[
"LOW",
"MEDIUM",
"HIGH",
"BLOCKED"
]
.includes(
String(
d?.commerceShield
?.risk
)
.toUpperCase()
)
? String(
d.commerceShield
.risk
)
.toUpperCase()
: "MEDIUM";

return {
ok:
true,

provider:
ai.provider,

listing: {

title:
String(
d.title ||
product.title
)
.slice(
0,
255
),

descriptionHtml:
String(
d.descriptionHtml ||
product.descriptionHtml ||
""
)
.slice(
0,
60000
),

productType:
String(
d.productType ||
product.productType ||
""
)
.slice(
0,
255
),

tags:
[
...new Set([
...(product.tags || []),
...(
Array.isArray(
d.tags
)
? d.tags
: []
),
"HELIOS"
])
]
.map(String)
.slice(
0,
250
),

seo: {

title:
String(
d?.seo?.title ||
d.title ||
product.title
)
.slice(
0,
70
),

description:
String(
d?.seo?.description ||
""
)
.slice(
0,
320
)
}
},

collection: {

title:
String(
d?.collection?.title ||
opportunity.name ||
product.productType ||
"Featured"
)
.slice(
0,
120
),

handle:
heliosSlug(
d?.collection?.handle ||
d?.collection?.title ||
opportunity.name ||
product.productType ||
"featured"
),

descriptionHtml:
String(
d?.collection
?.descriptionHtml ||
""
)
.slice(
0,
5000
)
},

commerceShield: {

risk,

reasons:
Array.isArray(
d?.commerceShield
?.reasons
)
? d
.commerceShield
.reasons
.slice(
0,
10
)
.map(String)
: []
},

quality: {

content:
heliosClamp(
d?.quality?.content
),

visual:
heliosClamp(
d?.quality?.visual
),

usability:
heliosClamp(
d?.quality?.usability
),

perceivedValue:
heliosClamp(
d?.quality
?.perceivedValue
),

listing:
heliosClamp(
d?.quality?.listing
),

seo:
heliosClamp(
d?.quality?.seo
)
}
};
}

function heliosQualityGate({
product,
score,
optimization
}) {

const hard = {

collectiveManaged:
Boolean(
(product?.tags || [])
.includes(
HELIOS_COLLECTIVE_TAG
)
),

supplierLinked:
Boolean(
product?.vendor ||
product?.supplierTag
),

inventory:
Number(
product?.inventory ||
0
) > 0,

validPrice:
Number(
product?.variants?.[0]
?.retailPrice ||
0
) > 0,

commerceShield:
optimization
?.commerceShield
?.risk !==
"BLOCKED",

completeListing:
Boolean(
optimization
?.listing
?.title &&
optimization
?.listing
?.descriptionHtml
)
};

const qualityValues =
Object.values(
optimization?.quality ||
{}
)
.filter(
(x) =>
Number.isFinite(
Number(x)
)
);

const qualityAverage =
qualityValues.length
? qualityValues.reduce(
(s, x) =>
s +
Number(x),
0
) /
qualityValues.length
: 0;

const commercial =
score?.heliosScore ??
0;

const confidence =
score?.confidence ||
"LOW";

const hardPass =
Object.values(
hard
)
.every(Boolean);

const pass =
hardPass &&
qualityAverage >=
65 &&
commercial >=
60 &&
optimization
?.commerceShield
?.risk !==
"HIGH";

return {

pass,

hardPass,

hardGates:
hard,

qualityAverage:
Math.round(
qualityAverage
),

commercialScore:
commercial,

confidence,

status:
pass
? "PASS"
: hardPass
? "REPAIR_OR_DECISION"
: "BLOCKED"
};
}

async function heliosUpsertCollection(
collection,
productId,
publish = false
) {

const handle =
heliosSlug(
collection?.handle ||
collection?.title ||
"featured"
);

const find =
await shopifyGraphQL(`
query HeliosFindCollection($query: String!) {
collections(
first: 10,
query: $query
) {
nodes {
id
title
handle
}
}
}
`,
{
query:
`handle:${handle}`
}
);

let col =
(
find?.collections?.nodes ||
[]
)
.find(
(x) =>
x.handle ===
handle
) ||
null;

if (!col) {

const created =
await shopifyGraphQL(`
mutation HeliosCollectionCreate($input: CollectionInput!) {
collectionCreate(input: $input) {
collection {
id
title
handle
}
userErrors {
field
message
}
}
}
`,
{
input: {

title:
collection?.title ||
"Featured",

handle,

descriptionHtml:
collection?.descriptionHtml ||
"",

products: [
productId
]
}
}
);

const errors =
created
?.collectionCreate
?.userErrors ||
[];

if (errors.length) {

throw new Error(
`Collection create: ${
errors
.map(
(x) =>
x.message
)
.join(
" | "
)
}`
);
}

col =
created
?.collectionCreate
?.collection ||
null;

} else {

const added =
await shopifyGraphQL(`
mutation HeliosCollectionAdd(
$id: ID!,
$productIds: [ID!]!
) {
collectionAddProducts(
id: $id,
productIds: $productIds
) {
collection {
id
title
handle
}
userErrors {
field
message
}
}
}
`,
{
id:
col.id,

productIds: [
productId
]
}
);

const errors =
added
?.collectionAddProducts
?.userErrors ||
[];

const meaningful =
errors.filter(
(x) =>
!/already exists|already.*collection/i
.test(
x.message ||
""
)
);

if (meaningful.length) {

throw new Error(
`Collection add: ${
meaningful
.map(
(x) =>
x.message
)
.join(
" | "
)
}`
);
}
}

if (
publish &&
col?.id
) {

const pub =
await heliosOnlineStorePublication();

if (pub?.id) {

await shopifyGraphQL(`
mutation HeliosPublishCollection(
$id: ID!,
$publicationId: ID!
) {
publishablePublish(
id: $id,
input: {
publicationId: $publicationId
}
) {
userErrors {
field
message
}
}
}
`,
{
id:
col.id,

publicationId:
pub.id
}
);
}
}

return col;
}

async function heliosApplyCollectiveListing(
product,
optimization,
{
publish = false
} = {}
) {

const p =
optimization.listing;

const update =
await shopifyGraphQL(`
mutation HeliosProductUpdate(
$product: ProductUpdateInput!
) {
productUpdate(
product: $product
) {
product {
id
title
handle
status
tags
productType
seo {
title
description
}
onlineStoreUrl
}
userErrors {
field
message
}
}
}
`,
{
product: {

id:
product.id,

title:
p.title,

descriptionHtml:
p.descriptionHtml,

productType:
p.productType,

tags:
p.tags,

seo:
p.seo,

status:
publish
? "ACTIVE"
: "DRAFT",

metafields: [
{
namespace:
"helios",

key:
"managed",

type:
"boolean",

value:
"true"
},
{
namespace:
"helios",

key:
"last_optimized_at",

type:
"single_line_text_field",

value:
heliosNow()
}
]
}
}
);

const errors =
update
?.productUpdate
?.userErrors ||
[];

if (errors.length) {

throw new Error(
`Product update: ${
errors
.map(
(x) =>
x.message
)
.join(
" | "
)
}`
);
}

const updated =
update
?.productUpdate
?.product;

let publication =
null;

if (
publish &&
updated?.id
) {

const pub =
await heliosOnlineStorePublication();

if (!pub?.id) {

throw new Error(
"Pubblicazione Online Store non trovata"
);
}

const published =
await shopifyGraphQL(`
mutation HeliosPublishProduct(
$id: ID!,
$publicationId: ID!
) {
publishablePublish(
id: $id,
input: {
publicationId: $publicationId
}
) {
publishable {
publishedOnPublication(
publicationId: $publicationId
)
}
userErrors {
field
message
}
}
}
`,
{
id:
updated.id,

publicationId:
pub.id
}
);

const pubErrors =
published
?.publishablePublish
?.userErrors ||
[];

if (pubErrors.length) {

throw new Error(
`Product publish: ${
pubErrors
.map(
(x) =>
x.message
)
.join(
" | "
)
}`
);
}

publication =
pub;
}

return {
product:
updated,

publication
};
}

function heliosBrandSectionLiquid() {

return String.raw`
{% comment %}
CORTEX HELIOS generated section
{% endcomment %}

<section
class="helios-home"
style="
--h-bg: {{ section.settings.bg }};
--h-fg: {{ section.settings.fg }};
--h-accent: {{ section.settings.accent }};
"
>

<div class="helios-hero">

<p class="helios-kicker">
{{ section.settings.kicker }}
</p>

<h1>
{{ section.settings.heading }}
</h1>

<p class="helios-sub">
{{ section.settings.subheading }}
</p>

{% if section.settings.cta_label != blank and section.settings.cta_link != blank %}

<a
class="helios-cta"
href="{{ section.settings.cta_link }}"
>
{{ section.settings.cta_label }}
</a>

{% endif %}

</div>

<div class="helios-grid">

{% for block in section.blocks %}

{% assign c = collections[block.settings.collection] %}

{% if c != blank %}

<a
class="helios-card"
href="{{ c.url }}"
{{ block.shopify_attributes }}
>

{% if c.featured_image %}

{{ c.featured_image
| image_url: width: 900
| image_tag:
loading: 'lazy',
alt: c.title
}}

{% endif %}

<div class="helios-card-copy">

<span>
{{ c.title }}
</span>

<small>
{{ c.products_count }} prodotti
</small>

</div>

</a>

{% endif %}

{% endfor %}

</div>

</section>

<style>

.helios-home {
background: var(--h-bg);
color: var(--h-fg);
padding: clamp(28px,5vw,80px) clamp(18px,4vw,64px);
font-family: inherit;
}

.helios-hero {
max-width: 980px;
margin: 0 auto 48px;
text-align: center;
}

.helios-kicker {
text-transform: uppercase;
letter-spacing: .18em;
font-size: 12px;
opacity: .66;
}

.helios-home h1 {
font-size: clamp(42px,8vw,92px);
line-height: .95;
letter-spacing: -.045em;
margin: 18px 0;
}

.helios-sub {
font-size: clamp(16px,2vw,22px);
max-width: 720px;
margin: 0 auto;
opacity: .76;
}

.helios-cta {
display: inline-block;
margin-top: 26px;
padding: 14px 22px;
border-radius: 999px;
background: var(--h-accent);
color: var(--h-bg);
text-decoration: none;
font-weight: 700;
}

.helios-grid {
max-width: 1240px;
margin: 0 auto;
display: grid;
grid-template-columns:
repeat(
auto-fit,
minmax(240px,1fr)
);
gap: 18px;
}

.helios-card {
position: relative;
min-height: 320px;
border-radius: 24px;
overflow: hidden;
background:
color-mix(
in srgb,
var(--h-fg) 8%,
transparent
);
color: inherit;
text-decoration: none;
}

.helios-card img {
width: 100%;
height: 100%;
min-height: 320px;
object-fit: cover;
display: block;
transition:
transform .6s
cubic-bezier(.2,.7,.2,1);
}

.helios-card:hover img {
transform: scale(1.035);
}

.helios-card-copy {
position: absolute;
left: 16px;
right: 16px;
bottom: 16px;
background:
color-mix(
in srgb,
var(--h-bg) 80%,
transparent
);
backdrop-filter: blur(14px);
padding: 14px 16px;
border-radius: 16px;
display: flex;
justify-content: space-between;
gap: 12px;
align-items: center;
}

.helios-card-copy span {
font-weight: 700;
}

.helios-card-copy small {
opacity: .65;
}

</style>

{% schema %}

{
"name": "HELIOS Home",

"settings": [

{
"type":"text",
"id":"kicker",
"label":"Kicker",
"default":"Curated by HELIOS"
},

{
"type":"text",
"id":"heading",
"label":"Titolo",
"default":"Discover what matters next"
},

{
"type":"textarea",
"id":"subheading",
"label":"Sottotitolo",
"default":"A multi-niche store curated around products with real demand, utility and momentum."
},

{
"type":"text",
"id":"cta_label",
"label":"CTA",
"default":"Explore"
},

{
"type":"url",
"id":"cta_link",
"label":"Link CTA"
},

{
"type":"color",
"id":"bg",
"label":"Sfondo",
"default":"#f4f1ea"
},

{
"type":"color",
"id":"fg",
"label":"Testo",
"default":"#111111"
},

{
"type":"color",
"id":"accent",
"label":"Accent",
"default":"#111111"
}

],

"blocks": [

{
"type":"collection",
"name":"Collection",

"settings":[

{
"type":"collection",
"id":"collection",
"label":"Collection"
}

]
}

],

"max_blocks": 8,

"presets":[
{
"name":"HELIOS Home"
}
]

}

{% endschema %}
`;
}

async function heliosGenerateBrandBlueprint(
context = {}
) {

const prompt = `
Sei HELIOS Brand & Store Architect.

Crea l'identità di uno store Shopify PRINCIPALE multi-nicchia, premium e credibile.

Non deve essere legato a un solo prodotto o trend.

Deve poter contenere Tech, Home, Lifestyle, Travel, Beauty, Accessories, Pet, Wellness e future nicchie senza sembrare un marketplace caotico.

Il brand deve essere originale, pronunciabile internazionalmente, breve e non dipendere da trademark noti.

Non affermare disponibilità legale del marchio: segnala sempre che la verifica trademark/domain è separata.

CONTESTO:

${JSON.stringify(
context
)
.slice(
0,
10000
)}

Restituisci solo JSON:

{
"brandName":"",
"tagline":"",
"positioning":"",
"tone":[""],
"palette":{
"background":"#",
"foreground":"#",
"accent":"#"
},
"home":{
"kicker":"",
"heading":"",
"subheading":"",
"ctaLabel":"Explore"
},
"collections":[
{
"title":"Tech",
"handle":"tech"
}
],
"seo":{
"title":"",
"description":""
},
"trademarkCheckRequired":true
}
`;

const ai =
await heliosAIJson(
prompt,
{
temperature:
0.55,

maxTokens:
3200
}
);

if (!ai.ok) {

return {
ok:
false,
error:
ai.error
};
}

return {
ok:
true,

provider:
ai.provider,

blueprint:
ai.data
};
}

async function heliosApplyBrandTheme(
blueprint,
{
confirm = false
} = {}
) {

if (!confirm) {

return {
ok:
false,

requiresConfirmation:
true,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"BRAND DEPLOYMENT REQUIRES CONFIRMATION",

message:
"HELIOS ha preparato il nuovo stile dello store. La scrittura del tema modifica la homepage pubblica e richiede una conferma esplicita.",

reason:
"STRUCTURAL_STORE_CHANGE",

actions: [
{
id:
"CONFIRM_BRAND_DEPLOY",

label:
"APPLY BRAND",

type:
"BACKEND",

payload: {
confirm:
true
}
},
{
id:
"OPEN_THEME",

label:
"OPEN SHOPIFY THEME",

type:
"LINK",

url:
heliosShopifyAdminUrl(
"themes"
)
}
]
})
};
}

const scopes =
await heliosShopifyScopes();

if (
!scopes.includes(
"write_themes"
)
) {

return {
ok:
false,

requiresOwnerAction:
true,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"SHOPIFY THEME PERMISSION REQUIRED",

message:
"HELIOS può generare il brand e il sito, ma l'app CORTEX non ha ancora lo scope write_themes necessario per scrivere il tema.",

reason:
"MISSING_WRITE_THEMES_SCOPE_OR_EXEMPTION",

actions: [
{
id:
"OPEN_APPS",

label:
"OPEN SHOPIFY APPS",

type:
"LINK",

url:
heliosShopifyAdminUrl(
"settings/apps"
)
},
{
id:
"VIEW_PLAN",

label:
"VIEW BRAND PLAN",

type:
"LOCAL"
}
]
})
};
}

const theme =
await heliosMainTheme();

if (!theme?.id) {

return {
ok:
false,

requiresOwnerAction:
true,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"THEME ACCESS NOT AVAILABLE",

message:
"HELIOS non riesce a leggere il tema principale. Shopify può richiedere anche l'esenzione specifica per la modifica dei theme files.",

reason:
theme?.error ||
"THEME_NOT_FOUND",

actions: [
{
id:
"OPEN_THEME",

label:
"OPEN THEMES",

type:
"LINK",

url:
heliosShopifyAdminUrl(
"themes"
)
}
]
})
};
}

const collections =
Array.isArray(
blueprint?.collections
)
? blueprint.collections
.slice(
0,
8
)
: [];

const blocks = {};
const blockOrder = [];

collections.forEach(
(c, i) => {

const id =
`collection_${i + 1}`;

blocks[id] = {
type:
"collection",

settings: {
collection:
heliosSlug(
c.handle ||
c.title
)
}
};

blockOrder.push(id);
}
);

const sectionSettings = {

kicker:
blueprint?.home?.kicker ||
"Curated by HELIOS",

heading:
blueprint?.home?.heading ||
blueprint?.brandName ||
"Discover what matters next",

subheading:
blueprint?.home?.subheading ||
blueprint?.positioning ||
"",

cta_label:
blueprint?.home?.ctaLabel ||
"Explore",

cta_link:
"/collections/all",

bg:
blueprint?.palette?.background ||
"#f4f1ea",

fg:
blueprint?.palette?.foreground ||
"#111111",

accent:
blueprint?.palette?.accent ||
"#111111"
};

const indexJson =
JSON.stringify({

sections: {

helios_home: {

type:
"helios-home",

blocks,

block_order:
blockOrder,

settings:
sectionSettings
}
},

order: [
"helios_home"
]
});

try {

const d =
await shopifyGraphQL(`
mutation HeliosThemeFiles(
$themeId: ID!,
$files: [OnlineStoreThemeFilesUpsertFileInput!]!
) {
themeFilesUpsert(
themeId: $themeId,
files: $files
) {
upsertedThemeFiles {
filename
}
job {
id
}
userErrors {
field
message
}
}
}
`,
{
themeId:
theme.id,

files: [
{
filename:
"sections/helios-home.liquid",

body: {
type:
"TEXT",

value:
heliosBrandSectionLiquid()
}
},
{
filename:
"templates/index.json",

body: {
type:
"TEXT",

value:
indexJson
}
}
]
},
HELIOS_THEME_API_VERSION
);

const errors =
d
?.themeFilesUpsert
?.userErrors ||
[];

if (errors.length) {

return {
ok:
false,

requiresOwnerAction:
true,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"SHOPIFY BLOCKED THEME WRITE",

message:
"Il brand è pronto ma Shopify ha rifiutato la scrittura del tema.",

reason:
errors
.map(
(x) =>
x.message
)
.join(
" | "
),

actions: [
{
id:
"OPEN_THEME",

label:
"OPEN THEMES",

type:
"LINK",

url:
heliosShopifyAdminUrl(
"themes"
)
},
{
id:
"VIEW_BRAND",

label:
"VIEW BRAND PLAN",

type:
"LOCAL"
}
]
})
};
}

return {
ok:
true,

theme,

files:
d
?.themeFilesUpsert
?.upsertedThemeFiles ||
[],

job:
d
?.themeFilesUpsert
?.job ||
null
};

} catch (error) {

return {
ok:
false,

requiresOwnerAction:
true,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"THEME API AUTHORIZATION REQUIRED",

message:
"HELIOS ha generato il sito ma Shopify richiede permessi/esenzione per modificare i theme files.",

reason:
String(
error?.message ||
error
),

actions: [
{
id:
"OPEN_THEME",

label:
"OPEN THEMES",

type:
"LINK",

url:
heliosShopifyAdminUrl(
"themes"
)
}
]
})
};
}
}

function heliosNewMission(
stores,
objective = ""
) {

return {

id:
heliosId(
"HM"
),

version:
HELIOS_VERSION,

status:
"ACTIVE",

mode:
"FULL_AUTO",

selectedStores:
stores,

objective:
objective ||
"Find the highest-value commercial opportunity.",

createdAt:
heliosNow(),

updatedAt:
heliosNow(),

checkpoint:
"SMART_LAUNCH",

progress:
5,

capital: {

initialPersonalCap:
HELIOS_DEFAULT_INITIAL_CAPITAL,

personalSpent:
0,

availableGeneratedProfit:
0,

autoReinvestMaxPct:
HELIOS_AUTO_REINVEST_MAX_PCT
},

pipelines: {},

events: [
{
at:
heliosNow(),

type:
"MISSION_STARTED",

stores
}
],

decisionRequired:
null
};
}

async function heliosRunMissionStart(
body
) {

const stores =
heliosSelectedStores(
body
);

if (!stores.length) {

return {

ok:
false,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"NO STORE SELECTED",

message:
"Seleziona almeno uno store nella card HELIOS prima di avviare la missione.",

reason:
"STORE_SELECTION_REQUIRED",

actions: [
{
id:
"SELECT_STORE",

label:
"SELECT STORE",

type:
"LOCAL"
}
]
})
};
}

const mission =
heliosNewMission(
stores,
body.objective ||
""
);

if (
stores.includes(
"ETSY"
)
) {

const etsyReady =
Boolean(
process.env
.ETSY_API_KEY &&
process.env
.ETSY_SHARED_SECRET &&
process.env
.ETSY_ACCESS_TOKEN &&
process.env
.ETSY_SHOP_ID
);

mission.pipelines
.ETSY =
etsyReady
? {
status:
"READY",

step:
"MARKET_SCAN",

progress:
5
}
: {
status:
"WAITING",

step:
"CONNECT_STORE",

progress:
0,

reason:
"ETSY_NOT_CONNECTED"
};
}

if (
stores.includes(
"SHOPIFY"
)
) {

mission.pipelines
.SHOPIFY = {

status:
"ACTIVE",

step:
"MARKET_SCAN",

progress:
5
};
}

const scan =
await heliosGlobalMarketScan(
stores,
mission.objective
);

if (
!scan.ok ||
!scan.opportunities.length
) {

mission.status =
"WAITING";

mission.checkpoint =
"MARKET_SCAN_FAILED";

mission.progress =
10;

mission.updatedAt =
heliosNow();

mission.decisionRequired = {

type:
"CONFIGURATION_OR_DATA",

reason:
scan.error ||
"INSUFFICIENT_MARKET_EVIDENCE"
};

return {

ok:
false,

mission,

scan,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"MARKET INTELLIGENCE PAUSED",

message:
"HELIOS non ha abbastanza segnali affidabili per scegliere un'opportunità senza inventare dati.",

reason:
scan.error ||
"INSUFFICIENT_MARKET_EVIDENCE",

missionId:
mission.id,

state:
"WAITING",

actions: [
{
id:
"RETRY_SCAN",

label:
"RETRY SCAN",

type:
"BACKEND"
}
]
})
};
}

mission.marketScan = {

sourceConfidence:
scan.sourceConfidence,

opportunities:
scan.opportunities
.slice(
0,
10
)
};

mission.checkpoint =
"OPPORTUNITY_SELECTED";

mission.progress =
28;

mission.updatedAt =
heliosNow();

for (
const store of
stores
) {

const opp =
scan.opportunities
.find(
(o) =>
o.channelFit
.includes(
store
)
);

if (!opp) {

mission.pipelines[
store
] = {

status:
"WAITING",

step:
"NO_VALID_OPPORTUNITY",

progress:
20,

reason:
"NO_VALID_OPPORTUNITY"
};

continue;
}

mission.pipelines[
store
] = {

...(
mission.pipelines[
store
] ||
{}
),

status:
store ===
"ETSY" &&
mission.pipelines[
store
]?.reason ===
"ETSY_NOT_CONNECTED"
? "WAITING"
: "ACTIVE",

step:
"OPPORTUNITY_SELECTED",

progress:
28,

opportunity:
opp
};
}

if (
stores.includes(
"SHOPIFY"
)
) {

const products =
await heliosCollectiveProducts({
limit:
150
});

const shopPipe =
mission.pipelines
.SHOPIFY;

if (!products.length) {

shopPipe.status =
"WAITING";

shopPipe.step =
"SUPPLIER_CONNECTION_REQUIRED";

shopPipe.progress =
34;

shopPipe.reason =
"NO_COLLECTIVE_PRODUCTS_IMPORTED";

mission.status =
stores.every(
(s) =>
mission.pipelines[
s
]?.status ===
"WAITING"
)
? "WAITING"
: "ACTIVE";

mission.checkpoint =
"SUPPLIER_CONNECTION_REQUIRED";

mission.updatedAt =
heliosNow();

mission.decisionRequired = {

type:
"OWNER_ACTION",

store:
"SHOPIFY",

reason:
"Collective non espone API pubbliche per cercare/invitare/accettare fornitori."
};

return {

ok:
true,

mission,

scan,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"SHOPIFY SUPPLIER CONNECTION REQUIRED",

message:
`HELIOS ha scelto l'opportunità “${shopPipe.opportunity?.name || ""}”, ma non trova ancora prodotti Collective importati da fornitori collegati.`,

reason:
"SHOPIFY_COLLECTIVE_CONNECTION_UI_REQUIRED",

missionId:
mission.id,

state:
"WAITING",

completed: [
"GLOBAL MARKET SCAN",
"OPPORTUNITY RANKING"
],

pending: [
"SUPPLIER CONNECTION",
"PRODUCT MATCH",
"QUALITY GATE",
"PUBLISH"
],

actions: [
{
id:
"OPEN_COLLECTIVE",

label:
"OPEN COLLECTIVE",

type:
"LINK",

url:
heliosCollectiveUrl()
},
{
id:
"VIEW_OPPORTUNITY",

label:
"VIEW OPPORTUNITY",

type:
"LOCAL"
}
]
})
};
}

const match =
await heliosRankCollectiveCandidates(
shopPipe.opportunity,
products
);

if (
match.emptyMatch
) {

shopPipe.status =
"WAITING";

shopPipe.step =
"BETTER_SUPPLIER_REQUIRED";

shopPipe.progress =
38;

shopPipe.reason =
"NO_STRONG_PRODUCT_MATCH";

shopPipe.candidateCount =
products.length;

mission.status =
"WAITING";

mission.checkpoint =
"BETTER_SUPPLIER_REQUIRED";

mission.updatedAt =
heliosNow();

return {

ok:
true,

mission,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"NO STRONG COLLECTIVE MATCH",

message:
`HELIOS ha analizzato ${products.length} prodotti Collective ma nessuno è abbastanza coerente con l'opportunità selezionata. Non pubblicherà un prodotto debole solo per completare la missione.`,

reason:
"SUPPLIER_CATALOG_MISMATCH",

missionId:
mission.id,

state:
"WAITING",

actions: [
{
id:
"OPEN_COLLECTIVE",

label:
"FIND SUPPLIER",

type:
"LINK",

url:
heliosCollectiveUrl()
},
{
id:
"CHOOSE_NEXT_OPPORTUNITY",

label:
"TRY NEXT OPPORTUNITY",

type:
"BACKEND"
}
]
})
};
}

const bestMatch =
match.matches[0];

const product =
products[
bestMatch.index
];

const score =
heliosPhysicalScore(
product,
bestMatch
);

const optimization =
await heliosOptimizeCollectiveListing(
product,
shopPipe.opportunity
);

if (!optimization.ok) {

shopPipe.status =
"WAITING";

shopPipe.step =
"LISTING_INTELLIGENCE_FAILED";

shopPipe.progress =
52;

shopPipe.reason =
optimization.error;

mission.status =
"WAITING";

mission.updatedAt =
heliosNow();

return {

ok:
false,

mission,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"LISTING INTELLIGENCE PAUSED",

message:
"Il prodotto è stato trovato, ma HELIOS non riesce a completare l'ottimizzazione con sufficiente affidabilità.",

reason:
optimization.error,

missionId:
mission.id,

actions: [
{
id:
"RETRY",

label:
"RETRY",

type:
"BACKEND"
}
]
})
};
}

const gate =
heliosQualityGate({

product,

score,

optimization
});

shopPipe.product = {

id:
product.id,

legacyId:
product.legacyId,

title:
product.title,

vendor:
product.vendor,

status:
product.status,

inventory:
product.inventory,

image:
product.image,

variants:
product.variants
};

shopPipe.match =
bestMatch;

shopPipe.score =
score;

shopPipe.optimization =
optimization;

shopPipe.qualityGate =
gate;

shopPipe.progress =
68;

if (!gate.pass) {

shopPipe.status =
"WAITING";

shopPipe.step =
gate.status ===
"BLOCKED"
? "QUALITY_BLOCKED"
: "QUALITY_DECISION";

mission.status =
"WAITING";

mission.checkpoint =
shopPipe.step;

mission.updatedAt =
heliosNow();

return {

ok:
true,

mission,

actionCard:
heliosActionCard({

severity:
gate.status ===
"BLOCKED"
? "CRITICAL"
: "ACTION_REQUIRED",

title:
gate.status ===
"BLOCKED"
? "QUALITY GATE BLOCKED"
: "QUALITY DECISION REQUIRED",

message:
"HELIOS non pubblica finché tutti gli hard gate e i livelli qualitativi non sono sufficienti.",

reason:
JSON.stringify(
gate.hardGates
),

missionId:
mission.id,

state:
"WAITING",

actions:
gate.status ===
"BLOCKED"
? [
{
id:
"REJECT_PRODUCT",

label:
"REJECT & REPLACE",

type:
"BACKEND"
}
]
: [
{
id:
"REPAIR",

label:
"SELF-REPAIR",

type:
"BACKEND"
},
{
id:
"VIEW_PRODUCT",

label:
"VIEW PRODUCT",

type:
"LOCAL"
}
]
})
};
}

shopPipe.status =
"READY_TO_PUBLISH";

shopPipe.step =
"QUALITY_GATE_PASSED";

shopPipe.progress =
78;

mission.checkpoint =
"SHOPIFY_READY_TO_PUBLISH";

mission.progress =
78;

mission.updatedAt =
heliosNow();
}

if (
stores.includes(
"ETSY"
) &&
mission.pipelines
.ETSY?.status ===
"WAITING"
) {

mission.status =
mission.pipelines
.SHOPIFY?.status ===
"READY_TO_PUBLISH"
? "ACTIVE"
: "WAITING";
}

return {

ok:
true,

mission,

scan,

smartLaunch: {

globalMarket:
true,

selectedStores:
stores,

fullAuto:
true,

initialCapitalCap:
HELIOS_DEFAULT_INITIAL_CAPITAL,

objective:
mission.objective
}
};
}

async function heliosPublishMissionProduct(
mission,
{
store = "SHOPIFY"
} = {}
) {

const target =
String(
store ||
"SHOPIFY"
)
.toUpperCase();

if (
!mission?.selectedStores
?.includes(
target
)
) {

return {

ok:
false,

actionCard:
heliosActionCard({

severity:
"CRITICAL",

title:
"STORE NOT AUTHORIZED",

message:
`${target} non è stato selezionato per questa missione. HELIOS non eseguirà operazioni sul canale.`,

reason:
"STORE_NOT_ENABLED_FOR_MISSION",

missionId:
mission?.id ||
null
})
};
}

if (
target !==
"SHOPIFY"
) {

return {

ok:
false,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"ETSY NOT CONNECTED YET",

message:
"La pipeline Etsy verrà attivata appena lo shop Etsy è aperto e OAuth è collegato.",

reason:
"ETSY_PENDING_SETUP",

missionId:
mission?.id ||
null
})
};
}

const pipe =
mission
?.pipelines
?.SHOPIFY;

if (
!pipe ||
pipe.status !==
"READY_TO_PUBLISH" ||
!pipe.product?.id ||
!pipe.optimization
) {

return {

ok:
false,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"PRODUCT NOT READY",

message:
"HELIOS non pubblica perché la pipeline Shopify non ha completato Opportunity → Supplier → Quality Gate.",

reason:
pipe?.step ||
"PIPELINE_INCOMPLETE",

missionId:
mission?.id ||
null
})
};
}

if (
!pipe
.qualityGate
?.pass
) {

return {

ok:
false,

actionCard:
heliosActionCard({

severity:
"CRITICAL",

title:
"QUALITY GATE NOT PASSED",

message:
"Pubblicazione bloccata da HELIOS Commerce Shield / Quality Gate.",

reason:
"QUALITY_GATE_REQUIRED",

missionId:
mission.id
})
};
}

const current =
(
await heliosCollectiveProducts({
limit:
200
})
)
.find(
(p) =>
p.id ===
pipe.product.id
);

if (!current) {

return {

ok:
false,

actionCard:
heliosActionCard({

severity:
"CRITICAL",

title:
"COLLECTIVE PRODUCT NO LONGER AVAILABLE",

message:
"Il prodotto selezionato non è più presente nel catalogo Collective importato. HELIOS non pubblicherà una copia scollegata dal fornitore.",

reason:
"PRODUCT_REMOVED_OR_UNSELLABLE",

missionId:
mission.id,

actions: [
{
id:
"REPLACE_PRODUCT",

label:
"FIND REPLACEMENT",

type:
"BACKEND"
}
]
})
};
}

if (
Number(
current.inventory ||
0
) <= 0
) {

return {

ok:
false,

actionCard:
heliosActionCard({

severity:
"IMPORTANT",

title:
"STOCK CHANGED",

message:
"Il prodotto è arrivato a stock zero prima della pubblicazione. HELIOS lo sostituisce invece di vendere senza copertura.",

reason:
"OUT_OF_STOCK",

missionId:
mission.id,

actions: [
{
id:
"REPLACE_PRODUCT",

label:
"FIND REPLACEMENT",

type:
"BACKEND"
}
]
})
};
}

try {

const applied =
await heliosApplyCollectiveListing(
current,
pipe.optimization,
{
publish:
true
}
);

const collection =
await heliosUpsertCollection(
pipe.optimization
.collection,
current.id,
true
);

const updatedMission =
JSON.parse(
JSON.stringify(
mission
)
);

updatedMission.status =
"CHECKPOINT";

updatedMission.checkpoint =
"PRODUCT_PUBLISHED";

updatedMission.progress =
100;

updatedMission.updatedAt =
heliosNow();

updatedMission
.pipelines
.SHOPIFY
.status =
"LIVE";

updatedMission
.pipelines
.SHOPIFY
.step =
"PRODUCT_PUBLISHED";

updatedMission
.pipelines
.SHOPIFY
.progress =
100;

updatedMission
.pipelines
.SHOPIFY
.live = {

id:
applied.product?.id ||
current.id,

title:
applied.product?.title ||
pipe.optimization
.listing.title,

handle:
applied.product?.handle ||
current.handle,

onlineStoreUrl:
applied.product
?.onlineStoreUrl ||
current.onlineStoreUrl ||
null,

collection
};

updatedMission.events = [

...(
updatedMission.events ||
[]
),

{
at:
heliosNow(),

type:
"PRODUCT_PUBLISHED",

store:
"SHOPIFY",

productId:
current.id
}
];

return {

ok:
true,

mission:
updatedMission,

result:
updatedMission
.pipelines
.SHOPIFY
.live,

chatCard: {

type:
"HELIOS_PRODUCT_CARD",

status:
"LIVE",

channel:
"SHOPIFY",

title:
applied.product?.title ||
pipe.optimization
.listing
.title,

score:
pipe.score
?.heliosScore ??
null,

growth:
pipe.match?.growth ??
null,

margin:
pipe.score
?.economics
?.grossMarginPct ??
null,

supplier:
current.vendor ||
current.supplierTag ||
"Collective",

url:
applied.product
?.onlineStoreUrl ||
current.onlineStoreUrl ||
null,

actions: [
{
id:
"VIEW_PRODUCT",

label:
"VIEW PRODUCT",

type:
"LOCAL"
},
{
id:
"FULL_ANALYSIS",

label:
"ANALISI COMPLETA",

type:
"LOCAL"
},
{
id:
"SHOPIFY",

label:
"SHOPIFY ↗",

type:
"LINK",

url:
heliosShopifyAdminUrl(
`products/${
current.legacyId ||
""
}`
)
}
]
},

checkpoint: {

required:
true,

message:
"Primo prodotto completato. Per creare/pubblicare un altro prodotto la missione richiede CONTINUA, come da regola HELIOS.",

actions: [
{
id:
"CONTINUE",

label:
"CONTINUA",

type:
"BACKEND"
},
{
id:
"STOP",

label:
"TERMINA",

type:
"BACKEND"
}
]
}
};

} catch (error) {

return {

ok:
false,

mission,

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"SHOPIFY PUBLISH PAUSED",

message:
"HELIOS ha fermato la missione nel punto esatto della pubblicazione.",

reason:
String(
error?.message ||
error
),

missionId:
mission.id,

state:
"WAITING",

completed: [
"MARKET",
"SUPPLIER",
"LISTING",
"QUALITY GATE"
],

pending: [
"PUBLISH"
],

actions: [
{
id:
"OPEN_PRODUCT",

label:
"OPEN SHOPIFY",

type:
"LINK",

url:
heliosShopifyAdminUrl(
`products/${
pipe.product
.legacyId ||
""
}`
)
},
{
id:
"RETRY_PUBLISH",

label:
"RETRY",

type:
"BACKEND"
}
]
})
};
}
}

// ============================================================
// MAIN HANDLER
// ============================================================

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

if (
req.method ===
"OPTIONS"
) {

return res
.status(200)
.end();
}

if (
req.method !==
"POST"
) {

return res
.status(405)
.json({
error:
"Usa POST"
});
}

try {

const body =
req.body ||
{};

// ============================================================
// CORTEX — VOCE
// ============================================================

if (
body.action ===
"tts"
) {

const key =
process.env
.ELEVENLABS_API_KEY;

if (!key) {

return res
.status(500)
.json({
error:
"ELEVENLABS_API_KEY mancante"
});
}

const text =
(body.text || "")
.toString()
.trim()
.slice(
0,
800
);

if (!text) {

return res
.status(400)
.json({
error:
"text mancante"
});
}

const voiceId =
(
body.voiceId ||
"EXAVITQu4vr4xnSDxMaL"
)
.toString();

const vs =
body.voice_settings ||
{};

const stability =
typeof vs.stability ===
"number"
? vs.stability
: 0.55;

const similarity =
typeof vs.similarity_boost ===
"number"
? vs.similarity_boost
: 0.85;

const style =
typeof vs.style ===
"number"
? vs.style
: 0.25;

const speed =
typeof body.speed ===
"number"
? Math.min(
Math.max(
body.speed,
0.7
),
1.2
)
: 1.0;

try {

const r =
await fetch(
"https://api.elevenlabs.io/v1/text-to-speech/" +
encodeURIComponent(
voiceId
),
{
method:
"POST",

headers: {
"xi-api-key":
key,

"Content-Type":
"application/json",

Accept:
"audio/mpeg"
},

body:
JSON.stringify({

text,

model_id:
"eleven_multilingual_v2",

voice_settings: {

stability,

similarity_boost:
similarity,

style,

use_speaker_boost:
true,

speed
}
})
}
);

if (!r.ok) {

const t =
await r.text();

return res
.status(
r.status
)
.json({
error:
"Errore ElevenLabs",

detail:
t.slice(
0,
300
)
});
}

const buf =
Buffer.from(
await r.arrayBuffer()
);

return res
.status(200)
.json({

ok:
true,

audio:
buf.toString(
"base64"
),

mime:
"audio/mpeg"
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
// IRIDE — PEXELS
// ============================================================

if (
body.action ===
"pexels"
) {

const pk =
process.env
.PEXELS_API_KEY;

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
body.query ||
"business"
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
Authorization:
pk
}
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
p.alt ||
"",

author:
p.photographer ||
"",

url:
p.url ||
""
}));

return res
.status(200)
.json({
photos
});
}

// ============================================================
// VIDEO
// ============================================================

if (
body.action ===
"video"
) {

const ck =
process.env
.CREATOMATE_API_KEY;

const pk =
process.env
.PEXELS_API_KEY;

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

const per =
15;

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
.status(
vr.status
)
.json({
error:
vd?.error ||
"Errore Pexels video"
});
}

const videos =
vd.videos ||
[];

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
?.link ||
null;

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
method:
"POST",

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
.status(
cr.status
)
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
// VIDEO STATUS
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
.status(
sr.status
)
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
// NERVUS — DATI MERCATO
// ============================================================

if (
body.action ===
"market"
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
/USDT$|BUSD$|BTC$|ETH$/
.test(
cleanSymbol
);

try {

if (isCrypto) {

const s =
cleanSymbol;

const [
t24,
kl
] =
await Promise.all([
fetch(
"https://api.binance.com/api/v3/ticker/24hr?symbol=" +
s
)
.then(
(r) =>
r.json()
),

fetch(
"https://api.binance.com/api/v3/klines?symbol=" +
s +
"&interval=1h&limit=24"
)
.then(
(r) =>
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
Array.isArray(
kl
)
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
)
.then(
(r) =>
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
// OCULUS — PLACES
// ============================================================

if (
body.action ===
"places"
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
// NERVUS — MARKET SERIES
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

const [
q,
ts
] =
await Promise.all([

fetch(
qUrl
)
.then(
(r) =>
r.json()
),

fetch(
tsUrl
)
.then(
(r) =>
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
v.volume != null
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
q.close != null
? Number(
q.close
)
: null,

changePct:
q.percent_change != null
? Number(
q.percent_change
)
: null,

high:
q.high != null
? Number(
q.high
)
: null,

low:
q.low != null
? Number(
q.low
)
: null,

volume:
q.volume != null
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
// NERVUS — ALPHA VANTAGE
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
)
.then(
(r) =>
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
Object.keys(
ts
)
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
] ||
last;

quote = {

price:
last.close,

changePct:
prev.close
? (
(last.close -
prev.close) /
prev.close
) *
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
await Promise.all([

fetch(
tsUrl
)
.then(
(r) =>
r.json()
),

fetch(
qUrl
)
.then(
(r) =>
r.json()
)

]);

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
Object.keys(
ts
)
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
] ||
{};

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
gqPrice != null
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
// TAVILY
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
// FIRECRAWL
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
!/^https?:\/\//
.test(
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
d.data ||
{};

const md =
(
data.markdown ||
""
)
.toString();

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
// COINDESK / CRYPTOCOMPARE
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
// HELIOS — CAPABILITIES
// ============================================================

if (
body.action ===
"helios_capabilities" ||
body.action ===
"helios_channels"
) {

const stores = [];

let shopify = {

id:
"SHOPIFY",

connected:
false,

status:
"NOT_CONNECTED",

mode:
"PHYSICAL_COLLECTIVE",

enabledForMission:
false,

capabilities: {},

scopes: [],

actionCard:
null
};

try {

const [
scopes,
shopRes,
products
] =
await Promise.all([

heliosShopifyScopes(),

shopifyGraphQL(`
query HeliosShopOverview {
shop {
name
myshopifyDomain
primaryDomain {
url
host
}
currencyCode
billingAddress {
countryCodeV2
}
}
}
`),

heliosCollectiveProducts({
limit:
100
})

]);

const payments =
await heliosShopifyPaymentsStatus();

const mainTheme =
await heliosMainTheme();

shopify = {

...shopify,

connected:
true,

status:
"CONNECTED",

scopes,

store: {

name:
shopRes?.shop?.name ||
process.env
.SHOPIFY_STORE,

myshopifyDomain:
shopRes?.shop
?.myshopifyDomain ||
`${process.env.SHOPIFY_STORE}.myshopify.com`,

primaryDomain:
shopRes?.shop
?.primaryDomain
?.url ||
null,

currency:
shopRes?.shop
?.currencyCode ||
null,

country:
shopRes?.shop
?.billingAddress
?.countryCodeV2 ||
null
},

payments,

collective: {

installedAndUsable:
true,

importedCandidates:
products.length,

note:
"Collective Discovery/inviti/accettazioni richiedono la UI Shopify; i prodotti condivisi da fornitori collegati possono essere importati automaticamente e gestiti da HELIOS."
},

theme:
mainTheme,

capabilities: {

readStore:
true,

readProducts:
scopes.includes(
"read_products"
) ||
scopes.includes(
"write_products"
),

writeProducts:
scopes.includes(
"write_products"
),

publishProducts:
scopes.includes(
"write_publications"
),

manageCollections:
scopes.includes(
"write_products"
),

managePages:
scopes.includes(
"write_online_store_pages"
) ||
scopes.includes(
"write_content"
),

manageNavigation:
scopes.includes(
"write_online_store_navigation"
),

readThemes:
scopes.includes(
"read_themes"
) ||
scopes.includes(
"write_themes"
),

writeThemes:
scopes.includes(
"write_themes"
),

readPayments:
scopes.includes(
"read_shopify_payments"
) ||
scopes.includes(
"read_shopify_payments_accounts"
)
}
};

} catch (error) {

shopify = {

...shopify,

status:
"ERROR",

error:
String(
error?.message ||
error
)
};
}

stores.push(
shopify
);

const etsyEnv = {

apiKey:
Boolean(
process.env
.ETSY_API_KEY
),

sharedSecret:
Boolean(
process.env
.ETSY_SHARED_SECRET
),

accessToken:
Boolean(
process.env
.ETSY_ACCESS_TOKEN
),

shopId:
Boolean(
process.env
.ETSY_SHOP_ID
)
};

const etsyConnected =
Object.values(
etsyEnv
)
.every(Boolean);

stores.push({

id:
"ETSY",

connected:
etsyConnected,

status:
etsyConnected
? "CONNECTED"
: "WAITING_SETUP",

mode:
"DIGITAL",

enabledForMission:
false,

configuration:
etsyEnv,

capabilities: {

marketScan:
true,

digitalFactory:
true,

publish:
etsyConnected,

fileUpload:
etsyConnected,

orderMonitoring:
etsyConnected
},

actionCard:
etsyConnected
? null
: heliosActionCard({

severity:
"IMPORTANT",

title:
"ETSY WAITING SETUP",

message:
"Lo shop Etsy non è ancora collegato a HELIOS. Completa l'apertura dello shop e poi OAuth/API.",

reason:
"ETSY_SHOP_NOT_CONNECTED",

actions: [
{
id:
"OPEN_ETSY",

label:
"OPEN ETSY",

type:
"LINK",

url:
"https://www.etsy.com/your/shops/me/dashboard"
}
]
})
});

return res
.status(200)
.json({

ok:
true,

heliosVersion:
HELIOS_VERSION,

stores,

missionRules: {

storeSelectionRequired:
true,

multiStoreAllowed:
true,

unselectedStoresAreBlocked:
true,

firstProductFullAutoAfterDeploy:
true,

checkpointAfterEachPublishedProduct:
true,

initialPersonalCapitalCap:
HELIOS_DEFAULT_INITIAL_CAPITAL,

maxAutoReinvestmentPct:
HELIOS_AUTO_REINVEST_MAX_PCT
}
});
}

// ============================================================
// HELIOS — SHOPIFY PERMISSIONS
// ============================================================

if (
body.action ===
"helios_shopify_permissions"
) {

try {

const scopes =
await heliosShopifyScopes();

const payments =
await heliosShopifyPaymentsStatus();

const theme =
await heliosMainTheme();

const publication =
await heliosOnlineStorePublication()
.catch(
() =>
null
);

const required = {

products: [
"write_products"
],

publications: [
"write_publications"
],

paymentsRead: [
"read_shopify_payments_accounts"
],

pages: [
"write_online_store_pages"
],

navigation: [
"write_online_store_navigation"
],

themes: [
"write_themes"
]
};

const status =
Object.fromEntries(

Object.entries(
required
)
.map(
([
key,
arr
]) => [

key,

{
ready:
arr.some(
(scope) =>
scopes.includes(
scope
)
) ||
(
key ===
"paymentsRead" &&
scopes.includes(
"read_shopify_payments"
)
) ||
(
key ===
"pages" &&
scopes.includes(
"write_content"
)
),

acceptedScopes:
arr
}
]
)
);

return res
.status(200)
.json({

ok:
true,

scopes,

status,

payments,

onlineStorePublication:
publication,

theme,

notes: {

collectiveDiscoveryApi:
false,

collectiveInvitationsApi:
false,

themeWriteNeedsShopifyExemption:
true
}
});

} catch (error) {

return res
.status(500)
.json({
error:
String(
error?.message ||
error
)
});
}
}

// ============================================================
// HELIOS — COLLECTIVE CANDIDATES
// ============================================================

if (
body.action ===
"helios_collective_candidates"
) {

const stores =
heliosSelectedStores(
body
);

if (
stores.length &&
!stores.includes(
"SHOPIFY"
)
) {

return res
.status(403)
.json({

error:
"SHOPIFY non è autorizzato per questa missione",

actionCard:
heliosActionCard({

severity:
"CRITICAL",

title:
"STORE NOT AUTHORIZED",

message:
"La missione non include Shopify.",

reason:
"STORE_NOT_ENABLED_FOR_MISSION"
})
});
}

try {

const products =
await heliosCollectiveProducts({
limit:
body.limit ||
150
});

const scored =
products.map(
(product) => ({

...product,

intelligence:
heliosPhysicalScore(
product,
body.market ||
{}
)
})
);

return res
.status(200)
.json({

ok:
true,

source:
"Shopify Collective imported products",

count:
scored.length,

products:
scored
});

} catch (error) {

return res
.status(500)
.json({
error:
String(
error?.message ||
error
)
});
}
}

// ============================================================
// HELIOS — MARKET SCAN
// ============================================================

if (
body.action ===
"helios_market_scan"
) {

const stores =
heliosSelectedStores(
body
);

if (!stores.length) {

return res
.status(400)
.json({

error:
"Seleziona almeno uno store",

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"NO STORE SELECTED",

message:
"HELIOS non avvia una scansione commerciale senza sapere su quali store è autorizzato a lavorare.",

reason:
"STORE_SELECTION_REQUIRED"
})
});
}

const scan =
await heliosGlobalMarketScan(
stores,
body.objective ||
""
);

return res
.status(
scan.ok
? 200
: 503
)
.json(
scan
);
}

// ============================================================
// HELIOS — BRAND PLAN
// ============================================================

if (
body.action ===
"helios_brand_plan"
) {

const stores =
heliosSelectedStores(
body
);

if (
stores.length &&
!stores.includes(
"SHOPIFY"
)
) {

return res
.status(403)
.json({

error:
"SHOPIFY non selezionato",

actionCard:
heliosActionCard({

severity:
"ACTION_REQUIRED",

title:
"SHOPIFY NOT SELECTED",

message:
"Seleziona Shopify nella card HELIOS prima di chiedere la creazione del sito Shopify.",

reason:
"STORE_NOT_ENABLED_FOR_MISSION"
})
});
}

const result =
await heliosGenerateBrandBlueprint({

objective:
body.objective ||
"Store principale multi-nicchia",

opportunities:
body.opportunities ||
body.marketScan
?.opportunities ||
[],

currentBrand:
body.currentBrand ||
null,

preferences:
body.preferences ||
null
});

return res
.status(
result.ok
? 200
: 503
)
.json(
result
);
}

if (
body.action ===
"helios_brand_apply"
) {

const stores =
heliosSelectedStores(
body
);

if (
!stores.includes(
"SHOPIFY"
)
) {

return res
.status(403)
.json({

error:
"SHOPIFY non autorizzato",

actionCard:
heliosActionCard({

severity:
"CRITICAL",

title:
"STORE NOT AUTHORIZED",

message:
"HELIOS non modifica il sito Shopify se Shopify non è selezionato per la missione.",

reason:
"STORE_NOT_ENABLED_FOR_MISSION"
})
});
}

const blueprint =
body.blueprint ||
null;

if (!blueprint) {

return res
.status(400)
.json({
error:
"blueprint mancante"
});
}

const result =
await heliosApplyBrandTheme(
blueprint,
{
confirm:
body.confirm ===
true
}
);

return res
.status(
result.ok
? 200
: result.requiresConfirmation
? 409
: 424
)
.json(
result
);
}

// ============================================================
// HELIOS — MISSION START
// ============================================================

if (
body.action ===
"helios_mission_start"
) {

try {

const result =
await heliosRunMissionStart(
body
);

return res
.status(
result.ok
? 200
: 409
)
.json(
result
);

} catch (error) {

return res
.status(500)
.json({

error:
String(
error?.message ||
error
),

actionCard:
heliosActionCard({

severity:
"CRITICAL",

title:
"HELIOS MISSION ERROR",

message:
"La missione è stata fermata senza eseguire nuove pubblicazioni.",

reason:
String(
error?.message ||
error
),

actions: [
{
id:
"RETRY",

label:
"RETRY",

type:
"BACKEND"
}
]
})
});
}
}

// ============================================================
// HELIOS — MISSION PUBLISH
// ============================================================

if (
body.action ===
"helios_mission_publish"
) {

const mission =
body.mission ||
null;

if (!mission?.id) {

return res
.status(400)
.json({
error:
"mission mancante"
});
}

try {

const result =
await heliosPublishMissionProduct(
mission,
{
store:
body.store ||
"SHOPIFY"
}
);

return res
.status(
result.ok
? 200
: 409
)
.json(
result
);

} catch (error) {

return res
.status(500)
.json({

error:
String(
error?.message ||
error
),

actionCard:
heliosActionCard({

severity:
"CRITICAL",

title:
"PUBLISH ERROR",

message:
"HELIOS ha fermato la pubblicazione per evitare uno stato parziale o duplicato.",

reason:
String(
error?.message ||
error
),

missionId:
mission.id
})
});
}
}

// ============================================================
// HELIOS — ABORT
// ============================================================

if (
body.action ===
"helios_mission_abort"
) {

const mission =
body.mission ||
{};

const aborted = {

...mission,

status:
"ABORTED",

checkpoint:
mission.checkpoint ||
"UNKNOWN",

updatedAt:
heliosNow(),

events: [

...(
Array.isArray(
mission.events
)
? mission.events
: []
),

{
at:
heliosNow(),

type:
"MISSION_ABORTED"
}
]
};

return res
.status(200)
.json({
ok:
true,

mission:
aborted
});
}

// ============================================================
// SHOPIFY DASHBOARD
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
const o of
orders
) {

vendite +=
parseFloat(
o.total_price ||
0
) ||
0;
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
) ||
0,

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
) /
100,

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
// SHOPIFY PRODUCTS
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
)
.map(
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
? p.image.src
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
// SHOPIFY CREATE
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
p.prezzo != null
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
// HELIOS STORE STATUS
// ============================================================

if (
body.action ===
"helios_store_status"
) {

try {

const [
shopRes,
countRes,
ordersRes,
payments,
collectiveProducts,
scopes
] =
await Promise.all([

shopifyFetch(
"/shop.json"
),

shopifyFetch(
"/products/count.json"
),

shopifyFetch(
"/orders.json?status=any&limit=100&fields=id,financial_status,fulfillment_status,total_price"
),

heliosShopifyPaymentsStatus(),

heliosCollectiveProducts({
limit:
100
})
.catch(
() =>
[]
),

heliosShopifyScopes()
.catch(
() =>
[]
)

]);

const shop =
shopRes.shop ||
{};

const orders =
ordersRes.orders ||
[];

const paidOrders =
orders.filter(
(o) =>
(o.financial_status || "") ===
"paid"
)
.length;

let storefront =
"UNKNOWN";

try {

const dom =
shop.domain ||
(
process.env
.SHOPIFY_STORE +
".myshopify.com"
);

const sr =
await fetch(
"https://" +
dom +
"/",
{
redirect:
"follow"
}
);

const finalUrl =
sr.url ||
"";

const html =
(
await sr.text()
)
.slice(
0,
5000
)
.toLowerCase();

if (
finalUrl.includes(
"/password"
) ||
html.includes(
'name="password"'
) ||
html.includes(
"opening soon"
) ||
html.includes(
"store is not available"
)
) {

storefront =
"LOCKED";

} else if (sr.ok) {

storefront =
"LIVE";
}

} catch {

storefront =
"UNKNOWN";
}

const hasCollectiveCandidates =
collectiveProducts.length >
0;

const collective =
hasCollectiveCandidates
? "READY_WITH_IMPORTED_PRODUCTS"
: "READY_NO_SUPPLIER_PRODUCTS";

return res
.status(200)
.json({

ok:
true,

source:
"Shopify",

heliosVersion:
HELIOS_VERSION,

store: {

connected:
true,

name:
shop.name ||
process.env
.SHOPIFY_STORE,

domain:
shop.domain ||
null,

myshopifyDomain:
shop.myshopify_domain ||
null,

currency:
shop.currency ||
null,

country:
shop.country_name ||
null,

countryCode:
(
shop.country_code ||
""
)
.toUpperCase() ||
null,

plan:
shop.plan_display_name ||
shop.plan_name ||
null
},

products:
countRes.count ||
0,

collectiveProducts:
collectiveProducts.length,

orders:
orders.length,

paidOrders,

payments,

scopes,

statuses: {

api:
"CONNECTED",

storefront,

payments:
payments.status,

collective,

suppliers:
hasCollectiveCandidates
? "CONNECTED"
: "WAITING_SUPPLIER_CONNECTION",

fulfillment:
hasCollectiveCandidates
? "COLLECTIVE_MANAGED"
: "WAITING_PRODUCT",

themeAutomation:
scopes.includes(
"write_themes"
)
? "SCOPE_PRESENT"
: "PERMISSION_REQUIRED_FOR_THEME_WRITE"
},

notes: [

"Shopify Payments viene verificato tramite shopifyPaymentsAccount quando lo scope lo consente; non viene più dedotto dalla presenza di ordini pagati.",

"Shopify Collective supporta l'Italia/EUR; HELIOS non applica più il vecchio filtro US/CA.",

"Discovery e connessione fornitori Collective richiedono la UI Shopify perché non esiste una API pubblica per inviti/accettazioni."
]
});

} catch (e) {

return res
.status(500)
.json({
error:
String(
e?.message ||
e
)
});
}
}

// ============================================================
// HELIOS READINESS
// ============================================================

if (
body.action ===
"helios_store_readiness"
) {

try {

const [
shopRes,
countRes,
payments,
collectiveProducts,
scopes
] =
await Promise.all([

shopifyFetch(
"/shop.json"
),

shopifyFetch(
"/products/count.json"
),

heliosShopifyPaymentsStatus(),

heliosCollectiveProducts({
limit:
100
})
.catch(
() =>
[]
),

heliosShopifyScopes()
.catch(
() =>
[]
)

]);

const shop =
shopRes.shop ||
{};

const productCount =
countRes.count ||
0;

let storefront =
"UNKNOWN";

try {

const dom =
shop.domain ||
(
process.env
.SHOPIFY_STORE +
".myshopify.com"
);

const sr =
await fetch(
"https://" +
dom +
"/",
{
redirect:
"follow"
}
);

const finalUrl =
sr.url ||
"";

const html =
(
await sr.text()
)
.slice(
0,
5000
)
.toLowerCase();

if (
finalUrl.includes(
"/password"
) ||
html.includes(
'name="password"'
) ||
html.includes(
"opening soon"
)
) {

storefront =
"LOCKED";

} else if (sr.ok) {

storefront =
"LIVE";
}

} catch {

storefront =
"UNKNOWN";
}

const paymentReady =
payments.status ===
"ACTIVE";

const paymentUnknownOnlyBecauseScope =
payments.status ===
"UNKNOWN_SCOPE_REQUIRED";

const collectiveReady =
true;

const supplierReady =
collectiveProducts.length >
0;

const infrastructureChecks = [

{
key:
"api",

label:
"Shopify API",

ok:
true,

weight:
20
},

{
key:
"storefront",

label:
"Storefront pubblico",

ok:
storefront ===
"LIVE",

weight:
20
},

{
key:
"payments",

label:
"Shopify Payments",

ok:
paymentReady,

unknown:
paymentUnknownOnlyBecauseScope,

weight:
25
},

{
key:
"collective",

label:
"Shopify Collective",

ok:
collectiveReady,

weight:
20
},

{
key:
"graphql",

label:
"HELIOS GraphQL commerce layer",

ok:
scopes.includes(
"write_products"
),

weight:
15
}

];

const total =
infrastructureChecks
.reduce(
(s, c) =>
s +
c.weight,
0
);

const got =
infrastructureChecks
.reduce(
(s, c) =>
s +
(
c.ok
? c.weight
: c.unknown
? c.weight *
0.5
: 0
),
0
);

const infrastructureReadiness =
Math.round(
(
got /
total
) *
100
);

const missionChecks = [

...infrastructureChecks,

{
key:
"supplier",

label:
"Prodotti da fornitori Collective collegati",

ok:
supplierReady,

weight:
20
}

];

const missionTotal =
missionChecks
.reduce(
(s, c) =>
s +
c.weight,
0
);

const missionGot =
missionChecks
.reduce(
(s, c) =>
s +
(
c.ok
? c.weight
: c.unknown
? c.weight *
0.5
: 0
),
0
);

const missionReadiness =
Math.round(
(
missionGot /
missionTotal
) *
100
);

return res
.status(200)
.json({

ok:
true,

readiness:
infrastructureReadiness,

infrastructureReadiness,

missionReadiness,

productCount,

collectiveProducts:
collectiveProducts.length,

checks:
missionChecks
.map(
(c) => ({

key:
c.key,

label:
c.label,

status:
c.ok
? "READY"
: c.unknown
? "UNKNOWN_SCOPE_REQUIRED"
: c.key ===
"storefront" &&
storefront ===
"LOCKED"
? "LOCKED"
: c.key ===
"supplier"
? "WAITING_SUPPLIER_CONNECTION"
: "NOT_READY"
})
),

actionRequired:
supplierReady
? null
: heliosActionCard({

severity:
"IMPORTANT",

title:
"COLLECTIVE SUPPLIER NEEDED",

message:
"L'infrastruttura Shopify è pronta, ma HELIOS non ha ancora prodotti importati da un fornitore Collective collegato.",

reason:
"NO_COLLECTIVE_PRODUCTS_IMPORTED",

actions: [
{
id:
"OPEN_COLLECTIVE",

label:
"OPEN COLLECTIVE",

type:
"LINK",

url:
heliosCollectiveUrl()
}
]
}),

note:
"La readiness non usa più ordini pagati come prova di configurazione Payments e non limita Collective a US/CA."
});

} catch (e) {

return res
.status(500)
.json({
error:
String(
e?.message ||
e
)
});
}
}

// ============================================================
// HELIOS SCORE PRODUCT
// ============================================================

if (
body.action ===
"helios_score_product"
) {

try {

const p =
body.product ||
{};

const num =
(v) =>
typeof v ===
"number" &&
isFinite(v)
? v
: null;

const retail =
num(
p.retailPrice
);

const cost =
num(
p.wholesalePrice
);

const shipping =
num(
p.shippingCost
);

const trendPercent =
num(
p.trendPercent
);

const stock =
num(
p.stock
);

const deliveryDays =
num(
p.deliveryDays
);

const competition =
(
p.competition ||
""
)
.toString()
.toUpperCase();

let totalCost =
null;

let marginEuro =
null;

let marginPercent =
null;

if (
retail != null &&
cost != null
) {

totalCost =
cost +
(
shipping != null
? shipping
: 0
);

marginEuro =
Math.round(
(
retail -
totalCost
) *
100
) /
100;

marginPercent =
retail > 0
? Math.round(
(
marginEuro /
retail
) *
1000
) /
10
: null;
}

const parts = [];

let marginScore =
null;

if (
marginPercent != null
) {

marginScore =
Math.max(
0,
Math.min(
1,
marginPercent /
60
)
);

parts.push({
key:
"margin",

weight:
35,

value:
marginScore
});
}

let trendScore =
null;

if (
trendPercent != null
) {

trendScore =
Math.max(
0,
Math.min(
1,
(
trendPercent +
20
) /
80
)
);

parts.push({
key:
"trend",

weight:
20,

value:
trendScore
});
}

let competitionScore =
null;

if (
competition ===
"LOW" ||
competition ===
"MEDIUM" ||
competition ===
"HIGH"
) {

competitionScore =
competition ===
"LOW"
? 1
: competition ===
"MEDIUM"
? 0.6
: 0.25;

parts.push({
key:
"competition",

weight:
15,

value:
competitionScore
});
}

let stockScore =
null;

if (
stock != null
) {

stockScore =
stock <= 0
? 0
: Math.max(
0.15,
Math.min(
1,
stock /
200
)
);

parts.push({
key:
"stock",

weight:
15,

value:
stockScore
});
}

let deliveryScore =
null;

if (
deliveryDays != null
) {

deliveryScore =
deliveryDays <= 3
? 1
: deliveryDays <= 7
? 0.7
: deliveryDays <= 14
? 0.4
: 0.15;

parts.push({
key:
"delivery",

weight:
15,

value:
deliveryScore
});
}

const wTot =
parts.reduce(
(s, x) =>
s +
x.weight,
0
);

const wGot =
parts.reduce(
(s, x) =>
s +
x.weight *
x.value,
0
);

const score =
wTot > 0
? Math.round(
(
wGot /
wTot
) *
100
)
: null;

const coverage =
parts.length /
5;

const confidence =
coverage >= 0.8
? "HIGH"
: coverage >= 0.5
? "MEDIUM"
: "LOW";

return res
.status(200)
.json({

ok:
true,

economics: {
retail,
wholesale:
cost,
shipping,
totalCost,
marginEuro,
marginPercent
},

subScores: {
marginScore,
trendScore,
competitionScore,
stockScore,
deliveryScore
},

heliosScore:
score,

confidence,

coverage:
Math.round(
coverage *
100
),

missing: [
"retailPrice",
"wholesalePrice",
"shippingCost",
"trendPercent",
"competition",
"stock",
"deliveryDays"
]
.filter(
(k) =>
body.product?.[k] ==
null
)
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
// OCULUS — SEND EMAIL
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
)
.toString();

const from =
(
body.from ||
"CORTEX <oculus@xstudioportfolio.it>"
)
.toString();

const replyTo =
(
body.reply_to ||
"alessiodifabrizio931@gmail.com"
)
.toString();

if (
!to ||
!/^[^@\s]+@[^@\s]+\.[^@\s]+$/
.test(
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
// OCULUS — FIND EMAIL
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
!/^https?:\/\//
.test(
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
) ||
[]
)
.filter(
(e) =>
!bad.test(e)
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
// NOTION HELPERS
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

switch (
p.type
) {

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
? p.select.name
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
? p.date.start
: null;

case "email":

return p.email ||
null;

case "phone_number":

return p.phone_number ||
null;

case "checkbox":

return p.checkbox;

case "url":

return p.url ||
null;

default:

return null;
}
};

const norm =
(s) =>
(
s ||
""
)
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
async (
dbId
) => {

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
async (
dbId
) => {

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
// ATLAS READ
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
] of
Object.entries(
pr
)
) {

out[k] =
readProp(v);
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
// ATLAS WRITE
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
)
.slice(
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
)
.slice(
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
)
.slice(
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
// NOTION CLEAR
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
// ATLAS DELETE
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
// MIDAS READ
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
n ===
"iva" ||
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
] of
Object.entries(
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
)
.padStart(
2,
"0"
);

const mesiTrascorsi =
(dataStart) => {

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
? m[kImporto]
: 0
) ||
0;

const tipo =
norm(
kTipo
? m[kTipo]
: ""
);

const cat =
norm(
kCategoria
? m[kCategoria]
: ""
);

const dataStr =
kData
? m[kData]
: null;

const ric =
norm(
kRicorrenza
? m[kRicorrenza]
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
) >=
1;

const nelMeseCorrente =
dataStr &&
new Date(
dataStr
)
.getFullYear() +
"-" +
String(
new Date(
dataStr
)
.getMonth() +
1
)
.padStart(
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
n *
100
) /
100;

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
// MIDAS WRITE
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
)
.slice(
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
)
.slice(
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
)
.slice(
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
// NOTION CREATE REPORT
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
] of
Object.entries(
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
)
.toString();

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
// NOTION LOG
// ============================================================

if (
body.action ===
"log"
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
] of
Object.entries(
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
)
.toString();

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
// NOTION LOG READ
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
.join("");

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
// CHAT AGENTI
// GEMINI → OPENROUTER → GROQ
// ============================================================

const {
system,
messages
} =
body;

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

const parts = [];

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
b.source?.data
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
b.source?.data
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
text:
""
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

const out = [];

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

const content = [];

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
b.source?.data
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
b.source?.data
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
// GEMINI
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

gbody.systemInstruction = {

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
data?.candidates?.[0]
?.content
?.parts ||
[]
)
.map(
(p) =>
p.text ||
""
)
.join("")
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

} catch (error) {

return {

ok:
false,

status:
503,

error:
error?.message ||
"Gemini non raggiungibile"
};
}
};

// ============================================================
// OPENROUTER
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
data?.choices?.[0]
?.message
?.content;

if (
Array.isArray(
text
)
) {

text =
text.map(
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
.join("");
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

} catch (error) {

return {

ok:
false,

status:
503,

error:
error?.message ||
"OpenRouter non raggiungibile"
};
}
};

// ============================================================
// GROQ
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
data?.choices?.[0]
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
.join("");
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

} catch (error) {

return {

ok:
false,

status:
503,

error:
error?.message ||
"Groq non raggiungibile"
};
}
};

// ============================================================
// CORTEX AI ROUTER
// ============================================================

const gemini =
await callGemini();

if (
gemini.ok
) {

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

if (
groq.ok
) {

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
