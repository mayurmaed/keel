import pg from "pg";
import { DB_NAME_RE } from "../config.js";

export interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
export type PgFactory = (url: string) => PgClient;

// ponytail: RDS's CA isn't in node's default bundle; TLS is still enforced on the wire.
// Import the RDS CA bundle if paranoia ever demands it.
export const realPg: PgFactory = (url) =>
  new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } }) as unknown as PgClient;

const HEX_RE = /^[0-9a-f]+$/;

function ident(name: string): string {
  if (!DB_NAME_RE.test(name)) throw new Error(`invalid database name "${name}" — lowercase letters, digits, underscores only`);
  return `"${name}"`;
}

export async function createLogicalDb(factory: PgFactory, adminUrl: string, name: string, password: string): Promise<void> {
  const id = ident(name);
  if (!HEX_RE.test(password)) throw new Error("db passwords must be hex-only (generated) — refusing to interpolate arbitrary strings into SQL");
  const c = factory(adminUrl);
  await c.connect();
  try {
    await c.query(`CREATE ROLE ${id} LOGIN PASSWORD '${password}'`);
    await c.query(`CREATE DATABASE ${id} OWNER ${id}`);
  } finally {
    await c.end();
  }
}

export async function dropLogicalDb(factory: PgFactory, adminUrl: string, name: string): Promise<void> {
  const id = ident(name);
  const c = factory(adminUrl);
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${id} WITH (FORCE)`);
    await c.query(`DROP ROLE IF EXISTS ${id}`);
  } finally {
    await c.end();
  }
}
