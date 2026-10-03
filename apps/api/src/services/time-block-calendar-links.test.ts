import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import * as schema from '@open-sunsama/database/schema';
import { eq, users, tasks, calendars, calendarAccounts, calendarEvents, timeBlocks, apiKeys, timeBlockCalendarLinks as links } from '@open-sunsama/database';
import { generateApiKey } from '@open-sunsama/utils';
import { encrypt } from './encryption.js';
import { linkTimeBlock, unlinkTimeBlock, syncLinkedTimeBlocks, withCalendarLinks } from './time-block-calendar-links.js';
import { moveBlocksWithTasks } from './task-blocks.js';
import { timeBlocksRouter } from '../routes/time-blocks.js';
import { calendarEventsRouter } from '../routes/calendar-events.js';
import { errorHandler } from '../middleware/error.js';
import { signToken } from '../lib/jwt.js';
import type { GoogleEvent } from './calendar-providers/google-helpers.js';
import type { TimeBlockCalendarLink } from '@open-sunsama/types';

type BlockResponse = { data: typeof timeBlocks.$inferSelect & { calendarLink: TimeBlockCalendarLink | null } };

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@open-sunsama/database', async importOriginal => ({
  ...await importOriginal<typeof import('@open-sunsama/database')>(), getDb: () => state.db,
}));
vi.mock('../lib/websocket/index.js', () => ({ publishEvent: vi.fn() }));

const pg = new PGlite();
const db = drizzle(pg, { schema });
state.db = db;
const app = new Hono().route('/time-blocks', timeBlocksRouter).route('/calendar-events', calendarEventsRouter);
app.onError(errorHandler);
const remote = new Map<string, GoogleEvent>();
const requests: { method: string; body: Record<string, unknown> }[] = [];
let failRequests = false;
let loseCreateResponse = false;
let userId: string;
let otherUserId: string;
let calendarId: string;
let accountId: string;
let blockId: string;
let siblingId: string;
let taskId: string;

async function request(method: string, path: string, body?: unknown, owner = userId) {
  return app.request(path, { method, headers: { Authorization: `Bearer ${signToken(owner)}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function block() { return (await db.select().from(timeBlocks).where(eq(timeBlocks.id, blockId)))[0]!; }
async function link() { return (await db.select().from(links).where(eq(links.timeBlockId, blockId)))[0]!; }
async function attach() {
  const response = await request('POST', `/time-blocks/${blockId}/calendar-link`, { calendarId, timezone: 'America/New_York' });
  expect(response.status).toBe(200);
  return (await response.json() as BlockResponse).data;
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../../packages/database/drizzle', import.meta.url)) });
}, 30_000);
afterAll(async () => { await pg.close(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('CALENDAR_ENCRYPTION_KEY', '11'.repeat(32));
  remote.clear(); requests.length = 0; failRequests = false; loseCreateResponse = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toMatch(/^https:\/\/www.googleapis.com\/calendar\/v3\/calendars\/test-calendar\/events/);
    const method = init?.method ?? 'GET';
    const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ method, body });
    if (failRequests) return new Response('{}', { status: 503 });
    const id = method === 'POST' ? body.id : decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
    if (method === 'POST') {
      if (remote.has(id)) return new Response('{}', { status: 409 });
      remote.set(id, { ...body, status: 'confirmed', htmlLink: `https://calendar.google.com/calendar/event?eid=${id}` });
      if (loseCreateResponse) { loseCreateResponse = false; throw new Error('Connection lost after Google saved the event'); }
    } else if (method === 'PATCH') {
      if (!remote.has(id)) return new Response('{}', { status: 404 });
      remote.set(id, { ...remote.get(id)!, ...body });
    } else if (method === 'DELETE') {
      remote.delete(id); return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(remote.get(id) ?? {}), { status: remote.has(id) ? 200 : 404 });
  }));
  await db.delete(users);
  const [user, other] = await db.insert(users).values([
    { email: 'links-e2e@example.com', passwordHash: 'unused', timezone: 'America/New_York' },
    { email: 'other-e2e@example.com', passwordHash: 'unused' },
  ]).returning();
  userId = user!.id; otherUserId = other!.id;
  const [account] = await db.insert(calendarAccounts).values({ userId, provider: 'google', providerAccountId: 'test', email: 'links-e2e@example.com', accessTokenEncrypted: encrypt('test-token'), tokenExpiresAt: new Date('2100-01-01') }).returning();
  accountId = account!.id;
  const [calendar] = await db.insert(calendars).values({ userId, accountId, externalId: 'test-calendar', name: 'Personal' }).returning();
  calendarId = calendar!.id;
  const [task] = await db.insert(tasks).values({ userId, title: 'Read up on Press Start', scheduledDate: '2026-10-02', notes: 'Private notes' }).returning();
  taskId = task!.id;
  const blocks = await db.insert(timeBlocks).values([
    { userId, taskId, title: 'Old title', description: 'Private description', date: '2026-10-02', startTime: '19:30', endTime: '21:30', durationMins: 120 },
    { userId, taskId, title: 'Second session', date: '2026-10-02', startTime: '21:30', endTime: '22:00', durationMins: 30 },
  ]).returning();
  blockId = blocks[0]!.id; siblingId = blocks[1]!.id;
});

