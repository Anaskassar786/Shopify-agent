import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals; @testing-library/react's auto-cleanup only
// activates when a global afterEach exists — wire it explicitly so renders
// never leak between tests.
afterEach(() => {
  cleanup();
});
