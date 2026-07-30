export function GET() {
  return new Response(
    "User-agent: *\nAllow: /\n\nSitemap: https://multix.zuey.me/sitemap-index.xml\n",
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    },
  );
}
