import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7: `directUrl` no longer exists. The URL here is used only by the
// Prisma CLI (migrate, db execute, studio), so it is the DIRECT connection
// (Neon host without "-pooler"): migrations must not go through the pooler.
// The app connects with the pooled DATABASE_URL through the driver adapter in
// lib/db.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DIRECT_URL ?? "",
  },
});
