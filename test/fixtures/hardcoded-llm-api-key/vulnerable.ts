import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// Inline OpenAI key.
// ruleid: hardcoded-llm-api-key
export const openai = new OpenAI({ apiKey: "sk-proj-AAAA1111BBBB2222CCCC3333DDDD4444" });

// Inline Anthropic key.
// ruleid: hardcoded-llm-api-key
export const anthropic = new Anthropic({ apiKey: "sk-ant-AAAA1111BBBB2222CCCC3333DDDD4444" });

// Plain regex match: any "sk-..." string in an apiKey field.
const config = {
  // ruleid: hardcoded-llm-api-key
  apiKey: "sk-proj-EEEE5555FFFF6666GGGG7777HHHH8888",
};
export { config };
