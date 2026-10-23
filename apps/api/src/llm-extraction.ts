import type { Env } from "./env";
import { type ExtractedRelationship, entityId } from "./memory-signals";

export type LlmExtractionProvider =
  | "gemini"
  | "workers-ai"
  | "openrouter"
  | "groq";

export type LlmExtractionResult = {
  signals: {
    entityIds: string[];
    relationships: ExtractedRelationship[];
    tags: string[];
  };
  provider: LlmExtractionProvider;
  model: string;
};

const MAX_CONTENT_CHARS = 8_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_ENTITIES = 30;
const MAX_RELATIONSHIPS = 20;
const MAX_TAGS = 20;

const GEMINI_GATEWAY_BASE =
  "https://gateway.ai.cloudflare.com/v1/7b4a06f2fcfaa0169d55051dc7c7eff0/austin-llm-gateway/google-ai-studio";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_WORKERS_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const USER_AGENT = "OpenMemory/1.0";

const ALLOWED_RELATIONSHIPS = new Set<string>([
  "uses",
  "supports",
  "blocks",
  "depends_on",
  "extends",
  "improves",
  "replaces",
]);

const SYSTEM_PROMPT = `You are a memory signal extractor for a personal knowledge graph. Extract entities, relationships and tags from the memory text. The text may mix Cantonese, Traditional Chinese and English. Keep entity names in their original language and script. Output ONLY a JSON object, no explanations, with this exact shape:
{"entities":[{"name":"...","type":"person|place|organization|product|object|concept|other"}],"relationships":[{"source":"<entity name>","relationship":"<verb>","target":"<entity name>"}],"tags":["..."]}
Rules:
- relationship verb MUST be one of: uses, supports, blocks, depends_on, extends, improves, replaces. Only include a relationship when one of these verbs genuinely fits; otherwise omit it.
- source and target must exactly match names in entities.
- tags: at most 8 short lowercase keywords.
- Do not invent facts not present in the text.`;

/**
 * Tries each configured LLM provider in order (Gemini -> Workers AI ->
 * OpenRouter -> Groq) and returns the first usable extraction. Providers
 * without credentials/bindings are skipped. Returns undefined when the LLM
 * layer is disabled (no provider configured) or every provider failed, so
 * callers can fall back to deterministic extraction.
 */
export async function extractSignalsWithLlm(
  env: Env,
  content: string,
): Promise<LlmExtractionResult | undefined> {
  const text = content.slice(0, MAX_CONTENT_CHARS);
  if (!text.trim()) {
    return undefined;
  }

  const providers = buildProviders(env);
  for (const provider of providers) {
    try {
      const raw = await provider.run(text);
      const signals = raw === undefined ? undefined : cleanExtraction(raw);
      if (signals) {
        return { signals, provider: provider.id, model: provider.model };
      }
    } catch {
      // Provider failed (network, timeout, bad response): try the next one.
    }
  }
  return undefined;
}

type ProviderRunner = {
  id: LlmExtractionProvider;
  model: string;
  run: (content: string) => Promise<unknown>;
};

function buildProviders(env: Env): ProviderRunner[] {
  const providers: ProviderRunner[] = [];

  if (env.GEMINI_API_KEY) {
    const model = env.OPENMEMORY_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    const apiKey = env.GEMINI_API_KEY;
    providers.push({
      id: "gemini",
      model,
      run: (content) => runGemini(model, apiKey, content),
    });
  }

  if (env.AI) {
    const model =
      env.OPENMEMORY_CF_EXTRACTION_MODEL ?? DEFAULT_WORKERS_AI_MODEL;
    const ai = env.AI;
    providers.push({
      id: "workers-ai",
      model,
      run: (content) => runWorkersAi(ai, model, content),
    });
  }

  if (env.OPENROUTER_API_KEY) {
    const model = env.OPENMEMORY_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
    const apiKey = env.OPENROUTER_API_KEY;
    providers.push({
      id: "openrouter",
      model,
      run: (content) =>
        runChatCompletions(OPENROUTER_URL, model, apiKey, content, {
          "HTTP-Referer": "https://openmemory.openvm067.space",
          "X-Title": "OpenMemory",
        }),
    });
  }

  if (env.GROQ_API_KEY) {
    const model = env.OPENMEMORY_GROQ_MODEL ?? DEFAULT_GROQ_MODEL;
    const apiKey = env.GROQ_API_KEY;
    providers.push({
      id: "groq",
      model,
      run: (content) =>
        runChatCompletions(GROQ_URL, model, apiKey, content, {}),
    });
  }

  return providers;
}

async function runGemini(
  model: string,
  apiKey: string,
  content: string,
): Promise<unknown> {
  const url = `${GEMINI_GATEWAY_BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: content }] }],
      generationConfig: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseSchema: {
          type: "OBJECT",
          properties: {
            entities: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  type: { type: "STRING" },
                },
                required: ["name"],
              },
            },
            relationships: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  source: { type: "STRING" },
                  relationship: { type: "STRING" },
                  target: { type: "STRING" },
                },
                required: ["source", "relationship", "target"],
              },
            },
            tags: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["entities", "relationships", "tags"],
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed with ${response.status}`);
  }
  const data = (await response.json()) as GeminiResponse;
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  return text || undefined;
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
};

