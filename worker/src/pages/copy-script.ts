/**
 * The only script the HTML pages run: copy buttons next to values a user has
 * to copy (see copy-button.ts). The CSP in http-responses.ts allows exactly
 * this text by its SHA-256 hash; test/copy-buttons.test.ts fails if the hash
 * below no longer matches, so update both together.
 *
 * Without this script (or with JavaScript off) the buttons stay hidden and the
 * values can still be selected by hand.
 */

export const COPY_SCRIPT = `document.documentElement.classList.add("js");
document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-copy]") : null;
  if (!button) return;
  const source = button.parentElement && button.parentElement.querySelector("input, pre");
  if (!source) return;
  const text = source instanceof HTMLInputElement ? source.value : source.textContent || "";
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    // Older browsers or no clipboard permission: copy the selection instead.
    const selection = window.getSelection();
    if (source instanceof HTMLInputElement) source.select();
    else if (selection) selection.selectAllChildren(source);
    copied = document.execCommand("copy");
    if (!(source instanceof HTMLInputElement) && selection) selection.removeAllRanges();
  }
  const label = button.getAttribute("aria-label");
  button.setAttribute("data-state", copied ? "copied" : "failed");
  button.setAttribute("aria-label", copied ? "Copied" : "Copy failed, select the text and copy it by hand");
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.removeAttribute("data-state");
    if (label) button.setAttribute("aria-label", label);
  }, 1600);
});`;

/** `sha256-<base64>` of COPY_SCRIPT, as used in the CSP `script-src`. */
export const COPY_SCRIPT_HASH = "sha256-rYBys3NS7eSR2TIVxiHPfsDLmeLEeTOwbWdGKiQ6Tck=";
