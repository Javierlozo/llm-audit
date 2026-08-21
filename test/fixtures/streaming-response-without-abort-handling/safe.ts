// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { streamText } from "ai";

const openai = new OpenAI();

// Abort signal forwarded, so a disconnect stops generation.
export async function POST(request: Request) {
  const { question } = await request.json();
  // ok: streaming-response-without-abort-handling
  const result = streamText({
    model: "claude-opus-4-7" as any,
    system: "You are concise.",
    prompt: question,
    abortSignal: request.signal,
  });
  return result.toTextStreamResponse();
}

// OpenAI SDK with the signal in the request options.
export async function stream(request: Request) {
  const { question } = await request.json();
  // ok: streaming-response-without-abort-handling
  return openai.chat.completions.create(
    {
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: question }],
    },
    { signal: request.signal }
  );
}
