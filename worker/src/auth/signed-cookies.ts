/**
 * HMAC-signed cookies for the dashboard session and the GitHub sign-in round trip.
 *
 * Cookies use the `__Host-` prefix (Secure, host-only, Path=/), HttpOnly and
 * SameSite=Lax. Values are `<base64url JSON>.<base64url HMAC-SHA256>` keyed by
 * SESSION_SECRET; anything unsigned, tampered or expired reads as absent.
 */

import { base64UrlToBytes, bytesToBase64Url } from "../accounts/base64.js";
import { tokensMatch } from "../http-guards.js";

export const SESSION_COOKIE = "__Host-multix-session";
export const LOGIN_COOKIE = "__Host-multix-login";
/**
 * Dashboard sessions last a week; every request re-checks the allowlist and
 * the account's session version, so signing out ends them server-side.
 */
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
/** Time allowed to finish the GitHub sign-in round trip. */
export const LOGIN_TTL_SECONDS = 10 * 60;

const encoder = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))),
  );
}

interface Envelope<T> {
  /** Purpose, so a sign-in cookie can never be replayed as a session. */
  p: string;
  /** Expiry, Unix seconds. */
  e: number;
  d: T;
}

export async function sign<T>(
  secret: string,
  purpose: string,
  data: T,
  ttlSeconds: number,
  now = Date.now(),
): Promise<string> {
  const envelope: Envelope<T> = { p: purpose, e: Math.floor(now / 1000) + ttlSeconds, d: data };
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(envelope)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verify<T>(
  secret: string,
  purpose: string,
  value: string | undefined,
  now = Date.now(),
): Promise<T | undefined> {
  if (!value) return undefined;
  const dot = value.indexOf(".");
  if (dot < 1) return undefined;
  const body = value.slice(0, dot);
  if (!(await tokensMatch(value.slice(dot + 1), await hmac(secret, body)))) return undefined;
  try {
    const envelope = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as Envelope<T>;
    if (envelope.p !== purpose || envelope.e <= Math.floor(now / 1000)) return undefined;
    return envelope.d;
  } catch {
    return undefined;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export interface Session {
  userId: string;
  /** The account's sessionVersion when the session was issued. */
  v: number;
}

export function readSession(request: Request, secret: string): Promise<Session | undefined> {
  return verify<Session>(secret, "session", readCookie(request, SESSION_COOKIE));
}

export async function sessionCookie(secret: string, session: Session): Promise<string> {
  return setCookie(
    SESSION_COOKIE,
    await sign(secret, "session", session, SESSION_TTL_SECONDS),
    SESSION_TTL_SECONDS,
  );
}

/**
 * CSRF token for dashboard forms, bound to the signed-in account and its
 * session version, so tokens from before a sign-out stop working.
 */
export function csrfToken(secret: string, userId: string, sessionVersion: number): Promise<string> {
  return hmac(secret, `csrf:${userId}:${sessionVersion}`);
}

export async function csrfValid(
  secret: string,
  userId: string,
  sessionVersion: number,
  given: unknown,
): Promise<boolean> {
  return (
    typeof given === "string" &&
    given.length > 0 &&
    tokensMatch(given, await csrfToken(secret, userId, sessionVersion))
  );
}
