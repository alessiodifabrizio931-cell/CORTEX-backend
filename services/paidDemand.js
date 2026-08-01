// services/paidDemand.js
//
// ============================================================
// OCULUS — MOTORE DOMANDA ATTIVA v2
// ============================================================
//
// Fonti gratuite:
// - Remote OK
// - Remotive
// - Himalayas
//
// Analisi:
// - scoring locale sempre disponibile
// - Gemini se disponibile
// - OpenRouter come fallback
//
// Classificazione:
// - COMMESSA
// - CLIENTE DIRETTO
// - COLLABORAZIONE
// - ASSUNZIONE
// ============================================================

const ANALYSIS_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openrouter/free";


// ============================================================
// UTILITY
// ============================================================

function stripHtml(text) {
  return (text || "")
    .toString()
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}


function normalize(text) {
  return (text || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


function clamp(value, min = 0, max = 100) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return min;
  }

  return Math.min(
    max,
    Math.max(min, n)
  );
}


function containsAny(text, words) {
  const normalized =
    normalize(text);

  return words.some(
    (word) =>
      normalized.includes(
        normalize(word)
      )
  );
}


function matchesQuery(job, query) {
  const q =
    normalize(query);

  if (!q) {
    return true;
  }

  const text =
    normalize(
      [
        job.title,
        job.company,
        job.description,
        job.category,
        Array.isArray(job.tags)
          ? job.tags.join(" ")
          : ""
      ]
        .filter(Boolean)
        .join(" ")
    );

  const words =
    q
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 2
      );

  if (!words.length) {
    return text.includes(q);
  }

  return words.some(
    (word) =>
      text.includes(word)
  );
}


// ============================================================
// REMOTE OK
// ============================================================

