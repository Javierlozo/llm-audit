// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const Env = z.object({
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
});
const env = Env.parse(process.env);

// ok: hardcoded-llm-api-key
export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ok: hardcoded-llm-api-key
export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
