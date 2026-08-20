import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await createApp({ config });
const server = app.listen(config.port, () => {
  console.log(`Company AI Hub listening on http://localhost:${config.port}`);
});
server.requestTimeout = 11 * 60_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.on("error", (error) => {
  console.error("Company AI Hub server error", error);
  process.exitCode = 1;
});
