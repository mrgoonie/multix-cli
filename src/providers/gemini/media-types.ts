/**
 * MIME-type predicates shared by the Gemini client and the CLI.
 * Runtime-neutral: no node:* imports.
 */

/** True if the MIME type is audio or video (requires polling after File API upload). */
export function requiresProcessingWait(mimeType: string): boolean {
  return mimeType.startsWith("audio/") || mimeType.startsWith("video/");
}
