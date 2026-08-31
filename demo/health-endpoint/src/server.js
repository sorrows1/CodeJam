import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createServer() {
  return http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("health endpoint fixture\n");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3001);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`health fixture listening on ${port}`);
  });
}
