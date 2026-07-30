export function getStaticPaths() {
  const documents = import.meta.glob("../content/docs/**/*.md", {
    eager: true,
    import: "default",
    query: "?raw",
  });

  return Object.entries(documents)
    .map(([filePath, markdown]) => {
      const relativePath = filePath.replace("../content/docs/", "").replace(/\.md$/, "");
      const slug = relativePath === "index" ? "index" : relativePath;

      return {
        params: { slug },
        props: { markdown: String(markdown) },
      };
    })
    .filter(({ params }) => params.slug !== "index");
}

export function GET({ props }: { props: { markdown: string } }) {
  return new Response(props.markdown, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
