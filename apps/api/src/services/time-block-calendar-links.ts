import { randomUUID } from 'node:crypto';
import {
  getDb, eq, and, inArray, timeBlocks, timeBlockCalendarLinks as links,
  calendars, calendarAccounts, calendarEvents, tasks,
} from '@open-sunsama/database';
import { ConflictError, NotFoundError } from '@open-sunsama/utils';
import { GoogleCalendarProvider, ProviderAuthError, ProviderEventNotFoundError } from './calendar-providers/index.js';
import { getAccessTokenForProvider } from './calendar-sync.js';
import { sameSchedule, scheduleInstants, scheduleFromEvent } from './linked-block-schedule.js';
import { calculateDuration } from '../validation/time-blocks.js';
import { publishEvent } from '../lib/websocket/index.js';

/** Reserve consent before calling Google; the same event ID survives retries. */
export async function linkTimeBlock(userId: string, blockId: string, calendarId: string, timezone: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [block] = await tx.select().from(timeBlocks)
      .where(and(eq(timeBlocks.id, blockId), eq(timeBlocks.userId, userId))).for('update');
    if (!block) throw new NotFoundError('Time block', blockId);
    const [target] = await tx.select({ calendar: calendars, account: calendarAccounts }).from(calendars)
      .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.accountId))
      .where(and(eq(calendars.id, calendarId), eq(calendars.userId, userId), eq(calendarAccounts.userId, userId)));
    if (!target) throw new NotFoundError('Calendar', calendarId);
    if (target.account.provider !== 'google' || !target.account.isActive || target.calendar.isReadOnly) {
      throw new ConflictError('Choose a writable calendar from an active Google account.');
    }
    const [existing] = await tx.select().from(links).where(eq(links.timeBlockId, blockId));
    if (existing) {
      if (existing.calendarId !== calendarId) throw new ConflictError('Unlink this block before choosing a different calendar.');
      return;
    }
    scheduleInstants(block, timezone);
    const id = randomUUID();
    await tx.insert(links).values({
      id, userId, timeBlockId: blockId, calendarId, timezone,
      externalId: `os${id.replaceAll('-', '')}`,
    });
  });
  await syncLinkedTimeBlocks(userId, { blockIds: [blockId] });
}

/** Unlinking leaves both copies in place and revokes all future sync. */
export async function unlinkTimeBlock(userId: string, blockId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    // Same lock order as sync and deletion: block, then link.
    const [block] = await tx.select().from(timeBlocks)
      .where(and(eq(timeBlocks.id, blockId), eq(timeBlocks.userId, userId))).for('update');
    if (!block) throw new NotFoundError('Time block', blockId);
    await tx.delete(links).where(and(eq(links.timeBlockId, blockId), eq(links.userId, userId)));
  });
  await publishEvent(userId, 'timeblock:updated', { timeBlockId: blockId });
  await publishEvent(userId, 'calendar-event:updated', { timeBlockId: blockId });
}

/** Batched metadata for lists, avoiding one database round trip per block. */
export async function withCalendarLinks<T extends { id: string; date: string; startTime: string; endTime: string }>(userId: string, blocks: T[]) {
  if (!blocks.length) return [];
  const rows = await getDb().select({ link: links, calendarName: calendars.name, email: calendarAccounts.email })
    .from(links).innerJoin(calendars, eq(calendars.id, links.calendarId))
    .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.accountId))
    .where(and(eq(links.userId, userId), inArray(links.timeBlockId, blocks.map(b => b.id))));
  const byBlock = new Map(rows.map(row => [row.link.timeBlockId, row]));
  return blocks.map(block => {
    const row = byBlock.get(block.id);
    return {
      ...block,
      calendarLink: row ? {
        calendarId: row.link.calendarId,
        calendarName: row.calendarName,
        accountEmail: row.email,
        provider: 'google' as const,
        timezone: row.link.timezone,
        htmlLink: row.link.htmlLink,
        status: row.link.syncError ? 'error' as const : sameSchedule(block, row.link.lastSyncedSchedule) ? 'synced' as const : 'pending' as const,
        syncError: row.link.syncError,
      } : null,
    };
  });
}

/**
 * Reconcile only explicit links. A saved local schedule different from the last
 * acknowledged one wins a conflict; otherwise Google is authoritative. Fresh
 * per-event GETs prevent stale incremental-sync batches from undoing a local
 * move, and keep links working outside the normal calendar sync date window.
 *
 * The durable schedule snapshot is also the retry queue. No process-local jobs
 * or fire-and-forget writes are needed for recovery after a restart.
 */
