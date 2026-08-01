// ============================================================
// OCULUS — REMOTIVE
// Ricerca opportunità remote utili per X Studio.
// ============================================================

const DEFAULT_KEYWORDS = [
  "web",
  "website",
  "webflow",
  "wordpress",
  "shopify",
  "frontend",
  "front-end",
  "design",
  "graphic",
  "ui",
  "ux",
  "brand",
  "branding",
  "logo",
  "social",
  "social media",
  "marketing",
  "content",
  "community",
  "video",
  "motion",
  "editor",
  "videographer",
  "reels",
  "tiktok",
  "photograph",
  "creative",
  "art director"
];

function normalizeText(value) {
  return (value || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function stripHtml(value) {
  return (value || "")
    .toString()
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesKeywords(job, keywords) {
  const haystack = normalizeText(
    [
      job.title,
      job.company_name,
      job.category,
      job.job_type,
      job.candidate_required_location,
      job.description,
      Array.isArray(job.tags) ? job.tags.join(" ") : ""
    ].join(" ")
  );

  return keywords.some((keyword) =>
    haystack.includes(normalizeText(keyword))
  );
}

function formatSalary(job) {
  if (job.salary) {
    return job.salary;
  }

  if (job.salary_min || job.salary_max) {
    const values = [
      job.salary_min,
      job.salary_max
    ].filter(
      (value) =>
        value !== null &&
        value !== undefined &&
        value !== ""
    );

    if (values.length) {
      return values.join(" - ");
    }
  }

  return null;
}

export async function searchRemotive(body, res) {
  const limit = Math.min(
    Math.max(parseInt(body.limit, 10) || 25, 1),
    50
  );

  const requestedKeywords = Array.isArray(body.keywords)
    ? body.keywords
        .map((keyword) =>
          keyword?.toString().trim()
        )
        .filter(Boolean)
    : [];

  const keywords = requestedKeywords.length
    ? requestedKeywords
    : DEFAULT_KEYWORDS;

  const category = (body.category || "")
    .toString()
    .trim();

  const search = (body.search || "")
    .toString()
    .trim();

  const params = new URLSearchParams();

  if (category) {
    params.set("category", category);
  }

  if (search) {
    params.set("search", search);
  }

  const endpoint =
    "https://remotive.com/api/remote-jobs" +
    (params.toString()
      ? `?${params.toString()}`
      : "");

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent":
          "CORTEX/1.0 (X Studio; OCULUS)"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res
        .status(response.status)
        .json({
          error: "Errore Remotive",
          details:
            data?.message ||
            data?.error ||
            `HTTP ${response.status}`
        });
    }

    const jobs = Array.isArray(data?.jobs)
      ? data.jobs
      : [];

    const results = jobs
      .filter((job) =>
        matchesKeywords(job, keywords)
      )
      .slice(0, limit)
      .map((job) => ({
        id: job.id || null,

        fonte: "Remotive",

        titolo: job.title || "",

        azienda:
          job.company_name || "",

        categoria:
          job.category || "",

        tipo:
          job.job_type || "",

        localita:
          job.candidate_required_location ||
          "Remote",

        remoto: true,

        budget:
          formatSalary(job),

        data:
          job.publication_date || null,

        descrizione:
          stripHtml(job.description)
            .slice(0, 500),

        tags:
          Array.isArray(job.tags)
            ? job.tags
            : [],

        logo:
          job.company_logo || null,

        url:
          job.url || null
      }));

    return res.status(200).json({
      ok: true,
      fonte: "Remotive",
      count: results.length,
      filters: {
        category:
          category || null,
        search:
          search || null,
        keywords
      },
      results
    });
  } catch (error) {
    return res.status(500).json({
      error:
        "Remotive non raggiungibile",
      details:
        String(
          error?.message ||
          error
        )
    });
  }
}