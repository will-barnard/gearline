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
 * orders query.  If this is null (first ever poll), we look back 24 hours to
 * catch orders placed while the app was being set up.  After a successful poll
 * we update {@code lastSyncAt} to the current time.
 *
 * The 24-hour lookback on first run means you won't miss orders placed between
 * connecting a marketplace and the first successful poll.
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
     * Maximum lookback window for order polling.
     *
     * If an account has never been polled (lastSyncAt is null) we only look
     * back this far so we don't flood Gearline with the account's entire order
     * history. The same cap applies if the poller was down for an extended
     * period — we cap at 72 hours rather than importing months of old orders.
     *
     * Orders older than this on first connect are intentionally ignored. They
     * can be imported manually via the admin dashboard in future if needed.
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

            // Determine the lookback window.
            // The earliest we will ever look back is MAX_LOOKBACK_HOURS ago — this
            // prevents a first-time poll (null lastSyncAt) or a long poller outage
            // from importing the account's entire order history.
            Instant floor = Instant.now().minus(MAX_LOOKBACK_HOURS, ChronoUnit.HOURS);
            Instant since = (account.getLastSyncAt() != null && account.getLastSyncAt().isAfter(floor))
                ? account.getLastSyncAt()
                : floor;

            log.info("Polling {} orders for account {} since {}", type, account.getId(), since);

            List<ImportedOrder> orders = connector.importOrders(account, since);

            if (orders.isEmpty()) {
                log.debug("No new {} orders for account {}", type, account.getId());
            } else {
                log.info("Found {} new {} order(s) for account {}", orders.size(), type, account.getId());
                int imported = 0;
                for (ImportedOrder order : orders) {
                    try {
                        var saved = orderImportService.importOrder(order, account);
                        if (saved != null) imported++;
                    } catch (Exception e) {
                        log.error("Failed to import {} order {}: {}",
                            type, order.getExternalOrderId(), e.getMessage(), e);
                    }
                }
                log.info("Imported {}/{} {} orders for account {}", imported, orders.size(), type, account.getId());
            }

            // Update lastSyncAt to now so next poll only fetches newer orders
            account.setLastSyncAt(Instant.now());
            accountRepository.save(account);

        } catch (Exception e) {
            log.error("Order polling failed for {} account {}: {}", type, account.getId(), e.getMessage(), e);
            // Don't update lastSyncAt on failure — next poll will re-attempt the same window
        }
    }
}
