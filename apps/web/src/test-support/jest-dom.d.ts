/**
 * jest-dom matcher typings for vitest ≥3.2. Vitest re-exports `Assertion`
 * from `@vitest/expect`, so module augmentation must target THAT module —
 * jest-dom's bundled `/vitest` entry only patches the re-export surface,
 * which no longer reaches call sites. Mirrors jest-dom's own augmentation
 * shape one-to-one (the `any` parameters are the documented matcher pattern).
 */
import "@vitest/expect";
import { type TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
