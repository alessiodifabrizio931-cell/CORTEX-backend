// services/paidDemand.js
//
// OCULUS — MOTORE DOMANDA ATTIVA v3
// Fonti: Freelancer.com (commesse), Remote OK, Remotive, Himalayas.
// Analisi: scoring locale + Gemini + fallback OpenRouter.

const ANALYSIS_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openrouter/free";

const FREELANCER_API =
  "https://www.freelancer.com/api/projects/0.1/projects/active/";


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
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return min;
  }

  return Math.min(
    max,
    Math.max(
      min,
      n
    )
  );
}


function containsAny(text, words) {
  const n =
    normalize(text);

  return words.some(
    (word) =>
      n.includes(
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

  const stop =
    new Set([
      "trova",
      "cerca",
      "opportunita",
      "online",
      "realizzare",
      "servizi",
      "servizio",
      "clienti",
      "cliente",
      "qualcuno",
      "lavoro",
      "lavori",
      "progetto",
      "progetti",
      "per",
      "con",
      "che",
      "dei",
      "delle",
      "della",
      "del",
      "una",
      "uno",
      "gli",
      "le",
      "and",
      "the",
      "for",
      "with",
      "from",
      "remote",
      "remoto"
    ]);

  const words =
    q
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 &&
          !stop.has(w)
      );

  if (!words.length) {
    return text.includes(q);
  }

  return words.some(
    (word) =>
      text.includes(word)
  );
}


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

      if (
        !key ||
        seen.has(key)
      ) {
        return false;
      }

      seen.add(key);

      return true;
    }
  );
}


function epochToIso(value) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    return null;
  }

  const ms =
    n < 1000000000000
      ? n * 1000
      : n;

  const d =
    new Date(ms);

  return Number.isNaN(
    d.getTime()
  )
    ? null
    : d.toISOString();
}


// ============================================================
// FREELANCER.COM
// ============================================================

function buildFreelancerUrl(project) {
  const seo =
    (
      project?.seo_url ||
      ""
    )
      .toString()
      .trim();

  if (
    seo.startsWith(
      "http"
    )
  ) {
    return seo;
  }

  if (seo) {
    return (
      "https://www.freelancer.com/projects/" +
      seo.replace(
        /^\/+/,
        ""
      )
    );
  }

  if (
    project?.id
  ) {
    return (
      "https://www.freelancer.com/projects/" +
      project.id
    );
  }

  return null;
}


function freelancerLocation(project) {
  const candidates = [
    project?.location
      ?.country?.name,

    project?.location
      ?.city,

    project?.location
      ?.country_name,

    project?.country
      ?.name,

    project?.country_name
  ].filter(Boolean);

  return candidates.length
    ? [
        ...new Set(
          candidates
        )
      ].join(", ")
    : "Internazionale / Remoto";
}


