import { createServer } from "node:http";

const port = process.env.PORT ?? 3000;
createServer((req, res) => {
  res.end(`hello from keel${process.env.GREETING ? ` — ${process.env.GREETING}` : ""}\n`);
}).listen(port, () => console.log(`listening on ${port}`));
