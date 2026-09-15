import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.ts";
import * as ytdlp from "./ytdlp.ts";
import { fetchPage } from "./web.ts";
import { looksLikeRecipe } from "./vtt.ts";
import { transcribe } from "../transcribe/index.ts";
import { isoDurationToMinutes } from "./jsonld.ts";

/** Woher der Text stammt - wandert in die Notion-Seite und die Web-App. */
export type TextSource =
  | "Untertitel"
  | "Auto-Untertitel"
  | "Videobeschreibung"
  | "Rezept-Metadaten der Seite"
  | "Seitentext"
  | "Transkription (lokal)"
  | "Transkription (Gemini)";

export interface ExtractResult {
  text: string;
  source: TextSource;
  /**
   * Die endgueltige Adresse, wie yt-dlp bzw. die Seite selbst sie nennt.
   *
   * Entscheidend fuer die Duplikat-Erkennung: Ein aus der TikTok-App geteilter
   * Kurzlink (vm.tiktok.com/XYZ) und die volle Adresse desselben Videos waeren
   * sonst zwei verschiedene Rezepte.
   */
  canonicalUrl?: string;
  /** Vorschaubild des Videos bzw. Bild der Seite - wird Notion-Titelbild. */
  thumbnailUrl?: string;
  title?: string;
  uploader?: string;
  durationSeconds?: number;
  hintMinutes?: number | null;
  /** true, wenn Whisper lief - fuer die Laufzeitanzeige. */
  transcribed: boolean;
}

export type ProgressFn = (step: string) => void;

export function detectPlatform(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "YouTube";
    if (/(^|\.)instagram\.com$/.test(host)) return "Instagram";
    if (/(^|\.)tiktok\.com$/.test(host)) return "TikTok";
    if (/(^|\.)facebook\.com$/.test(host)) return "Facebook";
    if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) return "X";
    if (/(^|\.)vimeo\.com$/.test(host)) return "Vimeo";
    return host;
  } catch {
    return "unbekannt";
  }
}

const VIDEO_HOSTS =
  /(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|vimeo\.com|dailymotion\.com|twitch\.tv)/i;

export function looksLikeVideoUrl(url: string): boolean {
  return VIDEO_HOSTS.test(url);
}

/**
 * Die Gratis-Kaskade: Untertitel und Beschreibung kosten nichts und sind sofort da.
 * Transkribiert wird nur, wenn davon nichts Brauchbares uebrig bleibt.
 */
export async function extract(url: string, onProgress: ProgressFn = () => {}): Promise<ExtractResult> {
  const cfg = getConfig();

  if (!looksLikeVideoUrl(url)) {
    onProgress("Seite wird gelesen");
    const page = await fetchPage(url);
    if (page.jsonLd) {
      return {
        text: page.text,
        source: "Rezept-Metadaten der Seite",
        canonicalUrl: page.canonicalUrl,
        thumbnailUrl: page.thumbnailUrl,
        title: page.title,
        hintMinutes: isoDurationToMinutes(page.jsonLd.totalTime),
        transcribed: false,
      };
    }
    if (page.text.length < 200) {
      throw new Error(
        "Auf der Seite war kaum Text zu finden. Lädt sie ihren Inhalt per JavaScript nach?",
      );
    }
    return {
      text: page.text,
      source: "Seitentext",
      canonicalUrl: page.canonicalUrl,
      thumbnailUrl: page.thumbnailUrl,
      title: page.title,
      transcribed: false,
    };
  }

  onProgress("Video-Infos werden geladen");
  const info = await ytdlp.probe(url);

  onProgress("Untertitel werden gesucht");
  const subs = await ytdlp.fetchSubtitles(url).catch((err: unknown) => {
    console.warn(`[untertitel] Abruf fehlgeschlagen: ${String(err)}`);
    return undefined;
  });

  const description = info.description?.trim() ?? "";
  const candidates: Array<{ text: string; source: TextSource }> = [];

  if (subs?.text) {
    candidates.push({ text: subs.text, source: subs.auto ? "Auto-Untertitel" : "Untertitel" });
  }
  // Bei TikTok und Reels steht das komplette Rezept oft in der Caption.
  if (description) candidates.push({ text: description, source: "Videobeschreibung" });

  for (const c of candidates) {
    if (c.text.length >= cfg.freeTextMinChars && looksLikeRecipe(c.text)) {
      // Beschreibung mitgeben, wenn sie zusaetzliche Mengen enthaelt.
      const combined =
        c.source !== "Videobeschreibung" && description.length > 80
          ? `${c.text}\n\n--- Videobeschreibung ---\n${description}`
          : c.text;
      return {
        text: combined,
        source: c.source,
        canonicalUrl: info.webpageUrl,
        thumbnailUrl: info.thumbnail,
        title: info.title,
        uploader: info.uploader,
        durationSeconds: info.durationSeconds,
        transcribed: false,
      };
    }
  }

  // Sichtbar machen, warum trotz vorhandenem Text transkribiert wird - sonst
  // raetselt man, weshalb ein Video mit Untertiteln zwei Minuten braucht.
  for (const c of candidates) {
    const grund =
      c.text.length < cfg.freeTextMinChars
        ? `nur ${c.text.length} Zeichen (Schwelle ${cfg.freeTextMinChars})`
        : "sieht nicht nach einem Rezept aus";
    console.log(`[extraktion] ${c.source} verworfen: ${grund}`);
  }

  onProgress("Tonspur wird heruntergeladen");
  const dir = await mkdtemp(join(tmpdir(), "rezept-"));
  try {
    const audioPath = await ytdlp.downloadAudio(url, dir);

    onProgress("Wird transkribiert");
    const result = await transcribe(audioPath);

    const parts = [result.text];
    if (description.length > 80) parts.push(`--- Videobeschreibung ---\n${description}`);

    return {
      text: parts.join("\n\n"),
      source: cfg.transcribeProvider === "gemini"
        ? "Transkription (Gemini)"
        : "Transkription (lokal)",
      canonicalUrl: info.webpageUrl,
      thumbnailUrl: info.thumbnail,
      title: info.title,
      uploader: info.uploader,
      durationSeconds: info.durationSeconds,
      transcribed: true,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
