/**
 * Values with an icon copy button beside them. The button works through
 * COPY_SCRIPT (copy-script.ts) and stays hidden when that script does not run.
 */

import { escapeHtml } from "../http-responses.js";

const COPY_ICON =
  '<svg class="i-copy" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const DONE_ICON =
  '<svg class="i-done" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function copyButton(label: string): string {
  return `<button type="button" class="copy-btn" data-copy aria-label="Copy ${escapeHtml(label)}" title="Copy">${COPY_ICON}${DONE_ICON}</button>`;
}

/** A read-only input with a copy button inside its right edge. */
export function copyField(value: string, label: string, id?: string): string {
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  return `<div class="copy-wrap"><input type="text"${idAttr} readonly value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" spellcheck="false">${copyButton(label)}</div>`;
}

/** A preformatted block (URL, command, curl example) with a copy button in its corner. */
export function copyBlock(text: string, label: string): string {
  return `<div class="copy-wrap"><pre>${escapeHtml(text)}</pre>${copyButton(label)}</div>`;
}
