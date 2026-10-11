/**
 * Gemini Files API per-file size limit. Google documents it as "2 GB" without
 * saying whether that is GiB, so the decimal value is used: a file between
 * 2,000,000,000 bytes and 2 GiB is rejected locally instead of failing on the
 * server after the upload.
 */
export const FILES_API_MAX_BYTES = 2_000_000_000;
