// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { generateText } from "ai";

const openai = new OpenAI();

// Route handler forwards the parsed body straight into the prompt.
export async function POST(request: Request) {
  const body = await request.json();
  // ruleid: request-body-to-llm-without-schema
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: body.question,
  });
  return Response.json({ text: r.text });
}

// Server Action, same shape through the OpenAI SDK.
export async function ask(request: Request) {
  const input = await request.json();
  // ruleid: request-body-to-llm-without-schema
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: input.message }],
  });
}

// Raw text body, no bound on length.
export async function summarize(request: Request) {
  const raw = await request.text();
  // ruleid: request-body-to-llm-without-schema
  return generateText({
    model: "claude-opus-4-7" as any,
    prompt: `Summarize this:\n${raw}`,
  });
}
