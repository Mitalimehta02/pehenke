import { describe, expect, it } from "vitest";
import { summariseHealth } from "./healthSummary";

const base = { missing: [], notSet: [], database: "ok" as const, pending: 0, failed: 0 };

describe("summariseHealth", () => {
  it("ok when variables are set, the database answers and nothing is pending", () => {
    expect(summariseHealth(base)).toEqual({ status: "ok", problems: [], env: "ok", database: "ok", migrations: "ok", blocking: false });
  });

  it("degraded and blocking when a required variable is missing: names only", () => {
    const h = summariseHealth({ ...base, missing: ["YOUCAM_API_KEY", "DATABASE_URL"], database: null, pending: null });
    expect(h).toMatchObject({ status: "degraded", env: "missing: YOUCAM_API_KEY, DATABASE_URL", database: "not checked", blocking: true });
    expect(h.problems).toEqual(["required variables not set: YOUCAM_API_KEY, DATABASE_URL"]);
  });

  it("degraded and blocking when migrations are pending or failed (the case that broke the live site)", () => {
    expect(summariseHealth({ ...base, pending: 2 })).toMatchObject({ status: "degraded", migrations: "2 pending", problems: ["migrations: 2 pending"], blocking: true });
    expect(summariseHealth({ ...base, failed: 1, pending: 1 })).toMatchObject({ migrations: "1 failed", blocking: true });
  });

  it("degraded but not blocking when the database is unreachable: it may only be asleep", () => {
    const h = summariseHealth({ ...base, database: "unreachable", pending: null });
    expect(h).toMatchObject({ status: "degraded", database: "unreachable", migrations: "unknown (database not reachable)", blocking: false });
    expect(h.problems).toEqual(["database unreachable"]);
  });

  it("optional variables that are not set are named, without making it degraded", () => {
    expect(summariseHealth({ ...base, notSet: ["DIRECT_URL", "ADMIN_SECRET"] })).toMatchObject({ status: "ok", env: "ok (optional, not set: DIRECT_URL, ADMIN_SECRET)" });
  });
});
