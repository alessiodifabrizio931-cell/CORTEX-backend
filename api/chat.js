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

    // --- GENERAZIONE VIDEO (per PULSUS / LUMEN) ---
    // Sfondo clip Pexels + voce ElevenLabs + sottotitoli automatici -> mp4 9:16
    if (body.action === "video") {
      const ck = process.env.CREATOMATE_API_KEY;
      const pk = process.env.PEXELS_API_KEY;
      if (!ck) return res.status(500).json({ error: "CREATOMATE_API_KEY mancante" });
      if (!pk) return res.status(500).json({ error: "PEXELS_API_KEY mancante" });

      const script = (body.script || "").toString().trim();
      if (!script) return res.status(400).json({ error: "script mancante (il testo da leggere)" });
      const query = (body.query || "abstract background").toString().trim();
      const voiceId = (body.voiceId || "XrExE9yKIg1WjnnlVkGX").toString().trim(); // default: Matilda

      // 1) cerca clip verticale su Pexels
      const per = 15;
      const vr = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=${per}`, { headers: { Authorization: pk } });
      const vd = await vr.json();
      if (!vr.ok) return res.status(vr.status).json({ error: vd?.error || "Errore Pexels video" });
      const videos = vd.videos || [];
      if (!videos.length) return res.status(404).json({ error: `Nessuna clip Pexels per "${query}"` });
      const pick = videos[Math.floor(Math.random() * videos.length)];
      // Tra i file verticali, prendi quello con la risoluzione PIU' ALTA (4K/HD)
      const files = (pick.video_files || [])
        .filter((f) => f.file_type === "video/mp4" && (f.height || 0) >= (f.width || 0))
        .sort((a, b) => (b.height || 0) - (a.height || 0)); // dalla piu' alta alla piu' bassa
      const bgUrl = files.length ? files[0].link : (pick.video_files?.[0]?.link || null);
      if (!bgUrl) return res.status(404).json({ error: "Nessun file mp4 utilizzabile da Pexels" });

      // 2) costruisci la composizione per Creatomate
      const source = {
        output_format: "mp4",
        width: 1080,
        height: 1920,
        elements: [
          { type: "video", track: 1, source: bgUrl, fit: "cover", loop: true, volume: "0%" },
          { type: "audio", id: "voce", track: 2, source: script, provider: `elevenlabs model_id=eleven_multilingual_v2 voice_id=${voiceId}` },
          {
            type: "text", track: 3,
            transcript_source: "voce",
            transcript_effect: "highlight",
            transcript_maximum_length: 1,
            y: "80%", width: "90%", height: "35%",
            x_alignment: "50%", y_alignment: "50%",
            font_family: "Montserrat", font_weight: "700", font_size: "9 vmin",
            fill_color: "#ffffff",
            stroke_color: "#000000", stroke_width: "1.6 vmin",
            background_color: "rgba(0,0,0,0)",
            text_transform: "uppercase"
          }
        ]
      };

      // 3) chiedi il render a Creatomate
      const cr = await fetch("https://api.creatomate.com/v1/renders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ck}` },
        body: JSON.stringify({ source })
      });
      const cd = await cr.json();
      if (!cr.ok) return res.status(cr.status).json({ error: "Errore Creatomate", details: cd });
      const render = Array.isArray(cd) ? cd[0] : cd;

      return res.status(200).json({ ok: true, status: render.status, id: render.id, url: render.url, background_used: bgUrl, voice_used: voiceId });
    }

    // --- STATO DEL RENDER VIDEO (polling) ---
    // Dato l'id di un render Creatomate, ne restituisce lo stato aggiornato
    // e, quando pronto, l'URL definitivo dell'mp4.
    if (body.action === "video_status") {
      const ck = process.env.CREATOMATE_API_KEY;
      if (!ck) return res.status(500).json({ error: "CREATOMATE_API_KEY mancante" });
      const id = (body.id || "").toString().trim();
      if (!id) return res.status(400).json({ error: "id mancante" });

      const sr = await fetch("https://api.creatomate.com/v1/renders/" + encodeURIComponent(id), {
        headers: { "Authorization": `Bearer ${ck}` }
      });
      const sd = await sr.json();
      if (!sr.ok) return res.status(sr.status).json({ error: "Errore stato Creatomate", details: sd });

      // sd.status: planned, waiting, transcribing, rendering, succeeded, failed
      return res.status(200).json({
        ok: true,
        status: sd.status || "unknown",
        url: sd.status === "succeeded" ? (sd.url || null) : null,
        error_message: sd.error_message || null
      });
    }

    // --- NERVUS: dati di mercato (Binance per crypto, Twelve Data per forex/azioni) ---
    if (body.action === "market") {
      const symbol = (body.symbol || "").toString().trim().toUpperCase();
      if (!symbol) return res.status(400).json({ error: "symbol mancante" });
      // Se finisce in USDT/BTC/ETH/BUSD -> crypto Binance (live, senza key)
      const isCrypto = /USDT$|BUSD$|BTC$|ETH$/.test(symbol.replace(/[^A-Z]/g, ""));
      try {
        if (isCrypto) {
          const s = symbol.replace(/[^A-Z]/g, "");
          const [t24, kl] = await Promise.all([
            fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=" + s).then(r => r.json()),
            fetch("https://api.binance.com/api/v3/klines?symbol=" + s + "&interval=1h&limit=24").then(r => r.json())
          ]);
          if (t24.code) return res.status(400).json({ error: "Simbolo crypto non valido su Binance: " + s });
          const closes = Array.isArray(kl) ? kl.map(c => Number(c[4])) : [];
          return res.status(200).json({
            ok: true, source: "Binance (live)", symbol: s,
            price: Number(t24.lastPrice), changePct: Number(t24.priceChangePercent),
            high24h: Number(t24.highPrice), low24h: Number(t24.lowPrice), volume: Number(t24.volume),
            closes1h: closes
          });
        } else {
          const key = process.env.TWELVEDATA_API_KEY;
          if (!key) return res.status(500).json({ error: "TWELVEDATA_API_KEY mancante" });
          const q = await fetch("https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(symbol) + "&apikey=" + key).then(r => r.json());
          if (q.status === "error" || q.code) return res.status(400).json({ error: q.message || "Simbolo non trovato su Twelve Data" });
          return res.status(200).json({
            ok: true, source: "Twelve Data (ritardato ~ore)", symbol,
            price: Number(q.close), changePct: Number(q.percent_change),
            high24h: Number(q.high), low24h: Number(q.low), volume: q.volume ? Number(q.volume) : null,
            name: q.name || null, exchange: q.exchange || null
          });
        }
      } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
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

    // ===== ATLAS / MIDAS: helper per leggere e scrivere database gestionali =====
    // Legge il valore "semplice" di una proprieta' Notion, qualunque sia il tipo
    const readProp = (p) => {
      if (!p) return null;
      switch (p.type) {
        case "title": return (p.title || []).map(t => t.plain_text).join("");
        case "rich_text": return (p.rich_text || []).map(t => t.plain_text).join("");
        case "number": return p.number;
        case "select": return p.select ? p.select.name : null;
        case "multi_select": return (p.multi_select || []).map(s => s.name).join(", ");
        case "date": return p.date ? p.date.start : null;
        case "email": return p.email || null;
        case "phone_number": return p.phone_number || null;
        case "checkbox": return p.checkbox;
        case "url": return p.url || null;
        default: return null;
      }
    };
    // Trova il nome reale di una colonna partendo da alias (case/accent-insensitive)
    const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const findProp = (schemaProps, aliases) => {
      const keys = Object.keys(schemaProps || {});
      for (const a of aliases) { const t = norm(a); const k = keys.find(k => norm(k) === t); if (k) return k; }
      return null;
    };
    // Legge tutte le righe di un database (max 100)
    const notionQuery = async (dbId) => {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, { method: "POST", headers: notionH(), body: JSON.stringify({ page_size: 100 }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Errore query Notion");
      return d.results || [];
    };
    const notionSchema = async (dbId) => {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers: notionH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Errore schema Notion");
      return d.properties || {};
    };

    // --- ATLAS: legge il database CLIENTI ---
    if (body.action === "atlas_read") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) return res.status(400).json({ error: "databaseId mancante" });
      try {
        const rows = await notionQuery(dbId);
        const clienti = rows.map(pg => {
          const pr = pg.properties || {};
          const out = {};
          for (const [k, v] of Object.entries(pr)) out[k] = readProp(v);
          out._id = pg.id;
          return out;
        });
        return res.status(200).json({ ok: true, clienti });
      } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

    // --- ATLAS: aggiunge un cliente ---
    if (body.action === "atlas_write") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) return res.status(400).json({ error: "databaseId mancante" });
      const dati = body.dati || {};
      try {
        const schema = await notionSchema(dbId);
        const props = {};
        const map = [
          { al: ["Nome", "Name"], v: dati.nome, t: "title" },
          { al: ["Stato"], v: dati.stato, t: "select" },
          { al: ["Telefono"], v: dati.telefono, t: "rich_text" },
          { al: ["Email"], v: dati.email, t: "email" },
          { al: ["Servizio"], v: dati.servizio, t: "select" },
          { al: ["Citta", "Città"], v: dati.citta, t: "rich_text" },
          { al: ["Tipo rinnovo"], v: dati.tipoRinnovo, t: "select" },
          { al: ["Data rinnovo"], v: dati.dataRinnovo, t: "date" },
          { al: ["Ultimo contatto"], v: dati.ultimoContatto, t: "date" },
          { al: ["Prossima azione"], v: dati.prossimaAzione, t: "date" },
          { al: ["Note"], v: dati.note, t: "rich_text" }
        ];
        for (const m of map) {
          if (m.v == null || m.v === "") continue;
          const key = findProp(schema, m.al);
          if (!key) continue;
          const realType = schema[key].type;
          if (realType === "title") props[key] = { title: [{ text: { content: String(m.v).slice(0, 200) } }] };
          else if (realType === "rich_text") props[key] = { rich_text: [{ text: { content: String(m.v).slice(0, 1800) } }] };
          else if (realType === "select") props[key] = { select: { name: String(m.v).slice(0, 100) } };
          else if (realType === "email") props[key] = { email: String(m.v) };
          else if (realType === "phone_number") props[key] = { phone_number: String(m.v) };
          else if (realType === "date") props[key] = { date: { start: String(m.v) } };
          else if (realType === "number") props[key] = { number: Number(m.v) };
        }
        const r = await fetch("https://api.notion.com/v1/pages", { method: "POST", headers: notionH(), body: JSON.stringify({ parent: { database_id: dbId }, properties: props }) });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: d?.message || "Errore creazione cliente" });
        return res.status(200).json({ ok: true, url: d.url || null });
      } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

    // --- ATLAS: elimina (archivia) un cliente dato il suo _id ---
    if (body.action === "atlas_delete") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const pageId = (body.pageId || "").toString().trim();
      if (!pageId) return res.status(400).json({ error: "pageId mancante" });
      try {
        const r = await fetch("https://api.notion.com/v1/pages/" + pageId, {
          method: "PATCH", headers: notionH(), body: JSON.stringify({ archived: true })
        });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: d?.message || "Errore eliminazione" });
        return res.status(200).json({ ok: true });
      } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

    // --- MIDAS: legge MOVIMENTI e calcola i conti (fatturato, incassato, tasse) ---
    if (body.action === "midas_read") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) return res.status(400).json({ error: "databaseId mancante" });
      try {
        const schema = await notionSchema(dbId);
        const kImporto = findProp(schema, ["Importo"]);
        const kTipo = findProp(schema, ["Tipo"]);
        const kCategoria = findProp(schema, ["Categoria"]);
        const kStato = findProp(schema, ["Stato"]);
        const rows = await notionQuery(dbId);
        const movimenti = rows.map(pg => {
          const pr = pg.properties || {};
          const out = {};
          for (const [k, v] of Object.entries(pr)) out[k] = readProp(v);
          return out;
        });
        // Calcoli
        let entrate = 0, uscite = 0, fatturato = 0, daFatturare = 0;
        for (const m of movimenti) {
          const imp = Number(kImporto ? m[kImporto] : 0) || 0;
          const tipo = norm(kTipo ? m[kTipo] : "");
          const cat = norm(kCategoria ? m[kCategoria] : "");
          const isEntrata = tipo.includes("entrata") || imp > 0 && !tipo.includes("uscita");
          if (tipo.includes("uscita") || cat.includes("spesa") || cat.includes("fotografo") || cat.includes("videomaker") || cat.includes("modella")) {
            uscite += Math.abs(imp);
          } else {
            entrate += Math.abs(imp);
            // fatturato vs da fatturare: se categoria/stato dice "da fatturare" o "non fatturato"
            const stato = norm(kStato ? m[kStato] : "");
            if (cat.includes("da fatturare") || stato.includes("da fatturare") || cat.includes("non fatturato")) daFatturare += Math.abs(imp);
            else fatturato += Math.abs(imp);
          }
        }
        // Calcolo forfettario (valori Alessio: coeff 78%, imposta 5%, INPS 26,07%)
        const COEFF = 0.78, IMPOSTA = 0.05, INPS = 0.2607;
        const imponibile = fatturato * COEFF;
        const impostaSost = imponibile * IMPOSTA;
        const contributiInps = imponibile * INPS;
        const daAccantonare = impostaSost + contributiInps;
        return res.status(200).json({
          ok: true,
          movimenti,
          conti: {
            entrate: Math.round(entrate * 100) / 100,
            uscite: Math.round(uscite * 100) / 100,
            saldo: Math.round((entrate - uscite) * 100) / 100,
            fatturato: Math.round(fatturato * 100) / 100,
            daFatturare: Math.round(daFatturare * 100) / 100,
            fiscale: {
              coefficiente: COEFF, aliquotaImposta: IMPOSTA, aliquotaInps: INPS,
              imponibile: Math.round(imponibile * 100) / 100,
              impostaSostitutiva: Math.round(impostaSost * 100) / 100,
              contributiInps: Math.round(contributiInps * 100) / 100,
              daAccantonare: Math.round(daAccantonare * 100) / 100
            }
          }
        });
      } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

    // --- MIDAS: aggiunge un movimento ---
    if (body.action === "midas_write") {
      if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) return res.status(400).json({ error: "databaseId mancante" });
      const dati = body.dati || {};
      try {
        const schema = await notionSchema(dbId);
        const props = {};
        const map = [
          { al: ["Descrizione", "Nome", "Name"], v: dati.descrizione, t: "title" },
          { al: ["Tipo"], v: dati.tipo, t: "select" },
          { al: ["Categoria"], v: dati.categoria, t: "select" },
          { al: ["Cliente", "Clienti"], v: dati.cliente, t: "rich_text" },
          { al: ["Importo"], v: dati.importo, t: "number" },
          { al: ["Stato"], v: dati.stato, t: "select" },
          { al: ["Data"], v: dati.data, t: "date" }
        ];
        for (const m of map) {
          if (m.v == null || m.v === "") continue;
          const key = findProp(schema, m.al);
          if (!key) continue;
          const realType = schema[key].type;
          if (realType === "title") props[key] = { title: [{ text: { content: String(m.v).slice(0, 200) } }] };
          else if (realType === "rich_text") props[key] = { rich_text: [{ text: { content: String(m.v).slice(0, 1800) } }] };
          else if (realType === "select") props[key] = { select: { name: String(m.v).slice(0, 100) } };
          else if (realType === "number") props[key] = { number: Number(m.v) };
          else if (realType === "date") props[key] = { date: { start: String(m.v) } };
        }
        const r = await fetch("https://api.notion.com/v1/pages", { method: "POST", headers: notionH(), body: JSON.stringify({ parent: { database_id: dbId }, properties: props }) });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: d?.message || "Errore creazione movimento" });
        return res.status(200).json({ ok: true, url: d.url || null });
      } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

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
