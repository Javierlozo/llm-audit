import { generateText, streamText, generateObject } from "ai";

// Instructions wrap user input in a single string with no role boundary.
export async function vuln1(req: any) {
  // ruleid: untrusted-input-concatenated-into-prompt-template
  return generateText({
    model: "claude-opus-4-7" as any,
    prompt: `Translate the following to French:
${req.body.text}

Output only the translation.`,
  });
}

// streamText with the same shape.
export async function vuln2(req: any) {
  // ruleid: untrusted-input-concatenated-into-prompt-template
  return streamText({
    model: "claude-opus-4-7" as any,
    prompt: `Summarize this in one sentence: ${req.query.article}`,
  });
}

// generateObject with embedded user input.
export async function vuln3(req: any) {
  // ruleid: untrusted-input-concatenated-into-prompt-template
  return generateObject({
    model: "claude-opus-4-7" as any,
    schema: {} as any,
    prompt: `Extract entities from: ${req.body.text}`,
  });
}
