// services/places.js
// Servizio Google Places usato da OCULUS.
// Per ora replica esattamente il comportamento già presente in api/chat.js,
// così possiamo separare il backend senza cambiare il funzionamento di CORTEX.

export async function searchPlaces(body, res) {
  const gk = process.env.PLACES_API_KEY;

  if (!gk) {
    return res.status(500).json({
      error: "PLACES_API_KEY mancante"
    });
  }

  const textQuery = (body.query || "")
    .toString()
    .slice(0, 200)
    .trim();

  if (!textQuery) {
    return res.status(400).json({
      error: "query mancante"
    });
  }

  try {
    const response = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": gk,
          "X-Goog-FieldMask":
            "places.displayName," +
            "places.formattedAddress," +
            "places.nationalPhoneNumber," +
            "places.internationalPhoneNumber," +
            "places.websiteUri," +
            "places.primaryTypeDisplayName," +
            "places.googleMapsUri," +
            "places.rating"
        },

        body: JSON.stringify({
          textQuery,
          languageCode: "it",
          regionCode: "IT",
          maxResultCount: 20
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Errore Google Places"
      });
    }

    const results = (data.places || []).map((place) => ({
      nome:
        place.displayName?.text || "",

      indirizzo:
        place.formattedAddress || "",

      categoria:
        place.primaryTypeDisplayName?.text || "",

      telefono:
        place.internationalPhoneNumber ||
        place.nationalPhoneNumber ||
        null,

      sito:
        place.websiteUri || null,

      maps:
        place.googleMapsUri || null,

      rating:
        place.rating || null
    }));

    return res.status(200).json({
      ok: true,
      query: textQuery,
      count: results.length,
      results
    });
  } catch (error) {
    console.error("[OCULUS / Google Places]", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Errore durante la ricerca Google Places"
    });
  }
}
