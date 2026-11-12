import { describe, it, expect } from "vitest";
import { pickPerLink, similarTitles } from "../src/migrate/dedupe.ts";
import type { Job } from "../src/jobs/store.ts";

const job = (id: string, url: string, mealieSlug: string | null = null) =>
  ({ id, url, mealieSlug }) as unknown as Job;

describe("pickPerLink", () => {
  it("nimmt je Link die neueste Fassung", () => {
    // Neueste zuerst, wie listJobs sie liefert.
    const { nehmen, aeltere } = pickPerLink([job("neu", "u1"), job("alt", "u1"), job("b", "u2")]);
    expect(nehmen.map((j) => j.id)).toEqual(["neu", "b"]);
    expect(aeltere.map((j) => j.id)).toEqual(["alt"]);
  });

  it("bevorzugt die Fassung, die schon in Mealie steht", () => {
    const { nehmen } = pickPerLink([job("neu", "u1"), job("in-mealie", "u1", "karotten")]);
    expect(nehmen.map((j) => j.id)).toEqual(["in-mealie"]);
  });

  it("fasst Fotos und Diktate ohne Link nicht zusammen", () => {
    const { nehmen } = pickPerLink([job("f1", ""), job("f2", "")]);
    expect(nehmen).toHaveLength(2);
  });
});

describe("similarTitles", () => {
  it("findet Schreibvarianten", () => {
    expect(
      similarTitles(["Risoni Hähnchenblech", "Risoni-Hähnchenblech", "Pulled Beef", "Biga Pizza"]),
    ).toEqual([["Risoni Hähnchenblech", "Risoni-Hähnchenblech"]]);
  });
});
