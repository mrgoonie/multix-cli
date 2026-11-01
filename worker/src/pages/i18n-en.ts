/**
 * English UI strings of the HTML pages, and the shape every language follows.
 * Plain strings are trusted static markup; function entries escape whatever
 * they interpolate. User and provider data never goes through this table.
 */

import { escapeHtml } from "../http-responses.js";
import type { NoticeCode } from "./notice-codes.js";

/** A link lifetime in the largest whole unit, e.g. "7 days" or "90 minutes". */
function durationText(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

export const EN = {
  langName: "English",
  skipToContent: "Skip to content",
  brandTag: "MCP",
  tagline: "The multimodal layer for AI agents.",
  prefs: {
    theme: "Theme",
    language: "Language",
    auto: "Auto",
    light: "Light",
    dark: "Dark",
  },
  nav: {
    label: "Dashboard",
    overview: "Overview",
    providerKeys: "Provider keys",
    storage: "R2 storage",
    apiKeys: "API keys",
    clients: "Connected clients",
    apiDocs: "API docs",
    dashboard: "Dashboard",
    openapi: "OpenAPI JSON",
    endpoints: "Endpoints",
    gettingStarted: "Getting started",
  },
  account: {
    signedInAs: "Signed in as",
    signOut: "Sign out",
    signOutTitle: "Ends the dashboard session on every device",
  },
  signIn: {
    title: "multix MCP dashboard",
    heading: "Your keys, <em>your agents</em>.",
    body: "Sign in with GitHub to save the provider keys your MCP clients use and to see which clients are connected. Access is limited to invited accounts.",
    button: "Sign in with GitHub",
  },
  overview: {
    title: "multix MCP dashboard",
    eyebrow: "MCP dashboard",
    welcome: (login: string) => `Welcome, <em>${escapeHtml(login)}</em>`,
    lede: "One remote MCP server for image, video, speech and music. Bring your own provider keys; your agents call them through multix.",
    setupHeading: "Get set up",
    done: "Done",
    todo: "To do",
    stepSignIn: "Sign in with GitHub",
    stepSignInLocal: "Sign in",
    stepSignInDone: (login: string) => `Signed in as <strong>${escapeHtml(login)}</strong>.`,
    stepKey: "Add a provider key",
    stepKeyDone: (n: number) => `${n} ${n === 1 ? "provider is" : "providers are"} ready.`,
    stepKeyTodo: "Your MCP requests use your own keys. Add one for at least one provider.",
    stepKeyLink: "Add a key",
    stepConnect: "Paste the MCP URL into your client",
    stepConnectBody:
      "Add this remote MCP server URL in Claude, Cursor, VS Code or another client. It opens this site to sign in and approve the connection.",
    stepConnectDone: (n: number) => `${n} ${n === 1 ? "client is" : "clients are"} connected.`,
    mcpUrlLabel: "MCP server URL",
    claudeCode: "Claude Code:",
    claudeCodeLabel: "Claude Code command",
    statusHeading: "Provider status",
    statusReady: "Ready",
    statusNotSet: "Not set",
    statusSummary: (ready: number, total: number) => `${ready} of ${total} providers ready`,
    statProviders: "Providers ready",
    statStorage: "R2 storage",
    statStorageOn: "Configured",
    statStorageOff: "Not configured",
    statApiKeys: "API keys",
    statClients: "Connected clients",
  },
  providerKeys: {
    heading: "Provider keys",
    intro:
      "Keys are encrypted at rest and used only for your own MCP requests. Saved values are never shown again. Changes can take up to a minute to reach every region.",
    getKey: "Get a key",
    savedCount: (n: number) => `${n} saved`,
    notSet: "Not set",
    savedAt: (date: string) => `Saved ${escapeHtml(date)}`,
    remove: "Remove",
    save: "Save",
    replace: "Replace the saved value",
    paste: "Paste value",
    apiKey: "API key",
    alternative: (primary: string) =>
      `Alternative name, read only when ${escapeHtml(primary)} is not set`,
    labels: {
      REPLICATE_API_TOKEN: "API token",
      RUNWAYML_API_SECRET: "API secret",
      CLOUDFLARE_ACCOUNT_ID: "Account ID",
      CLOUDFLARE_API_TOKEN: "API token (Workers AI permission)",
      CLOUDFLARE_AI_GATEWAY_ID: "AI Gateway ID (optional)",
      TOPVIEW_UID: "Topview UID (account id sent with the key)",
    } as Record<string, string>,
  },
  storage: {
    heading: "Output storage",
    intro:
      'Your own bucket for files your MCP jobs create: Cloudflare R2 (give the account ID) or any S3-compatible service such as AWS S3, Backblaze B2 or MinIO (give its public https endpoint instead). Use credentials with object read and write access on this bucket. Saving lists the bucket and writes, then deletes, an empty <span class="mono">.multix-probe-*</span> object; nothing is saved if a check fails. Saved credentials are encrypted and never shown again.',
    notConfigured: "Not configured",
    notConfiguredBody:
      "File outputs of MCP jobs need a bucket; without one only text output and provider URLs are returned.",
    configured: "Configured",
    bucketLine: (bucket: string, prefix: string) =>
      `Bucket <span class="mono">${escapeHtml(bucket)}</span>, directory <span class="mono">${escapeHtml(prefix)}/</span>`,
    publicLinks: (url: string) =>
      `Outputs get public URLs under <span class="mono">${escapeHtml(url)}</span>.`,
    presignedLinks: (seconds: number) =>
      `Outputs get presigned links valid for ${durationText(seconds)}. multix never deletes outputs; set a lifecycle rule on the bucket to expire them.`,
    r2Line: "Cloudflare R2.",
    endpointLine: (host: string) =>
      `S3-compatible endpoint <span class="mono">${escapeHtml(host)}</span>.`,
    remove: "Remove",
    accountId: "Cloudflare account ID (R2; leave blank when you give an endpoint)",
    endpoint: "S3-compatible endpoint (other services; https, public host name, no path)",
    region: "Region (endpoint only; default us-east-1)",
    addressing: "Bucket addressing (endpoint only)",
    addressingPath: "Path-style (https://host/bucket/key)",
    addressingVirtual: "Virtual-hosted (https://bucket.host/key)",
    linkExpiry: (max: number) =>
      `Presigned link lifetime in seconds (optional, 60–${max}, default ${max} = 7 days)`,
    accessKeyId: "Access key ID",
    secretAccessKey: "Secret access key",
    bucket: "Bucket name",
    prefix: (fallback: string) =>
      `Directory path (optional, default <span class="mono">${escapeHtml(fallback)}</span>; outputs go to <span class="mono">&lt;path&gt;/&lt;account&gt;/&lt;job&gt;/</span>)`,
    publicBaseUrl: "Public base URL (optional, https custom domain or r2.dev)",
    checkAndSave: "Check and save",
    checkAndReplace: "Check and replace",
  },
  apiKeys: {
    heading: "API keys",
    intro: (origin: string) =>
      `For the REST API (<a href="/api/docs">reference</a>, base URL <span class="mono">${escapeHtml(origin)}/api/v1</span>). A key acts as your account: it can change provider keys and storage and run jobs. Only a hash is stored. A revoked key can keep working for up to a minute.`,
    none: "No API keys yet.",
    created: (date: string) => `Created ${escapeHtml(date)}`,
    revoke: "Revoke",
    namePlaceholder: "Key name, e.g. laptop or CI",
    nameLabel: "Key name",
    create: "Create API key",
    limit: (max: number) => `You have the maximum of ${max} keys; revoke one to create another.`,
    newHeading: (name: string) => `API key created: ${escapeHtml(name)}`,
    newBody:
      "Copy it now. It is shown only once; if you lose it, revoke it and create another. Do not reload this page: that sends the form again and creates another key.",
    newLabel: "New API key",
  },
  clients: {
    heading: "Connected MCP clients",
    none: "No MCP clients are connected yet.",
    connectedAt: (date: string) => `Connected ${escapeHtml(date)}`,
    disconnect: "Disconnect",
  },
  consent: {
    title: (client: string) => `Authorize ${client}`,
    heading: (client: string) => `Allow <em>${escapeHtml(client)}</em> to use multix?`,
    publishedBy: (domain: string) => `Published by <strong>${escapeHtml(domain)}</strong>.`,
    unverified: "This app registered itself; its name is not verified.",
    sendsTo: (host: string) => `Access will be sent to <strong>${escapeHtml(host)}</strong>.`,
    loopback:
      "<strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.",
    costs:
      "It will be able to generate images and videos with the provider keys saved in your account, which may cost money at those providers.",
    scopes: "Scopes:",
    notYou: (login: string) =>
      `Signed in as <strong>${escapeHtml(login)}</strong>. Not you? <a href="/dashboard">Open the dashboard</a> and sign out first.`,
    allow: "Allow",
    deny: "Deny",
  },
  apiDocs: {
    title: "multix REST API",
    heading: "multix <em>REST API</em>",
    baseUrl: "Base URL",
    spec: "machine-readable spec:",
    createKeys: "create keys in",
    exportLabel: "export command",
    exportCommand: "export MULTIX_API_KEY='paste the key from /dashboard here'",
    errors:
      'Errors are JSON: <span class="mono">{"error":{"code":"bad_request","message":"…"}}</span>. Requests share the per-account rate limit of the MCP endpoint.',
    endpoints: "Endpoints",
    example: (operation: string) => `${operation} example`,
  },
  copy: {
    copy: (label: string) => `Copy ${label}`,
    title: "Copy",
    copied: "Copied",
    failed: "Copy failed: the text is selected, copy it by hand",
  },
  localAuth: {
    loginTitle: "Sign in to multix MCP",
    loginHeading: "Sign in",
    loginBody: "Sign in with the username and password of your account on this server.",
    username: "Username",
    password: "Password",
    signIn: "Sign in",
    withGithub: "Sign in with GitHub",
    invalidCredentials: "Incorrect username or password.",
    needsSetup: "No admin account exists yet.",
    setupLink: "Create the admin account",
    setupTitle: "Create the admin account",
    setupBody:
      "This page works once. Enter the bootstrap token from the server's configuration or start-up log, then choose the admin's username and password.",
    bootstrapToken: "Bootstrap token",
    confirmPassword: "Confirm password",
    usernameHint:
      "3–32 lower-case letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
    passwordHint: "12–256 characters.",
    createAdmin: "Create admin and sign in",
    badToken: "The bootstrap token is not valid.",
    badUsername:
      "The username must be 3–32 lower-case letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
    badPassword: "The password must be 12–256 characters.",
    passwordMismatch: "The passwords do not match.",
  },
  messages: {
    back: "Back to the dashboard",
    authorizationFailed: "Authorization failed",
    unverifiedApp: "This app could not be verified.",
    signedOut: "Signed out",
    signedOutBody: "Your session ended. Start connecting from your MCP client again.",
    signInExpired: "Sign-in expired",
    signInExpiredBody:
      "This sign-in link expired or was opened in another browser. Please start again.",
    signInCancelled: "Sign-in cancelled",
    signInCancelledBody: "GitHub sign-in was cancelled.",
    signInFailed: "Sign-in failed",
    signInNoCode: "GitHub did not return an authorization code.",
    signInError: "GitHub sign-in could not be completed. Please try again.",
    notInvited: "Not invited",
    notInvitedBody: (login: string) =>
      `The GitHub account ${login} is not on this server's access list.`,
  },
  notices: {
    saved: "Key saved.",
    removed: "Key removed.",
    disconnected: "Client disconnected. It must sign in again to use your account.",
    invalid:
      "That value was not saved: it must be 1–1024 characters without spaces or line breaks.",
    "api-key-revoked": "API key revoked. It can keep working for up to a minute.",
    "api-key-not-found": "No API key was revoked: it was not found, it may already be gone.",
    "api-key-invalid-name": "API key not created: the name must be 1–64 printable characters.",
    "api-key-limit": "API key not created: revoke a key first, an account can hold at most 10.",
    "r2-saved": "Output storage saved. Access was checked with a list, upload and delete.",
    "r2-removed": "Output storage removed.",
    "r2-invalid-account":
      "Storage settings not saved: give either a Cloudflare account ID of 32 hexadecimal characters or an S3-compatible endpoint, not both.",
    "r2-invalid-endpoint":
      "Storage settings not saved: the endpoint must be an https URL with a public host name and no IP address, port, path, query or credentials.",
    "r2-invalid-region":
      "Storage settings not saved: the region may only use lower-case letters, digits and hyphens, and R2 accepts only auto.",
    "r2-invalid-addressing":
      "Storage settings not saved: addressing must be path-style or virtual-hosted, and R2 accepts only path-style.",
    "r2-invalid-expiry":
      "Storage settings not saved: the link lifetime must be a whole number of seconds from 60 to 604800.",
    "r2-endpoint-not-public":
      "Storage settings not saved: the endpoint does not resolve, or resolves to a private or reserved address.",
    "r2-invalid-keys":
      "Storage settings not saved: the access key ID must be 16–128 letters or digits and the secret 16–1024 characters without spaces.",
    "r2-invalid-bucket":
      "Storage settings not saved: the bucket name must be 3–63 lower-case letters, digits or hyphens (dots only with path-style addressing on an endpoint).",
    "r2-invalid-url":
      "Storage settings not saved: the public base URL must be an https URL without a query string or fragment.",
    "r2-invalid-prefix":
      "Storage settings not saved: the directory path may only use letters, digits, dots, underscores, hyphens and slashes (no . or .. segments, at most 256 characters).",
    "r2-denied":
      "Storage settings not saved: the storage service refused the credentials. Check the key pair and that the token covers this bucket.",
    "r2-no-bucket": "Storage settings not saved: the bucket does not exist for those credentials.",
    "r2-read-only":
      "Storage settings not saved: the token can read the bucket but not write to it. Use credentials with object read and write access (R2: Object Read & Write).",
    "r2-no-delete":
      "Storage settings not saved: the token could upload but not delete the probe object. Use credentials with object read and write access (R2: Object Read & Write).",
    "r2-unreachable":
      "Storage settings not saved: the storage service could not be reached. Try again.",
    "r2-error":
      "Storage settings not saved: the storage service returned an unexpected error. Try again.",
  } satisfies Record<NoticeCode, string>,
};

/** Every language provides the same entries with the same signatures. */
export type Messages = typeof EN;
