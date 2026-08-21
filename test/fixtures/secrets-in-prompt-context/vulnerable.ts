// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { generateText } from "ai";

const openai = new OpenAI();

// Internal endpoint and key handed to the model as context.
export async function vuln1() {
  // ruleid: secrets-in-prompt-context
  return generateText({
    model: "claude-opus-4-7" as any,
    system: `You may call the billing API at ${process.env.BILLING_API_URL} using key ${process.env.BILLING_API_KEY}.`,
    prompt: "refund the last order",
  });
}

// Secret assigned straight into the system field.
export async function vuln2() {
  // ruleid: secrets-in-prompt-context
  return generateText({
    model: "claude-opus-4-7" as any,
    system: process.env.SYSTEM_PROMPT_WITH_CREDENTIALS,
    prompt: "hello",
  });
}

// Same failure in an OpenAI messages array.
export async function vuln3(question: string) {
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      // ruleid: secrets-in-prompt-context
      { role: "system", content: `Admin token: ${process.env.ADMIN_TOKEN}` },
      { role: "user", content: question },
    ],
  });
}
