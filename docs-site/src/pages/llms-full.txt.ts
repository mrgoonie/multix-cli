const pages = import.meta.glob("../content/docs/**/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

export function GET() {
  const sections = Object.entries(pages)
    .filter(([path]) => !path.includes("/vi/"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([path, content]) => `<!-- ${path.replace("../content/docs", "")} -->\n\n${content.trim()}`,
    );

  return new Response(`${sections.join("\n\n---\n\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
