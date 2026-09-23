import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { VenueSocket } from "./venue-socket";

test("between a dropped socket and its reconnect, ready() says no so sends fall back to HTTP", async () => {
  const clients = new Set<ServerWebSocket<unknown>>();
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: { open: (ws) => void clients.add(ws), close: (ws) => void clients.delete(ws), message() {} },
  });
  const socket = new VenueSocket(`ws://localhost:${server.port}`);
  try {
    socket.start();
    expect(await socket.ready(1000)).toBe(true);
    for (const ws of clients) ws.close();
    const end = Date.now() + 1000;
    while (socket.connected && Date.now() < end) await Bun.sleep(2);
    expect(socket.connected).toBe(false);
    // The reconnect waits a backoff of at least 250ms; until then there is nothing to send on.
    expect(await socket.ready(0)).toBe(false);
    // And it does come back.
    expect(await socket.ready(2000)).toBe(true);
  } finally {
    socket.stop();
    server.stop(true);
  }
});
