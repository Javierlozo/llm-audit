// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { generateText } from "ai";

// Credential stays in the client config, out of the context.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Static system prompt. The credential never reaches the model.
export async function safe1(question: string) {
  // ok: secrets-in-prompt-context
  return generateText({
    model: "claude-opus-4-7" as any,
    system: "You are a billing assistant. Answer only from the supplied order summary.",
    prompt: question,
  });
}

// Data fetched server-side behind the credential; only the result is passed.
export async function safe2(orderId: string, question: string) {
  const order = await fetch(`${process.env.BILLING_API_URL}/orders/${orderId}`, {
    headers: { authorization: `Bearer ${process.env.BILLING_API_KEY}` },
  }).then((r) => r.json());

  // ok: secrets-in-prompt-context
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a billing assistant." },
      { role: "user", content: `Order total: ${order.total}. Question: ${question}` },
    ],
  });
}

// Model id from env is configuration, not a secret in the context.
export async function safe3(question: string) {
  // ok: secrets-in-prompt-context
  return generateText({
    model: process.env.MODEL_ID as any,
    system: "You are concise.",
    prompt: question,
  });
}
