package com.gearline.service;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.marketplace.common.connector.MarketplaceConnector;
import com.gearline.marketplace.common.connector.MarketplaceConnectorRegistry;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.common.dto.ImportedOrder;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Polls Reverb and eBay for new orders on a configurable schedule and pipes
 * each new order through {@link OrderImportService} (dedup → save → inventory
 * deduction → Shopify push).
 *
 * ── Why polling? ─────────────────────────────────────────────────────────────
 *
 * Shopify sends webhooks for its own orders, but Reverb and eBay don't push
 * webhook notifications to third-party apps for order events.  We must poll
 * their APIs periodically to discover new sales.
 *
 * ── Schedule ─────────────────────────────────────────────────────────────────
 *
 * Default: every 10 minutes (fixed delay from last run completion).
 * Override with the environment variable ORDER_POLL_INTERVAL_MS.
 *
 * Initial delay: 60 seconds after startup to let the app fully initialise
 * and marketplace tokens to be validated before the first poll.
 *
 * ── Fault isolation ──────────────────────────────────────────────────────────
 *
 * Each marketplace account is polled independently.  A failure on one account
 * (expired token, API outage) does not prevent other accounts from being polled.
 *
 * ── lastSyncAt window ────────────────────────────────────────────────────────
 *
 * We use the account's {@code lastSyncAt} as the "since" timestamp for the
 * orders query.  After a successful poll we update {@code lastSyncAt} to the
 * current time so the next poll only fetches newer orders.
 *
 * First-run behaviour: if {@code lastSyncAt} is null (account was just connected
 * or the DB was re-created), we do NOT look back — we set lastSyncAt to now and
 * skip the poll entirely.  This prevents the app from flooding the system with
 * historical orders on every fresh deployment.  Only orders that arrive AFTER
 * the app is running will be imported.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderPollingScheduler {

    private final MarketplaceAccountRepository accountRepository;
    private final MarketplaceConnectorRegistry connectorRegistry;
    private final OrderImportService orderImportService;

    /**
     * The set of marketplace types this scheduler actively polls.
     * Shopify is excluded — we receive its orders via webhooks instead.
     */
    private static final List<MarketplaceType> POLLED_TYPES = List.of(
        MarketplaceType.REVERB,
        MarketplaceType.EBAY
    );

    /**
     * Maximum lookback cap for accounts that have been polled before.
     *
     * If the poller was down for an extended period (e.g. the app was offline
     * for several days) we cap how far back we look rather than importing weeks
     * of orders. Orders older than this cap after a long outage are intentionally
     * skipped — they can be imported manually if needed.
     *
     * This cap does NOT apply on first poll: when lastSyncAt is null we set it
     * to now and skip entirely (no historical import at all).
     */
    private static final long MAX_LOOKBACK_HOURS = 72;

    @Scheduled(
        fixedDelayString  = "${gearline.order-polling.interval-ms:600000}",
        initialDelayString = "${gearline.order-polling.initial-delay-ms:60000}",
        timeUnit = TimeUnit.MILLISECONDS
    )
    public void pollAllAccounts() {
        log.debug("Order polling cycle starting");

        for (MarketplaceType type : POLLED_TYPES) {
            List<MarketplaceAccount> accounts = accountRepository
                .findByMarketplaceTypeAndActiveTrue(type);

            if (accounts.isEmpty()) {
                log.debug("No active {} accounts — skipping", type);
                continue;
            }

            for (MarketplaceAccount account : accounts) {
                pollAccount(account);
            }
        }

        log.debug("Order polling cycle complete");
    }

    // ── Per-account polling ────────────────────────────────────────────────────

    private void pollAccount(MarketplaceAccount account) {
        MarketplaceType type = account.getMarketplaceType();
        try {
            MarketplaceConnector connector = connectorRegistry.getConnector(type);

            // ── First-run guard ────────────────────────────────────────────────
            // When lastSyncAt is null the account was just connected (or the DB
            // was re-created). Instead of looking back MAX_LOOKBACK_HOURS and
            // flooding the system with historical orders, we stamp lastSyncAt=now
            // and return. The next scheduled poll will pick up any truly new orders.
            if (account.getLastSyncAt() == null) {
                log.info("First poll for {} account {} — initializing lastSyncAt to now, "
                    + "skipping historical import", type, account.getId());
                accountRepository.updateLastSyncAt(account.getId(), Instant.now());
                return;
            }

            // Cap how far back we look to avoid importing weeks of orders after
            // a long poller outage.
            Instant floor = Instant.now().minus(MAX_LOOKBACK_HOURS, ChronoUnit.HOURS);
            Instant since = account.getLastSyncAt().isAfter(floor)
                ? account.getLastSyncAt()
                : floor;

            log.info("Polling {} orders for account {} since {}", type, account.getId(), since);

            List<ImportedOrder> orders = connector.importOrders(account, since);

            if (orders.isEmpty()) {
                log.debug("No new {} orders for account {}", type, account.getId());
            } else {
                log.info("Found {} new {} order(s) for account {}", orders.size(), type, account.getId());
                int imported = 0;
                int failed = 0;
                for (ImportedOrder order : orders) {
                    try {
                        var saved = orderImportService.importOrder(order, account);
                        if (saved != null) imported++;
                    } catch (Exception e) {
                        failed++;
                        log.error("Failed to import {} order {}: {}",
                            type, order.getExternalOrderId(), e.getMessage(), e);
                    }
                }
                log.info("Imported {}/{} {} orders for account {} ({} failed)",
                    imported, orders.size(), type, account.getId(), failed);

                // Finding #18: only advance lastSyncAt when all orders imported successfully.
                // If any failed, keeping lastSyncAt at its current value means the next poll
                // will re-attempt the same window — no orders are permanently skipped due to
                // a transient import failure. (Permanently bad orders will be retried every
                // poll cycle until they succeed or are manually resolved.)
                if (failed > 0) {
                    log.warn("{} {} order(s) failed to import for account {} — not advancing lastSyncAt; "
                        + "they will be retried on the next poll", failed, type, account.getId());
                    return; // skip the lastSyncAt update below
                }
            }

            // Update lastSyncAt to now so next poll only fetches newer orders.
            // Using a targeted UPDATE instead of save() to avoid ObjectOptimisticLockingFailureException:
            // the auth provider may have refreshed credentials mid-poll (bumping @Version), so the
            // account entity we hold here can be stale. updateLastSyncAt() bypasses the version check.
            accountRepository.updateLastSyncAt(account.getId(), Instant.now());

        } catch (Exception e) {
            log.error("Order polling failed for {} account {}: {}", type, account.getId(), e.getMessage(), e);
            // Don't update lastSyncAt on failure — next poll will re-attempt the same window
        }
    }
}
