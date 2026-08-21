// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { marked } from "marked";

// react-markdown with raw HTML enabled, rendering model output.
export function VulnComponent({ answer }: { answer: string }) {
  // ruleid: model-output-rendered-as-markdown-without-sanitization
  return <ReactMarkdown rehypePlugins={[rehypeRaw]}>{answer}</ReactMarkdown>;
}

// unified pipeline opting into dangerous HTML with no sanitize step.
export async function renderAnswer(answer: string) {
  const file = await unified()
    .use(remarkParse)
    // ruleid: model-output-rendered-as-markdown-without-sanitization
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(answer);
  return String(file);
}

// marked with sanitize explicitly disabled.
export function renderWithMarked(answer: string) {
  // ruleid: model-output-rendered-as-markdown-without-sanitization
  marked.setOptions({ sanitize: false });
  return marked.parse(answer);
}
