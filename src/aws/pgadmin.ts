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
// sslmode in the URL is stripped because pg >= 8.16 treats sslmode=require as
// verify-full, overriding the explicit ssl option below — the URL keeps
// ?sslmode=require for psql/libpq consumers; node-pg gets ssl via the option.
export const realPg: PgFactory = (url) => {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } }) as unknown as PgClient;
};

const HEX_RE = /^[0-9a-f]+$/;

function ident(name: string): string {
  if (!DB_NAME_RE.test(name)) throw new Error(`invalid database name "${name}" — lowercase letters, digits, underscores only`);
  return `"${name}"`;
}

export async function createLogicalDb(factory: PgFactory, adminUrl: string, name: string, password: string): Promise<void> {
  const id = ident(name);
  if (!HEX_RE.test(password)) throw new Error("db passwords must be hex-only (generated) — refusing to interpolate arbitrary strings into SQL");
  const admin = ident(new URL(adminUrl).username); // validated like any identifier
  const c = factory(adminUrl);
  await c.connect();
  try {
    // DROP first: a partially-failed prior create leaves an ownerless role; keel's
    // registry duplicate-guard means a healthy db never reaches this path.
    await c.query(`DROP ROLE IF EXISTS ${id}`);
    await c.query(`CREATE ROLE ${id} LOGIN PASSWORD '${password}'`);
    // RDS master isn't superuser; PG16 requires SET ROLE rights to assign ownership.
    await c.query(`GRANT ${id} TO ${admin}`);
    await c.query(`CREATE DATABASE ${id} OWNER ${id}`);
  } finally {
    await c.end();
  }
}

// GoTrue queries its tables unqualified and tracks migrations in an unqualified `schema_migrations`,
// so its connection's search_path MUST be `auth`. pop (its ORM) drops URL `options`, so the only
// driver-independent way to set it is a role-level default. A dedicated role also keeps GoTrue's
// footprint to the auth schema it owns — the app keeps its own role, so a `public.users` can never
// collide with `auth.users`. Runs as the db master (has CREATEROLE); idempotent for re-creates.
export async function ensureAuthRole(
  factory: PgFactory, adminUrl: string, role: string, password: string,
): Promise<void> {
  if (!DB_NAME_RE.test(role)) throw new Error(`invalid auth role "${role}" — lowercase letters, digits, underscores only`);
  if (!HEX_RE.test(password)) throw new Error("gotrue role passwords must be hex-only (generated) — refusing to interpolate arbitrary strings into SQL");
  const r = `"${role}"`;
  const admin = ident(new URL(adminUrl).username);
  const c = factory(adminUrl);
  await c.connect();
  try {
    await c.query(
      `DO $$ BEGIN
         IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
           ALTER ROLE ${r} LOGIN PASSWORD '${password}';
         ELSE
           CREATE ROLE ${r} LOGIN PASSWORD '${password}';
         END IF;
       END $$`,
    );
    await c.query(`GRANT ${r} TO ${admin}`);           // PG16 needs membership to assign ownership
    await c.query(`CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ${r}`);
    await c.query(`ALTER SCHEMA auth OWNER TO ${r}`);  // idempotent: own it even if it pre-existed
    await c.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
    await c.query(`ALTER ROLE ${r} SET search_path = auth, public`);
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
