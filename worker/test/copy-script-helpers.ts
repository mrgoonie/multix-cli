import { COPY_SCRIPT } from "../src/pages/copy-script.js";

/** A page's HTML without the one allowed (hashed) copy script, to check nothing else runs. */
export function withoutCopyScript(html: string): string {
  return html.replace(`<script>${COPY_SCRIPT}</script>`, "");
}
