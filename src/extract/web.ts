import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { findRecipe, recipeToText, type JsonLdRecipe } from "./jsonld.ts";

export interface WebPage {
  title?: string;
  /** Aus <link rel="canonical"> - Blogs haengen gern Kampagnen-Parameter an. */
  canonicalUrl?: string;
  text: string;
  /** Gesetzt, wenn die Seite ein schema.org/Recipe mitliefert. */
  jsonLd?: JsonLdRecipe;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function fetchPage(url: string, timeoutMs = 30_000): Promise<WebPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`Die Seite antwortete mit HTTP ${res.status} (${res.statusText}).`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("xml")) {
      throw new Error(`Die URL liefert kein HTML, sondern "${type}".`);
    }
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  return parsePage(html, url);
}

/** Getrennt von fetchPage, damit es sich ohne Netzwerk testen laesst. */
/** Liest <link rel="canonical"> und akzeptiert nur absolute http(s)-Adressen. */
export function findCanonicalUrl(html: string): string | undefined {
  const m = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html);
  if (!m) return undefined;
  const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1]?.trim();
  if (!href) return undefined;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? href : undefined;
  } catch {
    return undefined;
  }
}

export function parsePage(html: string, url: string): WebPage {
  const canonicalUrl = findCanonicalUrl(html);
  const jsonLd = findRecipe(html);
  if (jsonLd) {
    return { title: jsonLd.name, text: recipeToText(jsonLd), jsonLd, canonicalUrl };
  }

  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim();

  try {
    const article = new Readability(document as never).parse();
    const text = article?.textContent?.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text) return { title: article?.title?.trim() || title, text, canonicalUrl };
  } catch {
    // Readability scheitert an manchen Seiten - dann eben der rohe Body.
  }

  const body = document.querySelector("body")?.textContent ?? "";
  return { title, text: body.replace(/\s+/g, " ").trim(), canonicalUrl };
}
