// services/paidDemand.js
//
// OCULUS — MOTORE DOMANDA ATTIVA
//
// VERSIONE GRATUITA
//
// Fonti:
// 1. Remote OK
// 2. Remotive
// 3. Himalayas
//
// Nessuna delle tre richiede pagamento o API key.
//
// Gemini viene usato solo come classificatore,
// non come motore di ricerca web.
//
// Obiettivo:
// trovare richieste REALI compatibili con le capacità di CORTEX.

const ANALYSIS_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";


// ============================================================
// UTILITY
// ============================================================

function stripHtml(text) {
  return (text || "")
    .toString()
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}


function normalize(text) {
  return (text || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}


function matchesQuery(job, query) {
  const q = normalize(query);

  if (!q) return true;

  const haystack = normalize(
    [
      job.title,
      job.company,
      job.description,
      job.tags?.join(" "),
      job.category
    ]
      .filter(Boolean)
      .join(" ")
  );

  const words = q
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (!words.length) {
    return haystack.includes(q);
  }

  return words.some((word) =>
    haystack.includes(word)
  );
}


// ============================================================
// REMOTE OK
// ============================================================

async function fetchRemoteOK() {
  try {
    const response = await fetch(
      "https://remoteok.com/api",
      {
        headers: {
          "User-Agent":
            "CORTEX/1.0"
        }
      }
    );

    if (!response.ok) {
      console.error(
        "[OCULUS / RemoteOK]",
        response.status
      );

      return [];
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter(
        (item) =>
          item &&
          item.position &&
          item.url
      )
      .map((item) => ({
        source:
          "Remote OK",

        title:
          item.position || "",

        client:
          item.company || null,

        company:
          item.company || null,

        location:
          item.location || "Da remoto",

        remote:
          true,

        url:
          item.url || null,

        description:
          stripHtml(
            item.description || ""
          ).slice(0, 1800),

        category:
          null,

        tags:
          Array.isArray(item.tags)
            ? item.tags
            : [],

        salaryMin:
          Number(item.salary_min) || null,

        salaryMax:
          Number(item.salary_max) || null,

        currency:
          item.currency || null,

        publishedAt:
          item.date || null
      }));

  } catch (error) {
    console.error(
      "[OCULUS / RemoteOK error]",
      error
    );

    return [];
  }
}


// ============================================================
// REMOTIVE
// ============================================================

async function fetchRemotive(query) {
  try {
    const url =
      "https://remotive.com/api/remote-jobs" +
      "?search=" +
      encodeURIComponent(query || "") +
      "&limit=50";

    const response =
      await fetch(url);

    if (!response.ok) {
      console.error(
        "[OCULUS / Remotive]",
        response.status
      );

      return [];
    }

    const data =
      await response.json();

    const jobs =
      Array.isArray(data?.jobs)
        ? data.jobs
        : [];

    return jobs.map((item) => ({
      source:
        "Remotive",

      title:
        item.title || "",

      client:
        item.company_name || null,

      company:
        item.company_name || null,

      location:
        item.candidate_required_location ||
        "Da remoto",

      remote:
        true,

      url:
        item.url || null,

      description:
        stripHtml(
          item.description || ""
        ).slice(0, 1800),

      category:
        item.category || null,

      tags:
        Array.isArray(item.tags)
          ? item.tags
          : [],

      salary:
        item.salary || null,

      salaryMin:
        null,

      salaryMax:
        null,

      currency:
        null,

      publishedAt:
        item.publication_date || null
    }));

  } catch (error) {
    console.error(
      "[OCULUS / Remotive error]",
      error
    );

    return [];
  }
}


// ============================================================
// HIMALAYAS
// ============================================================

async function fetchHimalayas(query) {
  try {
    const url =
      "https://himalayas.app/jobs/api" +
      "?limit=20" +
      "&q=" +
      encodeURIComponent(query || "");

    const response =
      await fetch(url);

    if (!response.ok) {
      console.error(
        "[OCULUS / Himalayas]",
        response.status
      );

      return [];
    }

    const data =
      await response.json();

    const jobs =
      Array.isArray(data?.jobs)
        ? data.jobs
        : Array.isArray(data)
        ? data
        : [];

    return jobs
      .filter(
        (item) =>
          item &&
          item.title
      )
      .map((item) => {

        const company =
          item.company?.name ||
          item.companyName ||
          item.company ||
          null;

        const url =
          item.applicationUrl ||
          item.url ||
          item.jobUrl ||
          null;

        const locations =
          Array.isArray(
            item.locationRestrictions
          )
            ? item.locationRestrictions
                .join(", ")
            : item.location ||
              "Da remoto";

        return {
          source:
            "Himalayas",

          title:
            item.title || "",

          client:
            company,

          company,

          location:
            locations,

          remote:
            true,

          url,

          description:
            stripHtml(
              item.description ||
              item.excerpt ||
              ""
            ).slice(0, 1800),

          category:
            item.category ||
            null,

          tags:
            Array.isArray(item.skills)
              ? item.skills
              : Array.isArray(item.tags)
              ? item.tags
              : [],

          salaryMin:
            Number(
              item.minSalary ||
              item.salaryMin
            ) || null,

          salaryMax:
            Number(
              item.maxSalary ||
              item.salaryMax
            ) || null,

          currency:
            item.currency ||
            item.salaryCurrency ||
            null,

          publishedAt:
            item.publishedAt ||
            item.createdAt ||
            null
        };
      })
      .filter(
        (item) =>
          item.url
      );

  } catch (error) {
    console.error(
      "[OCULUS / Himalayas error]",
      error
    );

    return [];
  }
}


// ============================================================
// DEDUPLICAZIONE
// ============================================================

function removeDuplicates(items) {
  const seen =
    new Set();

  return items.filter((item) => {

    const key =
      normalize(
        `${item.url}|${item.title}|${item.company}`
      );

    if (
      !key ||
      seen.has(key)
    ) {
      return false;
    }

    seen.add(key);

    return true;
  });
}


// ============================================================
// SCORING LOCALE
// ============================================================

function simpleScore(job, query) {
  const text =
    normalize(
      [
        job.title,
        job.description,
        job.tags?.join(" "),
        job.category
      ]
        .filter(Boolean)
        .join(" ")
    );

  const qWords =
    normalize(query)
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2
      );


  let fitScore =
    40;


  for (
    const word of qWords
  ) {
    if (
      text.includes(word)
    ) {
      fitScore += 8;
    }
  }


  const cortexSkills = [
    "shopify",
    "ecommerce",
    "e-commerce",
    "website",
    "web",
    "wordpress",
    "webflow",
    "frontend",
    "developer",
    "design",
    "marketing",
    "social",
    "content",
    "automation",
    "artificial intelligence",
    " ai ",
    "saas",
    "landing",
    "seo",
    "video",
    "branding",
    "copywriting"
  ];


  for (
    const keyword of
    cortexSkills
  ) {
    if (
      text.includes(keyword)
    ) {
      fitScore += 2;
    }
  }


  fitScore =
    Math.min(
      100,
      fitScore
    );


  let automationScore =
    35;


  const automationFriendly = [
    "website",
    "shopify",
    "wordpress",
    "webflow",
    "frontend",
    "content",
    "copywriting",
    "seo",
    "social",
    "marketing",
    "automation",
    "artificial intelligence",
    "chatbot",
    "design",
    "landing",
    "ecommerce",
    "e-commerce"
  ];


  for (
    const keyword of
    automationFriendly
  ) {
    if (
      text.includes(keyword)
    ) {
      automationScore += 4;
    }
  }


  automationScore =
    Math.min(
      95,
      automationScore
    );


  let priority =
    "BASSA";


  if (
    fitScore >= 80 &&
    automationScore >= 65
  ) {
    priority =
      "ALTA";

  } else if (
    fitScore >= 60
  ) {
    priority =
      "MEDIA";
  }


  return {
    fitScore,
    automationScore,
    priority
  };
}


// ============================================================
// GEMINI — SOLO CLASSIFICAZIONE
// ============================================================

async function analyzeWithGemini(
  jobs,
  query
) {
  const key =
    process.env
      .GEMINI_API_KEY;


  if (
    !key ||
    !jobs.length
  ) {
    return null;
  }


  const compactJobs =
    jobs
      .slice(0, 20)
      .map(
        (job, index) => ({
          index,

          title:
            job.title,

          company:
            job.company,

          source:
            job.source,

          description:
            job.description
              .slice(
                0,
                700
              ),

          tags:
            job.tags
        })
      );


  const prompt = `
Sei OCULUS, analista commerciale di CORTEX.

L'utente cerca opportunità per:

"${query}"

Le offerte seguenti sono REALI e provengono da API pubbliche.

NON inventare nuove opportunità.

Valuta ogni offerta in base alla capacità di CORTEX di svolgere il lavoro.

CORTEX è forte in:

- sviluppo siti
- e-commerce
- Shopify
- WordPress
- Webflow
- landing page
- web app
- AI
- automazioni
- chatbot
- marketing digitale
- social media
- content creation
- branding
- SEO
- video
- prodotti digitali

Restituisci:

compatibilita:
0-100

automatizzabilita:
0-100

priorita:
ALTA
MEDIA
BASSA

motivazione:
massimo 25 parole in italiano.

Rispondi SOLO JSON:

{
  "results": [
    {
      "index": 0,
      "compatibilita": 0,
      "automatizzabilita": 0,
      "priorita": "BASSA",
      "motivazione": ""
    }
  ]
}

OPPORTUNITA:

${JSON.stringify(compactJobs)}
`;


  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL}:generateContent?key=${key}`;


    const response =
      await fetch(
        url,
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
                temperature:
                  0.1,

                maxOutputTokens:
                  4096,

                responseMimeType:
                  "application/json"
              }
            })
        }
      );


    const data =
      await response.json();


    if (!response.ok) {
      console.error(
        "[OCULUS / Gemini]",
        data
      );

      return null;
    }


    const raw =
      (
        data
          ?.candidates?.[0]
          ?.content?.parts ||
        []
      )
        .map(
          (part) =>
            part.text ||
            ""
        )
        .join("")
        .trim();


    if (!raw) {
      return null;
    }


    return JSON.parse(raw);

  } catch (error) {

    console.error(
      "[OCULUS / Gemini error]",
      error
    );

    return null;
  }
}


// ============================================================
// HANDLER PRINCIPALE
// ============================================================

export async function searchPaidDemand(
  body,
  res
) {

  const service =
    (
      body.service ||
      body.query ||
      ""
    )
      .toString()
      .trim()
      .slice(
        0,
        300
      );


  if (!service) {
    return res.status(400).json({
      error:
        "Servizio o ricerca mancante"
    });
  }


  const maxResults =
    Math.min(
      Math.max(
        parseInt(
          body.maxResults
        ) || 10,
        1
      ),
      20
    );


  try {

    // ----------------------------------------------------------
    // Ricerca parallela sulle 3 fonti
    // ----------------------------------------------------------

    const [
      remoteOK,
      remotive,
      himalayas
    ] =
      await Promise.all([
        fetchRemoteOK(),
        fetchRemotive(
          service
        ),
        fetchHimalayas(
          service
        )
      ]);


    let jobs = [
      ...remoteOK,
      ...remotive,
      ...himalayas
    ];


    // ----------------------------------------------------------
    // Deduplicazione
    // ----------------------------------------------------------

    jobs =
      removeDuplicates(
        jobs
      );


    // ----------------------------------------------------------
    // Filtro per ricerca
    // ----------------------------------------------------------

    jobs =
      jobs.filter(
        (job) =>
          job.url &&
          matchesQuery(
            job,
            service
          )
      );


    // ----------------------------------------------------------
    // Scoring locale
    // ----------------------------------------------------------

    jobs =
      jobs.map(
        (job) => {

          const score =
            simpleScore(
              job,
              service
            );

          return {
            ...job,
            ...score
          };
        }
      );


    // ----------------------------------------------------------
    // Primo ordinamento
    // ----------------------------------------------------------

    jobs.sort(
      (a, b) =>
        (
          b.fitScore *
            0.6 +
          b.automationScore *
            0.4
        ) -
        (
          a.fitScore *
            0.6 +
          a.automationScore *
            0.4
        )
    );


    jobs =
      jobs.slice(
        0,
        Math.max(
          maxResults,
          20
        )
      );


    // ----------------------------------------------------------
    // Analisi Gemini
    // ----------------------------------------------------------

    const aiAnalysis =
      await analyzeWithGemini(
        jobs,
        service
      );


    if (
      Array.isArray(
        aiAnalysis
          ?.results
      )
    ) {

      for (
        const ai of
        aiAnalysis.results
      ) {

        const index =
          Number(
            ai.index
          );


        if (
          !Number.isInteger(
            index
          ) ||
          !jobs[index]
        ) {
          continue;
        }


        jobs[
          index
        ].fitScore =
          Math.min(
            100,
            Math.max(
              0,
              Number(
                ai.compatibilita
              ) ||
                jobs[index]
                  .fitScore
            )
          );


        jobs[
          index
        ].automationScore =
          Math.min(
            100,
            Math.max(
              0,
              Number(
                ai.automatizzabilita
              ) ||
                jobs[index]
                  .automationScore
            )
          );


        if (
          [
            "ALTA",
            "MEDIA",
            "BASSA"
          ].includes(
            ai.priorita
          )
        ) {
          jobs[
            index
          ].priority =
            ai.priorita;
        }


        jobs[
          index
        ].reason =
          ai.motivazione ||
          "";
      }
    }


    // ----------------------------------------------------------
    // Ordinamento definitivo
    // ----------------------------------------------------------

    const priorityValue = {
      ALTA: 3,
      MEDIA: 2,
      BASSA: 1
    };


    jobs.sort(
      (a, b) => {

        const scoreA =
          a.fitScore *
            0.6 +
          a.automationScore *
            0.4 +
          (
            priorityValue[
              a.priority
            ] || 0
          ) *
            5;


        const scoreB =
          b.fitScore *
            0.6 +
          b.automationScore *
            0.4 +
          (
            priorityValue[
              b.priority
            ] || 0
          ) *
            5;


        return (
          scoreB -
          scoreA
        );
      }
    );


    // ----------------------------------------------------------
    // Output finale in italiano
    // ----------------------------------------------------------

    const results =
      jobs
        .slice(
          0,
          maxResults
        )
        .map(
          (
            job,
            index
          ) => {

            let budget =
              job.salary ||
              null;


            if (
              !budget &&
              (
                job.salaryMin ||
                job.salaryMax
              )
            ) {

              budget =
                `${
                  job.salaryMin ||
                  "?"
                } - ${
                  job.salaryMax ||
                  "?"
                }`;
            }


            return {

              id:
                `OC-${Date.now()}-${index + 1}`,

              titolo:
                job.title ||
                "Opportunità",

              cliente:
                job.client ||
                null,

              servizio:
                service,

              budget,

              valuta:
                job.currency ||
                null,

              localita:
                job.location ||
                null,

              remoto:
                job.remote !==
                false,

              fonte:
                job.source,

              url:
                job.url,

              descrizione:
                job.description
                  .slice(
                    0,
                    600
                  ),

              compatibilita:
                job.fitScore,

              automatizzabilita:
                job.automationScore,

              priorita:
                job.priority,

              motivazione:
                job.reason ||
                "Opportunità compatibile con le capacità digitali di CORTEX.",

              pubblicataIl:
                job.publishedAt ||
                null
            };
          }
        );


    return res.status(200).json({

      ok:
        true,

      modalita:
        "domanda_attiva",

      motore:
        "fonti_pubbliche_gratuite",

      ricerca:
        service,

      numeroRisultati:
        results.length,

      fonti: [
        "Remote OK",
        "Remotive",
        "Himalayas"
      ],

      results
    });


  } catch (error) {

    console.error(
      "[OCULUS / Domanda Attiva]",
      error
    );


    return res.status(500).json({

      error:
        error?.message ||
        "Errore durante la ricerca della domanda attiva"

    });
  }
}
