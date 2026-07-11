import { createServer } from "node:http";

const port = process.env.PORT ?? 3000;

async function dbCheck() {
  if (!process.env.DATABASE_URL) return "";
  try {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
