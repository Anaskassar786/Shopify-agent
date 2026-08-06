/**
 * Schema barrel — every table and enum is re-exported here. drizzle.config.ts
 * points at this file for migration generation.
 */
export * from "./_common";
export * from "./merchant";
export * from "./billing";
export * from "./iam";
export * from "./shopify";
export * from "./shopify-data";
export * from "./analytics";
export * from "./ai";
export * from "./audit";
export * from "./notifications";
export * from "./jobs";
