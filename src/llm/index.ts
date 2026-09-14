import { generateJson } from "./gemini.ts";
import { buildPrompt, type PromptContext } from "./prompt.ts";
import { RecipeSchema, GEMINI_RESPONSE_SCHEMA, type Recipe } from "./recipeSchema.ts";

export type { PromptContext };

/** Baut den Prompt, ruft das Modell und validiert die Antwort gegen das Zod-Schema. */
export async function extractRecipe(ctx: PromptContext): Promise<Recipe> {
  const prompt = await buildPrompt(ctx);
  const raw = await generateJson({ prompt, schema: GEMINI_RESPONSE_SCHEMA });

  const parsed = RecipeSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Die Antwort des Modells passt nicht zum Rezept-Schema (${issues}). ` +
        `Meist hilft ein erneuter Versuch; haeuft es sich, ist der Prompt in ` +
        `prompts/recipe.de.md zu unscharf geworden.`,
    );
  }
  return parsed.data;
}
