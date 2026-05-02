/**
 * Default markdown conversion prompt.
 * Copied verbatim from document_converter.py.
 */

export const DEFAULT_CONVERT_PROMPT = `Convert this document to clean, well-formatted Markdown.

Requirements:
- Preserve all content, structure, and formatting
- Convert tables to markdown table format
- Maintain heading hierarchy (# ## ### etc)
- Preserve lists, code blocks, and quotes
- Extract text from images if present
- Keep formatting consistent and readable

Output only the markdown content without any preamble or explanation.`;
