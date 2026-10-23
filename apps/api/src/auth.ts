import { normalizeTenantId } from "@openmemory/core";
import { resolveOpenMemorySession } from "./better-auth";
import type { Env } from "./env";

const USER_HEADER = "x-openmemory-user-id";

export type HeaderSource = Headers | Record<string, string | undefined>;

export type TenantResolution =
  | { tenantId: string }
  | { error: string; message?: string };

export function resolveTenant(
  headers: HeaderSource,
  options: { allowHeaderTenant?: boolean } = {},
): TenantResolution {
  if (options.allowHeaderTenant === false) {
    return {
      error: "header_tenant_disabled" as const,
      message:
        "Header tenant mode is available only for local development. Use OAuth-backed identity outside localhost.",
    };
  }

  const rawTenant =
    getHeader(headers, USER_HEADER) ?? getHeader(headers, "x-user-id");

  if (!rawTenant) {
    return {
      error: "missing_tenant" as const,
      message: `Pass ${USER_HEADER} for local development. API key auth will replace this header in production.`,
    };
  }

  const tenantId = normalizeTenantId(rawTenant);
  if (!tenantId) {
    return { error: "invalid_tenant" as const };
  }

  return { tenantId };
}

export type ApiTokenStatus = "absent" | "disabled" | "matched" | "mismatch";

/**
 * The API token is an additional accepted credential, never a gate: when it
 * is not configured the channel is disabled, and requests that do not carry
 * it fall back to the existing session / header-tenant behavior unchanged.
 */
export function getApiTokenStatus(
  env: Env,
  headers: HeaderSource,
): ApiTokenStatus {
  const configured = env.OPENMEMORY_API_TOKEN;
  if (!configured) {
    return "disabled";
  }

  const authorization = getHeader(headers, "authorization");
  if (!authorization) {
    return "absent";
  }

  return timingSafeEqual(authorization, `Bearer ${configured}`)
    ? "matched"
    : "mismatch";
}

export type RequestTenantResolution =
  | {
      tenantId: string;
      principal: "api-token" | "header" | "session";
      sessionTenant: { tenantId: string } | undefined;
    }
  | { error: string; message?: string };

/**
 * Resolves the tenant for a REST request. Precedence:
 * 1. A matching API token authenticates the request on any host; the tenant
 *    comes from the tenant header.
 * 2. A Better Auth session cookie identifies the tenant as before.
 * 3. A present-but-wrong bearer token with no valid session fails closed
 *    with 401 instead of downgrading to header-tenant mode.
 * 4. Otherwise the legacy rule applies: header tenant only on localhost.
 */
export async function resolveRequestTenant(
  env: Env,
  request: Request,
  headers: HeaderSource,
): Promise<RequestTenantResolution> {
  const tokenStatus = getApiTokenStatus(env, headers);

  if (tokenStatus === "matched") {
    const tenant = resolveTenant(headers, { allowHeaderTenant: true });
    if ("error" in tenant) {
      return tenant;
    }
    return {
      tenantId: tenant.tenantId,
      principal: "api-token",
      sessionTenant: undefined,
    };
  }

  const sessionTenant = await resolveSessionTenant(env, request);
  if (sessionTenant) {
    return {
      tenantId: sessionTenant.tenantId,
      principal: "session",
      sessionTenant,
    };
  }

  if (tokenStatus === "mismatch") {
    return {
      error: "unauthorized",
      message: "Pass a valid bearer token.",
    };
  }

  const tenant = resolveTenant(headers, {
    allowHeaderTenant: isLocalDevelopmentRequest(request),
  });
  if ("error" in tenant) {
    return tenant;
  }
  return {
    tenantId: tenant.tenantId,
    principal: "header",
    sessionTenant: undefined,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return diff === 0;
}

export const getGraph = (env: Env, tenantId: string) => {
  const id = env.MEMORY_GRAPHS.idFromName(tenantId);
  return env.MEMORY_GRAPHS.get(id);
};

export async function resolveSessionTenant(env: Env, request: Request) {
  try {
    const session = await resolveOpenMemorySession(env, request);
    const rawTenant = session?.user?.id;
    const tenantId =
      typeof rawTenant === "string" ? normalizeTenantId(rawTenant) : undefined;

    return tenantId ? { tenantId } : undefined;
  } catch {
    return undefined;
  }
}

export function isLocalDevelopmentRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function getHeader(headers: HeaderSource, name: string) {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()];
}
