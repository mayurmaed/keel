import { describe, it, expect } from "vitest";
import { createLogicalDb, dropLogicalDb, PgFactory } from "../src/aws/pgadmin";

function fakePg() {
  const state = { connected: false, ended: false, queries: [] as string[] };
  const factory: PgFactory = () => ({
    connect: async () => {
      state.connected = true;
    },
    query: async (sql) => {
      state.queries.push(sql);
    },
    end: async () => {
      state.ended = true;
    },
  });
  return { state, factory };
}

describe("pgadmin", () => {
  it("createLogicalDb runs correct SQL sequence and ends client", async () => {
    const { state, factory } = fakePg();
    await createLogicalDb(factory, "postgresql://admin@localhost/postgres", "api", "abc123");
    expect(state.queries).toEqual([
      'DROP ROLE IF EXISTS "api"',
      'CREATE ROLE "api" LOGIN PASSWORD \'abc123\'',
      'GRANT "api" TO "admin"',
      'CREATE DATABASE "api" OWNER "api"',
    ]);
    expect(state.ended).toBe(true);
  });

  it("createLogicalDb throws for invalid database name before connecting", async () => {
    const { state, factory } = fakePg();
    await expect(
      createLogicalDb(factory, "postgresql://admin@localhost/postgres", "Bad-Name", "abc123")
    ).rejects.toThrow(/invalid database name/);
    expect(state.connected).toBe(false);
  });

  it("createLogicalDb throws for non-hex password before connecting", async () => {
    const { state, factory } = fakePg();
    await expect(
      createLogicalDb(factory, "postgresql://admin@localhost/postgres", "api", "p@ss'word")
    ).rejects.toThrow(/hex-only/);
    expect(state.connected).toBe(false);
  });

  it("createLogicalDb ends client even when query rejects", async () => {
    const state = { connected: false, ended: false, queries: [] as string[] };
    const factory: PgFactory = () => ({
      connect: async () => {
        state.connected = true;
      },
      query: async () => {
        throw new Error("query failed");
      },
      end: async () => {
        state.ended = true;
      },
    });
    await expect(
      createLogicalDb(factory, "postgresql://admin@localhost/postgres", "api", "abc123")
    ).rejects.toThrow("query failed");
    expect(state.ended).toBe(true);
  });

  it("dropLogicalDb runs correct SQL sequence and ends client", async () => {
    const { state, factory } = fakePg();
    await dropLogicalDb(factory, "postgresql://admin@localhost/postgres", "api");
    expect(state.queries).toEqual([
      'DROP DATABASE IF EXISTS "api" WITH (FORCE)',
      'DROP ROLE IF EXISTS "api"',
    ]);
    expect(state.ended).toBe(true);
  });
});
