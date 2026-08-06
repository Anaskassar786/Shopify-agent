import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  billingEvents,
  plans,
  shopifyOauthStates,
  shopifySessions,
  storeSettings,
  stores,
  subscriptions,
} from "@profit/db";
import { BillingEventType, PlanCode, StoreStatus, SubscriptionStatus } from "@profit/types";
import { withStoreScope } from "@profit/db";
import type { EncryptionService } from "@profit/crypto";
import {
  AuthenticationError,
  ShopifyApiError,
  ValidationError,
} from "../../lib/errors";
import type { Logger } from "@profit/logger";
import { verifyOauthQueryHmac, type QueryParams } from "@profit/shopify";
import { shopifyGraphql, shopifyPostJson, ShopifyHttpError } from "@profit/shopify";
import { sanitizeShopDomain } from "@profit/shopify";
import type { AuditService } from "../audit/audit.service";

/**
 * Shopify OAuth (P2: OAuth 2.0, offline tokens; P5: state validation, replay
 * protection). Flow ownership: this service is the ONLY component allowed to
 * write platform-level store rows (outside tenant scope) — provisioning is a
 * platform act, everything afterwards is tenant-scoped.
 */

export interface ShopifyOauthConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly appUrl: string;
  readonly scopes: string;
  readonly apiVersion: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

const SHOP_PROFILE_QUERY = `
  query ShopProfile {
    shop {
      id
      name
      email
      currencyCode
      ianaTimezone
      myshopifyDomain
    }
  }
`;

interface ShopProfileResponse {
  shop: {
    id: string;
    name: string;
    email: string | null;
    currencyCode: string;
    ianaTimezone: string | null;
    myshopifyDomain: string;
  };
}

interface AccessTokenResponse {
  access_token: string;
  scope: string;
}

export interface OnlineTokenExchangeResult {
  readonly accessToken: string;
  readonly scope: string;
  readonly expiresAt: Date;
  readonly associatedUser: {
    readonly id: number;
    readonly email: string | null;
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly accountOwner: boolean;
    readonly locale: string | null;
  } | null;
}

interface OnlineTokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
  associated_user?: {
    id: number;
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    account_owner?: boolean;
    locale?: string | null;
  };
}

export interface OauthServiceDeps {
  readonly db: ProfitDb;
  readonly encryption: EncryptionService;
  readonly config: ShopifyOauthConfig;
  readonly audit: AuditService;
  readonly logger: Logger;
  /**
   * Post-provisioning fan-out (M2): fired once provisioning commits. Used to
   * schedule the initial full sync + webhook reconciliation. Errors inside the
   * hook are logged, never rethrown — a scheduling hiccup must not break the
   * merchant's install redirect.
   */
  readonly afterProvision?: ((storeId: string) => Promise<void>) | undefined;
}

export class ShopifyOauthService {
  private readonly db: ProfitDb;
  private readonly encryption: EncryptionService;
  private readonly config: ShopifyOauthConfig;
  private readonly audit: AuditService;
  private readonly logger: Logger;
  private readonly afterProvision?: ((storeId: string) => Promise<void>) | undefined;

  constructor(deps: OauthServiceDeps) {
    this.db = deps.db;
    this.encryption = deps.encryption;
    this.config = deps.config;
    this.audit = deps.audit;
    this.logger = deps.logger;
    if (deps.afterProvision !== undefined) this.afterProvision = deps.afterProvision;
  }

