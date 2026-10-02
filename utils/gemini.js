const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Deliberately a separate env var (and ideally a separate Gemini
// project/key) from GEMINI_API_KEY above — image generation is billed far
// more heavily than text/analysis calls, so keeping it on its own key makes
// usage and cost easy to track independently. Falls back to GEMINI_API_KEY
// so a single-key dev setup still works.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

const PROMPT = `You are analyzing a photo of a single clothing item for a wardrobe app.
Identify its dominant color(s), pattern, and fabric type.
Respond with your best guess even if you're not fully certain.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    colors: {
      type: "array",
      items: { type: "string" },
      description: "1-2 dominant colors of the item, e.g. ['Navy']",
    },
    pattern: {
      type: "string",
      description: "e.g. Solid, Print, Striped, Floral, Checked",
    },
    fabricType: {
      type: "string",
      description: "e.g. Cotton, Denim, Wool, Polyester, Linen, Knit",
    },
  },
  required: ["colors", "pattern", "fabricType"],
};

class GeminiError extends Error {}

// Calls Gemini's vision model on a single clothing photo and returns
// structured wardrobe insights. Throws GeminiError on any failure so the
// route can turn it into a clean 502 without leaking upstream details.
async function analyzeClothingImage(base64Image, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError("GEMINI_API_KEY is not configured");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType, data: base64Image } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GeminiError(`Gemini request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiError("Gemini response had no content");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini response was not valid JSON");
  }

  if (
    !Array.isArray(parsed.colors) ||
    typeof parsed.pattern !== "string" ||
    typeof parsed.fabricType !== "string"
  ) {
    throw new GeminiError("Gemini response did not match the expected shape");
  }

  return {
    colors: parsed.colors,
    pattern: parsed.pattern,
    fabricType: parsed.fabricType,
  };
}

const OOTD_OCCASIONS = ["Work", "Date", "Casual", "Dinner Night"];

const OOTD_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    outfits: {
      type: "array",
      description: `Exactly one outfit per occasion, in this order: ${OOTD_OCCASIONS.join(", ")}.`,
      items: {
        type: "object",
        properties: {
          occasion: {
            type: "string",
            enum: OOTD_OCCASIONS,
          },
          itemIds: {
            type: "array",
            items: { type: "string" },
            description:
              "ids of the chosen wardrobe items, copied exactly from the provided wardrobe list",
          },
          note: {
            type: "string",
            description:
              "one short, friendly styling tip (max ~15 words) explaining the pick, weather-aware",
          },
        },
        required: ["occasion", "itemIds", "note"],
      },
    },
  },
  required: ["outfits"],
};

function buildOotdPrompt({ items, weather }) {
  const wardrobeJson = JSON.stringify(
    items.map((item) => ({
      id: item.id,
      category: item.category,
      name: item.name,
      fit: item.fit ?? null,
      colors: item.colors ?? [],
      pattern: item.pattern ?? null,
      fabricType: item.fabricType ?? null,
    })),
  );

  const weatherJson = JSON.stringify({
    temperatureC: weather.temperatureC,
    condition: weather.condition,
    location: weather.location ?? null,
  });

  return `You are a personal stylist for the Kanti app. Build today's outfit-of-the-day (OOTD) picks for a user, using ONLY the clothing items in their wardrobe below.

WARDROBE (JSON array, each item has a unique "id"):
${wardrobeJson}

TODAY'S WEATHER (JSON):
${weatherJson}

TASK:
Create exactly one outfit for each of these occasions, in this order: ${OOTD_OCCASIONS.join(", ")}.

RULES:
1. Every outfit must be built entirely from the wardrobe list above. Never invent items or ids. Only use "id" values copied exactly from the wardrobe.
2. Every outfit needs a complete base: either (one "Top" + one "Bottom") or one "Dress", plus one "Shoes" item. Add "Outerwear", "Sweater", "Accessories", or "Carry-on" pieces only when they suit the occasion and weather.
3. Dress for the weather: if temperatureC is low or the condition suggests cold/rain/wind, favor warmer layers (Outerwear, Sweater, closed shoes) and add a layer where sensible; if it's warm and sunny, favor lighter pieces and skip heavy layers.
4. Match formality to the occasion: "Work" should read polished/professional, "Date" and "Dinner Night" more elevated or evening-appropriate, "Casual" relaxed and easy.
5. Keep each outfit visually coherent (colors and patterns that pair well together), and avoid reusing the exact same full outfit twice across occasions when the wardrobe has enough variety.
6. Do not repeat an item's category twice within the same outfit (e.g. never two Tops in one outfit), except that Accessories may appear alongside anything.
7. "note" is a short, warm, weather-aware styling tip a stylist friend might text you (max ~15 words).
8. If the wardrobe is limited, still do your best to produce a complete, sensible outfit for every occasion rather than skipping one.

Respond with JSON only, matching the required schema.`;
}

