import { pgTable, uuid, varchar, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { timeBlocks } from './time-blocks';
import { calendars } from './calendars';

export interface LinkedBlockSchedule {
  date: string;
  startTime: string;
  endTime: string;
}

// A row is created ONLY by the explicit per-block Add to calendar action.
// Keep this separate from the disposable calendar_events cache: resetting a
// calendar must not lose links or republish private blocks.
export const timeBlockCalendarLinks = pgTable('time_block_calendar_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // A deleted block leaves a durable deletion job until Google acknowledges it.
  timeBlockId: uuid('time_block_id').references(() => timeBlocks.id, { onDelete: 'set null' }),
  calendarId: uuid('calendar_id').notNull().references(() => calendars.id, { onDelete: 'cascade' }),
  externalId: varchar('external_id', { length: 500 }).notNull(),
  timezone: varchar('timezone', { length: 100 }).notNull(),
  lastSyncedSchedule: jsonb('last_synced_schedule').$type<LinkedBlockSchedule>(),
  lastSyncedAt: timestamp('last_synced_at'),
  syncError: varchar('sync_error', { length: 1000 }),
  htmlLink: varchar('html_link', { length: 1000 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('time_block_calendar_links_block_idx').on(table.timeBlockId),
  uniqueIndex('time_block_calendar_links_event_idx').on(table.calendarId, table.externalId),
  index('time_block_calendar_links_user_idx').on(table.userId),
]);
