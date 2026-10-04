function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("Gemini retry on transient failures", () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.GEMINI_API_KEY = "test-key";
    // Shrink the retry backoff so these tests don't wait out real
    // multi-second delays.
    process.env.GEMINI_RETRY_BASE_DELAY_MS = "5";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.GEMINI_API_KEY = originalApiKey;
    delete process.env.GEMINI_RETRY_BASE_DELAY_MS;
  });

  it("retries a 503 and succeeds once Gemini recovers", async () => {
    const { analyzeClothingImage } = require("./gemini");

    const overloaded = jsonResponse(503, {
      error: { code: 503, message: "high demand", status: "UNAVAILABLE" },
    });
    const success = jsonResponse(200, {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  colors: ["Navy"],
                  pattern: "Solid",
                  fabricType: "Cotton",
                }),
              },
            ],
          },
        },
      ],
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(overloaded)
      .mockResolvedValueOnce(success);

    const result = await analyzeClothingImage("base64data", "image/jpeg");

    expect(result).toEqual({
      colors: ["Navy"],
      pattern: "Solid",
      fabricType: "Cotton",
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up and throws GeminiError after repeated 503s", async () => {
    const { analyzeClothingImage, GeminiError } = require("./gemini");

    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(503, {
        error: { code: 503, message: "high demand", status: "UNAVAILABLE" },
      }),
    );

    await expect(
      analyzeClothingImage("base64data", "image/jpeg"),
    ).rejects.toBeInstanceOf(GeminiError);
    // 1 initial attempt + 3 retries = 4 total calls.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a non-transient 4xx error", async () => {
    const { analyzeClothingImage, GeminiError } = require("./gemini");

    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(400, { error: { message: "bad request" } }),
      );

    await expect(
      analyzeClothingImage("base64data", "image/jpeg"),
    ).rejects.toBeInstanceOf(GeminiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429 on the same model, and goes straight to the fallback model", async () => {
    process.env.GEMINI_MODEL = "gemini-3.6-flash";
    process.env.GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";
    const { analyzeClothingImage } = require("./gemini");

    // A daily free-tier quota 429 — retryDelay is in hours, so retrying the
    // same model would be pure waste.
    const quotaExceeded = jsonResponse(429, {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message:
          "Quota exceeded for quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier",
      },
    });
    const success = jsonResponse(200, {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  colors: ["Navy"],
                  pattern: "Solid",
                  fabricType: "Cotton",
                }),
              },
            ],
          },
        },
      ],
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(quotaExceeded)
      .mockResolvedValueOnce(success);

    const result = await analyzeClothingImage("base64data", "image/jpeg");

    expect(result).toEqual({
      colors: ["Navy"],
      pattern: "Solid",
      fabricType: "Cotton",
    });
    // Exactly 2 calls total: one 429 on the primary model (no local retries
    // burning more of its exhausted daily quota), then one success on the
    // fallback model.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toContain(
      "gemini-3.6-flash:generateContent",
    );
    expect(global.fetch.mock.calls[1][0]).toContain(
      "gemini-3.1-flash-lite:generateContent",
    );

    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODEL;
  });

  it("falls back to GEMINI_FALLBACK_MODEL once the primary model exhausts its retries", async () => {
    process.env.GEMINI_MODEL = "gemini-3.6-flash";
    process.env.GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";
    const { analyzeClothingImage } = require("./gemini");

    const overloaded = jsonResponse(503, {
      error: { code: 503, message: "high demand", status: "UNAVAILABLE" },
    });
    const success = jsonResponse(200, {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  colors: ["Navy"],
                  pattern: "Solid",
                  fabricType: "Cotton",
                }),
              },
            ],
          },
        },
      ],
    });

    // 4 overloaded responses for the primary model's attempts, then succeed
    // on the fallback model's first attempt.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(overloaded)
      .mockResolvedValueOnce(overloaded)
      .mockResolvedValueOnce(overloaded)
      .mockResolvedValueOnce(overloaded)
      .mockResolvedValueOnce(success);

    const result = await analyzeClothingImage("base64data", "image/jpeg");

    expect(result).toEqual({
      colors: ["Navy"],
      pattern: "Solid",
      fabricType: "Cotton",
    });
    expect(global.fetch).toHaveBeenCalledTimes(5);
    expect(global.fetch.mock.calls[0][0]).toContain(
      "gemini-3.6-flash:generateContent",
    );
    expect(global.fetch.mock.calls[4][0]).toContain(
      "gemini-3.1-flash-lite:generateContent",
    );

    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODEL;
  });
});