// Calls Gemini to compose weather- and occasion-aware outfits from a user's
// wardrobe. `items` is the flat metadata for each wardrobe piece (no images —
// wardrobe photos never leave the device, so this is a text-only call).
// Throws GeminiError on any failure so the route can turn it into a clean
// 502 without leaking upstream details.
async function generateOotdSuggestions({ items, weather }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError("GEMINI_API_KEY is not configured");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildOotdPrompt({ items, weather }) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: OOTD_RESPONSE_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GeminiError(`Gemini request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiError("Gemini response had no content");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini response was not valid JSON");
  }

  if (!Array.isArray(parsed.outfits)) {
    throw new GeminiError("Gemini response did not match the expected shape");
  }

  const validIds = new Set(items.map((item) => item.id));

  // Defensively drop any hallucinated ids/occasions rather than trusting the
  // model output verbatim.
  const outfits = parsed.outfits
    .filter(
      (outfit) =>
        outfit &&
        OOTD_OCCASIONS.includes(outfit.occasion) &&
        Array.isArray(outfit.itemIds),
    )
    .map((outfit) => ({
      occasion: outfit.occasion,
      itemIds: outfit.itemIds.filter((id) => validIds.has(id)),
      note: typeof outfit.note === "string" ? outfit.note : "",
    }))
    .filter((outfit) => outfit.itemIds.length > 0);

  return { outfits };
}

function buildOotdImagePrompt({ occasion, note, weather, items }) {
  const categoryList = items.map((item) => item.category).join(", ");

  return `You are a fashion photographer composing a single outfit preview image for a styling app.

You are given ${items.length} separate photos of real clothing items a user owns, in this order: ${categoryList}.

TASK:
Compose ONE new image that presents these exact garments together as a single, cohesive "${occasion}" outfit — as if laid out as a clean flat-lay or worn together on a plain-background model. Keep each garment's actual color, pattern, fit, and design faithful to its source photo; do not invent, substitute, or restyle the pieces themselves.

CONTEXT:
- Occasion: ${occasion}
- Weather: ${weather.temperatureC}°C, ${weather.condition}
- Styling note: ${note || "(none)"}

STYLE:
Soft, even studio lighting, plain neutral background, no text or watermarks, no extra garments beyond the ones provided.`;
}

// Calls Gemini's image model with the outfit's item photos and returns one
// generated image composing them into a single outfit shot. Uses a
// different model (and, recommended, a different API key) from the
// text-only analysis/suggestion calls above, since image generation is
// billed per output image. Throws GeminiError on any failure so the route
// can turn it into a clean 502 without leaking upstream details.
async function generateOotdImage({ occasion, note, items, weather }) {
  const apiKey = process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError("GEMINI_IMAGE_API_KEY is not configured");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;

  const imageParts = items.map((item) => ({
    inline_data: { mime_type: item.mimeType, data: item.image },
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: buildOotdImagePrompt({ occasion, note, weather, items }) }, ...imageParts],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GeminiError(`Gemini request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData || part.inline_data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;

  if (!inlineData?.data) {
    throw new GeminiError("Gemini response had no generated image");
  }

  return {
    image: inlineData.data,
    mimeType: inlineData.mimeType || inlineData.mime_type || "image/png",
  };
}

module.exports = {
  analyzeClothingImage,
  generateOotdSuggestions,
  generateOotdImage,
  OOTD_OCCASIONS,
  GeminiError,
};
