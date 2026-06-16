import "dotenv/config";
import { createApp } from "./app";
import { logEnvWarnings } from "./env";
import { startPfProgressSubscriber } from "./services/progressSubscriber";

const PORT = parseInt(
  process.env.PORT || process.env.BACKEND_PORT || "3001",
  10
);

logEnvWarnings();

const app = createApp();
const server = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Backend listening on port ${PORT}`);
});

startPfProgressSubscriber();

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 7_200_000;
server.timeout = 0;
