import type { SearchResult } from "@openmemory/core";
import { describe, expect, test } from "vitest";
import type { Env } from "../src/env";
import { rerankSearchResults } from "../src/recall";

describe("recall reranking", () => {
  test("applies reranker score order for known candidates", async () => {
    const memories = makeResults(["mem_a", "mem_b", "mem_c"]);
    const calls: Array<{ model: unknown; input: unknown }> = [];
    const env = makeEnv({
      run: async (model, input) => {
        calls.push({ model, input });
        return {
          response: [
            { id: 2, score: 0.91 },
            { id: 0, score: 0.42 },
          ],
        };
      },
    });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual([
      "mem_c",
      "mem_a",
      "mem_b",
    ]);
    expect(results[0]?.metadata.rerank).toEqual({
      status: "applied",
      model: "@cf/test/reranker",
    });
    expect(calls).toEqual([
      {
        model: "@cf/test/reranker",
        input: {
          query: "launch owner",
          contexts: [
            { text: "Memory mem_a" },
            { text: "Memory mem_b" },
            { text: "Memory mem_c" },
          ],
          top_k: 3,
        },
      },
    ]);
  });

  test("sorts unsorted reranker scores from high to low", async () => {
    const memories = makeResults(["mem_a", "mem_b", "mem_c"]);
    const env = makeEnv({
      run: async () => ({
        response: [
          { id: 0, score: 0.1 },
          { id: 2, score: 0.9 },
          { id: 1, score: 0.5 },
        ],
      }),
    });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual([
      "mem_c",
      "mem_b",
      "mem_a",
    ]);
  });

  test("reads rankings wrapped in a result envelope", async () => {
    const memories = makeResults(["mem_a", "mem_b"]);
    const env = makeEnv({
      run: async () => ({
        result: {
          response: [
            { id: 1, score: 0.87 },
            { id: 0, score: 0.12 },
          ],
        },
      }),
    });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual(["mem_b", "mem_a"]);
    expect(results[0]?.metadata.rerank).toEqual({
      status: "applied",
      model: "@cf/test/reranker",
    });
  });

  test("ignores duplicate, negative, and out-of-range indexes", async () => {
    const memories = makeResults(["mem_a", "mem_b", "mem_c"]);
    const env = makeEnv({
      run: async () => ({
        response: [
          { id: 99, score: 0.99 },
          { id: 1, score: 0.8 },
          { id: 1, score: 0.7 },
          { id: -1, score: 0.6 },
          { id: 0, score: 0.5 },
        ],
      }),
    });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual([
      "mem_b",
      "mem_a",
      "mem_c",
    ]);
  });

  test("falls back to deterministic order when the model errors", async () => {
    const memories = makeResults(["mem_a", "mem_b", "mem_c"]);
    const env = makeEnv({
      run: async () => {
        throw new Error("workers ai unavailable");
      },
    });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual([
      "mem_a",
      "mem_b",
      "mem_c",
    ]);
    expect(results[0]?.metadata.rerank).toEqual({ status: "empty" });
  });

  test("falls back to deterministic order on an empty ranking", async () => {
    const memories = makeResults(["mem_a", "mem_b", "mem_c"]);
    const env = makeEnv({ run: async () => ({ response: [] }) });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual([
      "mem_a",
      "mem_b",
      "mem_c",
    ]);
    expect(results[0]?.metadata.rerank).toEqual({ status: "empty" });
  });

  test("falls back to deterministic order when output is malformed", async () => {
    const memories = makeResults(["mem_a", "mem_b", "mem_c"]);
    const env = makeEnv({ run: async () => ({ response: "not rankings" }) });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual([
      "mem_a",
      "mem_b",
      "mem_c",
    ]);
    expect(results[0]?.metadata.rerank).toEqual({ status: "empty" });
  });

  test("times out to deterministic order when the model is slow", async () => {
    const memories = makeResults(["mem_a", "mem_b", "mem_c"]);
    const env = makeEnv({
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { response: [{ id: 2, score: 0.9 }] };
      },
      timeoutMs: "10",
    });

    const results = await rerankSearchResults(env, "launch owner", memories);

    expect(results.map((result) => result.id)).toEqual([
      "mem_a",
      "mem_b",
      "mem_c",
    ]);
    expect(results[0]?.metadata.rerank).toEqual({ status: "empty" });
  });

  test("skips reranking without an explicit model", async () => {
    const memories = makeResults(["mem_a", "mem_b"]);

    const results = await rerankSearchResults({} as Env, "launch", memories);

    expect(results.map((result) => result.id)).toEqual(["mem_a", "mem_b"]);
    expect(results[0]?.metadata.rerank).toEqual({ status: "skipped" });
  });
});

type RunFn = (model: string, input: unknown) => Promise<unknown>;

function makeEnv(options: { run: RunFn; timeoutMs?: string }): Env {
  return {
    AI: {
      run: options.run,
    },
    EMBEDDING_MODEL: "@cf/test/embedding",
    OPENMEMORY_RERANK_MODEL: "@cf/test/reranker",
    ...(options.timeoutMs
      ? { OPENMEMORY_RERANK_TIMEOUT_MS: options.timeoutMs }
      : {}),
  } as unknown as Env;
}

function makeResults(ids: string[]): SearchResult[] {
  return ids.map((id, index) => ({
    id,
    content: `Memory ${id}`,
    source: "test",
    tags: [],
    metadata: {},
    type: "fact",
    status: "active",
    isLatest: true,
    confidence: 0.8,
    importance: 0.5,
    entityIds: [],
    score: 1 - index * 0.1,
    reason: "keyword",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  }));
}
