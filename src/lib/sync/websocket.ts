const WEBSOCKET_TEST_TIMEOUT_MS = 5_000;

/**
 * Probe the WebSocket upgrade path without joining a room. This catches a
 * reverse proxy that serves HTTP correctly but drops or rejects upgrades.
 */
export function testWebSocketConnection(
  wsUrl: string,
  timeoutMs = WEBSOCKET_TEST_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new Error("WebSocket is unavailable in this browser."));
      return;
    }

    let socket: WebSocket | undefined;
    let settled = false;

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (error) reject(error);
      else resolve();
    }

    const timer = setTimeout(
      () => finish(new Error(`WebSocket connection timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );

    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    socket.onopen = () => finish();
    socket.onerror = () => finish(new Error("WebSocket connection failed."));
    socket.onclose = () => {
      if (!settled) finish(new Error("WebSocket closed before connecting."));
    };
  });
}
