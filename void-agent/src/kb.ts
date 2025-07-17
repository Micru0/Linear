// Define the shape of the environment variables we expect for KB access
export interface Env {
  TEAM_RULES_KV: KVNamespace;
}

// The key in the KV store where the knowledge base JSON is stored.
const KB_KEY = "team_rules.json";

// Define the expected structure of the knowledge base.
// This is a simplified example; you can make it as complex as needed.
export interface TeamKnowledgeBase {
  [teamId: string]: {
    name: string;
    keywords: string[];
    domains: string[]; // e.g., "api", "frontend", "billing"
  };
}

// Define the structure for the label knowledge base.
export interface LabelKnowledgeBase {
  data: {
    issueLabels: {
      nodes: {
        id: string;
        name: string;
      }[];
    };
  }
}

/**
 * Fetches the team knowledge base from the KV store.
 * @param env - The environment object containing the KV namespace.
 * @returns A promise that resolves to the parsed knowledge base.
 */
export async function getTeamKnowledgeBase(env: Env): Promise<TeamKnowledgeBase> {
  const kbJson = await env.TEAM_RULES_KV.get(KB_KEY);
  if (!kbJson) {
    throw new Error(`Knowledge base not found in KV with key: ${KB_KEY}`);
  }
  return JSON.parse(kbJson);
}

/**
 * Fetches the label knowledge base from the KV store.
 * @param env - The environment object containing the KV namespace.
 * @returns A promise that resolves to the parsed label knowledge base.
 */
export async function getLabelKnowledgeBase(env: Env): Promise<LabelKnowledgeBase> {
	const kbJson = await env.TEAM_RULES_KV.get("labels.json");
	if (!kbJson) {
	  throw new Error(`Knowledge base not found in KV with key: labels.json`);
	}
	return JSON.parse(kbJson);
  }

/**
 * Validates a list of label IDs against the knowledge base.
 * @param env - The environment variables.
 * @param labelIds - The list of label IDs to validate.
 * @returns A list of valid label IDs.
 */
export async function validateLabelIds(env: Env, labelIds: string[]): Promise<string[]> {
    const labelKb = await getLabelKnowledgeBase(env);
    if (!labelKb?.data?.issueLabels?.nodes) {
      console.error("Invalid Label Knowledge Base structure:", JSON.stringify(labelKb));
      return [];
    }
    const validLabelIds = new Set(labelKb.data.issueLabels.nodes.map((l: any) => l.id));
    return labelIds.filter(id => validLabelIds.has(id));
}
