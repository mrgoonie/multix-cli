/**
 * Videos shown in the landing page's case-studies section. An empty list
 * renders no section at all.
 *
 * Each item renders as its poster; the video loads only when clicked
 * (a YouTube URL becomes a youtube-nocookie embed, anything else a <video>),
 * and each item adds a schema.org VideoObject to the page's JSON-LD.
 * Video hosts other than this origin must also be allowed by the CSP in
 * scripts/write-security-headers.mjs (frame-src / media-src).
 */

export interface CaseStudy {
  title: string;
  description: { en: string; vi: string };
  /** Video file or YouTube watch/share URL. */
  url: string;
  /** Poster image path or URL, shown before the video loads. */
  poster: string;
  /** The multix command that produced it. */
  command: string;
  /** ISO 8601 date; recommended by search engines for VideoObject. */
  uploadDate?: string;
}

export const caseStudies: CaseStudy[] = [];

/** YouTube video ID from a watch, share or embed URL, or null for other hosts. */
export function youtubeId(url: string): string | null {
  const match =
    /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(
      url,
    );
  return match ? match[1] : null;
}
