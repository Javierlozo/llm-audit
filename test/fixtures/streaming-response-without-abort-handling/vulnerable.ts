// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { streamText } from "ai";

const openai = new OpenAI();

// Caller disconnects, generation continues, tokens keep billing.
export async function POST(request: Request) {
  const { question } = await request.json();
  // ruleid: streaming-response-without-abort-handling
  const result = streamText({
    model: "claude-opus-4-7" as any,
    system: "You are concise.",
    prompt: question,
  });
  return result.toTextStreamResponse();
}

// OpenAI streaming with no signal wired through.
export async function stream(request: Request) {
  const { question } = await request.json();
  // ruleid: streaming-response-without-abort-handling
  return openai.chat.completions.create({
    model: "gpt-4o",
    stream: true,
    messages: [{ role: "user", content: question }],
  });
}
