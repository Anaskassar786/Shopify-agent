import { and, eq } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { shopifySessions, stores } from "@profit/db";
import type { EncryptionService } from "@profit/crypto";
import type { Logger } from "@profit/logger";
import { shopifyPostJson, ShopifyHttpError } from "@profit/shopify";

/**
 * Centralized OFFLINE expiring Shopify credential service.
 * - Proactive refresh for expiring offline tokens
 * - Atomic persistence with optimistic concurrency (updatedAt)
 * - Migration path for existing non-expiring tokens
 * - Safe 401 recovery
 */

export interface OfflineCredential {
  readonly shopDomain: string;
  readonly accessToken: string;
}

export interface OfflineCredentialServiceDeps {
  readonly db: ProfitDb;
  readonly encryption: EncryptionService;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly logger: Logger;
}

interface ShopifyExpiringResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
}

const REFRESH_SAFETY_MS = 5 * 60 * 1000;

export class ShopifyReauthRequiredError extends Error {
  constructor(message = "SHOPIFY_REAUTH_REQUIRED") {
    super(message);
    this.name = "ShopifyReauthRequiredError";
  }
}

export class OfflineCredentialService {
  private readonly db: ProfitDb;
  private readonly encryption: EncryptionService;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly logger: Logger;

  constructor(deps: OfflineCredentialServiceDeps) {
    this.db = deps.db;
    this.encryption = deps.encryption;
    this.apiKey = deps.apiKey;
    this.apiSecret = deps.apiSecret;
    this.logger = deps.logger;
  }

  async getValidAccessToken(storeId: string): Promise<OfflineCredential> {
    const row = await this.loadSession(storeId);
    if (!row) {
      throw new Error(`no offline session for store ${storeId}`);
    }

    const now = Date.now();
    const exp = row.expiresAt ? row.expiresAt.getTime() : 0;

    if (exp === 0 || exp > now + REFRESH_SAFETY_MS) {
      const token = this.encryption.decrypt(row.accessTokenEncrypted);
      this.logger.debug({ storeId, hasRefresh: !!row.refreshTokenEncrypted }, "offline.credential.valid");
      return { shopDomain: row.shopDomain, accessToken: token };
    }

    if (!row.refreshTokenEncrypted) {
      throw new ShopifyReauthRequiredError();
    }

    return this.refresh(storeId, row);
  }

  private async loadSession(storeId: string) {
    const rows = await this.db
      .select({
        shopDomain: stores.shopDomain,
        accessTokenEncrypted: shopifySessions.accessTokenEncrypted,
        refreshTokenEncrypted: shopifySessions.refreshTokenEncrypted,
        expiresAt: shopifySessions.expiresAt,
        refreshTokenExpiresAt: shopifySessions.refreshTokenExpiresAt,
        updatedAt: shopifySessions.updatedAt,
      })
      .from(shopifySessions)
      .innerJoin(stores, eq(shopifySessions.storeId, stores.id))
      .where(
        and(
          eq(shopifySessions.storeId, storeId),
          eq(shopifySessions.sessionType, "OFFLINE"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async refresh(storeId: string, current: any): Promise<OfflineCredential> {
    const oldRefresh = this.encryption.decrypt(current.refreshTokenEncrypted!);
    const shop = current.shopDomain;

    let resp: ShopifyExpiringResponse;
    try {
      resp = await shopifyPostJson<ShopifyExpiringResponse>(
        `https://${shop}/admin/oauth/access_token`,
        {
          client_id: this.apiKey,
          client_secret: this.apiSecret,
          grant_type: "refresh_token",
          refresh_token: oldRefresh,
        },
        {},
      );
    } catch (err: any) {
      if (err instanceof ShopifyHttpError && err.status >= 400) {
        throw new ShopifyReauthRequiredError();
      }
      throw err;
    }

    const newAccessEnc = this.encryption.encrypt(resp.access_token);
    const newRefreshEnc = this.encryption.encrypt(resp.refresh_token);
    const newAccessExp = new Date(Date.now() + resp.expires_in * 1000);
    const newRefreshExp = new Date(Date.now() + resp.refresh_token_expires_in * 1000);
    const newScopes = resp.scope.split(",").map((s) => s.trim());

    const updated = await this.db
      .update(shopifySessions)
      .set({
        accessTokenEncrypted: newAccessEnc,
        refreshTokenEncrypted: newRefreshEnc,
        expiresAt: newAccessExp,
        refreshTokenExpiresAt: newRefreshExp,
        scopes: newScopes,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(shopifySessions.storeId, storeId),
          eq(shopifySessions.sessionType, "OFFLINE"),
          eq(shopifySessions.updatedAt, current.updatedAt),
        ),
      )
      .returning();

    if (updated.length === 0) {
      return this.getValidAccessToken(storeId);
    }

    this.logger.info({ storeId, shopDomain: shop }, "offline.credential.refreshed");
    return {
      shopDomain: shop,
      accessToken: this.encryption.decrypt(newAccessEnc),
    };
  }

  /**
   * PHASE 10: Migrate existing non-expiring OFFLINE token (irreversible on Shopify side).
   */
  async migrateExistingToExpiring(storeId: string): Promise<boolean> {
    const row = await this.loadSession(storeId);
    if (!row || row.refreshTokenEncrypted) return false;

    const oldAccess = this.encryption.decrypt(row.accessTokenEncrypted);
    const shop = row.shopDomain;

    let migrated: ShopifyExpiringResponse;
    try {
      migrated = await shopifyPostJson<ShopifyExpiringResponse>(
        `https://${shop}/admin/oauth/access_token`,
        {
          client_id: this.apiKey,
          client_secret: this.apiSecret,
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: oldAccess,
          subject_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
          requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
          expiring: "1",
        },
        {},
      );
    } catch {
      return false;
    }

    await this.db
      .update(shopifySessions)
      .set({
        accessTokenEncrypted: this.encryption.encrypt(migrated.access_token),
        refreshTokenEncrypted: this.encryption.encrypt(migrated.refresh_token),
        expiresAt: new Date(Date.now() + migrated.expires_in * 1000),
        refreshTokenExpiresAt: new Date(Date.now() + migrated.refresh_token_expires_in * 1000),
        scopes: migrated.scope.split(",").map((s) => s.trim()),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(shopifySessions.storeId, storeId),
          eq(shopifySessions.sessionType, "OFFLINE"),
        ),
      );

    this.logger.info({ storeId }, "offline.migrated_to_expiring");
    return true;
  }

  async forceRefreshIfPossible(storeId: string): Promise<boolean> {
    try {
      await this.getValidAccessToken(storeId);
      return true;
    } catch (e) {
      if (e instanceof ShopifyReauthRequiredError) return false;
      throw e;
    }
  }
}
