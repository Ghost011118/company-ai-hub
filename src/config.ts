import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/company-ai-hub.sqlite"),
  APP_ENCRYPTION_KEY: z.string().min(1),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).max(256).optional(),
  ADMIN_DISPLAY_NAME: z.string().min(1).max(120).default("Administrator"),
  PROVIDER_HOST_ALLOWLIST: z.string().optional(),
  ALLOW_PRIVATE_PROVIDER_HOSTS: z.enum(["true", "false"]).default("false"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  GATEWAY_BEARER_TOKEN: z.string().min(24).max(4_096).optional(),
  GATEWAY_AUTH_DISABLED: z.enum(["true", "false"]).default("false"),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
});

export interface AppConfig {
  environment: "development" | "test" | "production";
  port: number;
  databasePath: string;
  encryptionKey: Buffer;
  adminEmail?: string;
  adminPassword?: string;
  adminDisplayName: string;
  providerHostAllowlist: ReadonlySet<string>;
  allowPrivateProviderHosts: boolean;
  sessionTtlMs: number;
  trustProxyHops: number;
  gatewayBearerToken?: string;
  gatewayAuthDisabled: boolean;
  sessionCookieSecure: boolean;
}

export function parseEncryptionKey(value: string): Buffer {
  const encoding = /^[a-f\d]{64}$/i.test(value) ? "hex" : "base64";
  const key = Buffer.from(value, encoding);
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must encode exactly 32 bytes");
  }
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const config: AppConfig = {
    environment: parsed.NODE_ENV,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    encryptionKey: parseEncryptionKey(parsed.APP_ENCRYPTION_KEY),
    adminDisplayName: parsed.ADMIN_DISPLAY_NAME,
    providerHostAllowlist: new Set(
      (parsed.PROVIDER_HOST_ALLOWLIST ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
    allowPrivateProviderHosts:
      parsed.ALLOW_PRIVATE_PROVIDER_HOSTS === "true" && parsed.NODE_ENV !== "production",
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 60 * 60 * 1000,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    gatewayAuthDisabled: parsed.GATEWAY_AUTH_DISABLED === "true" && parsed.NODE_ENV !== "production",
    sessionCookieSecure: parsed.SESSION_COOKIE_SECURE === undefined ? parsed.NODE_ENV === "production" : parsed.SESSION_COOKIE_SECURE === "true",
  };
  if (parsed.ADMIN_EMAIL !== undefined) config.adminEmail = parsed.ADMIN_EMAIL.toLowerCase();
  if (parsed.ADMIN_PASSWORD !== undefined) config.adminPassword = parsed.ADMIN_PASSWORD;
  if (parsed.GATEWAY_BEARER_TOKEN !== undefined) config.gatewayBearerToken = parsed.GATEWAY_BEARER_TOKEN;
  if (parsed.NODE_ENV === "production" && (!config.gatewayBearerToken || parsed.GATEWAY_AUTH_DISABLED === "true")) {
    throw new Error("GATEWAY_BEARER_TOKEN is required and gateway auth cannot be disabled in production");
  }
  if (!config.gatewayBearerToken && !config.gatewayAuthDisabled) {
    throw new Error("Set GATEWAY_BEARER_TOKEN or explicitly set GATEWAY_AUTH_DISABLED=true for local development/test");
  }
  return config;
}
