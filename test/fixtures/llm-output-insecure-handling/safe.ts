import OpenAI from "openai";
import { generateText } from "ai";
import { z } from "zod";
import DOMPurify from "isomorphic-dompurify";

const openai = new OpenAI();

// Model output validated against a schema before any use.
const Reply = z.object({ answer: z.string().max(2000) });

export async function safe1() {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    system: "Reply with JSON: { answer: string }.",
    prompt: "What is 2+2?",
  });
  const parsed = Reply.parse(JSON.parse(r.text));
  // ok: llm-output-insecure-handling
  return parsed.answer;
}

// Model output sanitized before rendering as HTML.
export async function safe2(el: HTMLElement) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "give me a paragraph" }],
  });
  const raw = r.choices[0].message.content ?? "";
  // ok: llm-output-insecure-handling
  el.innerHTML = DOMPurify.sanitize(raw);
}

// Model output displayed as text content, never executed.
export async function safe3(el: HTMLElement) {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: "explain caches in one sentence",
  });
  // ok: llm-output-insecure-handling
  el.textContent = r.text;
}
