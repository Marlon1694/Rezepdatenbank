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
  if (s.includes("sign in to confirm") || s.includes("bot")) {
    return (
      "YouTube hält den Server für einen Bot. Cookies hinterlegen (docs/cookies.md) " +
      "behebt das in aller Regel."
    );
  }
  if (s.includes("video unavailable") || s.includes("private video")) {
    return "Das Video ist nicht (mehr) öffentlich abrufbar.";
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

export async function selfUpdate(): Promise<void> {
  try {
    const { code, stdout } = await run(["-U"], 120_000);
    if (code === 0) console.log(`[yt-dlp] ${stdout.trim().split("\n").pop()}`);
  } catch (err) {
    console.warn(`[yt-dlp] Selbstupdate uebersprungen: ${String(err)}`);
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
  return {
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
  langs = ["de", "en"],
): Promise<{ text: string; lang: string; auto: boolean } | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "subs-"));
  try {
    const { code, stderr } = await run([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      [...langs, ...langs.map((l) => `${l}-orig`), ...langs.map((l) => `${l}.*`)].join(","),
      "--sub-format",
      "vtt/srt/best",
      "--convert-subs",
      "vtt",
      "--no-warnings",
      "--no-playlist",
      "-o",
      join(dir, "sub.%(ext)s"),
      ...cookieArgs(),
      url,
    ]);
    // Untertitel sind der schnellste Weg - schlaegt er fehl, laeuft stattdessen
    // Whisper und der Job dauert Minuten statt Sekunden. Deshalb nicht still
    // uebergehen, sondern den Grund protokollieren.
    if (code !== 0) {
      console.warn(`[untertitel] yt-dlp beendete sich mit ${code}: ${explainError(stderr)}`);
      return undefined;
    }

    const files = (await readdir(dir)).filter((f) => f.endsWith(".vtt"));
    if (!files.length) {
      const hint = stderr.trim().split("\n").slice(-3).join(" | ");
      console.warn(
        `[untertitel] keine Datei erhalten. Das Video hat entweder keine, oder ` +
          `YouTube verweigert sie ohne Cookies (siehe docs/cookies.md).` +
          (hint ? ` Letzte Meldung: ${hint}` : ""),
      );
      return undefined;
    }

    // Bevorzugung: gewuenschte Sprachreihenfolge, manuell vor automatisch.
    const score = (f: string): number => {
      const langIndex = langs.findIndex((l) => f.includes(`.${l}`));
      const base = langIndex === -1 ? langs.length : langIndex;
      return base * 2;
    };
    files.sort((a, b) => score(a) - score(b));

    const chosen = files[0];
    if (!chosen) return undefined;

    const raw = await readFile(join(dir, chosen), "utf8");
    const text = parseVtt(raw);
    if (!text) return undefined;

    const langMatch = /\.([a-z]{2}(?:-[A-Za-z]+)?)\.vtt$/.exec(chosen);
    return {
      text,
      lang: langMatch?.[1] ?? "?",
      auto: raw.includes("Kind: captions") && raw.includes("Language:"),
    };
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
