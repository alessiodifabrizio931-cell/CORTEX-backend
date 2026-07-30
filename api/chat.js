const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

function chunkText(t) {
  t = (t || "").toString();
  const out = [];
  for (let i = 0; i < t.length; i += 1900) out.push({ type: "text", text: { content: t.slice(i, i + 1900) } });
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });

  try {
    const body = req.body || {};

    // --- RICERCA FOTO PEXELS (per IRIDE) ---
    if (body.action === "pexels") {
      const pk = process.env.PEXELS_API_KEY;
      if (!pk) return res.status(500).json({ error: "PEXELS_API_KEY mancante" });
      const query = encodeURIComponent(body.query || "business");
      const per = Math.min(Math.max(parseInt(body.per_page) || 9, 1), 15);
      const pr = await fetch(`https://api.pexels.com/v1/search?query=${query}&per_page=${per}&orientation=landscape`, { headers: { Authorization: pk } });
      const pd = await pr.json();
      if (!pr.ok) return res.status(pr.status).json({ error: pd?.error || "Errore Pexels" });
      const photos = (pd.photos || []).map((p) => ({ src: p.src?.large || p.src?.medium, thumb: p.src?.tiny, alt: p.alt || "", author: p.photographer || "", url: p.url || "" }));
      return res.status(200).json({ photos });
    }

    // --- RICERCA ATTIVITA' GOOGLE PLACES (per OCULUS) ---
    if (body.action === "places") {
      const gk = process.env.PLACES_API_KEY;
      if (!gk) return res.status(500).json({ error: "PLACES_API_KEY mancante" });
      const textQuery = (body.query || "").toString().slice(0, 200);
      if (!textQuery) return res.status(400).json({ error: "query mancante" });
      const pr = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": gk, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName,places.googleMapsUri,places.rating" },
        body: JSON.stringify({ textQuery, languageCode: "it", regionCode: "IT", maxResultCount: 20 })
      });
      const pd = await pr.json();
      if (!pr.ok) return res.status(pr.status).json({ error: pd?.error?.message || "Errore Places" });
      const results = (pd.places || []).map((p) => ({ nome: p.displayName?.text || "", indirizzo: p.formattedAddress || "", categoria: p.primaryTypeDisplayName?.text || "", telefono: p.internationalPhoneNumber || p.nationalPhoneNumber || null, sito: p.websiteUri || null, maps: p.googleMapsUri || null, rating: p.rating || null }));
      return res.status(200).json({ results });
    }

    // --- NOTION: helper header ---
    const notionH = () => ({ "Authorization": `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" });

    // --- NOTION: crea pagina relazione ---
    if (body.action === "notion") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const databaseId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!databaseId) return res.status(400).json({ error: "databaseId mancante" });
      const dbr = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, { headers: notionH() });
      const db = await dbr.json();
      if (!dbr.ok) return res.status(dbr.status).json({ error: db?.message || "Errore lettura database Notion" });
      let titleProp = "Name";
      for (const [k, v] of Object.entries(db.properties || {})) { if (v && v.type === "title") { titleProp = k; break; } }
      const title = (body.title || "Relazione CORTEX").toString().slice(0, 200);
      const finalText = (body.finalText || "").toString();
      const sections = Array.isArray(body.sections) ? body.sections : [];
      const h2 = (t) => ({ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: (t || "").toString().slice(0, 200) } }] } });
      const para = (t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: chunkText(t) } });
      const children = [h2("Sintesi CORTEX")];
      if (finalText) children.push(para(finalText));
      for (const s of sections) { children.push(h2((s.name || "Organo") + (s.count ? " (" + s.count + ")" : ""))); children.push(para(s.text || "")); }
      const payload = { parent: { database_id: databaseId }, properties: { [titleProp]: { title: [{ text: { content: title } }] } }, children: children.slice(0, 100) };
      const pr = await fetch("https://api.notion.com/v1/pages", { method: "POST", headers: notionH(), body: JSON.stringify(payload) });
      const pd = await pr.json();
      if (!pr.ok) return res.status(pr.status).json({ error: pd?.message || "Errore creazione pagina Notion" });
      return res.status(200).json({ ok: true, url: pd.url || null });
    }

    // --- NOTION: scrivi una riga nel LOG ---
    if (body.action === "log") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const databaseId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!databaseId) return res.status(400).json({ error: "databaseId mancante" });
      const dbr = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, { headers: notionH() });
      const db = await dbr.json();
      if (!dbr.ok) return res.status(dbr.status).json({ error: db?.message || "Errore lettura database Notion" });
      let titleProp = "Name";
      for (const [k, v] of Object.entries(db.properties || {})) { if (v && v.type === "title") { titleProp = k; break; } }
      const line = (body.text || "").toString().slice(0, 1800);
      const organo = (body.organo || "").toString();
      const title = (organo ? organo + ": " : "") + line.slice(0, 90);
      const payload = { parent: { database_id: databaseId }, properties: { [titleProp]: { title: [{ text: { content: title || "log" } }] } }, children: [{ object: "block", type: "paragraph", paragraph: { rich_text: chunkText(line) } }] };
      const pr = await fetch("https://api.notion.com/v1/pages", { method: "POST", headers: notionH(), body: JSON.stringify(payload) });
      const pd = await pr.json();
      if (!pr.ok) return res.status(pr.status).json({ error: pd?.message || "Errore log Notion" });
      return res.status(200).json({ ok: true });
    }

    // --- NOTION: leggi le voci del LOG di oggi ---
    if (body.action === "log_read") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const databaseId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!databaseId) return res.status(400).json({ error: "databaseId mancante" });
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const pr = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, { method: "POST", headers: notionH(), body: JSON.stringify({ filter: { timestamp: "created_time", created_time: { on_or_after: since.toISOString() } }, page_size: 100 }) });
      const pd = await pr.json();
      if (!pr.ok) return res.status(pr.status).json({ error: pd?.message || "Errore lettura log" });
      const items = (pd.results || []).map((p) => { const props = p.properties || {}; let title = ""; for (const v of Object.values(props)) { if (v.type === "title") { title = (v.title || []).map((t) => t.plain_text).join(""); break; } } return title; }).filter(Boolean);
      return res.status(200).json({ items });
    }

    // --- CHAT GEMINI (agenti) ---
    const { system, messages } = body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages mancante" });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "GEMINI_API_KEY mancante" });
    const contents = messages.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const parts = [];
      if (typeof m.content === "string") { parts.push({ text: m.content }); }
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text") parts.push({ text: b.text });
          else if (b.type === "image" && b.source?.data) parts.push({ inline_data: { mime_type: b.source.media_type || "image/jpeg", data: b.source.data } });
          else if (b.type === "document" && b.source?.data) parts.push({ inline_data: { mime_type: "application/pdf", data: b.source.data } });
        }
      }
      if (!parts.length) parts.push({ text: "" });
      return { role, parts };
    });
    const gbody = { contents, generationConfig: { maxOutputTokens: 8192, temperature: 0.7 } };
    if (system) gbody.systemInstruction = { parts: [{ text: system }] };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(gbody) });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Errore Gemini" });
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