  /** GET /shopify/install — mint single-use state, return Shopify authorize URL. */
  async buildInstallUrl(rawShop: string): Promise<string> {
    const shopDomain = sanitizeShopDomain(rawShop);
    const state = randomBytes(24).toString("base64url");
    await this.db.insert(shopifyOauthStates).values({
      state,
      shopDomain,
      grantScopes: this.config.scopes.split(",").map((s) => s.trim()),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const params = new URLSearchParams({
      client_id: this.config.apiKey,
      scope: this.config.scopes,
      redirect_uri: `${this.config.appUrl}/shopify/callback`,
      state,
    });
    return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
  }

  /** GET /shopify/callback — full verification + provisioning. Returns post-install redirect. */
  async handleCallback(query: QueryParams, meta: { ip?: string | undefined }): Promise<string> {
    const { code, state, shop } = query;
    if (typeof code !== "string" || code === "") throw new ValidationError("missing code");
    if (typeof state !== "string" || state === "") throw new ValidationError("missing state");
    if (typeof shop !== "string" || shop === "") throw new ValidationError("missing shop");

    if (!verifyOauthQueryHmac(query, this.config.apiSecret)) {
      this.logger.warn({ shop }, "shopify.oauth.hmac_rejected");
      throw new AuthenticationError("callback signature verification failed");
    }
    const shopDomain = sanitizeShopDomain(shop);
    await this.burnState(state, shopDomain);

    const token = await this.exchangeCodeForOfflineToken(shopDomain, code);
    const profile = await this.fetchShopProfile(shopDomain, token.access_token);
    const storeId = await this.provisionStore(shopDomain, profile, token);

    await this.audit.record({
      storeId,
      action: "shopify.app.installed",
      entityType: "store",
      entityId: storeId,
      result: "SUCCESS",
      ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
      metadata: { scope: token.scope },
    });

    await this.registerInstallWebhooks(shopDomain, storeId, token.access_token);

    if (this.afterProvision !== undefined) {
      try {
        await this.afterProvision(storeId);
      } catch (error) {
        this.logger.error({ err: error, storeId }, "shopify.oauth.after_provision_failed");
      }
    }
    this.logger.info({ shopDomain, storeId }, "shopify.oauth.installed");
    return `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/apps/${this.config.apiKey}`;
  }

  /**
   * Replay defense: the state row must exist, match the shop, be unexpired and
   * unused; the UPDATE ... WHERE used_at IS NULL makes single-use atomic even
   * under concurrent replay attempts.
   */
  private async burnState(state: string, shopDomain: string): Promise<void> {
    // Atomic single-use: the UPDATE only lands while used_at IS NULL, so a
    // concurrent/serial replay finds zero rows and fails closed.
    const burned = await this.db
      .update(shopifyOauthStates)
      .set({ usedAt: new Date() })
      .where(
        and(eq(shopifyOauthStates.state, state), isNull(shopifyOauthStates.usedAt)),
      )
      .returning({
        shopDomain: shopifyOauthStates.shopDomain,
        expiresAt: shopifyOauthStates.expiresAt,
      });
    const row = burned[0];
    if (row === undefined) {
      throw new AuthenticationError("oauth state unknown or already used");
    }
    if (row.shopDomain !== shopDomain) {
      throw new AuthenticationError("oauth state shop mismatch");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new AuthenticationError("oauth state expired");
    }
  }

  private async exchangeCodeForOfflineToken(
    shopDomain: string,
    code: string,
  ): Promise<AccessTokenResponse> {
    try {
      return await shopifyPostJson<AccessTokenResponse>(
        `https://${shopDomain}/admin/oauth/access_token`,
        {
          client_id: this.config.apiKey,
          client_secret: this.config.apiSecret,
          code,
        },
        {},
      );
    } catch (error) {
      throw new ShopifyApiError(
        "offline token exchange failed",
        error instanceof ShopifyHttpError ? error : undefined,
      );
    }
  }

  /** Business token exchange: session token → online access token (associated user identity). */
  async exchangeSessionTokenForOnlineAccess(
    shopDomain: string,
    sessionToken: string,
  ): Promise<OnlineTokenExchangeResult> {
    const response = await shopifyPostJson<OnlineTokenResponse>(
      `https://${shopDomain}/admin/oauth/access_token`,
      {
        client_id: this.config.apiKey,
        client_secret: this.config.apiSecret,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: sessionToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:shopify:params:oauth:token-type:online-access-token",
      },
      {},
    );
    const user = response.associated_user;
    return {
      accessToken: response.access_token,
      scope: response.scope,
      expiresAt: new Date(Date.now() + response.expires_in * 1000),
      associatedUser:
        user === undefined
          ? null
          : {
              id: user.id,
              email: user.email ?? null,
              firstName: user.first_name ?? null,
              lastName: user.last_name ?? null,
              accountOwner: user.account_owner === true,
              locale: user.locale ?? null,
            },
    };
  }

  private async fetchShopProfile(shopDomain: string, offlineToken: string) {
    const data = await shopifyGraphql<ShopProfileResponse>(
      shopDomain,
      this.config.apiVersion,
      offlineToken,
      SHOP_PROFILE_QUERY,
      {},
    );
    return data.shop;
  }

  /** Idempotent provisioning: reinstalls re-activate and rotate the offline token. */
  private async provisionStore(
    shopDomain: string,
    profile: ShopProfileResponse["shop"],
    token: AccessTokenResponse,
  ): Promise<string> {
    const encryptedToken = this.encryption.encrypt(token.access_token);
    const grantedScopes = token.scope.split(",").map((s) => s.trim());

    const storeId = await this.db.transaction(async (tx) => {
      const upserted = await tx
        .insert(stores)
        .values({
          shopDomain: profile.myshopifyDomain,
          shopifyShopId: profile.id.replace(/\D/g, "") || null,
          name: profile.name,
          email: profile.email,
          currency: profile.currencyCode,
          timezone: profile.ianaTimezone ?? "UTC",
          status: StoreStatus.Active,
          installedAt: new Date(),
          uninstalledAt: null,
        })
        .onConflictDoUpdate({
          target: stores.shopDomain,
          set: {
            shopifyShopId: profile.id.replace(/\D/g, "") || null,
            name: profile.name,
            email: profile.email,
            currency: profile.currencyCode,
            timezone: profile.ianaTimezone ?? "UTC",
            status: StoreStatus.Active,
            uninstalledAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: stores.id });

      const row = upserted[0];
      if (row === undefined) throw new ShopifyApiError("store provisioning failed");

      await tx
        .insert(storeSettings)
        .values({ storeId: row.id })
        .onConflictDoNothing({ target: storeSettings.storeId });

      await tx
        .insert(shopifySessions)
        .values({
          storeId: row.id,
          sessionType: "OFFLINE",
          accessTokenEncrypted: encryptedToken,
          scopes: grantedScopes,
        })
        .onConflictDoUpdate({
          target: [shopifySessions.storeId, shopifySessions.sessionType],
          set: {
            accessTokenEncrypted: encryptedToken,
            scopes: grantedScopes,
            updatedAt: new Date(),
          },
        });

      // Trial subscription on first install (billing lifecycle formalized in M5;
      // the trial row is real and drives the subscription gate today).
      const starter = await tx
        .select({ id: plans.id, trialDays: plans.trialDays })
        .from(plans)
        .where(eq(plans.code, "STARTER"))
        .limit(1);
      const starterPlan = starter[0];
      if (starterPlan !== undefined) {
        const existing = await tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(eq(subscriptions.storeId, row.id))
          .limit(1);
        if (existing[0] === undefined) {
          const trialEndsAt = new Date(Date.now() + starterPlan.trialDays * 24 * 60 * 60 * 1000);
          await tx.insert(subscriptions).values({
            storeId: row.id,
            planId: starterPlan.id,
            status: SubscriptionStatus.Trialing,
            trialEndsAt,
          });
          // M5 ledger: the merchant's billing history must BEGIN at install —
          // row and its first event commit in the same transaction.
          await tx.insert(billingEvents).values({
            storeId: row.id,
            type: BillingEventType.TrialStarted,
            planCode: PlanCode.Starter,
            toStatus: SubscriptionStatus.Trialing,
            amountCents: 0,
            metadata: {
              source: "install_provisioning",
              trialEndsAt: trialEndsAt.toISOString(),
              trialDays: starterPlan.trialDays,
            },
          });
        }
      } else {
        this.logger.warn("plans catalog not seeded — skipping trial subscription creation");
      }

      return row.id;
    });

    return storeId;
  }

  /**
   * Registers install-time webhooks we actively consume in M1. GDPR/mandatory
   * topics are covered by the mandatory-webhook declaration (Partner config)
   * and their handlers are live from day one. M2's sync engine registers the
   * business topics it activates (orders/products/...).
   */
  private async registerInstallWebhooks(
    shopDomain: string,
    storeId: string,
    offlineToken: string,
  ): Promise<void> {
    const topics = ["APP_UNINSTALLED"] as const;
    for (const topic of topics) {
      try {
        await shopifyGraphql(
          shopDomain,
          this.config.apiVersion,
          offlineToken,
          `mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
             webhookSubscriptionCreate(topic: $topic, webhookSubscription: {
               callbackUrl: $callbackUrl, format: JSON
             }) {
               webhookSubscription { id topic }
               userErrors { field message }
             }
           }`,
          { topic, callbackUrl: `${this.config.appUrl}/shopify/webhooks` },
        );
      } catch (error) {
        // Registration failure must not fail the install; M2 reconciliation job
        // re-registers. It is audited loudly either way (P5: webhook failures monitored).
        await this.audit.record({
          storeId,
          action: "shopify.webhook.registration_failed",
          entityType: "webhook",
          entityId: topic,
          result: "FAILURE",
          metadata: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }
}
