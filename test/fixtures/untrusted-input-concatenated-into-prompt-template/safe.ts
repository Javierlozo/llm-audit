import { generateText } from "ai";
import { z } from "zod";

const Body = z.object({ text: z.string().min(1).max(4000) });

// Static system prompt, untrusted input only in the user role.
export async function safe1(req: any) {
  const { text } = Body.parse(req.body);
  // ok: untrusted-input-concatenated-into-prompt-template
  return generateText({
    model: "claude-opus-4-7" as any,
    system: "Translate the user's text to French. Output only the translation.",
    messages: [{ role: "user", content: text }],
  });
}

// Static prompt with no user input.
export async function safe2() {
  // ok: untrusted-input-concatenated-into-prompt-template
  return generateText({
    model: "claude-opus-4-7" as any,
    prompt: "Give me three random portfolio project ideas.",
  });
}
