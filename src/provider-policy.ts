import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ProviderPolicy {
  hostAllowlist: ReadonlySet<string>;
  allowPrivateHosts: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = normalizeHost(address);
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0);
  }
  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("2001:db8")) return true;
    if (normalized.startsWith("::ffff:")) return isPrivateOrReservedAddress(normalized.slice(7));
    return !/^[23]/.test(normalized);
  }
  return true;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

export async function validateProviderBaseUrl(rawUrl: string, policy: ProviderPolicy): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Provider URL is invalid");
  }
  const hostname = normalizeHost(url.hostname);
  const secureProtocol = url.protocol === "https:";
  if (!secureProtocol && !(policy.allowPrivateHosts && url.protocol === "http:")) {
    throw new Error("Provider URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Provider URL must not contain credentials, query, or fragment");
  if (!hostname) throw new Error("Provider URL requires a hostname");
  if (policy.hostAllowlist.size > 0 && !policy.hostAllowlist.has(hostname)) throw new Error("Provider hostname is not allowed");
  if (!policy.allowPrivateHosts) {
    const addresses = isIP(hostname) ? [hostname] : await (policy.resolve ?? defaultResolve)(hostname);
    if (addresses.length === 0 || addresses.some(isPrivateOrReservedAddress)) throw new Error("Provider hostname must resolve only to public addresses");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export async function buildProviderUrl(baseUrl: string, endpoint: "responses" | "chat/completions" | "models", policy: ProviderPolicy): Promise<string> {
  const validated = await validateProviderBaseUrl(baseUrl, policy);
  return `${validated}/${endpoint}`;
}
