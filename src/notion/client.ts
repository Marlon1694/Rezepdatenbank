import { Client } from "@notionhq/client";
import { getConfig } from "../config.ts";

/**
 * Seit Notion-API 2025-09-03 (Default im SDK v5) haengen Seiten nicht mehr an einer
 * database_id, sondern an einer data_source_id. Eine Datenbank ist jetzt ein Behaelter
 * fuer eine oder mehrere Datenquellen. Dieses Modul loest das einmal auf und merkt
 * sich das Ergebnis.
 */

export type PropertyKind =
  | "title"
  | "rich_text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "url"
  | "date"
  | "checkbox"
  | "people"
  | "files"
  | "relation"
  | "formula"
  | "rollup"
  | "created_time"
  | "last_edited_time"
  | (string & {});

export interface PropertyInfo {
  name: string;
  type: PropertyKind;
  /** Bestehende Optionen bei select / multi_select / status - Basis fuer den Tag-Abgleich. */
  options: string[];
}

export interface DataSourceSchema {
  dataSourceId: string;
  databaseTitle: string;
  properties: PropertyInfo[];
}

let client: Client | undefined;

export function getNotion(): Client {
  if (!client) client = new Client({ auth: getConfig().notionToken });
  return client;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
let schemaCache: { value: DataSourceSchema; at: number } | undefined;

export async function getDataSourceSchema(force = false): Promise<DataSourceSchema> {
  if (!force && schemaCache && Date.now() - schemaCache.at < CACHE_TTL_MS) {
    return schemaCache.value;
  }

  const notion = getNotion();
  const databaseId = getConfig().notionDatabaseId;

  const database = await notion.databases.retrieve({ database_id: databaseId });

  const references = "data_sources" in database ? database.data_sources : [];
  const first = references[0];
  if (!first) {
    throw new Error(
      `Die Notion-Datenbank ${databaseId} hat keine Datenquelle. Ist die Integration ` +
        `wirklich mit ihr verbunden? Siehe docs/notion.md.`,
    );
  }
  if (references.length > 1) {
    console.warn(
      `[notion] Datenbank hat ${references.length} Datenquellen. Es wird die erste ` +
        `benutzt: "${first.name}". Bei Bedarf in src/notion/client.ts anpassen.`,
    );
  }

  const dataSource = await notion.dataSources.retrieve({ data_source_id: first.id });

  const properties: PropertyInfo[] = Object.entries(dataSource.properties ?? {}).map(
    ([name, prop]) => {
      const p = prop as Record<string, unknown> & { type: string };
      const container = p[p.type] as { options?: Array<{ name: string }> } | undefined;
      return {
        name,
        type: p.type,
        options: container?.options?.map((o) => o.name) ?? [],
      };
    },
  );

  // GetDataSourceResponse ist eine Union; die schmale Variante hat kein title.
  const titleProp = "title" in dataSource ? dataSource.title : undefined;
  const databaseTitle =
    Array.isArray(titleProp) && titleProp.length > 0
      ? titleProp.map((t) => ("plain_text" in t ? t.plain_text : "")).join("")
      : first.name || "(ohne Titel)";

  const value: DataSourceSchema = { dataSourceId: first.id, databaseTitle, properties };
  schemaCache = { value, at: Date.now() };
  return value;
}

export function clearSchemaCache(): void {
  schemaCache = undefined;
}
