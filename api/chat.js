const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });

  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "GEMINI_API_KEY mancante" });

    const { system, messages } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages mancante" });

    const contents = messages.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const parts = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text") parts.push({ text: b.text });
          else if (b.type === "image" && b.source?.data) parts.push({ inline_data: { mime_type: b.source.media_type || "image/jpeg", data: b.source.data } });
          else if (b.type === "document" && b.source?.data) parts.push({ inline_data: { mime_type: "application/pdf", data: b.source.data } });
        }
      }
      if (!parts.length) parts.push({ text: "" });
      return { role, parts };
    });

    const body = { contents, generationConfig: { maxOutputTokens: 1200, temperature: 0.7 } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Errore Gemini" });

    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
