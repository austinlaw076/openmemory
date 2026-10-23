import { normalizeTenantId } from "@openmemory/core";
import { describe, expect, test } from "vitest";
import { getApiTokenStatus, resolveRequestTenant } from "../src/auth";
import type { Env } from "../src/env";

const API_TOKEN = "unit-test-api-token";
const TENANT_HEADER = { "x-openmemory-user-id": "Alice Example" };
const PRODUCTION_URL = "https://openmemory.example.com/v1/profile";
const LOCAL_URL = "http://localhost:8787/v1/profile";

function envWith(partial: Record<string, unknown>): Env {
  return partial as unknown as Env;
}

function request(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe("getApiTokenStatus", () => {
  test("is disabled when no token is configured", () => {
    const env = envWith({});
    expect(getApiTokenStatus(env, new Headers())).toBe("disabled");
    expect(
      getApiTokenStatus(
        env,
        new Headers({ authorization: `Bearer ${API_TOKEN}` }),
      ),
    ).toBe("disabled");
  });

  test("is absent when a token is configured but no bearer is sent", () => {
    const env = envWith({ OPENMEMORY_API_TOKEN: API_TOKEN });
    expect(getApiTokenStatus(env, new Headers())).toBe("absent");
    expect(getApiTokenStatus(env, new Headers({ cookie: "session=1" }))).toBe(
      "absent",
    );
  });

  test("matches only the exact bearer token", () => {
    const env = envWith({ OPENMEMORY_API_TOKEN: API_TOKEN });
    expect(
      getApiTokenStatus(
        env,
        new Headers({ authorization: `Bearer ${API_TOKEN}` }),
      ),
    ).toBe("matched");
    expect(
      getApiTokenStatus(
        env,
        new Headers({ authorization: "Bearer wrong-token" }),
      ),
    ).toBe("mismatch");
    expect(
      getApiTokenStatus(
        env,
        new Headers({ authorization: `Token ${API_TOKEN}` }),
      ),
    ).toBe("mismatch");
  });
});

describe("resolveRequestTenant", () => {
  test("accepts a matching API token with a tenant header on any host", async () => {
    const env = envWith({ OPENMEMORY_API_TOKEN: API_TOKEN });
    const req = request(PRODUCTION_URL, {
      ...TENANT_HEADER,
      authorization: `Bearer ${API_TOKEN}`,
    });
    const resolved = await resolveRequestTenant(env, req, req.headers);
    expect(resolved).toMatchObject({
      principal: "api-token",
      tenantId: normalizeTenantId("Alice Example"),
    });
  });

  test("rejects a wrong bearer token on production instead of downgrading to header tenant", async () => {
    const env = envWith({ OPENMEMORY_API_TOKEN: API_TOKEN });
    const req = request(PRODUCTION_URL, {
      ...TENANT_HEADER,
      authorization: "Bearer wrong-token",
    });
    const resolved = await resolveRequestTenant(env, req, req.headers);
    expect(resolved).toMatchObject({ error: "unauthorized" });
  });

  test("rejects a wrong bearer token on localhost too (fail closed)", async () => {
    const env = envWith({ OPENMEMORY_API_TOKEN: API_TOKEN });
    const req = request(LOCAL_URL, {
      ...TENANT_HEADER,
      authorization: "Bearer wrong-token",
    });
    const resolved = await resolveRequestTenant(env, req, req.headers);
    expect(resolved).toMatchObject({ error: "unauthorized" });
  });

  test("keeps production header tenant disabled when the token is configured but absent", async () => {
    const env = envWith({ OPENMEMORY_API_TOKEN: API_TOKEN });
    const req = request(PRODUCTION_URL, { ...TENANT_HEADER });
    const resolved = await resolveRequestTenant(env, req, req.headers);
    expect(resolved).toMatchObject({ error: "header_tenant_disabled" });
  });

  test("keeps production header tenant disabled when no token is configured", async () => {
    const env = envWith({});
    const req = request(PRODUCTION_URL, { ...TENANT_HEADER });
    const resolved = await resolveRequestTenant(env, req, req.headers);
    expect(resolved).toMatchObject({ error: "header_tenant_disabled" });
  });

  test("keeps localhost header tenant working when no token is configured", async () => {
    const env = envWith({});
    const req = request(LOCAL_URL, { ...TENANT_HEADER });
    const resolved = await resolveRequestTenant(env, req, req.headers);
    expect(resolved).toMatchObject({
      principal: "header",
      tenantId: normalizeTenantId("Alice Example"),
    });
  });

  test("requires the tenant header even when the API token matches", async () => {
    const env = envWith({ OPENMEMORY_API_TOKEN: API_TOKEN });
    const req = request(PRODUCTION_URL, {
      authorization: `Bearer ${API_TOKEN}`,
    });
    const resolved = await resolveRequestTenant(env, req, req.headers);
    expect(resolved).toMatchObject({ error: "missing_tenant" });
  });
});
