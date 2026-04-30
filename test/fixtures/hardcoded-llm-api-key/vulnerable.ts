// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.
// Imports below resolve to packages this project deliberately does not depend on.
//
// llm-audit test fixture. The strings shaped like API keys below are
// deliberately invalid placeholders (note the repeating AAAA1111... and
// EEEE5555... patterns) used only to verify that the rule matches.
// They are not, and have never been, real credentials.
//
// pragma: allowlist secret
// trufflehog:ignore
// gitleaks:allow

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
