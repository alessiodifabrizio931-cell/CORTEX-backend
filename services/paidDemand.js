// services/paidDemand.js
//
// OCULUS — PAID DEMAND ENGINE
//
// Cerca sul web richieste REALI di servizi/prodotti digitali
// attraverso Gemini + Google Search grounding.
//
// Non effettua scraping diretto di LinkedIn.
// Cerca invece contenuti pubblicamente disponibili e indicizzati
// sul web, incluse job board, marketplace, siti aziendali,
// LinkedIn quando indicizzato e altre fonti.
//
// OUTPUT:
// - titolo opportunità
// - cliente/azienda se disponibile
// - servizio richiesto
// - budget se presente
// - fonte
// - URL
// - descrizione
// - fit con CORTEX
// - automazione stimata
// - priorità

const SEARCH_MODEL =
  process.env.GEMINI_SEARCH_MODEL ||
  "gemini-3.5-flash";

export async function searchPaidDemand(body, res) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: "GEMINI_API_KEY mancante"
    });
  }

  const service = (body.service || body.query || "")
    .toString()
    .trim()
    .slice(0, 300);

  if (!service) {
    return res.status(400).json({
      error: "service/query mancante"
    });
  }

  const location = (body.location || "")
    .toString()
    .trim()
    .slice(0, 150);

  const maxResults = Math.min(
    Math.max(parseInt(body.maxResults) || 10, 1),
    20
  );

  const locationText = location
    ? `Localizzazione preferita: ${location}.`
    : `La ricerca può essere internazionale e includere opportunità remote.`;

  const prompt = `
Sei OCULUS, il motore commerciale di CORTEX.

Devi trovare sul WEB opportunità REALI e ATTUALI dove qualcuno sta cercando
e potenzialmente pagando per questo servizio o prodotto:

"${service}"

${locationText}

CERCA SOPRATTUTTO:
- richieste di realizzazione siti web
- Shopify ed e-commerce
- WordPress
- Webflow
- landing page
- web app
- SaaS e micro-SaaS
- automazioni
- integrazioni AI
- chatbot
- lead generation
- marketing digitale
- social media
- content creation
- video
- branding
- design
- prodotti digitali
- cataloghi online
- gestione e-commerce
- richieste freelance
- consulenza digitale
- altri servizi compatibili con il servizio richiesto

FONTI UTILI:
- LinkedIn quando il contenuto è pubblicamente indicizzato
- Indeed
- Upwork
- Freelancer
- Contra
- Malt
- RemoteOK
- We Work Remotely
- job board
- siti aziendali
- pagine Careers
- forum/business community pubbliche
- richieste pubbliche indicizzate da Google

REGOLE FONDAMENTALI:

1. NON inventare offerte.
2. Ogni opportunità deve provenire da una fonte reale trovata tramite Google Search.
3. Non inserire opportunità senza un URL verificabile.
4. Dai priorità alle offerte recenti.
5. Se il budget non è indicato, usa null. NON inventare il budget.
6. Se il nome del cliente non è disponibile, usa null.
7. Evita annunci palesemente scaduti quando possibile.
8. Evita duplicati.
9. Cerca opportunità dove CORTEX potrebbe realmente produrre almeno una parte significativa del lavoro.
10. Restituisci massimo ${maxResults} risultati.

Per ogni opportunità valuta:

fitScore:
da 0 a 100, quanto è compatibile con capacità digitali/AI/web/marketing.

automationScore:
da 0 a 100, quanta parte del lavoro potrebbe essere automatizzata
o fortemente assistita da CORTEX.

priority:
HIGH, MEDIUM oppure LOW.

Restituisci ESCLUSIVAMENTE JSON valido, senza markdown e senza testo prima o dopo.

Formato:

{
  "query": "${service.replace(/"/g, '\\"')}",
  "results": [
    {
      "title": "titolo dell'opportunità",
      "client": null,
      "service": "servizio richiesto",
      "budget": null,
      "currency": null,
      "location": null,
      "remote": true,
      "source": "nome piattaforma o sito",
      "url": "https://...",
      "description": "breve descrizione concreta",
      "fitScore": 0,
      "automationScore": 0,
      "priority": "HIGH",
      "reason": "perché è interessante per CORTEX"
    }
  ]
}
`;

  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${SEARCH_MODEL}:generateContent?key=${key}`;

    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],

        tools: [
          {
            google_search: {}
          }
        ],

        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
          responseMimeType: "application/json"
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Errore Gemini Google Search"
      });
    }

    const rawText =
      (
        data?.candidates?.[0]?.content?.parts || []
      )
        .map((part) => part.text || "")
        .join("")
        .trim();

    if (!rawText) {
      return res.status(502).json({
        error: "Gemini non ha restituito risultati"
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      return res.status(502).json({
        error: "Risposta Paid Demand non valida",
        raw: rawText
      });
    }

    const results = Array.isArray(parsed.results)
      ? parsed.results
      : [];

    const cleanResults = results
      .filter(
        (item) =>
          item &&
          typeof item.url === "string" &&
          item.url.startsWith("http")
      )
      .slice(0, maxResults)
      .map((item, index) => ({
        id: `PD-${Date.now()}-${index + 1}`,

        title:
          item.title ||
          "Opportunità senza titolo",

        client:
          item.client || null,

        service:
          item.service || service,

        budget:
          item.budget ?? null,

        currency:
          item.currency || null,

        location:
          item.location || null,

        remote:
          Boolean(item.remote),

        source:
          item.source ||
          "Web",

        url:
          item.url,

        description:
          item.description || "",

        fitScore:
          Math.min(
            100,
            Math.max(
              0,
              Number(item.fitScore) || 0
            )
          ),

        automationScore:
          Math.min(
            100,
            Math.max(
              0,
              Number(item.automationScore) || 0
            )
          ),

        priority:
          ["HIGH", "MEDIUM", "LOW"].includes(
            item.priority
          )
            ? item.priority
            : "MEDIUM",

        reason:
          item.reason || ""
      }));

    cleanResults.sort((a, b) => {
      const priorityValue = {
        HIGH: 3,
        MEDIUM: 2,
        LOW: 1
      };

      const aScore =
        a.fitScore * 0.6 +
        a.automationScore * 0.4 +
        priorityValue[a.priority] * 5;

      const bScore =
        b.fitScore * 0.6 +
        b.automationScore * 0.4 +
        priorityValue[b.priority] * 5;

      return bScore - aScore;
    });

    const groundingMetadata =
      data?.candidates?.[0]?.groundingMetadata ||
      null;

    return res.status(200).json({
      ok: true,

      mode: "paid_demand",

      query: service,

      location:
        location || null,

      count:
        cleanResults.length,

      results:
        cleanResults,

      grounding: groundingMetadata
        ? {
            webSearchQueries:
              groundingMetadata.webSearchQueries ||
              [],

            searchEntryPoint:
              groundingMetadata.searchEntryPoint ||
              null
          }
        : null
    });
  } catch (error) {
    console.error(
      "[OCULUS / Paid Demand]",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Errore durante Paid Demand"
    });
  }
}
