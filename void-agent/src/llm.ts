import { z } from "zod";
import OpenAI from "openai";

// Define the shape of the environment variables we expect for the LLM service
export interface Env {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
}

// Zod schema for the triage plan
const TriagePlanSchema = z.object({
  rewrite: z.object({
    title: z.string().optional().describe("A clear, specific title for the issue."),
    description: z.string().optional().describe("A detailed, actionable description."),
  }).optional().describe("Fields for rewriting the issue's title or description for clarity."),
  priority: z.enum(["Urgent", "High", "Medium", "Low", "No priority"]).optional().describe("The issue's priority."),
  teamId: z.string().optional().describe("The ID of the team that should own this issue."),
  labelIds: z.array(z.string()).optional().describe("A list of relevant label UUIDs."),
  estimate: z.number().optional().describe("A Fibonacci point estimate (0, 1, 2, 3, 5, 8, 13) of the effort required."),
  assigneeId: z.string().optional().describe("The ID of a specific person to assign it to."),
  subtasks: z.array(z.string()).optional().describe("A list of titles for subtasks to be created."),
  needsClarification: z.boolean().describe("Set to true if you lack the information to proceed."),
  clarificationComment: z.string().optional().describe("If clarification is needed, a friendly comment asking for more details."),
});

// Type alias for the inferred schema
export type TriagePlan = z.infer<typeof TriagePlanSchema>;

let openai: OpenAI | null = null;

function getOpenAIClient(env: Env): OpenAI {
  if (!openai) {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set in the environment.");
    }
    openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openai;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Calls the LLM to generate a triage plan for an issue.
 * @param env - The environment variables object.
 * @param prompt - The full prompt to send to the LLM.
 * @returns A validated TriagePlan object.
 */
export async function getTriagePlan(env: Env & { PROMPT: string }, issueContent: string): Promise<TriagePlan> {
  const client = getOpenAIClient(env);
  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: env.PROMPT,
          },
          {
            role: "user",
            content: issueContent,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("LLM response was empty.");
      }

      const parsedJson = JSON.parse(content);
      return TriagePlanSchema.parse(parsedJson);

    } catch (error) {
      console.error(`LLM call failed on attempt ${i + 1}:`, error);
      if (i === MAX_RETRIES - 1) {
        throw new Error("Failed to get a valid triage plan from the LLM after multiple retries.");
      }
      await new Promise(res => setTimeout(res, RETRY_DELAY_MS * (i + 1)));
    }
  }

  // This should be unreachable due to the throw in the loop
  throw new Error("Exited retry loop without returning a value.");
}