async function fetchRemoteOK() {
  try {
    const response =
      await fetch(
        "https://remoteok.com/api",
        {
          headers: {
            "User-Agent":
              "CORTEX/2.0"
          }
        }
      );

    if (!response.ok) {
      console.warn(
        "[OCULUS] Remote OK:",
        response.status
      );

      return [];
    }

    const data =
      await response.json();

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
      .map(
        (item) => ({
          source:
            "Remote OK",

          title:
            item.position || "",

          company:
            item.company || null,

          client:
            item.company || null,

          location:
            item.location ||
            "Da remoto",

          remote:
            true,

          url:
            item.url || null,

          description:
            stripHtml(
              item.description || ""
            ).slice(0, 2200),

          category:
            null,

          tags:
            Array.isArray(item.tags)
              ? item.tags
              : [],

          salary:
            null,

          salaryMin:
            Number(item.salary_min) ||
            null,

          salaryMax:
            Number(item.salary_max) ||
            null,

          currency:
            item.currency ||
            null,

          publishedAt:
            item.date ||
            null
        })
      );

  } catch (error) {
    console.warn(
      "[OCULUS] Remote OK non disponibile:",
      error?.message || error
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
      console.warn(
        "[OCULUS] Remotive:",
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

    return jobs.map(
      (item) => ({
        source:
          "Remotive",

        title:
          item.title || "",

        company:
          item.company_name ||
          null,

        client:
          item.company_name ||
          null,

        location:
          item.candidate_required_location ||
          "Da remoto",

        remote:
          true,

        url:
          item.url ||
          null,

        description:
          stripHtml(
            item.description || ""
          ).slice(0, 2200),

        category:
          item.category ||
          null,

        tags:
          Array.isArray(item.tags)
            ? item.tags
            : [],

        salary:
          item.salary ||
          null,

        salaryMin:
          null,

        salaryMax:
          null,

        currency:
          null,

        publishedAt:
          item.publication_date ||
          null
      })
    );

  } catch (error) {
    console.warn(
      "[OCULUS] Remotive non disponibile:",
      error?.message || error
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
      "?limit=40&q=" +
      encodeURIComponent(query || "");

    const response =
      await fetch(url);

    if (!response.ok) {
      console.warn(
        "[OCULUS] Himalayas:",
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
      .map(
        (item) => {
          let company =
            null;

          if (
            typeof item.company ===
            "string"
          ) {
            company =
              item.company;
          } else {
            company =
              item.company?.name ||
              item.companyName ||
              null;
          }

          const location =
            Array.isArray(
              item.locationRestrictions
            )
              ? item.locationRestrictions.join(
                  ", "
                )
              : item.location ||
                "Da remoto";

          return {
            source:
              "Himalayas",

            title:
              item.title || "",

            company,

            client:
              company,

            location,

            remote:
              true,

            url:
              item.applicationUrl ||
              item.url ||
              item.jobUrl ||
              null,

            description:
              stripHtml(
                item.description ||
                item.excerpt ||
                ""
              ).slice(0, 2200),

            category:
              item.category ||
              null,

            tags:
              Array.isArray(
                item.skills
              )
                ? item.skills
                : Array.isArray(
                    item.tags
                  )
                ? item.tags
                : [],

            salary:
              null,

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
        }
      )
      .filter(
        (item) =>
          item.title &&
          item.url
      );

  } catch (error) {
    console.warn(
      "[OCULUS] Himalayas non disponibile:",
      error?.message || error
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

  return items.filter(
    (item) => {
      const key =
        normalize(
          [
            item.url,
            item.title,
            item.company
          ]
            .filter(Boolean)
            .join("|")
        );

      if (!key) {
        return false;
      }

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    }
  );
}


// ============================================================
// TIPO OPPORTUNITA'
// ============================================================

function classifyOpportunity(job) {
  const text =
    normalize(
      [
        job.title,
        job.description,
        job.category,
        Array.isArray(job.tags)
          ? job.tags.join(" ")
          : ""
      ]
        .filter(Boolean)
        .join(" ")
    );

  const commissionSignals = [
    "looking for a freelancer",
    "seeking freelancer",
    "need a freelancer",
    "freelance project",
    "project based",
    "project-based",
    "build our website",
    "build a website",
    "create a website",
    "create website",
    "redesign our website",
    "website redesign",
    "shopify store",
    "shopify project",
    "need someone to",
    "looking for someone to",
    "contract project"
  ];

  const collaborationSignals = [
    "contractor",
    "contract position",
    "freelance",
    "consultant",
    "consulting",
    "fractional",
    "part-time",
    "part time",
    "temporary"
  ];

  const employmentSignals = [
    "full-time",
    "full time",
    "employee",
    "employment",
    "salary",
    "benefits",
    "health insurance",
    "vacation",
    "join our team",
    "we are hiring",
    "hiring",
    "apply for this job"
  ];

  if (
    containsAny(
      text,
      commissionSignals
    )
  ) {
    return "COMMESSA";
  }

  if (
    containsAny(
      text,
      collaborationSignals
    )
  ) {
    return "COLLABORAZIONE";
  }

  if (
    containsAny(
      text,
      employmentSignals
    )
  ) {
    return "ASSUNZIONE";
  }

  return "CLIENTE DIRETTO";
}


// ============================================================
// ANALISI LOCALE
// ============================================================

function localAnalysis(job, query) {
  const text =
    normalize(
      [
        job.title,
        job.description,
        job.category,
        Array.isArray(job.tags)
          ? job.tags.join(" ")
          : ""
      ]
        .filter(Boolean)
        .join(" ")
    );

  const queryWords =
    normalize(query)
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 2
      );

  let compatibility =
    35;

  for (
    const word of
    queryWords
  ) {
    if (
      text.includes(word)
    ) {
      compatibility +=
        7;
    }
  }

  const cortexSkills = [
    "shopify",
    "ecommerce",
    "e-commerce",
    "website",
    "web development",
    "wordpress",
    "webflow",
    "landing page",
    "frontend",
    "automation",
    "artificial intelligence",
    " ai ",
    "chatbot",
    "social media",
    "marketing",
    "content",
    "seo",
    "branding",
    "design",
    "video",
    "lead generation"
  ];

  for (
    const skill of
    cortexSkills
  ) {
    if (
      text.includes(skill)
    ) {
      compatibility +=
        3;
    }
  }

  compatibility =
    clamp(
      compatibility
    );

  let automation =
    30;

  const automationSignals = [
    "website",
    "shopify",
    "ecommerce",
    "e-commerce",
    "wordpress",
    "webflow",
    "landing",
    "automation",
    "ai",
    "chatbot",
    "content",
    "seo",
    "social",
    "marketing",
    "copywriting",
    "design"
  ];

  for (
    const signal of
    automationSignals
  ) {
    if (
      text.includes(signal)
    ) {
      automation +=
        4;
    }
  }

  automation =
    clamp(
      automation,
      0,
      95
    );

  const type =
    classifyOpportunity(
      job
    );

  let commercialProbability =
    30;

  if (
    type ===
    "COMMESSA"
  ) {
    commercialProbability =
      85;
  }

  else if (
    type ===
    "CLIENTE DIRETTO"
  ) {
    commercialProbability =
      70;
  }

  else if (
    type ===
    "COLLABORAZIONE"
  ) {
    commercialProbability =
      55;
  }

  else {
    commercialProbability =
      20;
  }

  if (
    compatibility >= 80
  ) {
    commercialProbability +=
      5;
  }

  commercialProbability =
    clamp(
      commercialProbability
    );

  let revenuePotential =
    "MEDIO";

  if (
    type === "COMMESSA" &&
    compatibility >= 70
  ) {
    revenuePotential =
      "ALTO";
  }

  if (
    type ===
    "ASSUNZIONE"
  ) {
    revenuePotential =
      "BASSO";
  }

  let urgency =
    "MEDIA";

  if (
    containsAny(
      text,
      [
        "urgent",
        "urgently",
        "asap",
        "immediately",
        "immediate start",
        "start immediately"
      ]
    )
  ) {
    urgency =
      "ALTA";
  }

  let priority =
    "MEDIA";

  if (
    commercialProbability >= 75 &&
    compatibility >= 65
  ) {
    priority =
      "ALTA";
  }

  if (
    type ===
      "ASSUNZIONE" ||
    compatibility <
      45
  ) {
    priority =
      "BASSA";
  }

  let recommendedAction =
    "Aprire la fonte e verificare requisiti e modalità di contatto.";

  if (
    type ===
    "COMMESSA"
  ) {
    recommendedAction =
      "Preparare una proposta commerciale personalizzata e contattare il cliente.";
  }

  else if (
    type ===
    "CLIENTE DIRETTO"
  ) {
    recommendedAction =
      "Analizzare il bisogno e proporre il servizio più adatto.";
  }

  else if (
    type ===
    "COLLABORAZIONE"
  ) {
    recommendedAction =
      "Valutare una collaborazione freelance o consulenziale.";
  }

  else {
    recommendedAction =
      "Valutare solo se trasformabile in collaborazione esterna.";
  }

  return {
    compatibility,
    automation,
    type,
    commercialProbability,
    revenuePotential,
    urgency,
    priority,
    recommendedAction
  };
}


// ============================================================
// PUNTEGGIO OPPORTUNITA'
// ============================================================

function calculateOpportunityScore(job) {
  const revenueValues = {
    ALTO: 100,
    MEDIO: 60,
    BASSO: 25
  };

  const urgencyValues = {
    ALTA: 100,
    MEDIA: 60,
    BASSA: 25
  };

  const typeBonus = {
    COMMESSA: 20,
    "CLIENTE DIRETTO": 15,
    COLLABORAZIONE: 5,
    ASSUNZIONE: -15
  };

  const score =
    job.compatibility *
      0.30 +
    job.automation *
      0.20 +
    job.commercialProbability *
      0.30 +
    (
      revenueValues[
        job.revenuePotential
      ] || 0
    ) *
      0.15 +
    (
      urgencyValues[
        job.urgency
      ] || 0
    ) *
      0.05 +
    (
      typeBonus[
        job.type
      ] || 0
    );

  return Math.round(
    score * 100
  ) / 100;
}


// ============================================================
// PROMPT AI
// ============================================================

function buildAnalysisPrompt(
  jobs,
  query
) {
  const data =
    jobs.map(
      (
        job,
        index
      ) => ({
        index,
        titolo:
          job.title,
        azienda:
          job.company,
        fonte:
          job.source,
        descrizione:
          job.description.slice(
            0,
            700
          ),
        tipoStimato:
          job.type
      })
    );

  return `
Sei OCULUS, analista commerciale di CORTEX.

L'obiettivo NON è semplicemente trovare offerte di lavoro.
Devi capire quali opportunità possono trasformarsi in ricavi attraverso
servizi digitali, siti web, Shopify, e-commerce, AI, automazioni,
marketing, social media e produzione di contenuti.

Ricerca utente:
"${query}"

Classifica ogni risultato come:

COMMESSA
CLIENTE DIRETTO
COLLABORAZIONE
ASSUNZIONE

Le COMMESSE e i CLIENTI DIRETTI devono essere privilegiati.

Restituisci ESCLUSIVAMENTE JSON valido:

{
  "results": [
    {
      "index": 0,
      "compatibilita": 0,
      "automatizzabilita": 0,
      "tipo": "ASSUNZIONE",
      "probabilitaCommerciale": 0,
      "potenzialeRicavo": "BASSO",
      "urgenza": "MEDIA",
      "priorita": "BASSA",
      "motivazione": "",
      "azioneConsigliata": ""
    }
  ]
}

Non inventare opportunità.
Analizza esclusivamente quelle fornite.

OPPORTUNITA:
${JSON.stringify(data)}
`;
}


// ============================================================
// GEMINI
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

  try {
    const prompt =
      buildAnalysisPrompt(
        jobs,
        query
      );

    const response =
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL}:generateContent?key=${key}`,
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
      console.warn(
        "[OCULUS] Gemini non disponibile:",
        response.status,
        data?.error?.message ||
          ""
      );

      return null;
    }

    const raw =
      (
        data?.candidates?.[0]
          ?.content?.parts ||
        []
      )
        .map(
          (part) =>
            part.text || ""
        )
        .join("")
        .trim();

    if (!raw) {
      return null;
    }

    return JSON.parse(
      raw
    );

  } catch (error) {
    console.warn(
      "[OCULUS] Errore analisi Gemini:",
      error?.message ||
        error
    );

    return null;
  }
}


// ============================================================
// OPENROUTER
// ============================================================

async function analyzeWithOpenRouter(
  jobs,
  query
) {
  const key =
    process.env
      .OPENROUTER_API_KEY;

  if (
    !key ||
    !jobs.length
  ) {
    return null;
  }

  try {
    const prompt =
      buildAnalysisPrompt(
        jobs,
        query
      );

    const response =
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

            "X-Title":
              "CORTEX OCULUS"
          },

          body:
            JSON.stringify({
              model:
                OPENROUTER_MODEL,

              messages: [
                {
                  role:
                    "user",

                  content:
                    prompt
                }
              ],

              temperature:
                0.1,

              max_tokens:
                4096,

              stream:
                false
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      console.warn(
        "[OCULUS] OpenRouter non disponibile:",
        response.status,
        data?.error?.message ||
          ""
      );

      return null;
    }

    let raw =
      data?.choices?.[0]
        ?.message?.content;

    if (
      Array.isArray(raw)
    ) {
      raw =
        raw
          .map(
            (part) =>
              part?.text ||
              part?.content ||
              ""
          )
          .join("");
    }

    raw =
      (raw || "")
        .toString()
        .trim()
        .replace(
          /^```json/i,
          ""
        )
        .replace(
          /^```/,
          ""
        )
        .replace(
          /```$/,
          ""
        )
        .trim();

    if (!raw) {
      return null;
    }

    return JSON.parse(
      raw
    );

  } catch (error) {
    console.warn(
      "[OCULUS] Errore analisi OpenRouter:",
      error?.message ||
        error
    );

    return null;
  }
}


// ============================================================
// APPLICA ANALISI AI
// ============================================================

function applyAIAnalysis(
  jobs,
  analysis
) {
  if (
    !Array.isArray(
      analysis?.results
    )
  ) {
    return;
  }

  const validTypes = [
    "COMMESSA",
    "CLIENTE DIRETTO",
    "COLLABORAZIONE",
    "ASSUNZIONE"
  ];

  const validLevels = [
    "ALTA",
    "MEDIA",
    "BASSA"
  ];

  const validRevenue = [
    "ALTO",
    "MEDIO",
    "BASSO"
  ];

  for (
    const ai of
    analysis.results
  ) {
    const index =
      Number(ai.index);

    if (
      !Number.isInteger(
        index
      ) ||
      !jobs[index]
    ) {
      continue;
    }

    const job =
      jobs[index];

    if (
      ai.compatibilita !=
      null
    ) {
      job.compatibility =
        clamp(
          ai.compatibilita
        );
    }

    if (
      ai.automatizzabilita !=
      null
    ) {
      job.automation =
        clamp(
          ai.automatizzabilita
        );
    }

    if (
      validTypes.includes(
        ai.tipo
      )
    ) {
      job.type =
        ai.tipo;
    }

    if (
      ai.probabilitaCommerciale !=
      null
    ) {
      job.commercialProbability =
        clamp(
          ai.probabilitaCommerciale
        );
    }

    if (
      validRevenue.includes(
        ai.potenzialeRicavo
      )
    ) {
      job.revenuePotential =
        ai.potenzialeRicavo;
    }

    if (
      validLevels.includes(
        ai.urgenza
      )
    ) {
      job.urgency =
        ai.urgenza;
    }

    if (
      validLevels.includes(
        ai.priorita
      )
    ) {
      job.priority =
        ai.priorita;
    }

    if (
      ai.motivazione
    ) {
      job.reason =
        String(
          ai.motivazione
        );
    }

    if (
      ai.azioneConsigliata
    ) {
      job.recommendedAction =
        String(
          ai.azioneConsigliata
        );
    }
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
    return res
      .status(400)
      .json({
        error:
          "Servizio o ricerca mancante"
      });
  }

  const maxResults =
    Math.min(
      Math.max(
        Number.parseInt(
          body.maxResults,
          10
        ) || 10,
        1
      ),
      20
    );

  try {
    // ------------------------------------------------------------
    // FONTI
    // ------------------------------------------------------------

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

    jobs =
      removeDuplicates(
        jobs
      );

    jobs =
      jobs.filter(
        (job) =>
          job.url &&
          matchesQuery(
            job,
            service
          )
      );

    // ------------------------------------------------------------
    // SCORING LOCALE
    // ------------------------------------------------------------

    jobs =
      jobs.map(
        (job) => {
          const analysis =
            localAnalysis(
              job,
              service
            );

          const result = {
            ...job,
            ...analysis
          };

          result.opportunityScore =
            calculateOpportunityScore(
              result
            );

          return result;
        }
      );

    jobs.sort(
      (a, b) =>
        b.opportunityScore -
        a.opportunityScore
    );

    // Limitiamo i dati mandati all'AI.
    jobs =
      jobs.slice(
        0,
        20
      );

    // ------------------------------------------------------------
    // ANALISI AI
    // ------------------------------------------------------------

    let aiProvider =
      "locale";

    let aiAnalysis =
      await analyzeWithGemini(
        jobs,
        service
      );

    if (aiAnalysis) {
      aiProvider =
        "gemini";
    }

    if (!aiAnalysis) {
      aiAnalysis =
        await analyzeWithOpenRouter(
          jobs,
          service
        );

      if (aiAnalysis) {
        aiProvider =
          "openrouter";
      }
    }

    applyAIAnalysis(
      jobs,
      aiAnalysis
    );

    // ------------------------------------------------------------
    // RANKING FINALE
    // ------------------------------------------------------------

    for (
      const job of jobs
    ) {
      job.opportunityScore =
        calculateOpportunityScore(
          job
        );
    }

    jobs.sort(
      (a, b) =>
        b.opportunityScore -
        a.opportunityScore
    );

    // ------------------------------------------------------------
    // OUTPUT
    // ------------------------------------------------------------

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
                  job.salaryMin ??
                  "?"
                } - ${
                  job.salaryMax ??
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

              tipo:
                job.type,

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
                    700
                  ),

              compatibilita:
                job.compatibility,

              automatizzabilita:
                job.automation,

              probabilitaCommerciale:
                job.commercialProbability,

              potenzialeRicavo:
                job.revenuePotential,

              urgenza:
                job.urgency,

              priorita:
                job.priority,

              punteggioOpportunita:
                job.opportunityScore,

              motivazione:
                job.reason ||
                "Opportunità analizzata da OCULUS.",

              azioneConsigliata:
                job.recommendedAction,

              pubblicataIl:
                job.publishedAt ||
                null
            };
          }
        );

    const statistiche = {
      commesse:
        results.filter(
          (x) =>
            x.tipo ===
            "COMMESSA"
        ).length,

      clientiDiretti:
        results.filter(
          (x) =>
            x.tipo ===
            "CLIENTE DIRETTO"
        ).length,

      collaborazioni:
        results.filter(
          (x) =>
            x.tipo ===
            "COLLABORAZIONE"
        ).length,

      assunzioni:
        results.filter(
          (x) =>
            x.tipo ===
            "ASSUNZIONE"
        ).length,

      prioritaAlta:
        results.filter(
          (x) =>
            x.priorita ===
            "ALTA"
        ).length
    };

    return res
      .status(200)
      .json({
        ok:
          true,

        modalita:
          "domanda_attiva",

        versione:
          "2.0",

        ricerca:
          service,

        analisi:
          aiProvider,

        fonti: [
          "Remote OK",
          "Remotive",
          "Himalayas"
        ],

        numeroRisultati:
          results.length,

        statistiche,

        results
      });

  } catch (error) {
    console.error(
      "[OCULUS / DOMANDA ATTIVA]",
      error
    );

    return res
      .status(500)
      .json({
        error:
          error?.message ||
          "Errore durante la ricerca della Domanda Attiva"
      });
  }
}