export async function syncLinkedTimeBlocks(userId: string, filter: { blockIds?: string[]; accountId?: string } = {}) {
  if (filter.blockIds?.length === 0) return;
  const db = getDb();
  const candidates = await db.select({ id: links.id, timeBlockId: links.timeBlockId }).from(links)
    .innerJoin(calendars, eq(calendars.id, links.calendarId))
    .where(and(eq(links.userId, userId),
      filter.blockIds ? inArray(links.timeBlockId, filter.blockIds) : undefined,
      filter.accountId ? eq(calendars.accountId, filter.accountId) : undefined));

  for (const candidate of candidates) {
    let changed = false;
    await db.transaction(async (tx) => {
      const [block] = candidate.timeBlockId ? await tx.select().from(timeBlocks)
        .where(and(eq(timeBlocks.id, candidate.timeBlockId), eq(timeBlocks.userId, userId))).for('update') : [];
      const [link] = await tx.select().from(links)
        .where(and(eq(links.id, candidate.id), eq(links.userId, userId))).for('update');
      if (!link) return;
      const [target] = await tx.select({ calendar: calendars, account: calendarAccounts }).from(calendars)
        .innerJoin(calendarAccounts, eq(calendarAccounts.id, calendars.accountId))
        .where(and(eq(calendars.id, link.calendarId), eq(calendarAccounts.userId, userId)));
      if (!target) return;
      const provider = new GoogleCalendarProvider();
      try {
        if (!target.account.isActive) throw new ProviderAuthError('google');
        if (target.account.provider !== 'google' || target.calendar.isReadOnly) {
          throw new Error('This calendar is no longer writable. Choose another calendar or unlink this block.');
        }
        const token = await getAccessTokenForProvider(target.account, provider);
        const cachedEvent = and(eq(calendarEvents.userId, userId), eq(calendarEvents.calendarId, link.calendarId), eq(calendarEvents.externalId, link.externalId));
        if (!block || !link.timeBlockId) {
          await provider.deleteEvent(token, target.calendar.externalId, link.externalId);
          await tx.delete(calendarEvents).where(cachedEvent);
          await tx.delete(links).where(eq(links.id, link.id));
          changed = true;
          return;
        }

        let external;
        if (!link.lastSyncedSchedule) {
          const [task] = block.taskId ? await tx.select({ title: tasks.title }).from(tasks)
            .where(and(eq(tasks.id, block.taskId), eq(tasks.userId, userId))) : [];
          external = await provider.createEvent(token, target.calendar.externalId, {
            idempotencyKey: link.externalId,
            title: task?.title ?? block.title,
            ...scheduleInstants(block, link.timezone),
            timezone: link.timezone,
            // Notes, subtasks and attachments remain private.
          });
          // A retry can find a previously created event after the block moved.
          const desired = scheduleInstants(block, link.timezone);
          if (external.startTime.getTime() !== desired.startTime.getTime() || external.endTime.getTime() !== desired.endTime.getTime()) {
            external = await provider.updateEvent(token, target.calendar.externalId, link.externalId, { ...desired, timezone: link.timezone });
          }
        } else if (!sameSchedule(block, link.lastSyncedSchedule)) {
          external = await provider.updateEvent(token, target.calendar.externalId, link.externalId, {
            ...scheduleInstants(block, link.timezone), timezone: link.timezone, isAllDay: false,
          });
        } else {
          external = await provider.getEvent(token, target.calendar.externalId, link.externalId);
        }

        const schedule = scheduleFromEvent(external, link.timezone);
        if (!sameSchedule(block, schedule)) {
          await tx.update(timeBlocks).set({ ...schedule, durationMins: calculateDuration(schedule.startTime, schedule.endTime), updatedAt: new Date() })
            .where(eq(timeBlocks.id, block.id));
        }
        const [cached] = await tx.select({ id: calendarEvents.id }).from(calendarEvents).where(cachedEvent).limit(1);
        if (cached) await tx.update(calendarEvents).set({ ...external, updatedAt: new Date() }).where(cachedEvent);
        else await tx.insert(calendarEvents).values({ ...external, userId, calendarId: link.calendarId });
        changed = !sameSchedule(block, schedule) || !sameSchedule(block, link.lastSyncedSchedule) || !!link.syncError;
        await tx.update(links).set({ lastSyncedSchedule: schedule, lastSyncedAt: new Date(), syncError: null, htmlLink: external.htmlLink })
          .where(eq(links.id, link.id));
      } catch (error) {
        if (error instanceof ProviderEventNotFoundError) {
          // External deletion revokes the link; never recreate a deleted event.
          await tx.delete(calendarEvents).where(and(eq(calendarEvents.calendarId, link.calendarId), eq(calendarEvents.externalId, link.externalId), eq(calendarEvents.userId, userId)));
          await tx.delete(links).where(eq(links.id, link.id));
        } else {
          const message = error instanceof ProviderAuthError
            ? 'Reconnect your Google account in Settings to resume sync.'
            : error instanceof Error && /time|timed|writable/.test(error.message)
              ? error.message : 'Calendar sync failed. Retry, or reconnect your Google account in Settings.';
          await tx.update(links).set({ syncError: message }).where(eq(links.id, link.id));
        }
        changed = true;
      }
    });
    if (changed) {
      await publishEvent(userId, 'timeblock:updated', { timeBlockId: candidate.timeBlockId });
      await publishEvent(userId, 'calendar-event:updated', { timeBlockId: candidate.timeBlockId });
    }
  }
}
