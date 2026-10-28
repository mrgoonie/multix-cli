/**
 * The only script the HTML pages run: copy buttons next to values a user has
 * to copy (see copy-button.ts). The CSP in http-responses.ts allows exactly
 * this text by its SHA-256 hash; test/copy-buttons.test.ts fails if the hash
 * below no longer matches, so update both together.
 *
 * Only pages with a copy button include it (page-layout.ts). Without it (or
 * with JavaScript off) the buttons stay hidden and the values can still be
 * selected by hand. Results are announced through the #copy-status live region,
 * which carries the messages in the page's language (data-copied, data-failed).
 */

export const COPY_SCRIPT = `document.documentElement.classList.add("js");
function copySelection(source) {
  const selection = window.getSelection();
  if (source instanceof HTMLInputElement) source.select();
  else if (selection) selection.selectAllChildren(source);
  return document.execCommand("copy");
}
document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-copy]") : null;
  if (!button) return;
  const source = button.parentElement && button.parentElement.querySelector("input, pre");
  if (!source) return;
  const text = source instanceof HTMLInputElement ? source.value : source.textContent || "";
  let copied = false;
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = copySelection(source);
    }
  } else {
    copied = copySelection(source);
  }
  // Clear our selection on success; on failure leave it so the user can copy by hand.
  if (copied && !(source instanceof HTMLInputElement)) window.getSelection()?.removeAllRanges();
  // The page puts both messages, in its language, on the live region.
  const status = document.getElementById("copy-status");
  const message = (status && status.getAttribute(copied ? "data-copied" : "data-failed")) || (copied ? "Copied" : "Copy failed");
  button.setAttribute("data-state", copied ? "copied" : "failed");
  button.setAttribute("aria-label", message);
  if (status) status.textContent = message;
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.removeAttribute("data-state");
    button.setAttribute("aria-label", button.getAttribute("data-label") || "Copy");
    if (status) status.textContent = "";
  }, 1600);
});`;

/** `sha256-<base64>` of COPY_SCRIPT, as used in the CSP `script-src`. */
export const COPY_SCRIPT_HASH = "sha256-wYeGU/O2ARa/l23331Ydh+tSTGaESrICpcUHkJGQeSw=";
