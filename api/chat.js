import { searchPlaces } from "../services/places.js";
import { searchPaidDemand } from "../services/paidDemand.js";
import { searchRemotive } from "../services/remotive.js";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

function chunkText(t) {
  t = (t || "").toString();
  const out = [];
  for (let i = 0; i < t.length; i += 1900) {
    out.push({ type: "text", text: { content: t.slice(i, i + 1900) } });
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Usa POST" });
  }

  try {
    const body = req.body || {};

    // ============================================================
    // IRIDE — RICERCA FOTO PEXELS
    // ============================================================
    if (body.action === "pexels") {
      const pk = process.env.PEXELS_API_KEY;
      if (!pk) {
        return res.status(500).json({ error: "PEXELS_API_KEY mancante" });
      }
      const query = encodeURIComponent(body.query || "business");
      const per = Math.min(Math.max(parseInt(body.per_page) || 9, 1), 15);

      const pr = await fetch(
        `https://api.pexels.com/v1/search?query=${query}&per_page=${per}&orientation=landscape`,
        { headers: { Authorization: pk } }
      );
      const pd = await pr.json();
      if (!pr.ok) {
        return res.status(pr.status).json({ error: pd?.error || "Errore Pexels" });
      }

      const photos = (pd.photos || []).map((p) => ({
        src: p.src?.large || p.src?.medium,
        thumb: p.src?.tiny,
        alt: p.alt || "",
        author: p.photographer || "",
        url: p.url || ""
      }));

      return res.status(200).json({ photos });
    }

    // ============================================================
    // PULSUS / LUMEN — GENERAZIONE VIDEO
    // ============================================================
    if (body.action === "video") {
      const ck = process.env.CREATOMATE_API_KEY;
      const pk = process.env.PEXELS_API_KEY;
      if (!ck) {
        return res.status(500).json({ error: "CREATOMATE_API_KEY mancante" });
      }
      if (!pk) {
        return res.status(500).json({ error: "PEXELS_API_KEY mancante" });
      }

      const script = (body.script || "").toString().trim();
      if (!script) {
        return res.status(400).json({ error: "script mancante (il testo da leggere)" });
      }

      const query = (body.query || "abstract background").toString().trim();
      const voiceId = (body.voiceId || "XrExE9yKIg1WjnnlVkGX").toString().trim();
      const per = 15;

      const vr = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(
          query
        )}&orientation=portrait&per_page=${per}`,
        { headers: { Authorization: pk } }
      );
      const vd = await vr.json();
      if (!vr.ok) {
        return res.status(vr.status).json({ error: vd?.error || "Errore Pexels video" });
      }

      const videos = vd.videos || [];
      if (!videos.length) {
        return res.status(404).json({ error: `Nessuna clip Pexels per "${query}"` });
      }

      const pick = videos[Math.floor(Math.random() * videos.length)];
      const files = (pick.video_files || [])
        .filter(
          (f) =>
            f.file_type === "video/mp4" && (f.height || 0) >= (f.width || 0)
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      const bgUrl = files.length
        ? files[0].link
        : pick.video_files?.[0]?.link || null;

      if (!bgUrl) {
        return res.status(404).json({ error: "Nessun file mp4 utilizzabile da Pexels" });
      }

      const source = {
        output_format: "mp4",
        width: 1080,
        height: 1920,
        elements: [
          { type: "video", track: 1, source: bgUrl, fit: "cover", loop: true, volume: "0%" },
          {
            type: "audio",
            id: "voce",
            track: 2,
            source: script,
            provider: `elevenlabs model_id=eleven_multilingual_v2 voice_id=${voiceId}`
          },
          {
            type: "text",
            track: 3,
            transcript_source: "voce",
            transcript_effect: "highlight",
            transcript_maximum_length: 1,
            y: "80%",
            width: "90%",
            height: "35%",
            x_alignment: "50%",
            y_alignment: "50%",
            font_family: "Montserrat",
            font_weight: "700",
            font_size: "9 vmin",
            fill_color: "#ffffff",
            stroke_color: "#000000",
            stroke_width: "1.6 vmin",
            background_color: "rgba(0,0,0,0)",
            text_transform: "uppercase"
          }
        ]
      };

      const cr = await fetch("https://api.creatomate.com/v1/renders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ck}` },
        body: JSON.stringify({ source })
      });
      const cd = await cr.json();
      if (!cr.ok) {
        return res.status(cr.status).json({ error: "Errore Creatomate", details: cd });
      }

      const render = Array.isArray(cd) ? cd[0] : cd;
      return res.status(200).json({
        ok: true,
        status: render.status,
        id: render.id,
        url: render.url,
        background_used: bgUrl,
        voice_used: voiceId
      });
    }

    // ============================================================
    // STATO RENDER VIDEO
    // ============================================================
    if (body.action === "video_status") {
      const ck = process.env.CREATOMATE_API_KEY;
      if (!ck) {
        return res.status(500).json({ error: "CREATOMATE_API_KEY mancante" });
      }
      const id = (body.id || "").toString().trim();
      if (!id) {
        return res.status(400).json({ error: "id mancante" });
      }

      const sr = await fetch(
        "https://api.creatomate.com/v1/renders/" + encodeURIComponent(id),
        { headers: { Authorization: `Bearer ${ck}` } }
      );
      const sd = await sr.json();
      if (!sr.ok) {
        return res.status(sr.status).json({ error: "Errore stato Creatomate", details: sd });
      }

      return res.status(200).json({
        ok: true,
        status: sd.status || "unknown",
        url: sd.status === "succeeded" ? sd.url || null : null,
        error_message: sd.error_message || null
      });
    }

    // ============================================================
    // NERVUS — DATI DI MERCATO
    // ============================================================
    if (body.action === "market") {
      const symbol = (body.symbol || "").toString().trim().toUpperCase();
      if (!symbol) {
        return res.status(400).json({ error: "symbol mancante" });
      }

      const cleanSymbol = symbol.replace(/[^A-Z]/g, "");
      const isCrypto = /USDT$|BUSD$|BTC$|ETH$/.test(cleanSymbol);

      try {
        if (isCrypto) {
          const s = cleanSymbol;
          const [t24, kl] = await Promise.all([
            fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=" + s).then((r) => r.json()),
            fetch(
              "https://api.binance.com/api/v3/klines?symbol=" + s + "&interval=1h&limit=24"
            ).then((r) => r.json())
          ]);

          if (t24.code) {
            return res.status(400).json({ error: "Simbolo crypto non valido su Binance: " + s });
          }

          const closes = Array.isArray(kl) ? kl.map((c) => Number(c[4])) : [];

          return res.status(200).json({
            ok: true,
            source: "Binance (live)",
            symbol: s,
            price: Number(t24.lastPrice),
            changePct: Number(t24.priceChangePercent),
            high24h: Number(t24.highPrice),
            low24h: Number(t24.lowPrice),
            volume: Number(t24.volume),
            closes1h: closes
          });
        }

        const key = process.env.TWELVEDATA_API_KEY;
        if (!key) {
          return res.status(500).json({ error: "TWELVEDATA_API_KEY mancante" });
        }

        const q = await fetch(
          "https://api.twelvedata.com/quote?symbol=" +
            encodeURIComponent(symbol) +
            "&apikey=" +
            key
        ).then((r) => r.json());

        if (q.status === "error" || q.code) {
          return res.status(400).json({ error: q.message || "Simbolo non trovato su Twelve Data" });
        }

        return res.status(200).json({
          ok: true,
          source: "Twelve Data (ritardato ~ore)",
          symbol,
          price: Number(q.close),
          changePct: Number(q.percent_change),
          high24h: Number(q.high),
          low24h: Number(q.low),
          volume: q.volume ? Number(q.volume) : null,
          name: q.name || null,
          exchange: q.exchange || null
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // OCULUS — RICERCA PROSPECT GOOGLE PLACES
    // ============================================================
    if (body.action === "places") {
      return searchPlaces(body, res);
    }

    // ============================================================
    // OCULUS — DOMANDA ATTIVA
    // ============================================================
    if (body.action === "paid_demand") {
      return searchPaidDemand(body, res);
    }

    // ============================================================
    // NERVUS — CANDELE STORICHE (Twelve Data) per forex/oro/indici/azioni
    // Restituisce OHLC giornaliero per calcolare setup, RSI, ATR lato frontend.
    // ============================================================
    if (body.action === "market_series") {
      const key = process.env.TWELVEDATA_API_KEY;
      if (!key) {
        return res.status(500).json({ error: "TWELVEDATA_API_KEY mancante" });
      }
      const symbol = (body.symbol || "").toString().trim().toUpperCase();
      if (!symbol) {
        return res.status(400).json({ error: "symbol mancante" });
      }
      const outputsize = Math.min(Math.max(parseInt(body.outputsize) || 60, 20), 200);

      try {
        // quote (prezzo, variazione, high/low, volume)
        const qUrl =
          "https://api.twelvedata.com/quote?symbol=" +
          encodeURIComponent(symbol) +
          "&apikey=" +
          key;
        // serie giornaliera (candele)
        const tsUrl =
          "https://api.twelvedata.com/time_series?symbol=" +
          encodeURIComponent(symbol) +
          "&interval=1day&outputsize=" +
          outputsize +
          "&order=ASC&apikey=" +
          key;

        const [q, ts] = await Promise.all([
          fetch(qUrl).then((r) => r.json()),
          fetch(tsUrl).then((r) => r.json())
        ]);

        if (ts.status === "error" || ts.code) {
          return res.status(400).json({ error: ts.message || "Simbolo non valido su Twelve Data" });
        }

        const values = Array.isArray(ts.values) ? ts.values : [];
        const candles = values.map((v) => ({
          time: v.datetime,
          open: Number(v.open),
          high: Number(v.high),
          low: Number(v.low),
          close: Number(v.close),
          volume: v.volume != null ? Number(v.volume) : null
        }));

        const quote =
          q && !q.code && q.status !== "error"
            ? {
                price: q.close != null ? Number(q.close) : null,
                changePct: q.percent_change != null ? Number(q.percent_change) : null,
                high: q.high != null ? Number(q.high) : null,
                low: q.low != null ? Number(q.low) : null,
                volume: q.volume != null ? Number(q.volume) : null,
                name: q.name || null,
                exchange: q.exchange || null
              }
            : null;

        return res.status(200).json({
          ok: true,
          source: "Twelve Data",
          symbol,
          quote,
          candles
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // NERVUS — CANDELE ALPHA VANTAGE (azioni/forex/indici) — fallback Twelve Data
    // ============================================================
    if (body.action === "market_av") {
      const key = process.env.ALPHAVANTAGE_API_KEY;
      if (!key) {
        return res.status(500).json({ error: "ALPHAVANTAGE_API_KEY mancante" });
      }
      const symbol = (body.symbol || "").toString().trim().toUpperCase();
      if (!symbol) {
        return res.status(400).json({ error: "symbol mancante" });
      }
      const isFx = symbol.includes("/");

      try {
        let candles = [];
        let quote = null;

        if (isFx) {
          const parts = symbol.split("/");
          const from = parts[0];
          const to = parts[1] || "USD";
          const url =
            "https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=" +
            encodeURIComponent(from) +
            "&to_symbol=" +
            encodeURIComponent(to) +
            "&outputsize=compact&apikey=" +
            key;
          const d = await fetch(url).then((r) => r.json());
          if (d.Note || d.Information) {
            return res.status(429).json({ error: "Limite Alpha Vantage raggiunto, riprova più tardi." });
          }
          const ts = d["Time Series FX (Daily)"] || {};
          candles = Object.keys(ts)
            .sort()
            .map((time) => ({
              time,
              open: Number(ts[time]["1. open"]),
              high: Number(ts[time]["2. high"]),
              low: Number(ts[time]["3. low"]),
              close: Number(ts[time]["4. close"]),
              volume: null
            }));
          if (candles.length) {
            const last = candles[candles.length - 1];
            const prev = candles[candles.length - 2] || last;
            quote = {
              price: last.close,
              changePct: prev.close ? ((last.close - prev.close) / prev.close) * 100 : null,
              high: last.high,
              low: last.low,
              volume: null,
              name: from + "/" + to
            };
          }
        } else {
          const tsUrl =
            "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=" +
            encodeURIComponent(symbol) +
            "&outputsize=compact&apikey=" +
            key;
          const qUrl =
            "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=" +
            encodeURIComponent(symbol) +
            "&apikey=" +
            key;
          const [tsRes, qRes] = await Promise.all([
            fetch(tsUrl).then((r) => r.json()),
            fetch(qUrl).then((r) => r.json())
          ]);
          if (tsRes.Note || tsRes.Information) {
            return res.status(429).json({ error: "Limite Alpha Vantage raggiunto, riprova più tardi." });
          }
          const ts = tsRes["Time Series (Daily)"] || {};
          candles = Object.keys(ts)
            .sort()
            .map((time) => ({
              time,
              open: Number(ts[time]["1. open"]),
              high: Number(ts[time]["2. high"]),
              low: Number(ts[time]["3. low"]),
              close: Number(ts[time]["4. close"]),
              volume: ts[time]["5. volume"] != null ? Number(ts[time]["5. volume"]) : null
            }));
          const gq = qRes["Global Quote"] || {};
          const gqPrice = gq["05. price"] != null ? Number(gq["05. price"]) : null;
          const gqChange =
            gq["10. change percent"] != null ? parseFloat(gq["10. change percent"]) : null;
          quote = {
            price: gqPrice != null ? gqPrice : candles.length ? candles[candles.length - 1].close : null,
            changePct: gqChange,
            high: gq["03. high"] != null ? Number(gq["03. high"]) : null,
            low: gq["04. low"] != null ? Number(gq["04. low"]) : null,
            volume: gq["06. volume"] != null ? Number(gq["06. volume"]) : null,
            name: symbol
          };
        }

        if (!candles.length) {
          return res.status(400).json({ error: "Nessun dato Alpha Vantage per " + symbol });
        }

        return res.status(200).json({
          ok: true,
          source: "Alpha Vantage",
          symbol,
          quote,
          candles
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // TAVILY — RICERCA WEB REALE (HELIOS / CODEX)
    // ============================================================
    if (body.action === "websearch") {
      const key = process.env.TAVILY_API_KEY;
      if (!key) {
        return res.status(500).json({ error: "TAVILY_API_KEY mancante" });
      }
      const query = (body.query || "").toString().trim();
      if (!query) {
        return res.status(400).json({ error: "query mancante" });
      }
      const max = Math.min(Math.max(parseInt(body.max_results) || 6, 1), 10);
      try {
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            query,
            search_depth: body.deep ? "advanced" : "basic",
            max_results: max,
            include_answer: true
          })
        });
        const d = await r.json();
        if (!r.ok) {
          return res.status(r.status).json({ error: d?.error || "Errore Tavily" });
        }
        const results = (d.results || []).map((x) => ({
          title: x.title || "",
          url: x.url || "",
          content: (x.content || "").toString().slice(0, 500),
          score: x.score || null
        }));
        return res.status(200).json({
          ok: true,
          source: "Tavily",
          query,
          answer: d.answer || null,
          results
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // FIRECRAWL — SCRAPING SITO / URL (CODEX)
    // ============================================================
    if (body.action === "scrape") {
      const key = process.env.FIRECRAWL_API_KEY;
      if (!key) {
        return res.status(500).json({ error: "FIRECRAWL_API_KEY mancante" });
      }
      const url = (body.url || "").toString().trim();
      if (!url || !/^https?:\/\//.test(url)) {
        return res.status(400).json({ error: "url mancante o non valido (deve iniziare con http/https)" });
      }
      try {
        const r = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`
          },
          body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true })
        });
        const d = await r.json();
        if (!r.ok || d.success === false) {
          return res.status(r.status || 502).json({ error: d?.error || "Errore Firecrawl" });
        }
        const data = d.data || {};
        const md = (data.markdown || "").toString();
        const meta = data.metadata || {};
        return res.status(200).json({
          ok: true,
          source: "Firecrawl",
          url,
          title: meta.title || meta.ogTitle || url,
          description: meta.description || "",
          markdown: md.slice(0, 12000),
          truncated: md.length > 12000
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // COINDESK DATA — PREZZO/INDICE BTC (NERVUS) — richiede chiave attiva
    // ============================================================
    if (body.action === "coindesk") {
      const key = process.env.COINDESK_API_KEY;
      if (!key) {
        return res.status(500).json({ error: "COINDESK_API_KEY mancante" });
      }
      const fsym = (body.symbol || "BTC").toString().trim().toUpperCase().replace(/USDT?$/, "");
      const tsym = (body.vs || "USD").toString().trim().toUpperCase();
      try {
        const r = await fetch(
          "https://min-api.cryptocompare.com/data/pricemultifull?fsyms=" +
            encodeURIComponent(fsym) +
            "&tsyms=" +
            encodeURIComponent(tsym),
          { headers: { authorization: "Apikey " + key } }
        );
        const d = await r.json();
        if (d.Response === "Error") {
          return res.status(400).json({ error: d.Message || "Errore CoinDesk Data" });
        }
        const raw = d?.RAW?.[fsym]?.[tsym];
        if (!raw) {
          return res.status(404).json({ error: "Nessun dato CoinDesk per " + fsym + "/" + tsym });
        }
        return res.status(200).json({
          ok: true,
          source: "CoinDesk Data",
          symbol: fsym + "/" + tsym,
          price: raw.PRICE ?? null,
          changePct: raw.CHANGEPCT24HOUR ?? null,
          high: raw.HIGH24HOUR ?? null,
          low: raw.LOW24HOUR ?? null,
          volume: raw.TOTALVOLUME24HTO ?? null,
          supply: raw.SUPPLY ?? null,
          mktcap: raw.MKTCAP ?? null
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // OCULUS — REMOTE OK (Remotive)
    // ============================================================
    if (body.action === "remoteok") {
      return searchRemotive(body, res);
    }

    // ============================================================
    // NOTION — FUNZIONI COMUNI
    // ============================================================
    const notionH = () => ({
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    });

    const readProp = (p) => {
      if (!p) return null;
      switch (p.type) {
        case "title":
          return (p.title || []).map((t) => t.plain_text).join("");
        case "rich_text":
          return (p.rich_text || []).map((t) => t.plain_text).join("");
        case "number":
          return p.number;
        case "select":
          return p.select ? p.select.name : null;
        case "multi_select":
          return (p.multi_select || []).map((s) => s.name).join(", ");
        case "date":
          return p.date ? p.date.start : null;
        case "email":
          return p.email || null;
        case "phone_number":
          return p.phone_number || null;
        case "checkbox":
          return p.checkbox;
        case "url":
          return p.url || null;
        default:
          return null;
      }
    };

    const norm = (s) =>
      (s || "")
        .toString()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();

    const findProp = (schemaProps, aliases) => {
      const keys = Object.keys(schemaProps || {});
      for (const a of aliases) {
        const t = norm(a);
        const k = keys.find((k) => norm(k) === t);
        if (k) return k;
      }
      return null;
    };

    const notionQuery = async (dbId) => {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST",
        headers: notionH(),
        body: JSON.stringify({ page_size: 100 })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Errore query Notion");
      return d.results || [];
    };

    const notionSchema = async (dbId) => {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
        headers: notionH()
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "Errore schema Notion");
      return d.properties || {};
    };

    // ============================================================
    // ATLAS — LEGGI CLIENTI
    // ============================================================
    if (body.action === "atlas_read") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) {
        return res.status(400).json({ error: "databaseId mancante" });
      }
      try {
        const rows = await notionQuery(dbId);
        const clienti = rows.map((pg) => {
          const pr = pg.properties || {};
          const out = {};
          for (const [k, v] of Object.entries(pr)) {
            out[k] = readProp(v);
          }
          out._id = pg.id;
          return out;
        });
        return res.status(200).json({ ok: true, clienti });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // ATLAS — SCRIVI CLIENTE
    // ============================================================
    if (body.action === "atlas_write") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) {
        return res.status(400).json({ error: "databaseId mancante" });
      }
      const dati = body.dati || {};
      try {
        const schema = await notionSchema(dbId);
        const props = {};
        const map = [
          { al: ["Nome", "Name"], v: dati.nome },
          { al: ["Stato"], v: dati.stato },
          { al: ["Telefono"], v: dati.telefono },
          { al: ["Email"], v: dati.email },
          { al: ["Servizio"], v: dati.servizio },
          { al: ["Citta", "Città"], v: dati.citta },
          { al: ["Tipo rinnovo"], v: dati.tipoRinnovo },
          { al: ["Data rinnovo"], v: dati.dataRinnovo },
          { al: ["Ultimo contatto"], v: dati.ultimoContatto },
          { al: ["Prossima azione"], v: dati.prossimaAzione },
          { al: ["Note"], v: dati.note }
        ];

        for (const m of map) {
          if (m.v == null || m.v === "") continue;
          const key = findProp(schema, m.al);
          if (!key) continue;
          const realType = schema[key].type;

          if (realType === "title") {
            props[key] = { title: [{ text: { content: String(m.v).slice(0, 200) } }] };
          } else if (realType === "rich_text") {
            props[key] = { rich_text: [{ text: { content: String(m.v).slice(0, 1800) } }] };
          } else if (realType === "select") {
            props[key] = { select: { name: String(m.v).slice(0, 100) } };
          } else if (realType === "email") {
            props[key] = { email: String(m.v) };
          } else if (realType === "phone_number") {
            props[key] = { phone_number: String(m.v) };
          } else if (realType === "date") {
            props[key] = { date: { start: String(m.v) } };
          } else if (realType === "number") {
            props[key] = { number: Number(m.v) };
          }
        }

        const r = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: notionH(),
          body: JSON.stringify({ parent: { database_id: dbId }, properties: props })
        });
        const d = await r.json();
        if (!r.ok) {
          return res.status(r.status).json({ error: d?.message || "Errore creazione cliente" });
        }
        return res.status(200).json({ ok: true, url: d.url || null });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // ATLAS — ELIMINA CLIENTE
    // ============================================================
    if (body.action === "atlas_delete") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const pageId = (body.pageId || "").toString().trim();
      if (!pageId) {
        return res.status(400).json({ error: "pageId mancante" });
      }
      try {
        const r = await fetch("https://api.notion.com/v1/pages/" + pageId, {
          method: "PATCH",
          headers: notionH(),
          body: JSON.stringify({ archived: true })
        });
        const d = await r.json();
        if (!r.ok) {
          return res.status(r.status).json({ error: d?.message || "Errore eliminazione" });
        }
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // MIDAS — LEGGI CONTI
    // ============================================================
    if (body.action === "midas_read") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) {
        return res.status(400).json({ error: "databaseId mancante" });
      }
      try {
        const schema = await notionSchema(dbId);
        const kImporto = findProp(schema, ["Importo"]);
        const kTipo = findProp(schema, ["Tipo"]);
        const kCategoria = findProp(schema, ["Categoria"]);
        const kStato = findProp(schema, ["Stato"]);
        const kData = findProp(schema, ["Data"]);
        const kRicorrenza = findProp(schema, ["Ricorrenza"]);
        const kMesiDurata = findProp(schema, ["Mesi durata", "Mesi", "Durata"]);
        const kFatturato = findProp(schema, ["Fatturato"]);

        const rows = await notionQuery(dbId);
        const movimenti = rows.map((pg) => {
          const pr = pg.properties || {};
          const out = {};
          for (const [k, v] of Object.entries(pr)) {
            out[k] = readProp(v);
          }
          return out;
        });

        const now = new Date();
        const meseCorrente =
          now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");

        const mesiTrascorsi = (dataStart) => {
          if (!dataStart) return 1;
          const d = new Date(dataStart);
          if (isNaN(d)) return 1;
          let m =
            (now.getFullYear() - d.getFullYear()) * 12 +
            (now.getMonth() - d.getMonth()) +
            1;
          return m < 1 ? 0 : m;
        };

        let entrate = 0;
        let uscite = 0;
        let fatturato = 0;
        let daFatturare = 0;
        let entrateMese = 0;
        let usciteMese = 0;

        for (const m of movimenti) {
          const impMensile = Number(kImporto ? m[kImporto] : 0) || 0;
          const tipo = norm(kTipo ? m[kTipo] : "");
          const cat = norm(kCategoria ? m[kCategoria] : "");
          const dataStr = kData ? m[kData] : null;
          const ric = norm(kRicorrenza ? m[kRicorrenza] : "");

          const isUnaTantum =
            ric.includes("tantum") || ric.includes("una tantum") || (!ric && true);

          const mesiDur = isUnaTantum
            ? 1
            : Number(kMesiDurata ? m[kMesiDurata] : 0) ||
              (ric.includes("trimestr")
                ? 3
                : ric.includes("semestr")
                ? 6
                : ric.includes("annual")
                ? 12
                : ric.includes("mensile")
                ? 12
                : 1);

          const isFatturato = kFatturato
            ? norm(m[kFatturato]).startsWith("s")
            : !(cat.includes("da fatturare") || cat.includes("non fatturato"));

          const isUscita =
            tipo.includes("uscita") ||
            cat.includes("spesa") ||
            cat.includes("fotografo") ||
            cat.includes("videomaker") ||
            cat.includes("modella");

          const mesiOk = isUnaTantum
            ? 1
            : Math.min(Math.max(mesiTrascorsi(dataStr), 1), mesiDur);

          const maturato = impMensile * mesiOk;

          const attivaOra = isUnaTantum
            ? false
            : mesiTrascorsi(dataStr) <= mesiDur && mesiTrascorsi(dataStr) >= 1;

          const nelMeseCorrente =
            dataStr &&
            new Date(dataStr).getFullYear() +
              "-" +
              String(new Date(dataStr).getMonth() + 1).padStart(2, "0") ===
              meseCorrente;

          if (isUscita) {
            uscite += Math.abs(maturato);
            if (attivaOra) {
              usciteMese += Math.abs(impMensile);
            } else if (nelMeseCorrente) {
              usciteMese += Math.abs(impMensile);
            }
          } else {
            entrate += Math.abs(maturato);
            if (attivaOra) {
              entrateMese += Math.abs(impMensile);
            } else if (nelMeseCorrente) {
              entrateMese += Math.abs(impMensile);
            }
            if (isFatturato) {
              fatturato += Math.abs(maturato);
            } else {
              daFatturare += Math.abs(maturato);
            }
          }
        }

        const meseDaGennaio2026 = () => {
          const g = new Date(2026, 0, 1);
          let m =
            (now.getFullYear() - g.getFullYear()) * 12 +
            (now.getMonth() - g.getMonth()) +
            1;
          return m < 1 ? 0 : m;
        };

        const mesiCoop = meseDaGennaio2026();
        const extraCoopMensile = 60 * mesiCoop;
        const extraCoopSito = 500;
        const extraFuroreMensile = 500;
        const extraFuroreTot = extraFuroreMensile * mesiCoop;
        const incassiExtraTotale = extraFuroreTot + extraCoopMensile + extraCoopSito;
        const incassiExtraMese = extraFuroreMensile + 60;

        entrate += incassiExtraTotale;
        daFatturare += incassiExtraTotale;
        entrateMese += incassiExtraMese;

        const COEFF = 0.78;
        const IMPOSTA = 0.05;
        const INPS = 0.2607;

        const imponibile = fatturato * COEFF;
        const impostaSost = imponibile * IMPOSTA;
        const contributiInps = imponibile * INPS;
        const daAccantonare = impostaSost + contributiInps;

        const r2 = (n) => Math.round(n * 100) / 100;

        return res.status(200).json({
          ok: true,
          movimenti,
          conti: {
            entrate: r2(entrate),
            uscite: r2(uscite),
            saldo: r2(entrate - uscite),
            fatturato: r2(fatturato),
            daFatturare: r2(daFatturare),
            meseCorrente: {
              label: meseCorrente,
              entrate: r2(entrateMese),
              uscite: r2(usciteMese),
              saldo: r2(entrateMese - usciteMese)
            },
            extra: {
              furoreMensile: 500,
              coopMensile: 60,
              coopSito: 500,
              mesiConteggiati: mesiCoop,
              incassiExtraTotale: r2(incassiExtraTotale)
            },
            fiscale: {
              coefficiente: COEFF,
              aliquotaImposta: IMPOSTA,
              aliquotaInps: INPS,
              imponibile: r2(imponibile),
              impostaSostitutiva: r2(impostaSost),
              contributiInps: r2(contributiInps),
              daAccantonare: r2(daAccantonare)
            }
          }
        });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // MIDAS — AGGIUNGI MOVIMENTO
    // ============================================================
    if (body.action === "midas_write") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const dbId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!dbId) {
        return res.status(400).json({ error: "databaseId mancante" });
      }
      const dati = body.dati || {};
      try {
        const schema = await notionSchema(dbId);
        const props = {};
        const map = [
          { al: ["Descrizione", "Nome", "Name"], v: dati.descrizione },
          { al: ["Tipo"], v: dati.tipo },
          { al: ["Categoria"], v: dati.categoria },
          { al: ["Cliente", "Clienti"], v: dati.cliente },
          { al: ["Importo"], v: dati.importo },
          { al: ["Stato"], v: dati.stato },
          { al: ["Data"], v: dati.data }
        ];

        for (const m of map) {
          if (m.v == null || m.v === "") continue;
          const key = findProp(schema, m.al);
          if (!key) continue;
          const realType = schema[key].type;

          if (realType === "title") {
            props[key] = { title: [{ text: { content: String(m.v).slice(0, 200) } }] };
          } else if (realType === "rich_text") {
            props[key] = { rich_text: [{ text: { content: String(m.v).slice(0, 1800) } }] };
          } else if (realType === "select") {
            props[key] = { select: { name: String(m.v).slice(0, 100) } };
          } else if (realType === "number") {
            props[key] = { number: Number(m.v) };
          } else if (realType === "date") {
            props[key] = { date: { start: String(m.v) } };
          }
        }

        const r = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: notionH(),
          body: JSON.stringify({ parent: { database_id: dbId }, properties: props })
        });
        const d = await r.json();
        if (!r.ok) {
          return res.status(r.status).json({ error: d?.message || "Errore creazione movimento" });
        }
        return res.status(200).json({ ok: true, url: d.url || null });
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }

    // ============================================================
    // NOTION — CREA RELAZIONE
    // ============================================================
    if (body.action === "notion") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const databaseId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!databaseId) {
        return res.status(400).json({ error: "databaseId mancante" });
      }

      const dbr = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        headers: notionH()
      });
      const db = await dbr.json();
      if (!dbr.ok) {
        return res.status(dbr.status).json({ error: db?.message || "Errore lettura database Notion" });
      }

      let titleProp = "Name";
      for (const [k, v] of Object.entries(db.properties || {})) {
        if (v && v.type === "title") {
          titleProp = k;
          break;
        }
      }

      const title = (body.title || "Relazione CORTEX").toString().slice(0, 200);
      const finalText = (body.finalText || "").toString();
      const sections = Array.isArray(body.sections) ? body.sections : [];

      const h2 = (t) => ({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: (t || "").toString().slice(0, 200) } }]
        }
      });

      const para = (t) => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: chunkText(t) }
      });

      const children = [h2("Sintesi CORTEX")];
      if (finalText) children.push(para(finalText));

      for (const s of sections) {
        children.push(h2((s.name || "Organo") + (s.count ? " (" + s.count + ")" : "")));
        children.push(para(s.text || ""));
      }

      const payload = {
        parent: { database_id: databaseId },
        properties: { [titleProp]: { title: [{ text: { content: title } }] } },
        children: children.slice(0, 100)
      };

      const pr = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: notionH(),
        body: JSON.stringify(payload)
      });
      const pd = await pr.json();
      if (!pr.ok) {
        return res.status(pr.status).json({ error: pd?.message || "Errore creazione pagina Notion" });
      }

      return res.status(200).json({ ok: true, url: pd.url || null });
    }

    // ============================================================
    // NOTION — SCRIVI LOG
    // ============================================================
    if (body.action === "log") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const databaseId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!databaseId) {
        return res.status(400).json({ error: "databaseId mancante" });
      }

      const dbr = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        headers: notionH()
      });
      const db = await dbr.json();
      if (!dbr.ok) {
        return res.status(dbr.status).json({ error: db?.message || "Errore lettura database Notion" });
      }

      let titleProp = "Name";
      for (const [k, v] of Object.entries(db.properties || {})) {
        if (v.type === "title") {
          titleProp = k;
          break;
        }
      }

      const line = (body.text || "").toString().slice(0, 1800);
      const organo = (body.organo || "").toString();
      const title = (organo ? organo + ": " : "") + line.slice(0, 90);

      const payload = {
        parent: { database_id: databaseId },
        properties: { [titleProp]: { title: [{ text: { content: title || "log" } }] } },
        children: [
          { object: "block", type: "paragraph", paragraph: { rich_text: chunkText(line) } }
        ]
      };

      const pr = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: notionH(),
        body: JSON.stringify(payload)
      });
      const pd = await pr.json();
      if (!pr.ok) {
        return res.status(pr.status).json({ error: pd?.message || "Errore log Notion" });
      }

      return res.status(200).json({ ok: true });
    }

    // ============================================================
    // NOTION — LEGGI LOG
    // ============================================================
    if (body.action === "log_read") {
      if (!process.env.NOTION_TOKEN) {
        return res.status(500).json({ error: "NOTION_TOKEN mancante" });
      }
      const databaseId = (body.databaseId || "").toString().replace(/-/g, "").trim();
      if (!databaseId) {
        return res.status(400).json({ error: "databaseId mancante" });
      }

      const since = new Date();
      since.setHours(0, 0, 0, 0);

      const pr = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: "POST",
        headers: notionH(),
        body: JSON.stringify({
          filter: {
            timestamp: "created_time",
            created_time: { on_or_after: since.toISOString() }
          },
          page_size: 100
        })
      });
      const pd = await pr.json();
      if (!pr.ok) {
        return res.status(pr.status).json({ error: pd?.message || "Errore lettura log" });
      }

      const items = (pd.results || [])
        .map((p) => {
          const props = p.properties || {};
          let title = "";
          for (const v of Object.values(props)) {
            if (v.type === "title") {
              title = (v.title || []).map((t) => t.plain_text).join("");
              break;
            }
          }
          return title;
        })
        .filter(Boolean);

      return res.status(200).json({ items });
    }

    // ============================================================
    // CHAT DEGLI AGENTI — GEMINI + FALLBACK OPENROUTER + GROQ
    // ============================================================
    const { system, messages } = body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages mancante" });
    }

    const toGeminiContents = (inputMessages) =>
      inputMessages.map((m) => {
        const role = m.role === "assistant" ? "model" : "user";
        const parts = [];

        if (typeof m.content === "string") {
          parts.push({ text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === "text") {
              parts.push({ text: b.text || "" });
            } else if (b.type === "image" && b.source?.data) {
              parts.push({
                inline_data: {
                  mime_type: b.source.media_type || "image/jpeg",
                  data: b.source.data
                }
              });
            } else if (b.type === "document" && b.source?.data) {
              parts.push({
                inline_data: {
                  mime_type: b.source.media_type || "application/pdf",
                  data: b.source.data
                }
              });
            }
          }
        }

        if (!parts.length) parts.push({ text: "" });
        return { role, parts };
      });

    const toOpenRouterMessages = (inputMessages) => {
      const out = [];
      if (system) {
        out.push({ role: "system", content: String(system) });
      }
      for (const m of inputMessages) {
        const role = m.role === "assistant" ? "assistant" : "user";

        if (typeof m.content === "string") {
          out.push({ role, content: m.content });
          continue;
        }
        if (!Array.isArray(m.content)) {
          out.push({ role, content: "" });
          continue;
        }

        const content = [];
        for (const b of m.content) {
          if (b.type === "text") {
            content.push({ type: "text", text: b.text || "" });
          } else if (b.type === "image" && b.source?.data) {
            const mime = b.source.media_type || "image/jpeg";
            content.push({
              type: "image_url",
              image_url: { url: `data:${mime};base64,${b.source.data}` }
            });
          } else if (b.type === "document" && b.source?.data) {
            content.push({
              type: "text",
              text: "[Documento PDF allegato: il provider di fallback potrebbe non poterlo leggere direttamente.]"
            });
          }
        }
        out.push({ role, content: content.length ? content : "" });
      }
      return out;
    };

    // Groq accetta solo stringhe come content: appiattisco i blocchi.
    const toGroqMessages = (inputMessages) => {
      const flat = toOpenRouterMessages(inputMessages);
      return flat.map((m) => {
        if (typeof m.content === "string") return m;
        const text = (m.content || [])
          .map((c) => (typeof c === "string" ? c : c?.text || ""))
          .join(" ")
          .trim();
        return { role: m.role, content: text };
      });
    };

    // PROVIDER 1 — GEMINI
    const callGemini = async () => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        return { ok: false, status: 503, error: "GEMINI_API_KEY mancante" };
      }

      const contents = toGeminiContents(messages);
      const gbody = {
        contents,
        generationConfig: { maxOutputTokens: 8192, temperature: 0.7 }
      };
      if (system) {
        gbody.systemInstruction = { parts: [{ text: system }] };
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(gbody)
        });
        const data = await r.json();
        if (!r.ok) {
          return {
            ok: false,
            status: r.status,
            error: data?.error?.message || "Errore Gemini",
            raw: data
          };
        }

        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("")
          .trim();

        if (!text) {
          return { ok: false, status: 502, error: "Gemini non ha restituito testo" };
        }

        return { ok: true, provider: "gemini", model: MODEL, text };
      } catch (error) {
        return { ok: false, status: 503, error: error?.message || "Gemini non raggiungibile" };
      }
    };

    // PROVIDER 2 — OPENROUTER
    const callOpenRouter = async () => {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) {
        return { ok: false, status: 503, error: "OPENROUTER_API_KEY mancante" };
      }

      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "HTTP-Referer": process.env.CORTEX_PUBLIC_URL || "https://cortex.local",
            "X-Title": "CORTEX"
          },
          body: JSON.stringify({
            model: process.env.OPENROUTER_MODEL || "openrouter/free",
            messages: toOpenRouterMessages(messages),
            temperature: 0.7,
            max_tokens: 4096,
            stream: false
          })
        });
        const data = await r.json();
        if (!r.ok) {
          return {
            ok: false,
            status: r.status,
            error: data?.error?.message || "Errore OpenRouter",
            raw: data
          };
        }

        let text = data?.choices?.[0]?.message?.content;
        if (Array.isArray(text)) {
          text = text
            .map((part) => {
              if (typeof part === "string") return part;
              return part?.text || part?.content || "";
            })
            .join("");
        }
        text = (text || "").toString().trim();

        if (!text) {
          return { ok: false, status: 502, error: "OpenRouter non ha restituito testo" };
        }

        return {
          ok: true,
          provider: "openrouter",
          model: data?.model || process.env.OPENROUTER_MODEL || "openrouter/free",
          text
        };
      } catch (error) {
        return { ok: false, status: 503, error: error?.message || "OpenRouter non raggiungibile" };
      }
    };

    // PROVIDER 3 — GROQ (veloce, quota giornaliera gratuita, OpenAI-compatibile)
    const callGroq = async () => {
      const key = process.env.GROQ_API_KEY;
      if (!key) {
        return { ok: false, status: 503, error: "GROQ_API_KEY mancante" };
      }

      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`
          },
          body: JSON.stringify({
            model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            messages: toGroqMessages(messages),
            temperature: 0.7,
            max_tokens: 4096,
            stream: false
          })
        });
        const data = await r.json();
        if (!r.ok) {
          return {
            ok: false,
            status: r.status,
            error: data?.error?.message || "Errore Groq",
            raw: data
          };
        }

        let text = data?.choices?.[0]?.message?.content;
        if (Array.isArray(text)) {
          text = text
            .map((part) => (typeof part === "string" ? part : part?.text || ""))
            .join("");
        }
        text = (text || "").toString().trim();

        if (!text) {
          return { ok: false, status: 502, error: "Groq non ha restituito testo" };
        }

        return {
          ok: true,
          provider: "groq",
          model: data?.model || process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          text
        };
      } catch (error) {
        return { ok: false, status: 503, error: error?.message || "Groq non raggiungibile" };
      }
    };

    // CORTEX AI ROUTER — Gemini → OpenRouter → Groq
    const gemini = await callGemini();

    if (gemini.ok) {
      return res.status(200).json({
        content: [{ type: "text", text: gemini.text }],
        provider: gemini.provider,
        model: gemini.model,
        fallback: false
      });
    }

    console.warn("[CORTEX AI ROUTER] Gemini non disponibile:", gemini.status, gemini.error);

    const openrouter = await callOpenRouter();

    if (openrouter.ok) {
      return res.status(200).json({
        content: [{ type: "text", text: openrouter.text }],
        provider: openrouter.provider,
        model: openrouter.model,
        fallback: true,
        fallbackReason: gemini.error
      });
    }

    console.warn(
      "[CORTEX AI ROUTER] OpenRouter non disponibile:",
      openrouter.status,
      openrouter.error
    );

    const groq = await callGroq();

    if (groq.ok) {
      return res.status(200).json({
        content: [{ type: "text", text: groq.text }],
        provider: groq.provider,
        model: groq.model,
        fallback: true,
        fallbackReason: openrouter.error || gemini.error
      });
    }

    console.error(
      "[CORTEX AI ROUTER] Nessun motore disponibile:",
      "gemini=", gemini.error, "| openrouter=", openrouter.error, "| groq=", groq.error
    );

    return res.status(groq.status || openrouter.status || gemini.status || 503).json({
      error: "Nessun motore AI disponibile in questo momento.",
      details: { gemini: gemini.error, openrouter: openrouter.error, groq: groq.error }
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
