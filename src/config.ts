import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Laedt .env ohne externe Abhaengigkeit (Node >= 22 kann das noch nicht von selbst). */
function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // echte Umgebung gewinnt
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

const bool = z
  .string()
  .transform((v) => v.toLowerCase() === "true" || v === "1")
  .pipe(z.boolean());

const ConfigSchema = z.object({
  appToken: z.string().min(1, "APP_TOKEN fehlt - siehe .env.example"),
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default("0.0.0.0"),

  notionToken: z.string().min(1, "NOTION_TOKEN fehlt - siehe docs/notion.md"),
  notionDatabaseId: z.string().min(1, "NOTION_DATABASE_ID fehlt - siehe docs/notion.md"),

  geminiApiKey: z.string().default(""),
  // Feste Versionen statt "-latest": Letztere zeigen laut Google auf
  // experimentelle Modelle mit engeren Limits und ohne zugesicherte
  // Verfuegbarkeit - genau das fuehrt zu sporadischen 503ern.
  geminiModel: z.string().default("gemini-3.5-flash"),
  /** Wird angelaufen, wenn das Hauptmodell ueberlastet bleibt. Leer = keines. */
  geminiFallbackModel: z.string().default("gemini-2.5-flash"),
  /** Eigenes Modell fuer Audio, falls TRANSCRIBE_PROVIDER=gemini. */
  geminiTranscribeModel: z.string().default("gemini-3.5-transcribe"),

  /** Titelbild zum Rezept erzeugen lassen? */
  coverImage: bool.default(false),
  /** Bildmodell. Leer = kein Titelbild. "npm run models" zeigt die Namen. */
  imageModel: z.string().default(""),
  coverPromptFile: z.string().default("prompts/cover.de.md"),

  transcribeProvider: z.enum(["local", "gemini"]).default("local"),
  whisperModel: z.string().default("small"),
  whisperComputeType: z.string().default("int8"),

  freeTextMinChars: z.coerce.number().int().nonnegative().default(400),
  tagsWithHash: bool.default(false),
  /** Wert fuer die Status-Spalte bei NEU angelegten Rezepten. Leer = nicht setzen. */
  newRecipeStatus: z.string().default(""),
  ytdlpAutoUpdate: bool.default(true),
  /**
   * Welcher Kanal beim Selbstupdate. "nightly" ist der von yt-dlp selbst fuer
   * normale Nutzer empfohlene: Korrekturen fuer TikTok und Co. erscheinen dort
   * am Tag ihrer Entstehung, im stabilen Kanal erst Wochen spaeter.
   */
  ytdlpChannel: z.enum(["stable", "nightly"]).default("nightly"),
  cookiesFile: z.string().default("config/cookies.txt"),

  dataDir: z.string().default("data"),
  promptFile: z.string().default("prompts/recipe.de.md"),
  mappingFile: z.string().default("config/notion-mapping.json"),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;

  const parsed = ConfigSchema.safeParse({
    appToken: process.env.APP_TOKEN,
    port: process.env.PORT,
    host: process.env.HOST,
    notionToken: process.env.NOTION_TOKEN,
    notionDatabaseId: process.env.NOTION_DATABASE_ID,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL,
    geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL,
    geminiTranscribeModel: process.env.GEMINI_TRANSCRIBE_MODEL,
    coverImage: process.env.COVER_IMAGE,
    imageModel: process.env.IMAGE_MODEL,
    transcribeProvider: process.env.TRANSCRIBE_PROVIDER,
    whisperModel: process.env.WHISPER_MODEL,
    whisperComputeType: process.env.WHISPER_COMPUTE_TYPE,
    freeTextMinChars: process.env.FREE_TEXT_MIN_CHARS,
    tagsWithHash: process.env.TAGS_WITH_HASH,
    newRecipeStatus: process.env.NEW_RECIPE_STATUS,
    ytdlpAutoUpdate: process.env.YTDLP_AUTO_UPDATE,
    ytdlpChannel: process.env.YTDLP_CHANNEL,
    cookiesFile: process.env.COOKIES_FILE,
    dataDir: process.env.DATA_DIR,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Konfiguration unvollstaendig:\n${issues}\n\nVorlage: .env.example`);
  }

  cached = parsed.data;
  return cached;
}

/** Absoluter Pfad relativ zum Projektverzeichnis. */
export function projectPath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts);
}

/** Nur fuer Tests: erzwingt Neuauswertung der Umgebung. */
export function resetConfigCache(): void {
  cached = undefined;
}
