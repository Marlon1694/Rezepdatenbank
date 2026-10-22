import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.ts";
import { parseVtt } from "./vtt.ts";

export interface MediaInfo {
  title?: string;
  description?: string;
  uploader?: string;
  durationSeconds?: number;
  thumbnail?: string;
  webpageUrl?: string;
  extractor?: string;
  /** Vom Video gemeldete Sprache - bei Auto-Untertiteln die Originalspur. */
  language?: string;
  /** Sprachen mit echten, vom Kanal hinterlegten Untertiteln. */
  subtitleLangs: string[];
  /** Sprachen mit automatisch erzeugten Untertiteln. */
  autoCaptionLangs: string[];
}

export interface SubtitleChoice {
  lang: string;
  auto: boolean;
}

/**
 * Waehlt GENAU EINE Untertitelspur aus dem, was das Video wirklich anbietet.
 *
 * Vorher wurden pauschal sechs Varianten angefragt (de, en, de-orig, en-orig,
 * de.*, en.*). Jede davon ist eine eigene Anfrage an YouTubes Untertitel-
 * Endpunkt, und der antwortet darauf zuverlaessig mit "429 Too Many Requests".
 * Eine einzige, gezielte Anfrage laeuft durch.
 *
 * Bei Auto-Untertiteln steht die Sprache des Videos vorn: YouTube bietet dort
 * Hunderte Uebersetzungsziele an, aber nur die Originalspur ist nicht selbst
 * schon maschinell uebersetzt.
 */
export function pickSubtitleLanguage(
  info: Pick<MediaInfo, "language" | "subtitleLangs" | "autoCaptionLangs">,
  preferred: string[] = ["de", "en"],
): SubtitleChoice | undefined {
  const basis = (l: string) => l.replace(/-orig$/i, "").split("-")[0]?.toLowerCase() ?? "";
  const eigene = info.language ? basis(info.language) : "";

  /**
   * Bei Auto-Untertiteln geht "-orig" vor: YouTube fuehrt die Originalspur
   * eines deutschen Videos als "de-orig", waehrend das schlichte "de" eine
   * Rueckuebersetzung sein kann - also Maschine auf Maschine. Bei echten
   * Untertiteln gibt es kein "-orig", dort zaehlt der genaue Treffer.
   */
  const waehle = (
    verfuegbar: string[],
    reihenfolge: string[],
    origZuerst: boolean,
  ): string | undefined => {
    for (const wunsch of reihenfolge) {
      if (!wunsch) continue;
      const genau = () => verfuegbar.find((v) => v.toLowerCase() === wunsch);
      const orig = () => verfuegbar.find((v) => v.toLowerCase() === `${wunsch}-orig`);

      const treffer = origZuerst ? (orig() ?? genau()) : (genau() ?? orig());
      if (treffer) return treffer;

      // Regionalvariante wie "de-DE" als letzte Stufe.
      const nahe = verfuegbar.find((v) => basis(v) === wunsch);
      if (nahe) return nahe;
    }
    return undefined;
  };

  // Echte Untertitel sind immer besser als automatische.
  const manuell = waehle(info.subtitleLangs, [...preferred, eigene], false);
  if (manuell) return { lang: manuell, auto: false };

  const automatisch = waehle(info.autoCaptionLangs, [eigene, ...preferred], true);
  if (automatisch) return { lang: automatisch, auto: true };

  return undefined;
}

export class YtDlpError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "YtDlpError";
  }
}

function cookieArgs(): string[] {
  const file = getConfig().cookiesFile;
  return file && existsSync(file) ? ["--cookies", file] : [];
}

