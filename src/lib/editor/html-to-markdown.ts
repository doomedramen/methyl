import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";

/**
 * Convert pasted HTML to Markdown (spec item 18): headings, emphasis, links,
 * lists, tables, code and quotes come across; styling and scripts don't.
 * Loaded on demand by smart paste, so the parser isn't in the editor bundle.
 */
export function htmlToMarkdown(html: string): string {
  const file = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*", fences: true, rule: "-" })
    .processSync(html);
  return String(file).trim();
}
