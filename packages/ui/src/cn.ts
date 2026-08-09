/** Tiny className combiner (truthy values joined; duplicates tolerated). */
export function cn(...values: ReadonlyArray<string | false | null | undefined>): string {
  return values.filter((v): v is string => typeof v === "string" && v.length > 0).join(" ");
}