function run(
  args: string[],
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new YtDlpError(`yt-dlp hat nach ${timeoutMs / 1000}s nicht geantwortet.`, stderr));
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new YtDlpError(
          `yt-dlp nicht gefunden oder nicht startbar (${err.message}). ` +
            `Im Container ist es installiert; lokal: pipx install yt-dlp`,
          stderr,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/**
 * Uebersetzt die typischen yt-dlp-Fehler in etwas, das in der Web-App weiterhilft.
 * Ohne das steht dort ein 40-zeiliger Python-Trace.
 */
export function explainError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("login required") || s.includes("requested content is not available") ||
      s.includes("rate-limit reached") || s.includes("empty media response")) {
    return (
      "Die Plattform verlangt einen Login. Hinterlege Cookies unter config/cookies.txt " +
      "— siehe docs/cookies.md. Bei Instagram ist das inzwischen fast immer nötig."
    );
  }
  // "bot" nur als ganzes Wort: "both audio and video streams unavailable" ist
  // kein Bot-Verdacht, fuehrte aber genau zu dieser Meldung.
  if (s.includes("sign in to confirm") || /\bbots?\b/.test(s)) {
    return (
      "YouTube hält den Server für einen Bot. Cookies hinterlegen (docs/cookies.md) " +
      "behebt das in aller Regel."
    );
  }
  if (s.includes("video unavailable") || s.includes("private video")) {
    return "Das Video ist nicht (mehr) öffentlich abrufbar.";
  }
  if (s.includes("unexpected response from webpage request")) {
    return (
      "TikTok hat die Anfrage abgewiesen. Das passiert, wenn yt-dlp keinen " +
      "Browser-Fingerabdruck vorweisen kann oder der Extraktor veraltet ist. " +
      "Prüfen mit:  docker compose exec app yt-dlp --list-impersonate-targets"
    );
  }
  if (s.includes("unsupported url")) {
    return "Diese Seite kennt yt-dlp nicht. Sie wird stattdessen als Webseite gelesen.";
  }
  if (s.includes("http error 404")) return "Die URL existiert nicht (404).";
  const firstError = stderr
    .split("\n")
    .find((l) => l.startsWith("ERROR:"))
    ?.replace(/^ERROR:\s*/, "");
  return firstError?.trim() || "yt-dlp konnte die Seite nicht verarbeiten.";
}