async function fetchFreelancer(query) {
  const token =
    process.env
      .FREELANCER_API_TOKEN;

  if (!token) {
    console.warn(
      "[OCULUS] FREELANCER_API_TOKEN mancante"
    );

    return [];
  }

  try {
    const params =
      new URLSearchParams();

    params.set(
      "query",
      query || ""
    );

    params.set(
      "limit",
      "50"
    );

    params.set(
      "compact",
      "true"
    );

    params.set(
      "full_description",
      "true"
    );

    params.set(
      "job_details",
      "true"
    );

    params.set(
      "user_details",
      "true"
    );

    const response =
      await fetch(
        `${FREELANCER_API}?${params.toString()}`,
        {
          method:
            "GET",

          headers: {
            "freelancer-oauth-v1":
              token,

            "User-Agent":
              "CORTEX-OCULUS/3.0",

            "Accept":
              "application/json"
          }
        }
      );

    const data =
      await response
        .json()
        .catch(
          () =>
            null
        );

    if (!response.ok) {
      console.warn(
        "[OCULUS] Freelancer API:",
        response.status,
        data?.message ||
        data?.error ||
        ""
      );

      return [];
    }

    const projects =
      Array.isArray(
        data?.result
          ?.projects
      )
        ? data.result
            .projects
        : Array.isArray(
            data?.projects
          )
        ? data.projects
        : [];

    return projects
      .map(
        (project) => {

          const budgetMin =
            Number(
              project
                ?.budget
                ?.minimum
            );

          const budgetMax =
            Number(
              project
                ?.budget
                ?.maximum
            );

          const currency =
            project
              ?.currency
              ?.code ||
            project
              ?.currency
              ?.sign ||
            null;

          const tags =
            Array.isArray(
              project
                ?.jobs
            )
              ? project.jobs
                  .map(
                    (j) =>
                      j?.name ||
                      j?.seo_url
                  )
                  .filter(
                    Boolean
                  )
              : [];

          const owner =
            project?.owner ||
            project
              ?.owner_details ||
            null;

          const company =
            owner
              ?.display_name ||
            owner
              ?.username ||
            null;

          const bidCount =
            Number(
              project
                ?.bid_stats
                ?.bid_count ??
              project
                ?.bid_count
            );

          const typeRaw =
            normalize(
              project
                ?.type ||
              project
                ?.project_type ||
              ""
            );

          const projectType =
            typeRaw.includes(
              "hour"
            )
              ? "hourly"
              : "fixed";

          return {
            source:
              "Freelancer.com",

            sourceKind:
              "marketplace",

            forceType:
              "COMMESSA",

            title:
              project
                ?.title ||
              "Progetto Freelancer",

            company,

            client:
              company,

            location:
              freelancerLocation(
                project
              ),

            remote:
              true,

            url:
              buildFreelancerUrl(
                project
              ),

            description:
              stripHtml(
                project
                  ?.description ||
                project
                  ?.preview_description ||
                ""
              )
                .slice(
                  0,
                  3000
                ),

            category:
              "Progetto freelance",

            tags,

            salary:
              null,

            salaryMin:
              Number.isFinite(
                budgetMin
              ) &&
              budgetMin > 0
                ? budgetMin
                : null,

            salaryMax:
              Number.isFinite(
                budgetMax
              ) &&
              budgetMax > 0
                ? budgetMax
                : null,

            currency,

            publishedAt:
              epochToIso(
                project
                  ?.submitdate ||
                project
                  ?.time_submitted
              ),

            projectType,

            bidCount:
              Number.isFinite(
                bidCount
              )
                ? bidCount
                : null,

            freelancerProjectId:
              project?.id ||
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
      "[OCULUS] Freelancer non disponibile:",
      error?.message ||
      error
    );

    return [];
  }
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
              "CORTEX/3.0"
          }
        }
      );

    if (!response.ok) {
      return [];
    }

    const data =
      await response.json();

    if (
      !Array.isArray(
        data
      )
    ) {
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

          sourceKind:
            "job_board",

          title:
            item.position ||
            "",

          company:
            item.company ||
            null,

          client:
            item.company ||
            null,

          location:
            item.location ||
            "Da remoto",

          remote:
            true,

          url:
            item.url ||
            null,

          description:
            stripHtml(
              item.description ||
              ""
            )
              .slice(
                0,
                2200
              ),

          category:
            null,

          tags:
            Array.isArray(
              item.tags
            )
              ? item.tags
              : [],

          salary:
            null,

          salaryMin:
            Number(
              item.salary_min
            ) || null,

          salaryMax:
            Number(
              item.salary_max
            ) || null,

          currency:
            item.currency ||
            null,

          publishedAt:
            item.date ||
            null,

          projectType:
            null,

          bidCount:
            null
        })
      );

  } catch (error) {

    console.warn(
      "[OCULUS] Remote OK non disponibile:",
      error?.message ||
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
      encodeURIComponent(
        query ||
        ""
      ) +
      "&limit=50";

    const response =
      await fetch(url);

    if (!response.ok) {
      return [];
    }

    const data =
      await response.json();

    const jobs =
      Array.isArray(
        data?.jobs
      )
        ? data.jobs
        : [];

    return jobs.map(
      (item) => ({
        source:
          "Remotive",

        sourceKind:
          "job_board",

        title:
          item.title ||
          "",

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
            item.description ||
            ""
          )
            .slice(
              0,
              2200
            ),

        category:
          item.category ||
          null,

        tags:
          Array.isArray(
            item.tags
          )
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
          null,

        projectType:
          null,

        bidCount:
          null
      })
    );

  } catch (error) {

    console.warn(
      "[OCULUS] Remotive non disponibile:",
      error?.message ||
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
      "?limit=40&q=" +
      encodeURIComponent(
        query ||
        ""
      );

    const response =
      await fetch(url);

    if (!response.ok) {
      return [];
    }

    const data =
      await response.json();

    const jobs =
      Array.isArray(
        data?.jobs
      )
        ? data.jobs
        : Array.isArray(
            data
          )
        ? data
        : [];

    return jobs
      .map(
        (item) => {

          const company =
            typeof item.company ===
            "string"
              ? item.company
              : item.company
                  ?.name ||
                item.companyName ||
                null;

          const location =
            Array.isArray(
              item.locationRestrictions
            )
              ? item
                  .locationRestrictions
                  .join(", ")
              : item.location ||
                "Da remoto";

          return {
            source:
              "Himalayas",

            sourceKind:
              "job_board",

            title:
              item.title ||
              "",

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
              )
                .slice(
                  0,
                  2200
                ),

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
              null,

            projectType:
              null,

            bidCount:
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
      error?.message ||
      error
    );

    return [];
  }
}


// ============================================================
// CLASSIFICAZIONE
// ============================================================

function classifyOpportunity(job) {
  if (
    job.forceType
  ) {
    return job.forceType;
  }

  const text =
    normalize(
      [
        job.title,
        job.description,
        job.category,
        Array.isArray(
          job.tags
        )
          ? job.tags.join(
              " "
            )
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
// BUDGET / SFORZO / MARGINE
// ============================================================

function estimateBudgetBand(job) {
  const min =
    Number(
      job.salaryMin
    );

  const max =
    Number(
      job.salaryMax
    );

  const hasMin =
    Number.isFinite(min) &&
    min > 0;

  const hasMax =
    Number.isFinite(max) &&
    max > 0;

  const ref =
    hasMax
      ? max
      : hasMin
      ? min
      : null;

  if (
    ref == null
  ) {
    return "NON DICHIARATO";
  }

  if (
    ref < 250
  ) {
    return "MICRO";
  }

  if (
    ref < 500
  ) {
    return "BASSO";
  }

  if (
    ref < 2000
  ) {
    return "STANDARD";
  }

  if (
    ref < 10000
  ) {
    return "PREMIUM";
  }

  return "HIGH TICKET";
}


function estimateEffort(job) {
  const text =
    normalize(
      `${
        job.title ||
        ""
      } ${
        job.description ||
        ""
      }`
    );

  const low = [
    "landing page",
    "bug fix",
    "small fix",
    "minor changes",
    "simple website",
    "one page",
    "logo",
    "banner"
  ];

  const high = [
    "enterprise",
    "marketplace",
    "complex platform",
    "full saas",
    "mobile app",
    "large ecommerce",
    "custom erp",
    "long term"
  ];

  if (
    containsAny(
      text,
      high
    )
  ) {
    return "ALTO";
  }

  if (
    containsAny(
      text,
      low
    )
  ) {
    return "BASSO";
  }

  return "MEDIO";
}


function estimateMargin(
  job,
  automation,
  effort
) {
  const band =
    estimateBudgetBand(
      job
    );

  if (
    (
      band ===
        "STANDARD" ||
      band ===
        "PREMIUM" ||
      band ===
        "HIGH TICKET"
    ) &&
    automation >= 65 &&
    effort !== "ALTO"
  ) {
    return "ALTO";
  }

  if (
    (
      band ===
        "MICRO" ||
      band ===
        "BASSO"
    ) &&
    automation >= 80 &&
    effort === "BASSO"
  ) {
    return "ALTO";
  }

  if (
    effort ===
      "ALTO" &&
    band !==
      "HIGH TICKET"
  ) {
    return "BASSO";
  }

  return "MEDIO";
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
        Array.isArray(
          job.tags
        )
          ? job.tags.join(
              " "
            )
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
      text.includes(
        word
      )
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
      text.includes(
        skill
      )
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
      text.includes(
        signal
      )
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
    type ===
      "COMMESSA"
      ? 85
      : type ===
        "CLIENTE DIRETTO"
      ? 70
      : type ===
        "COLLABORAZIONE"
      ? 55
      : 20;

  if (
    compatibility >=
    80
  ) {
    commercialProbability +=
      5;
  }

  if (
    job.source ===
    "Freelancer.com"
  ) {
    commercialProbability +=
      5;
  }

  commercialProbability =
    clamp(
      commercialProbability
    );

  const budgetBand =
    estimateBudgetBand(
      job
    );

  const effort =
    estimateEffort(
      job
    );

  const marginPotential =
    estimateMargin(
      job,
      automation,
      effort
    );

  let revenuePotential =
    "MEDIO";

  if (
    [
      "PREMIUM",
      "HIGH TICKET"
    ].includes(
      budgetBand
    )
  ) {
    revenuePotential =
      "ALTO";
  }

  else if (
    budgetBand ===
      "STANDARD" &&
    type ===
      "COMMESSA"
  ) {
    revenuePotential =
      "ALTO";
  }

  else if (
    type ===
    "ASSUNZIONE"
  ) {
    revenuePotential =
      "BASSO";
  }

  else if (
    [
      "MICRO",
      "BASSO"
    ].includes(
      budgetBand
    ) &&
    marginPotential !==
      "ALTO"
  ) {
    revenuePotential =
      "BASSO";
  }

  let urgency =
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
      ? "ALTA"
      : "MEDIA";

  let priority =
    "MEDIA";

  if (
    commercialProbability >=
      75 &&
    compatibility >=
      65
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

  if (
    [
      "MICRO",
      "BASSO"
    ].includes(
      budgetBand
    ) &&
    effort ===
      "BASSO" &&
    automation >=
      80
  ) {
    priority =
      "ALTA";
  }

  let recommendedAction =
    "Aprire la fonte e verificare requisiti e modalità di contatto.";

  if (
    type ===
    "COMMESSA"
  ) {
    recommendedAction =
      "Preparare una proposta personalizzata e candidarsi rapidamente sulla piattaforma.";
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
    budgetBand,
    effort,
    marginPotential,
    recommendedAction
  };
}


// ============================================================
// RANKING
// ============================================================

function calculateOpportunityScore(job) {
  const revenueValues = {
    ALTO:
      100,

    MEDIO:
      60,

    BASSO:
      25
  };

  const urgencyValues = {
    ALTA:
      100,

    MEDIA:
      60,

    BASSA:
      25
  };

  const marginValues = {
    ALTO:
      100,

    MEDIO:
      60,

    BASSO:
      20
  };

  const typeBonus = {
    COMMESSA:
      20,

    "CLIENTE DIRETTO":
      15,

    COLLABORAZIONE:
      5,

    ASSUNZIONE:
      -15
  };

  const sourceBonus =
    job.source ===
    "Freelancer.com"
      ? 10
      : 0;

  const budgetBonus =
    job.budgetBand ===
      "HIGH TICKET"
      ? 10
      : job.budgetBand ===
        "PREMIUM"
      ? 8
      : job.budgetBand ===
        "STANDARD"
      ? 5
      : 0;

  const microEfficiencyBonus =
    [
      "MICRO",
      "BASSO"
    ].includes(
      job.budgetBand
    ) &&
    job.effort ===
      "BASSO" &&
    job.automation >=
      80
      ? 8
      : 0;

  const score =
    job.compatibility *
      0.20 +
    job.automation *
      0.15 +
    job.commercialProbability *
      0.25 +
    (
      marginValues[
        job.marginPotential
      ] || 0
    ) *
      0.20 +
    (
      revenueValues[
        job.revenuePotential
      ] || 0
    ) *
      0.10 +
    (
      urgencyValues[
        job.urgency
      ] || 0
    ) *
      0.05 +
    (
      job.remote
        ? 100
        : 60
    ) *
      0.05 +
    (
      typeBonus[
        job.type
      ] || 0
    ) +
    sourceBonus +
    budgetBonus +
    microEfficiencyBonus;

  return Math.round(
    score *
      100
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
          job.description
            .slice(
              0,
              700
            ),

        tipoStimato:
          job.type,

        budgetMin:
          job.salaryMin,

        budgetMax:
          job.salaryMax,

        valuta:
          job.currency,

        fasciaBudget:
          job.budgetBand,

        sforzoStimato:
          job.effort,

        margineStimato:
          job.marginPotential
      })
    );

  return `
Sei OCULUS, analista commerciale di CORTEX.

L'obiettivo principale è trovare COMMESSE e CLIENTI DIRETTI che possano generare ricavi tramite siti web, Shopify, e-commerce, AI, automazioni, marketing, social e contenuti.

Le normali ASSUNZIONI hanno priorità inferiore.

Ricerca utente:
"${query}"

Regola economica:
preferisci in genere progetti da 500 EUR in su, ma NON scartare progetti sotto 500 EUR se sono semplici, veloci, fortemente automatizzabili e con buon margine.

Non inventare budget.
Se non è dichiarato, lascialo come non dichiarato.

Restituisci SOLO JSON valido:

{
  "results": [
    {
      "index": 0,
      "compatibilita": 0,
      "automatizzabilita": 0,
      "tipo": "COMMESSA",
      "probabilitaCommerciale": 0,
      "potenzialeRicavo": "MEDIO",
      "urgenza": "MEDIA",
      "priorita": "MEDIA",
      "sforzo": "MEDIO",
      "marginePotenziale": "MEDIO",
      "motivazione": "",
      "azioneConsigliata": ""
    }
  ]
}

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
        data?.error
          ?.message ||
        ""
      );

      return null;
    }

    const raw =
      (
        data
          ?.candidates?.[0]
          ?.content
          ?.parts ||
        []
      )
        .map(
          (part) =>
            part.text ||
            ""
        )
        .join("")
        .trim();

    return raw
      ? JSON.parse(
          raw
        )
      : null;

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
        data?.error
          ?.message ||
        ""
      );

      return null;
    }

    let raw =
      data?.choices?.[0]
        ?.message
        ?.content;

    if (
      Array.isArray(
        raw
      )
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

    return raw
      ? JSON.parse(
          raw
        )
      : null;

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

    // I progetti Freelancer restano COMMESSE.
    if (
      validTypes.includes(
        ai.tipo
      ) &&
      job.source !==
        "Freelancer.com"
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
      validLevels.includes(
        ai.sforzo
      )
    ) {
      job.effort =
        ai.sforzo;
    }

    if (
      validLevels.includes(
        ai.marginePotenziale
      )
    ) {
      job.marginPotential =
        ai.marginePotenziale;
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
// FILTRO GEOGRAFICO
// ============================================================

function regionMatches(
  job,
  region
) {
  const mode =
    normalize(
      region ||
      "tutto"
    );

  if (
    !mode ||
    mode ===
      "tutto" ||
    mode ===
      "all"
  ) {
    return true;
  }

  const loc =
    normalize(
      job.location
    );

  if (
    mode ===
      "italia" ||
    mode ===
      "italy"
  ) {
    return (
      /italia|italy|italian/.test(
        loc
      )
    );
  }

  if (
    mode ===
      "europa" ||
    mode ===
      "europe"
  ) {
    return (
      /europe|europa|italy|italia|france|germany|spain|portugal|netherlands|belgium|austria|switzerland|poland|romania|greece|ireland|sweden|norway|denmark|finland|croatia|slovenia|czech|hungary/.test(
        loc
      )
    );
  }

  if (
    mode ===
      "remoto" ||
    mode ===
      "remote"
  ) {
    return (
      job.remote !==
      false
    );
  }

  if (
    mode ===
      "internazionale" ||
    mode ===
      "international"
  ) {
    return true;
  }

  return true;
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

  const region =
    (
      body.region ||
      body.area ||
      body.locationMode ||
      "TUTTO"
    )
      .toString()
      .trim();

  try {
    const [
      freelancer,
      remoteOK,
      remotive,
      himalayas
    ] =
      await Promise.all([
        fetchFreelancer(
          service
        ),

        fetchRemoteOK(),

        fetchRemotive(
          service
        ),

        fetchHimalayas(
          service
        )
      ]);

    let jobs =
      removeDuplicates([
        ...freelancer,
        ...remoteOK,
        ...remotive,
        ...himalayas
      ]);

    jobs =
      jobs.filter(
        (job) =>
          job.url &&
          matchesQuery(
            job,
            service
          ) &&
          regionMatches(
            job,
            region
          )
      );

    // ============================================================
    // SCORING LOCALE
    // ============================================================

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
      (
        a,
        b
      ) =>
        b.opportunityScore -
        a.opportunityScore
    );

    jobs =
      jobs.slice(
        0,
        24
      );

    // ============================================================
    // AI ANALYSIS
    // ============================================================

    let aiProvider =
      "locale";

    let aiAnalysis =
      await analyzeWithGemini(
        jobs,
        service
      );

    if (
      aiAnalysis
    ) {
      aiProvider =
        "gemini";
    }

    if (
      !aiAnalysis
    ) {
      aiAnalysis =
        await analyzeWithOpenRouter(
          jobs,
          service
        );

      if (
        aiAnalysis
      ) {
        aiProvider =
          "openrouter";
      }
    }

    applyAIAnalysis(
      jobs,
      aiAnalysis
    );

    // ============================================================
    // RANKING FINALE
    // ============================================================

    for (
      const job of
      jobs
    ) {
      job.opportunityScore =
        calculateOpportunityScore(
          job
        );
    }

    jobs.sort(
      (
        a,
        b
      ) =>
        b.opportunityScore -
        a.opportunityScore
    );

    // ============================================================
    // OUTPUT
    // ============================================================

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

              budgetMin:
                job.salaryMin ||
                null,

              budgetMax:
                job.salaryMax ||
                null,

              fasciaBudget:
                job.budgetBand,

              valuta:
                job.currency ||
                null,

              tipoProgetto:
                job.projectType ||
                null,

              numeroOfferte:
                job.bidCount ??
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

              sforzoStimato:
                job.effort,

              marginePotenziale:
                job.marginPotential,

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
        ).length,

      daFreelancer:
        results.filter(
          (x) =>
            x.fonte ===
            "Freelancer.com"
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
          "3.0",

        ricerca:
          service,

        regione:
          region,

        analisi:
          aiProvider,

        fonti: [
          "Freelancer.com",
          "Remote OK",
          "Remotive",
          "Himalayas"
        ],

        disponibilitaFonti: {
          freelancer:
            freelancer.length,

          remoteOK:
            remoteOK.length,

          remotive:
            remotive.length,

          himalayas:
            himalayas.length
        },

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
