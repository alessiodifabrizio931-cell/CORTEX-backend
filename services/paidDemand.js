    // ============================================================
    // CHAT DEGLI AGENTI — GEMINI + FALLBACK OPENROUTER
    // ============================================================

    const {
      system,
      messages
    } = body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: "messages mancante"
      });
    }

    // ============================================================
    // CONVERSIONE MESSAGGI PER GEMINI
    // ============================================================

    const toGeminiContents = (inputMessages) =>
      inputMessages.map((m) => {
        const role =
          m.role === "assistant"
            ? "model"
            : "user";

        const parts = [];

        if (typeof m.content === "string") {
          parts.push({
            text: m.content
          });
        }

        else if (Array.isArray(m.content)) {
          for (const b of m.content) {

            if (b.type === "text") {
              parts.push({
                text: b.text || ""
              });
            }

            else if (
              b.type === "image" &&
              b.source?.data
            ) {
              parts.push({
                inline_data: {
                  mime_type:
                    b.source.media_type ||
                    "image/jpeg",

                  data:
                    b.source.data
                }
              });
            }

            else if (
              b.type === "document" &&
              b.source?.data
            ) {
              parts.push({
                inline_data: {
                  mime_type:
                    b.source.media_type ||
                    "application/pdf",

                  data:
                    b.source.data
                }
              });
            }
          }
        }

        if (!parts.length) {
          parts.push({
            text: ""
          });
        }

        return {
          role,
          parts
        };
      });

    // ============================================================
    // CONVERSIONE MESSAGGI PER OPENROUTER
    // ============================================================

    const toOpenRouterMessages = (inputMessages) => {

      const out = [];

      if (system) {
        out.push({
          role: "system",
          content: String(system)
        });
      }

      for (const m of inputMessages) {

        const role =
          m.role === "assistant"
            ? "assistant"
            : "user";

        if (typeof m.content === "string") {

          out.push({
            role,
            content: m.content
          });

          continue;
        }

        if (!Array.isArray(m.content)) {

          out.push({
            role,
            content: ""
          });

          continue;
        }

        const content = [];

        for (const b of m.content) {

          if (b.type === "text") {

            content.push({
              type: "text",
              text: b.text || ""
            });

          }

          else if (
            b.type === "image" &&
            b.source?.data
          ) {

            const mime =
              b.source.media_type ||
              "image/jpeg";

            content.push({
              type: "image_url",

              image_url: {
                url:
                  `data:${mime};base64,${b.source.data}`
              }
            });

          }

          else if (
            b.type === "document" &&
            b.source?.data
          ) {

            content.push({
              type: "text",

              text:
                "[Documento PDF allegato]"
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

    // ============================================================
    // PROVIDER 1 — GEMINI
    // ============================================================

    const callGemini = async () => {

      const key =
        process.env.GEMINI_API_KEY;

      if (!key) {
        return {
          ok: false,
          status: 503,
          error:
            "GEMINI_API_KEY mancante"
        };
      }

      const contents =
        toGeminiContents(messages);

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
            ok: false,

            status:
              r.status,

            error:
              data?.error?.message ||
              "Errore Gemini"
          };
        }

        const text =
          (
            data?.candidates?.[0]
              ?.content?.parts ||
            []
          )
            .map(
              (p) =>
                p.text || ""
            )
            .join("")
            .trim();

        if (!text) {

          return {
            ok: false,

            status:
              502,

            error:
              "Gemini non ha restituito testo"
          };
        }

        return {
          ok: true,

          provider:
            "gemini",

          model:
            MODEL,

          text
        };

      }

      catch (error) {

        return {
          ok: false,

          status:
            503,

          error:
            error?.message ||
            "Gemini non raggiungibile"
        };
      }
    };

    // ============================================================
    // PROVIDER 2 — OPENROUTER
    // ============================================================

    const callOpenRouter = async () => {

      const key =
        process.env.OPENROUTER_API_KEY;

      if (!key) {

        return {
          ok: false,

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

                "Authorization":
                  `Bearer ${key}`,

                "X-Title":
                  "CORTEX"
              },

              body:
                JSON.stringify({

                  model:
                    process.env.OPENROUTER_MODEL ||
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
            ok: false,

            status:
              r.status,

            error:
              data?.error?.message ||
              "Errore OpenRouter"
          };
        }

        let text =
          data?.choices?.[0]
            ?.message?.content;

        if (Array.isArray(text)) {

          text =
            text
              .map(
                (part) =>
                  typeof part === "string"
                    ? part
                    : part?.text ||
                      part?.content ||
                      ""
              )
              .join("");
        }

        text =
          (text || "")
            .toString()
            .trim();

        if (!text) {

          return {
            ok: false,

            status:
              502,

            error:
              "OpenRouter non ha restituito testo"
          };
        }

        return {
          ok: true,

          provider:
            "openrouter",

          model:
            data?.model ||
            process.env.OPENROUTER_MODEL ||
            "openrouter/free",

          text
        };

      }

      catch (error) {

        return {
          ok: false,

          status:
            503,

          error:
            error?.message ||
            "OpenRouter non raggiungibile"
        };
      }
    };

    // ============================================================
    // CORTEX AI ROUTER
    // ============================================================

    const gemini =
      await callGemini();

    // GEMINI FUNZIONA
    if (gemini.ok) {

      return res.status(200).json({

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

    // GEMINI NON FUNZIONA → OPENROUTER
    const openrouter =
      await callOpenRouter();

    if (openrouter.ok) {

      return res.status(200).json({

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
          true
      });
    }

    // NESSUN PROVIDER DISPONIBILE
    return res.status(
      openrouter.status ||
      gemini.status ||
      503
    ).json({

      error:
        "Nessun motore AI disponibile in questo momento.",

      details: {

        gemini:
          gemini.error,

        openrouter:
          openrouter.error
      }
    });

  }

  catch (e) {

    return res.status(500).json({

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