export async function isAvailable(): Promise<boolean> {
  try {
    const { code } = await run(["--version"], 15_000);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Aktualisiert yt-dlp ueber pip.
 *
 * Nicht ueber "yt-dlp -U": bei einer pip-Installation prueft das zwar die
 * GitHub-Releases, ersetzt sich aber nicht selbst - es meldet brav "is up to
 * date" und aendert nichts. Genau daran scheiterte die Aktualisierung bisher
 * unbemerkt.
 */
export async function selfUpdate(): Promise<void> {
  const channel = getConfig().ytdlpChannel;
  const args = [
    "install",
    "--upgrade",
    "--no-cache-dir",
    ...(channel === "nightly" ? ["--pre"] : []),
    "yt-dlp[default,curl-cffi,deno]",
  ];

  await new Promise<void>((resolve) => {
    const child = spawn("pip", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));

    child.on("error", (err) => {
      console.warn(`[yt-dlp] Aktualisierung übersprungen: ${err.message}`);
      resolve();
    });
    child.on("close", async (code) => {
      if (code === 0) {
        const version = await run(["--version"], 15_000).catch(() => undefined);
        console.log(
          `[yt-dlp] Kanal ${channel}, Version ${version?.stdout.trim() || "unbekannt"}`,
        );
      } else {
        console.warn(
          `[yt-dlp] Aktualisierung fehlgeschlagen: ${out.trim().split("\n").pop()}`,
        );
      }
      resolve();
    });
  });
}

/**
 * Meldet, ob eine JavaScript-Laufzeit da ist.
 *
 * YouTube verlangt fuer seine Untertitel einen Token, den nur der mitgelieferte
 * Challenge-Loeser errechnen kann - und der braucht Deno. Fehlt es, bleiben
 * Titel und Beschreibung abrufbar, die Untertitel aber nicht. Der Fehler sieht
 * dann aus, als haette das Video gar keine.
 */
export async function hasJsRuntime(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("deno", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Meldet, ob Browser-Fingerabdruecke verfuegbar sind - TikTok braucht sie. */
export async function hasImpersonation(): Promise<boolean> {
  try {
    const { stdout } = await run(["--list-impersonate-targets"], 20_000);
    // Ohne curl_cffi steht hinter jedem Ziel "(unavailable)".
    return stdout.split("\n").some((l) => /curl_cffi/.test(l) && !/unavailable/.test(l));
  } catch {
    return false;
  }
}

/** Metadaten ohne Download. */
export async function probe(url: string): Promise<MediaInfo> {
  const { stdout, stderr, code } = await run([
    "-J",
    "--no-warnings",
    "--no-playlist",
    ...cookieArgs(),
    url,
  ]);
  if (code !== 0) throw new YtDlpError(explainError(stderr), stderr);

  const data = JSON.parse(stdout) as Record<string, unknown>;
  const keysOf = (v: unknown): string[] =>
    v && typeof v === "object" ? Object.keys(v as Record<string, unknown>) : [];

  return {
    language: typeof data.language === "string" ? data.language : undefined,
    subtitleLangs: keysOf(data.subtitles),
    autoCaptionLangs: keysOf(data.automatic_captions),
    title: typeof data.title === "string" ? data.title : undefined,
    description: typeof data.description === "string" ? data.description : undefined,
    uploader: typeof data.uploader === "string" ? data.uploader : undefined,
    durationSeconds: typeof data.duration === "number" ? data.duration : undefined,
    thumbnail: typeof data.thumbnail === "string" ? data.thumbnail : undefined,
    webpageUrl: typeof data.webpage_url === "string" ? data.webpage_url : undefined,
    extractor: typeof data.extractor_key === "string" ? data.extractor_key : undefined,
  };
}

/**
 * Untertitel holen - der schnellste und billigste Weg an ein Transkript.
 * Bevorzugt echte Untertitel, faellt auf Auto-Captions zurueck.
 */
export async function fetchSubtitles(
  url: string,
  choice: SubtitleChoice,
): Promise<{ text: string; lang: string; auto: boolean } | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "subs-"));
  try {
    const { code, stderr } = await run([
      "--skip-download",
      // Genau eine Spur. Jede weitere ist eine eigene Anfrage an YouTubes
      // Untertitel-Endpunkt und provoziert HTTP 429.
      choice.auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs",
      choice.lang,
      "--sub-format",
      "vtt/srt/best",
      "--convert-subs",
      "vtt",
      // Kurz Luft lassen - YouTube drosselt schnelle Folgeanfragen.
      "--sleep-requests",
      "1",
      "--no-warnings",
      "--no-playlist",
      "-o",
      join(dir, "sub.%(ext)s"),
      ...cookieArgs(),
      url,
    ]);

    // Erst nachsehen, ob trotzdem etwas ankam. yt-dlp beendet sich mit 1, sobald
    // IRGENDEINE angeforderte Spur scheitert - fruehr wurde deshalb auch eine
    // erfolgreich geladene Datei weggeworfen.
    const files = (await readdir(dir)).filter((f) => f.endsWith(".vtt"));

    if (!files.length) {
      const grund =
        code !== 0
          ? explainError(stderr)
          : "Das Video liefert für diese Sprache keine Datei.";
      console.warn(`[untertitel] ${choice.lang} (${choice.auto ? "automatisch" : "manuell"}): ${grund}`);
      return undefined;
    }

    if (code !== 0) {
      console.warn(
        `[untertitel] yt-dlp meldete einen Fehler, lieferte die Datei aber trotzdem - wird verwendet.`,
      );
    }

    const chosen = files[0];
    if (!chosen) return undefined;

    const raw = await readFile(join(dir, chosen), "utf8");
    const text = parseVtt(raw);
    if (!text) {
      console.warn(`[untertitel] ${chosen} enthielt keinen verwertbaren Text.`);
      return undefined;
    }

    console.log(
      `[untertitel] ${choice.lang} (${choice.auto ? "automatisch" : "manuell"}), ` +
        `${text.length} Zeichen`,
    );
    return { text, lang: choice.lang, auto: choice.auto };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Laedt die Tonspur und komprimiert sie zu 16 kHz Mono Opus. Whisper arbeitet ohnehin
 * mit 16 kHz, und ein 30-Minuten-Video landet so bei wenigen Megabyte - relevant, falls
 * die Datei doch einmal an eine API geht (25-MB-Limit).
 */
export async function downloadAudio(url: string, targetDir: string): Promise<string> {
  const out = join(targetDir, "audio.%(ext)s");
  const { stderr, code } = await run(
    [
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "opus",
      "--audio-quality",
      "0",
      "--postprocessor-args",
      "ExtractAudio:-ac 1 -ar 16000",
      "--no-warnings",
      "--no-playlist",
      "-o",
      out,
      ...cookieArgs(),
      url,
    ],
    600_000,
  );
  if (code !== 0) throw new YtDlpError(explainError(stderr), stderr);

  const files = (await readdir(targetDir)).filter((f) => f.startsWith("audio."));
  const audio = files.find((f) => f.endsWith(".opus")) ?? files[0];
  if (!audio) throw new YtDlpError("Die Tonspur konnte nicht extrahiert werden.", stderr);
  return join(targetDir, audio);
}
