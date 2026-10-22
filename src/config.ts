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
  geminiFallbackModel: z.string().default("gemini-3.6-flash"),
  /** Eigenes Modell fuer Audio, falls TRANSCRIBE_PROVIDER=gemini. */
  geminiTranscribeModel: z.string().default("gemini-3.5-transcribe"),

  /**
   * Woher das Notion-Titelbild kommt:
   *   thumbnail    = Vorschaubild des Videos bzw. Bild der Seite (kostenlos)
   *   ai           = erzeugtes Bild (kostenpflichtig, siehe README)
   *   thumbnail+ai = Vorschaubild, sonst erzeugtes
   *   none         = keines
   */
  coverSource: z.enum(["thumbnail", "ai", "thumbnail+ai", "none"]).default("thumbnail"),
  /** Bildmodell fuer den ai-Weg. "npm run models" zeigt die Namen. */
  imageModel: z.string().default(""),
  coverPromptFile: z.string().default("prompts/cover.de.md"),

  transcribeProvider: z.enum(["local", "gemini"]).default("local"),
  whisperModel: z.string().default("small"),
  whisperComputeType: z.string().default("int8"),

  /**
   * Fotos: Wie viele Bilder ein Rezept haben darf und wie gross jedes sein
   * darf. Ein iPhone-Foto liegt bei 2-4 MB; die Web-App rechnet es vor dem
   * Hochladen ohnehin kleiner, der Wert ist die Obergrenze fuer alle Wege.
   */
  maxPhotosPerJob: z.coerce.number().int().positive().default(60),
  maxPhotoBytes: z.coerce.number().int().positive().default(12 * 1024 * 1024),
  /**
   * Wie viele Bilder pro Leseanfrage an das Modell gehen. Ein ganzes Kochbuch
   * in einem Rutsch waere weder vom Kontext noch von der Sorgfalt her sinnvoll:
   * Bei dreissig Seiten auf einmal faengt jedes Modell an, Rezepte
   * zusammenzuziehen oder zu ueberspringen.
   */
  visionChunkSize: z.coerce.number().int().positive().default(4),
  /**
   * Bilder loeschen, sobald das Rezept in Notion steht. Das Titelbild liegt
   * dann ohnehin bei Notion; auf der Platte haetten sie nur noch fuer einen
   * zweiten Anlauf einen Zweck.
   */
  deletePhotosAfterSuccess: bool.default(true),
  /**
   * Alles, was trotzdem liegen bleibt - fehlgeschlagene Jobs, abgebrochene
   * Uploads - wird nach so vielen Tagen weggeraeumt. 0 = niemals.
   */
  photoRetentionDays: z.coerce.number().int().nonnegative().default(14),
  /**
   * Leer = geminiModel. Ein eigenes Modell lohnt nur, wenn das Hauptmodell
   * keine Bilder kann.
   */
  visionModel: z.string().default(""),

  freeTextMinChars: z.coerce.number().int().nonnegative().default(600),
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

export type CoverSource = Config["coverSource"];

/**
 * Welche Titelbild-Quellen erlaubt sind.
 *
 * Hier stand frueher `coverSource.includes("ai")` - und das ist eine Falle:
 * In "thumb-n-ai-l" steckt die Zeichenfolge "ai". Mit COVER_SOURCE=thumbnail
 * wurde deshalb doch das (kostenpflichtige) Bildmodell angefragt, sobald kein
 * Vorschaubild da war. Nur weil IMAGE_MODEL leer war, fiel es nicht auf.
 *
 * Deshalb: aufzaehlen statt in Zeichenketten suchen.
 */
export function coverWants(source: CoverSource): { thumbnail: boolean; ai: boolean } {
  return {
    thumbnail: source === "thumbnail" || source === "thumbnail+ai",
    ai: source === "ai" || source === "thumbnail+ai",
  };
}

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
    coverSource: process.env.COVER_SOURCE,
    imageModel: process.env.IMAGE_MODEL,
    transcribeProvider: process.env.TRANSCRIBE_PROVIDER,
    whisperModel: process.env.WHISPER_MODEL,
    whisperComputeType: process.env.WHISPER_COMPUTE_TYPE,
    maxPhotosPerJob: process.env.MAX_PHOTOS_PER_JOB,
    maxPhotoBytes: process.env.MAX_PHOTO_BYTES,
    visionChunkSize: process.env.VISION_CHUNK_SIZE,
    deletePhotosAfterSuccess: process.env.DELETE_PHOTOS_AFTER_SUCCESS,
    photoRetentionDays: process.env.PHOTO_RETENTION_DAYS,
    visionModel: process.env.VISION_MODEL,
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
