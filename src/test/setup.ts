import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Without this, React Testing Library never unmounts what a previous test
// rendered into document.body, so a later test's screen.findByText can
// match a stale element left over from an earlier `it()` in the same file
// (bit us in react.test.tsx: two tests both render an "enabled" status
// li — the second's query matched the first test's leftover DOM node).
afterEach(() => {
  cleanup();
});
