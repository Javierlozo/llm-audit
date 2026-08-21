// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { generateText } from "ai";

const openai = new OpenAI();

declare function search(q: string): Promise<{ text: string }[]>;

// Retrieved chunks concatenated into the system role.
export async function vuln1(question: string) {
  const chunks = await search(question);
  const retrievedContext = chunks.map((c) => c.text).join("\n---\n");
  // ruleid: untrusted-retrieval-context-in-system-role
  return generateText({
    model: "claude-opus-4-7" as any,
    system: `Answer using the following documents:\n${retrievedContext}`,
    prompt: question,
  });
}

// Same failure in an OpenAI messages array.
export async function vuln2(question: string) {
  const docs = await search(question);
  // ruleid: untrusted-retrieval-context-in-system-role
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: `Knowledge base:\n${docs.map((d) => d.text).join("\n")}` },
      { role: "user", content: question },
    ],
  });
}