describe('explicit time block calendar linking with real Postgres persistence', () => {
  it('keeps existing, created and automatically scheduled blocks private', async () => {
    await request('PATCH', `/time-blocks/${blockId}`, { startTime: '19:00' });
    await request('POST', '/time-blocks', { title: 'Local', date: '2026-10-02', startTime: '10:00', endTime: '11:00', calendarId });
    await request('POST', '/time-blocks/quick-schedule', { taskId, date: '2026-10-02', startTime: '09:00', durationMins: 30 });
    await request('POST', '/time-blocks/auto-schedule', { taskId });
    await syncLinkedTimeBlocks(userId);
    expect(await db.select().from(links)).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
  it('links just one block using the task title and correct instants, with no private notes', async () => {
    const result = await attach();
    expect(result.calendarLink).toMatchObject({ status: 'synced', calendarId, calendarName: 'Personal' });
    expect(remote.size).toBe(1);
    const event = [...remote.values()][0]!;
    expect(event.summary).toBe('Read up on Press Start');
    expect(event.start?.dateTime).toBe('2026-10-02T23:30:00.000Z');
    expect(event.end?.dateTime).toBe('2026-10-03T01:30:00.000Z');
    expect(event.description).toBeUndefined();
    const response = await request('GET', `/time-blocks?taskId=${taskId}`);
    const data = (await response.json() as { data: BlockResponse['data'][] }).data;
    expect(data.find(b => b.id === siblingId)!.calendarLink).toBeNull();
  });
  it('is idempotent after repeated clicks and a lost creation response', async () => {
    loseCreateResponse = true;
    expect((await attach()).calendarLink?.status).toBe('error');
    expect(remote.size).toBe(1);
    await request('PATCH', `/time-blocks/${blockId}`, { startTime: '18:00', endTime: '20:00' });
    expect((await attach()).calendarLink?.status).toBe('synced');
    await attach();
    expect(remote.size).toBe(1);
    expect([...remote.values()][0]!.start?.dateTime).toBe('2026-10-02T22:00:00.000Z');
  });
  it('pushes local moves/resizes, then pulls Google moves without echoing them back', async () => {
    await attach();
    await request('PATCH', `/time-blocks/${blockId}`, { date: '2026-10-03', startTime: '20:00', endTime: '22:30' });
    const id = (await link()).externalId;
    expect(remote.get(id)!.start?.dateTime).toBe('2026-10-04T00:00:00.000Z');
    remote.set(id, { ...remote.get(id)!, start: { dateTime: '2026-10-05T00:00:00Z' }, end: { dateTime: '2026-10-05T01:00:00Z' } });
    requests.length = 0;
    await syncLinkedTimeBlocks(userId, { accountId });
    expect(await block()).toMatchObject({ date: '2026-10-04', startTime: '20:00', endTime: '21:00', durationMins: 60, taskId });
    expect(requests.map(r => r.method)).toEqual(['GET']);
  });
  it('syncs cascade shifts only for explicitly linked blocks', async () => {
    await linkTimeBlock(userId, siblingId, calendarId, 'America/New_York');
    requests.length = 0;
    const response = await request('PATCH', `/time-blocks/${blockId}/cascade-resize`, { startTime: '19:30', endTime: '22:00' });
    expect(response.status).toBe(200);
    expect(remote.size).toBe(1);
    expect([...remote.values()][0]!.start?.dateTime).toBe('2026-10-03T02:00:00.000Z');
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it('recovers pending local changes after a provider failure and wins simultaneous edits', async () => {
    await attach();
    failRequests = true;
    const response = await request('PATCH', `/time-blocks/${blockId}`, { startTime: '18:00', endTime: '19:00' });
    expect((await response.json() as BlockResponse).data.calendarLink?.status).toBe('error');
    expect((await block()).startTime).toBe('18:00');
    failRequests = false;
    await syncLinkedTimeBlocks(userId, { accountId });
    expect([...remote.values()][0]!.start?.dateTime).toBe('2026-10-02T22:00:00.000Z');
    expect((await link()).syncError).toBeNull();
  });
  it('keeps links through cache resets and synchronizes task day moves', async () => {
    await attach();
    await db.delete(calendarEvents);
    await moveBlocksWithTasks(userId, [{ taskId, from: '2026-10-02' }], '2026-10-06');
    await syncLinkedTimeBlocks(userId);
    expect(remote.size).toBe(1);
    expect([...remote.values()][0]!.start?.dateTime).toBe('2026-10-06T23:30:00.000Z');
    expect(await db.select().from(calendarEvents)).toHaveLength(1);
  });
  it('preserves a local block when Google deletes its event, without resurrection', async () => {
    await attach(); remote.clear();
    await syncLinkedTimeBlocks(userId);
    expect(await block()).toBeDefined();
    expect(await db.select().from(links)).toHaveLength(0);
    await request('PATCH', `/time-blocks/${blockId}`, { startTime: '18:00' });
    expect(remote.size).toBe(0);
  });
  it('retains a durable deletion job when local deletion cannot reach Google', async () => {
    await attach(); failRequests = true;
    expect((await request('DELETE', `/time-blocks/${blockId}`)).status).toBe(200);
    const pending = await db.select().from(links);
    expect(pending[0]!.timeBlockId).toBeNull();
    expect(remote.size).toBe(1);
    failRequests = false;
    await syncLinkedTimeBlocks(userId);
    expect(remote.size).toBe(0);
    expect(await db.select().from(links)).toHaveLength(0);
  });
  it('unlinks without deleting either copy, then allows a new explicit link', async () => {
    await attach();
    await unlinkTimeBlock(userId, blockId);
    expect(await block()).toBeDefined(); expect(remote.size).toBe(1);
    requests.length = 0;
    await request('PATCH', `/time-blocks/${blockId}`, { startTime: '18:00' });
    expect(requests).toHaveLength(0);
    await attach(); expect(remote.size).toBe(2);
  });
  it('rejects foreign blocks, foreign calendars, read-only calendars and invalid timezones', async () => {
    expect((await request('POST', `/time-blocks/${blockId}/calendar-link`, { calendarId, timezone: 'UTC' }, otherUserId)).status).toBe(404);
    await db.update(calendars).set({ userId: otherUserId }).where(eq(calendars.id, calendarId));
    expect((await request('POST', `/time-blocks/${blockId}/calendar-link`, { calendarId, timezone: 'UTC' })).status).toBe(404);
    await db.update(calendars).set({ userId, isReadOnly: true }).where(eq(calendars.id, calendarId));
    expect((await request('POST', `/time-blocks/${blockId}/calendar-link`, { calendarId, timezone: 'UTC' })).status).toBe(409);
    expect((await request('POST', `/time-blocks/${blockId}/calendar-link`, { calendarId, timezone: 'Invalid/Zone' })).status).toBe(400);
    expect(remote.size).toBe(0);
  });
  it('does not let a time-block-only API key publish to a calendar', async () => {
    const key = generateApiKey();
    await db.insert(apiKeys).values({ userId, name: 'Blocks only', keyHash: key.hash, keyPrefix: key.prefix, scopes: ['time-blocks:write'] });
    const response = await app.request(`/time-blocks/${blockId}/calendar-link`, { method: 'POST', headers: { 'X-API-Key': key.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ calendarId, timezone: 'UTC' }) });
    expect(response.status).toBe(401); expect(remote.size).toBe(0);
  });
  it('reports unsupported all-day edits without destroying the local schedule', async () => {
    await attach();
    const id = (await link()).externalId;
    remote.set(id, { ...remote.get(id)!, start: { date: '2026-10-03' }, end: { date: '2026-10-04' } });
    await syncLinkedTimeBlocks(userId);
    expect((await block()).date).toBe('2026-10-02');
    expect((await withCalendarLinks(userId, [await block()]))[0]!.calendarLink?.syncError).toContain('timed event');
  });
});
