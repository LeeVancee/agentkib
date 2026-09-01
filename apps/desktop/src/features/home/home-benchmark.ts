export type HomeBenchmarkOutcome = "pending" | "ready" | "failed";

interface QueryStatus {
  isError: boolean;
  isSuccess: boolean;
}

export function homeBenchmarkOutcome(queries: QueryStatus[]): HomeBenchmarkOutcome {
  if (queries.some((query) => query.isError)) return "failed";
  if (queries.every((query) => query.isSuccess)) return "ready";
  return "pending";
}
