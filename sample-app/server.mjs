import { createServer } from "node:http";

const port = process.env.PORT ?? 3000;

async function dbCheck() {
  if (!process.env.DATABASE_URL) return "";
  try {
    const { default: pg } = await import("pg");
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.delete("sslmode"); // pg >= 8.16 treats sslmode=require as verify-full; ssl option below governs
    const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query("SELECT 1");
    await c.end();
    return " — db ok";
  } catch (e) {
    return ` — db error: ${e.message}`;
  }
}

createServer(async (req, res) => {
  const db = await dbCheck();
  res.end(`hello from keel${process.env.GREETING ? ` — ${process.env.GREETING}` : ""}${db}\n`);
}).listen(port, () => console.log(`listening on ${port}`));
