/**
 * SubscriptionManager
 *
 * Replaces global.pendingSubscribes with a proper service for managing long-poll subscriptions.
 * Tracks active HTTP connections waiting for device state updates.
 *
 * Key responsibilities:
 * - Track subscriptions per device serial
 * - Notify subscribers when state changes
 * - Clean up stale/closed connections
 * - Enforce subscription limits to prevent resource exhaustion
 */

import type { Subscription, DeviceObject, NotificationResult } from '../lib/types';
import { environment } from '../config/environment';

export class SubscriptionManager {
  private subscriptions: Map<string, Subscription[]> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private keepAliveInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup timer
    this.startCleanupTimer();
    // Start keep-alive timer to prevent NAT timeouts
    this.startKeepAliveTimer();
  }

  /**
   * Add a new subscription for a device
   * Automatically sets up cleanup on connection close
   */
  addSubscription(subscription: Subscription): boolean {
    const { serial, res } = subscription;

    const existing = this.subscriptions.get(serial) || [];
    if (existing.length >= environment.MAX_SUBSCRIPTIONS_PER_DEVICE) {
      console.warn(
        `[SubscriptionManager] Subscription limit reached for ${serial} (${existing.length}/${environment.MAX_SUBSCRIPTIONS_PER_DEVICE})`
      );
      return false;
    }

    if (!this.subscriptions.has(serial)) {
      this.subscriptions.set(serial, []);
    }
    this.subscriptions.get(serial)!.push(subscription);

    res.on('close', () => {
      this.removeSubscription(res, serial);
    });

    console.log(
      `[${new Date().toISOString()}] [SubscriptionManager] Opened subscription for ${serial} (session: ${subscription.sessionId}, total for device: ${
        this.subscriptions.get(serial)!.length
      })`
    );

    return true;
  }

  /**
   * Notify subscribers for a specific device and object key
   * Sends updated object to all matching subscribers and closes their connections
   */
  notify(serial: string, objectKey: string, updatedObject: DeviceObject): NotificationResult {
    const subscribers = this.subscriptions.get(serial);
    if (!subscribers || subscribers.length === 0) {
      return { notified: 0, removed: 0 };
    }

    let notified = 0;
    const remaining: Subscription[] = [];

    for (const sub of subscribers) {
      const watchingObject = sub.objects.find(obj => obj.object_key === objectKey);

      if (!watchingObject) {
        remaining.push(sub);
        continue;
      }

      if (sub.res.writableEnded || sub.res.destroyed) {
        console.warn(`[SubscriptionManager] Skipping closed connection for ${serial}`);
        continue;
      }

      try {
        const subscribeResponse = JSON.stringify({ objects: [updatedObject] }) + '\r\n';
        sub.res.write(subscribeResponse);
        sub.res.end();
        notified++;

        console.log(
          `[SubscriptionManager] Notified subscriber for ${serial}/${objectKey} (session: ${sub.sessionId})`
        );
      } catch (error) {
        console.error(`[SubscriptionManager] Failed to notify subscriber for ${serial}:`, error);
      }
    }

    const removed = subscribers.length - remaining.length;
    if (remaining.length > 0) {
      this.subscriptions.set(serial, remaining);
    } else {
      this.subscriptions.delete(serial);
    }

    return { notified, removed };
  }

  /**
   * Notify all subscribers for a device (used when multiple objects change)
   * Sends all changed objects in ONE notification
   */
  notifyAll(serial: string, changedObjects: any[]): NotificationResult {
    const subscribers = this.subscriptions.get(serial);
    if (!subscribers || subscribers.length === 0) {
      return { notified: 0, removed: 0 };
    }

    let notified = 0;

    this.subscriptions.delete(serial);

    for (const sub of subscribers) {
      try {
        if (sub.res.writableEnded || sub.res.destroyed) {
          continue;
        }

        const subscribeResponse = JSON.stringify({ objects: changedObjects }) + '\r\n';
        sub.res.write(subscribeResponse);
        sub.res.end();
        notified++;
      } catch (err) {
        console.error(`[SubscriptionManager] Failed to notify subscriber for ${serial}:`, err);
      }
    }

    return {
      notified,
      removed: subscribers.length,
    };
  }

  /**
   * Remove a specific subscription by response object
   */
  private removeSubscription(res: any, serial: string): void {
    const subscribers = this.subscriptions.get(serial);
    if (!subscribers) {
      return;
    }

    const filtered = subscribers.filter(sub => sub.res !== res);
    const removed = subscribers.length - filtered.length;

    if (filtered.length > 0) {
      this.subscriptions.set(serial, filtered);
    } else {
      this.subscriptions.delete(serial);
    }

    if (removed > 0) {
      console.log(`[${new Date().toISOString()}] [SubscriptionManager] Closed subscription for ${serial} (connection closed by client, remaining: ${filtered.length})`);
    }
  }

  /**
   * Clean up stale subscriptions
   * Removes subscriptions older than SUBSCRIPTION_TIMEOUT_MS
   */
  cleanupStale(): number {
    const now = Date.now();
    const timeout = environment.SUBSCRIPTION_TIMEOUT_MS;
    let totalRemoved = 0;

    for (const [serial, subscribers] of this.subscriptions.entries()) {
      const active: Subscription[] = [];

      for (const sub of subscribers) {
        const age = now - sub.connectedAt;

        if (age > timeout || sub.res.writableEnded || sub.res.destroyed) {
          if (!sub.res.writableEnded && !sub.res.destroyed) {
            try {
              console.log(`[${new Date().toISOString()}] [SubscriptionManager] Timed out subscription for ${serial} (age: ${Math.round(age / 1000)}s)`);
              sub.res.writeHead(408, { 'Content-Type': 'text/plain' });
              sub.res.end('Request Timeout');
            } catch (error) {
              // Ignore errors if connection is already gone
            }
          }
          totalRemoved++;
        } else {
          active.push(sub);
        }
      }

      if (active.length > 0) {
        this.subscriptions.set(serial, active);
      } else {
        this.subscriptions.delete(serial);
      }
    }

    if (totalRemoved > 0) {
      console.log(`[SubscriptionManager] Cleaned up ${totalRemoved} stale subscription(s)`);
    }

    return totalRemoved;
  }

  /**
   * Get subscription count for a device
   */
  getSubscriptionCount(serial: string): number {
    return this.subscriptions.get(serial)?.length || 0;
  }

  /**
   * Get total subscription count across all devices
   */
  getTotalSubscriptionCount(): number {
    let total = 0;
    for (const subs of this.subscriptions.values()) {
      total += subs.length;
    }
    return total;
  }

  /**
   * Get all active device serials with subscriptions
   */
  getActiveSerials(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStale();
    }, 60 * 1000);

    console.log('[SubscriptionManager] Cleanup timer started (interval: 60s)');
  }

  /**
   * Start keep-alive timer to prevent NAT timeouts
   * Sends a small ping to all active subscriptions periodically
   */
  private startKeepAliveTimer(): void {
    const interval = environment.KEEP_ALIVE_INTERVAL_MS;

    this.keepAliveInterval = setInterval(() => {
      this.sendKeepAlive();
    }, interval);

    console.log(`[SubscriptionManager] Keep-alive timer started (interval: ${interval}ms)`);
  }

  /**
   * Send keep-alive ping to all active subscriptions
   * Sends a newline character which is ignored by JSON parsers
   * but keeps the TCP connection alive through NAT
   */
  private sendKeepAlive(): void {
    let sent = 0;
    let failed = 0;

    for (const [serial, subscribers] of this.subscriptions.entries()) {
      const activeSubscribers: Subscription[] = [];

      for (const sub of subscribers) {
        if (sub.res.writableEnded || sub.res.destroyed) {
          // Connection already closed, skip
          continue;
        }

        try {
          // Send a newline as keep-alive - JSON parsers ignore leading whitespace
          sub.res.write('\n');
          activeSubscribers.push(sub);
          sent++;
        } catch (error) {
          // Connection is dead, will be cleaned up
          console.log(`[SubscriptionManager] Keep-alive failed for ${serial}, connection dead`);
          failed++;
        }
      }

      // Update subscribers list to remove dead connections
      if (activeSubscribers.length > 0) {
        this.subscriptions.set(serial, activeSubscribers);
      } else {
        this.subscriptions.delete(serial);
      }
    }

    if (sent > 0 || failed > 0) {
      console.log(`[${new Date().toISOString()}] [SubscriptionManager] Keep-alive: sent ${sent}, failed ${failed}`);
    }
  }

  /**
   * Stop cleanup timer (for graceful shutdown)
   */
  stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log('[SubscriptionManager] Cleanup timer stopped');
    }
  }

  /**
   * Stop keep-alive timer (for graceful shutdown)
   */
  stopKeepAliveTimer(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      console.log('[SubscriptionManager] Keep-alive timer stopped');
    }
  }

  /**
   * Graceful shutdown: close all subscriptions
   */
  async shutdown(): Promise<void> {
    console.log('[SubscriptionManager] Shutting down...');

    this.stopCleanupTimer();
    this.stopKeepAliveTimer();

    for (const [_serial, subscribers] of this.subscriptions.entries()) {
      for (const sub of subscribers) {
        if (!sub.res.writableEnded && !sub.res.destroyed) {
          try {
            sub.res.writeHead(503, { 'Content-Type': 'text/plain' });
            sub.res.end('Server shutting down');
          } catch (error) {
          }
        }
      }
    }

    this.subscriptions.clear();
    console.log('[SubscriptionManager] Shutdown complete');
  }
}
