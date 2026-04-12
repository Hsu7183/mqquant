import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://hsu7183.github.io",
  "null",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function getAllowedOrigins() {
  const raw = Deno.env.get("LOGIN_AUDIT_ALLOWED_ORIGINS") || "";
  if (!raw.trim()) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAllowedOrigin(origin: string | null) {
  const allowedOrigins = getAllowedOrigins();
  if (!origin) return allowedOrigins.includes("*") ? "*" : "";
  if (allowedOrigins.includes("*")) return "*";
  if (allowedOrigins.includes(origin)) return origin;
  if (origin === "null" && allowedOrigins.includes("null")) return "null";
  return "";
}

function corsHeaders(origin: string | null) {
  const allowedOrigin = resolveAllowedOrigin(origin);
  return {
    "Access-Control-Allow-Origin": allowedOrigin || "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function asText(value: unknown, max = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function asInt(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.trunc(num));
}

function asIso(value: unknown) {
  const text = asText(value, 64);
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function firstIp(req: Request) {
  const forwarded =
    req.headers.get("x-forwarded-for") ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "";

  const ip = forwarded.split(",")[0]?.trim();
  return ip || null;
}

function maskIp(ip: string | null) {
  if (!ip) return "";

  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }

  if (ip.includes(":")) {
    const parts = ip.split(":").filter(Boolean);
    return `${parts.slice(0, 4).join(":")}:****`;
  }

  return ip;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  if (origin && !resolveAllowedOrigin(origin)) {
    return json(origin, { ok: false, error: "origin_not_allowed" }, 403);
  }

  if (req.method !== "POST") {
    return json(origin, { ok: false, error: "method_not_allowed" }, 405);
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json(origin, { ok: false, error: "invalid_json" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json(origin, { ok: false, error: "missing_server_env" }, 500);
  }

  const payload = body as Record<string, unknown>;
  const ipAddress = firstIp(req);
  const maskedIp = maskIp(ipAddress);
  const nowIso = new Date().toISOString();

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const insertPayload = {
    event_type: asText(payload.eventType, 40) || "login_failure",
    reason: asText(payload.reason, 120),
    fail_count: asInt(payload.failCount),
    lock_until: asIso(payload.lockUntil),
    client_reported_at: asIso(payload.clientReportedAt),
    client_origin: asText(payload.clientOrigin, 200),
    client_host: asText(payload.clientHost, 200),
    page_path: asText(payload.pagePath, 300),
    page_href: asText(payload.pageHref, 500),
    masked_ip: maskedIp,
    ip_address: ipAddress,
    user_agent: req.headers.get("user-agent") || asText(payload.userAgent, 500),
    request_headers: {
      origin,
      referer: req.headers.get("referer"),
      "x-forwarded-for": req.headers.get("x-forwarded-for"),
      "cf-connecting-ip": req.headers.get("cf-connecting-ip"),
      "x-real-ip": req.headers.get("x-real-ip"),
    },
    payload,
  };

  const { data, error } = await supabase
    .from("login_attempt_audit")
    .insert(insertPayload)
    .select("id, created_at")
    .single();

  if (error) {
    return json(origin, { ok: false, error: "insert_failed" }, 500);
  }

  return json(origin, {
    ok: true,
    auditId: data?.id ?? null,
    loggedAt: data?.created_at || nowIso,
    maskedIp,
  });
});
