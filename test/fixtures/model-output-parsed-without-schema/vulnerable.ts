import OpenAI from "openai";
import { generateText } from "ai";

const openai = new OpenAI();

// JSON.parse on raw model output, no schema validation.
export async function vuln1() {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "respond with JSON: { user, balance }" }],
  });
  // ruleid: model-output-parsed-without-schema
  const data = JSON.parse(r.choices[0].message.content as string);
  return { user: data.user, balance: data.balance };
}

// Same shape with AI SDK generateText.
export async function vuln2() {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: "respond with JSON: { ok, value }",
  });
  // ruleid: model-output-parsed-without-schema
  return JSON.parse(r.text);
}
