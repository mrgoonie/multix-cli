/**
 * The dashboard's overview: greeting, the three onboarding steps (signed in,
 * a provider key saved, an MCP client connected) and which providers have a
 * key. Everything is derived from the data the dashboard already loads.
 */

import { escapeHtml } from "../http-responses.js";
import { PROVIDER_KEY_GROUPS } from "../provider-secret-names.js";
import { copyBlock } from "./copy-button.js";
import type { DashboardView } from "./dashboard-page.js";
import { type Messages, messagesFor } from "./i18n.js";
import { providerAnchor, savedCount } from "./provider-keys-card.js";

const CHECK =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

interface Step {
  done: boolean;
  title: string;
  /** Trusted markup: dictionary text and escaped values. */
  body: string;
}

function stepItem(step: Step, index: number, t: Messages): string {
  const mark = step.done ? CHECK : String(index + 1);
  const state = step.done
    ? `<span class="badge ok"><span class="dot" aria-hidden="true"></span>${escapeHtml(t.overview.done)}</span>`
    : `<span class="badge">${escapeHtml(t.overview.todo)}</span>`;
  return `<li class="step${step.done ? " done" : ""}"><span class="step-mark" aria-hidden="true">${mark}</span><div><div class="step-head"><h3>${escapeHtml(step.title)}</h3>${state}</div>${step.body}</div></li>`;
}

/** Providers with at least one saved name, out of all groups. */
export function readyProviders(view: DashboardView): number {
  return PROVIDER_KEY_GROUPS.filter((group) => savedCount(group, view.secrets) > 0).length;
}

function setupCard(view: DashboardView, t: Messages): string {
  const o = t.overview;
  const lang = view.prefs.lang;
  const ready = readyProviders(view);
  const clients = view.clients.length;
  const steps: Step[] = [
    { done: true, title: o.stepSignIn, body: `<p>${o.stepSignInDone(view.account.login)}</p>` },
    {
      done: ready > 0,
      title: o.stepKey,
      body:
        ready > 0
          ? `<p>${escapeHtml(o.stepKeyDone(ready))}</p>`
          : `<p>${escapeHtml(o.stepKeyTodo)}</p><p><a class="btn small" href="#provider-keys">${escapeHtml(o.stepKeyLink)}</a></p>`,
    },
    {
      done: clients > 0,
      title: o.stepConnect,
      body: `<p>${escapeHtml(clients > 0 ? o.stepConnectDone(clients) : o.stepConnectBody)}</p>
${copyBlock(view.mcpUrl, o.mcpUrlLabel, lang)}
<p class="muted"><small>${escapeHtml(o.claudeCode)}</small></p>
${copyBlock(`claude mcp add --transport http multix ${view.mcpUrl}`, o.claudeCodeLabel, lang)}`,
    },
  ];
  return `<section class="card" aria-labelledby="setup-h">
<h2 id="setup-h">${escapeHtml(o.setupHeading)}</h2>
<ol class="steps">${steps.map((step, i) => stepItem(step, i, t)).join("")}</ol>
</section>`;
}

function stats(view: DashboardView, t: Messages): string {
  const o = t.overview;
  const items: [string, string][] = [
    [o.statProviders, `${readyProviders(view)} / ${PROVIDER_KEY_GROUPS.length}`],
    [o.statStorage, view.r2 ? o.statStorageOn : o.statStorageOff],
    [o.statApiKeys, String(view.apiKeys.length)],
    [o.statClients, String(view.clients.length)],
  ];
  return `<dl class="stats">${items
    .map(
      ([label, value]) =>
        `<div class="stat"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

function providerStatus(view: DashboardView, t: Messages): string {
  const o = t.overview;
  const items = PROVIDER_KEY_GROUPS.map((group) => {
    const ok = savedCount(group, view.secrets) > 0;
    const status = ok
      ? `<span class="status status-ok"><span class="dot" aria-hidden="true"></span>${escapeHtml(o.statusReady)}</span>`
      : `<span class="status"><span class="dot" aria-hidden="true"></span>${escapeHtml(o.statusNotSet)}</span>`;
    return `<li><a href="#${providerAnchor(group)}"><span>${escapeHtml(group.provider)}</span>${status}</a></li>`;
  }).join("");
  return `<section class="card" aria-labelledby="provider-status-h">
<div class="row spread"><h2 id="provider-status-h">${escapeHtml(o.statusHeading)}</h2><p class="muted"><small>${escapeHtml(o.statusSummary(readyProviders(view), PROVIDER_KEY_GROUPS.length))}</small></p></div>
<ul class="providers">${items}</ul>
</section>`;
}

export function overviewSection(view: DashboardView): string {
  const t = messagesFor(view.prefs.lang);
  return `<section id="overview" class="intro" aria-labelledby="overview-h">
<p class="eyebrow">${escapeHtml(t.overview.eyebrow)}</p>
<h1 id="overview-h">${t.overview.welcome(view.account.login)}</h1>
<p class="lede">${escapeHtml(t.overview.lede)}</p>
</section>
${stats(view, t)}
${setupCard(view, t)}
${providerStatus(view, t)}`;
}
