/**
 * Turns the raw health facts into what /api/health reports. Pure, so it is
 * tested without a server. Only variable NAMES and counts appear, never values.
 */

export interface HealthFacts {
  /** required variables that are not set (names) */
  missing: string[];
  /** optional variables that are not set (names) */
  notSet: string[];
  /** null = not checked (no connection string to check with) */
  database: "ok" | "unreachable" | null;
  /** migrations in the code that the database doesn't have; null when the database couldn't be read */
  pending: number | null;
  /** migrations recorded as failed or rolled back */
  failed: number;
}

export interface HealthSummary {
  status: "ok" | "degraded";
  problems: string[];
  env: string;
  database: "ok" | "unreachable" | "not checked";
  migrations: string;
  /** a deploy in this state can't work: answer 503 so the host keeps the previous version and monitors alarm */
  blocking: boolean;
}

export function summariseHealth(f: HealthFacts): HealthSummary {
  const problems: string[] = [];
  if (f.missing.length) problems.push(`required variable${f.missing.length === 1 ? "" : "s"} not set: ${f.missing.join(", ")}`);
  const database = f.database ?? "not checked";
  if (database === "unreachable") problems.push("database unreachable");
  let migrations = "ok";
  if (database !== "ok") migrations = "unknown (database not reachable)";
  else if (f.failed) migrations = `${f.failed} failed`;
  else if (f.pending) migrations = `${f.pending} pending`;
  const migrationProblem = database === "ok" && migrations !== "ok";
  if (migrationProblem) problems.push(`migrations: ${migrations}`);
  return {
    status: problems.length ? "degraded" : "ok",
    problems,
    env: f.missing.length ? `missing: ${f.missing.join(", ")}` : f.notSet.length ? `ok (optional, not set: ${f.notSet.join(", ")})` : "ok",
    database,
    migrations,
    // a database that is asleep or briefly unreachable must not make the host restart the server
    blocking: f.missing.length > 0 || migrationProblem,
  };
}
