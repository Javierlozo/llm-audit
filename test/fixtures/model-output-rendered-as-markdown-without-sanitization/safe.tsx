// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";

// Default behaviour: HTML stays escaped. This is the common case.
export function SafeDefault({ answer }: { answer: string }) {
  // ok: model-output-rendered-as-markdown-without-sanitization
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>;
}

// Raw HTML enabled, but sanitized after it is parsed.
export function SafeSanitized({ answer }: { answer: string }) {
  // ok: model-output-rendered-as-markdown-without-sanitization
  return (
    <ReactMarkdown rehypePlugins={[rehypeRaw, rehypeSanitize]}>{answer}</ReactMarkdown>
  );
}

// unified pipeline with rehype-sanitize in the chain.
export async function renderSanitized(answer: string) {
  const file = await unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeSanitize)
    // ok: model-output-rendered-as-markdown-without-sanitization
    .use(rehypeStringify)
    .process(answer);
  return String(file);
}
