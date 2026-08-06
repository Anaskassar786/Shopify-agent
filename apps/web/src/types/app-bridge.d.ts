/**
 * App Bridge v4 (CDN build) global — narrow typed subset of the documented
 * surface this app consumes. The official CDN script auto-initializes from
 * the shopify-api-key meta tag; we only ever call idToken().
 */
export {};

declare global {
  interface Window {
    shopify?: {
      /** Current session token for backend verification (JWT, ~60s TTL). */
      idToken: () => Promise<string>;
    };
  }
}
