import markdown from "../content/docs/index.md?raw";

export function GET() {
  return new Response(markdown, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