async function runWorkersAi(
  ai: NonNullable<Env["AI"]>,
  model: string,
  content: string,
): Promise<unknown> {
  const run = ai.run(model, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
  }) as Promise<WorkersAiResponse>;
  const guarded = run.catch(() => undefined);
  const response = await raceTimeout(guarded, PROVIDER_TIMEOUT_MS);
  if (!response) {
    return undefined;
  }
  if (typeof response.response === "string") {
    return response.response;
  }
  if (response.response && typeof response.response === "object") {
    return response.response;
  }
  const choice = response.choices?.[0]?.message?.content;
  return typeof choice === "string" ? choice : undefined;
}

type WorkersAiResponse = {
  response?: string | Record<string, unknown>;
  choices?: Array<{ message?: { content?: string } }>;
};

async function runChatCompletions(
  url: string,
  model: string,
  apiKey: string,
  content: string,
  extraHeaders: Record<string, string>,
): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
  });
  if (!response.ok) {
    throw new Error(`Chat completions request failed with ${response.status}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? undefined;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Normalizes raw LLM output into the exact signals shape produced by
 * `extractMemorySignals`. Returns undefined when the payload is unusable or
 * contains neither entities nor tags.
 */
export function cleanExtraction(
  raw: unknown,
): LlmExtractionResult["signals"] | undefined {
  const parsed = parseJsonPayload(raw);
  if (!parsed) {
    return undefined;
  }

  const nameById = new Map<string, string>();
  const entityIds: string[] = [];
  const addEntity = (name: string): string | undefined => {
    const trimmed = name.trim();
    if (!trimmed) {
      return undefined;
    }
    const id = toEntityId(trimmed);
    if (!id) {
      return undefined;
    }
    if (!nameById.has(id)) {
      if (entityIds.length >= MAX_ENTITIES) {
        return undefined;
      }
      nameById.set(id, trimmed);
      entityIds.push(id);
    }
    return id;
  };

  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
  for (const entry of rawEntities) {
    const name =
      typeof entry === "string"
        ? entry
        : isRecord(entry) && typeof entry.name === "string"
          ? entry.name
          : undefined;
    if (name) {
      addEntity(name);
    }
  }

  const relationships: ExtractedRelationship[] = [];
  const seenRelationships = new Set<string>();
  const rawRelationships = Array.isArray(parsed.relationships)
    ? parsed.relationships
    : [];
  for (const entry of rawRelationships) {
    if (relationships.length >= MAX_RELATIONSHIPS) {
      break;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const sourceName =
      typeof entry.source === "string" ? entry.source : undefined;
    const targetName =
      typeof entry.target === "string" ? entry.target : undefined;
    const verb =
      typeof entry.relationship === "string"
        ? entry.relationship.trim().toLowerCase().replace(/\s+/g, "_")
        : undefined;
    if (!sourceName || !targetName || !verb) {
      continue;
    }
    if (!ALLOWED_RELATIONSHIPS.has(verb)) {
      continue;
    }
    const sourceEntityId = addEntity(sourceName);
    const targetEntityId = addEntity(targetName);
    if (
      !sourceEntityId ||
      !targetEntityId ||
      sourceEntityId === targetEntityId
    ) {
      continue;
    }
    const key = `${sourceEntityId}:${verb}:${targetEntityId}`;
    if (seenRelationships.has(key)) {
      continue;
    }
    seenRelationships.add(key);
    relationships.push({
      source: nameById.get(sourceEntityId) ?? sourceName.trim(),
      sourceEntityId,
      target: nameById.get(targetEntityId) ?? targetName.trim(),
      targetEntityId,
      relationship: verb as ExtractedRelationship["relationship"],
    });
  }

  const tags: string[] = [];
  const seenTags = new Set<string>();
  const rawTags = Array.isArray(parsed.tags) ? parsed.tags : [];
  for (const entry of rawTags) {
    if (tags.length >= MAX_TAGS) {
      break;
    }
    if (typeof entry !== "string") {
      continue;
    }
    const tag = entry.trim().toLowerCase().slice(0, 80);
    if (!tag || seenTags.has(tag)) {
      continue;
    }
    seenTags.add(tag);
    tags.push(tag);
  }

  if (entityIds.length === 0 && tags.length === 0) {
    return undefined;
  }
  return { entityIds, relationships, tags };
}

function parseJsonPayload(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) {
    return raw;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    text = fence[1].trim();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Uses the shared `entityId` normalization. Names with no [a-z0-9] characters
 * at all (for example pure Chinese names) collapse to an empty id under that
 * normalization, so they fall back to a stable hash id to stay linkable.
 */
function toEntityId(name: string): string {
  const normalized = entityId(name);
  if (normalized) {
    return normalized;
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `entity-${hash.toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
