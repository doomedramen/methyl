/**
 * Change notifications from the sync server (spec item 7): the server
 * streams a Server-Sent Event for every new change-log entry, so a client
 * can run a sync round straight away instead of waiting for its next poll.
 *
 * Read with fetch() rather than EventSource so the request can carry the
 * Authorization header. Reconnects with backoff until the signal aborts.
 */
export interface ChangeEvent {
  seq: number;
}

export function subscribeToChanges(options: {
  url: string;
  headers?: Record<string, string>;
  onChange: (event: ChangeEvent) => void;
  signal: AbortSignal;
  /** Called when the stream connects, e.g. to catch up on anything missed. */
  onConnect?: () => void;
  /** Called when a connected stream drops (it reconnects by itself). */
  onDisconnect?: () => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { url, headers, onChange, signal, onConnect, onDisconnect } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  let delay = 500;

  const connectOnce = async (): Promise<void> => {
    const response = await fetchImpl(url, { headers: { ...headers, accept: "text/event-stream" }, signal });
    if (!response.ok || !response.body) throw new Error(`events: HTTP ${response.status}`);
    delay = 500;
    onConnect?.();
    try {
      await readEvents(response.body, onChange);
    } finally {
      onDisconnect?.();
    }
  };

  const readEvents = async (body: ReadableStream<Uint8Array>, emit: (event: ChangeEvent) => void) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (!data) continue; // a comment / keepalive
        try {
          const parsed = JSON.parse(data) as Partial<ChangeEvent>;
          if (typeof parsed.seq === "number") emit({ seq: parsed.seq });
        } catch {
          // ignore a malformed frame
        }
      }
    }
  };

  return (async () => {
    while (!signal.aborted) {
      try {
        await connectOnce();
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}
