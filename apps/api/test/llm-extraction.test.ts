import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../src/env";
import { cleanExtraction, extractSignalsWithLlm } from "../src/llm-extraction";

const SAMPLE =
  "我同阿May約咗下星期二喺藍田站交收一部 Mac mini，佢係 Carousell 賣家，之前仲買過佢一部 PS5 手掣。";

const GOOD_JSON = JSON.stringify({
  entities: [
    { name: "阿May", type: "person" },
    { name: "藍田站", type: "place" },
    { name: "Mac mini", type: "product" },
    { name: "Carousell", type: "organization" },
  ],
  relationships: [
    { source: "阿May", relationship: "uses", target: "Carousell" },
    { source: "阿May", relationship: "sells", target: "Mac mini" },
  ],
  tags: ["Carousell", "交收", "carousell"],
});

function geminiResponse(text: string) {
  return Response.json({
    candidates: [{ content: { parts: [{ text }] } }],
  });
}

function chatResponse(text: string) {
  return Response.json({ choices: [{ message: { content: text } }] });
}

function fakeEnv(overrides: Record<string, unknown> = {}) {
  return {
    EMBEDDING_MODEL: "@cf/test/embedding",
    ...overrides,
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("llm extraction provider chain", () => {
  test("is disabled without any keys or AI binding and never fetches", async () => {
    const fetcher = vi.fn(async () => geminiResponse(GOOD_JSON));
    vi.stubGlobal("fetch", fetcher);

    await expect(extractSignalsWithLlm(fakeEnv(), SAMPLE)).resolves.toBe(
      undefined,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("uses Gemini first and cleans its output", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("gateway.ai.cloudflare.com");
      expect(url).toContain("gemini-3.8-flash:generateContent");
      expect(url).toContain("key=test-gemini-key");
      return geminiResponse(GOOD_JSON);
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await extractSignalsWithLlm(
      fakeEnv({ GEMINI_API_KEY: "test-gemini-key" }),
      SAMPLE,
    );

    expect(result?.provider).toBe("gemini");
    expect(result?.model).toBe("gemini-3.8-flash");
    // Latin-mixed names normalize through entityId; pure Chinese names fall
    // back to a stable hash id.
    expect(result?.signals.entityIds).toContain("may");
    expect(result?.signals.entityIds).toContain("mac-mini");
    expect(
      result?.signals.entityIds.some((id) => /^entity-[0-9a-f]{8}$/.test(id)),
    ).toBe(true);
    // Non-vocabulary verbs are dropped; allowed verbs survive.
    expect(result?.signals.relationships).toEqual([
      expect.objectContaining({
        sourceEntityId: "may",
        targetEntityId: "carousell",
        relationship: "uses",
      }),
    ]);
    expect(result?.signals.tags).toEqual(["carousell", "交收"]);
  });

  test("falls through to Workers AI when Gemini fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const aiRun = vi.fn(async () => ({ response: GOOD_JSON }));

    const result = await extractSignalsWithLlm(
      fakeEnv({ GEMINI_API_KEY: "k", AI: { run: aiRun } }),
      SAMPLE,
    );

    expect(result?.provider).toBe("workers-ai");
    expect(result?.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/qwen/qwen3-30b-a3b-fp8",
      expect.objectContaining({ max_tokens: 1024 }),
    );
  });

  test("skips invalid JSON and OpenAI-shaped Workers AI replies work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => geminiResponse("not json at all")),
    );
    const aiRun = vi.fn(async () => ({
      choices: [{ message: { content: GOOD_JSON } }],
    }));

    const result = await extractSignalsWithLlm(
      fakeEnv({ GEMINI_API_KEY: "k", AI: { run: aiRun } }),
      SAMPLE,
    );

    expect(result?.provider).toBe("workers-ai");
    expect(result?.signals.entityIds.length).toBeGreaterThan(0);
  });

  test("falls through OpenRouter to Groq and returns undefined when all fail", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        return new Response("rate limited", { status: 429 });
      }
      if (url.includes("api.groq.com")) {
        return chatResponse(GOOD_JSON);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const env = fakeEnv({
      OPENROUTER_API_KEY: "or-key",
      GROQ_API_KEY: "groq-key",
    });
    const result = await extractSignalsWithLlm(env, SAMPLE);
    expect(result?.provider).toBe("groq");
    expect(result?.model).toBe("openai/gpt-oss-120b");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(extractSignalsWithLlm(env, SAMPLE)).resolves.toBe(undefined);
  });

  test("honors model overrides from env", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chatResponse(GOOD_JSON)),
    );
    const result = await extractSignalsWithLlm(
      fakeEnv({
        GROQ_API_KEY: "g",
        OPENMEMORY_GROQ_MODEL: "custom/groq-model",
      }),
      SAMPLE,
    );
    expect(result?.model).toBe("custom/groq-model");
  });
});

describe("llm extraction output cleaning", () => {
  test("dedupes entities, enforces caps, and drops unknown relationships", () => {
    const entities = Array.from({ length: 35 }, (_, index) => ({
      name: `Entity ${index}`,
    }));
    entities.push({ name: "Entity 0" });
    const cleaned = cleanExtraction({
      entities,
      relationships: [
        {
          source: "Entity 1",
          relationship: "uses",
          target: "Entity 2",
        },
        {
          source: "Entity 1",
          relationship: "uses",
          target: "Entity 2",
        },
        {
          source: "Entity 1",
          relationship: "blocks",
          target: "Entity 1",
        },
      ],
      tags: ["One", "one", "Two"],
    });

    expect(cleaned?.entityIds).toHaveLength(30);
    expect(cleaned?.entityIds[0]).toBe("entity-0");
    expect(cleaned?.relationships).toHaveLength(1);
    expect(cleaned?.tags).toEqual(["one", "two"]);
  });

  test("accepts fenced or prose-wrapped JSON", () => {
    const fenced = cleanExtraction("```json\n" + GOOD_JSON + "\n```");
    expect(fenced?.entityIds).toContain("carousell");
    const wrapped = cleanExtraction(`Here you go: ${GOOD_JSON} done.`);
    expect(wrapped?.entityIds).toContain("carousell");
  });

  test("rejects garbage and empty payloads", () => {
    expect(cleanExtraction("no json here")).toBe(undefined);
    expect(cleanExtraction({ entities: [], relationships: [], tags: [] })).toBe(
      undefined,
    );
    expect(cleanExtraction(42)).toBe(undefined);
    expect(cleanExtraction(undefined)).toBe(undefined);
  });

  test("pure Chinese entity names get stable non-empty ids", () => {
    const cleaned = cleanExtraction({
      entities: [{ name: "藍田站" }, { name: "藍田站" }, { name: "觀塘站" }],
      relationships: [],
      tags: [],
    });
    expect(cleaned?.entityIds).toHaveLength(2);
    for (const id of cleaned?.entityIds ?? []) {
      expect(id).toMatch(/^entity-[0-9a-f]{8}$/);
    }
  });
});
