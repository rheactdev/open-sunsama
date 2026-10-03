import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { calendarsRouter } from '../routes/calendars.js';
import { calendarAccountsRouter } from '../routes/calendar-accounts.js';
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
const app = new Hono().use('*', cors()).route('/time-blocks', timeBlocksRouter).route('/calendar-events', calendarEventsRouter);
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


it('temporary browser preview with simulated Google', async () => {
  app.route('/calendars', calendarsRouter);
  app.route('/calendar/accounts', calendarAccountsRouter);
  app.post('/auth/login', async c => c.json({ success: true, data: { token: signToken(userId), user: (await db.select().from(users).where(eq(users.id,userId)))[0] } }));
  app.get('/auth/me', async c => c.json({ success: true, data: (await db.select().from(users).where(eq(users.id,userId)))[0] }));
  app.get('/tasks/active', c => c.json({success:true,data:null}));
  app.get('/tasks/active-timer', c => c.json({success:true,data:null}));
  app.get('/tasks', async c => c.json({success:true,data:await db.select().from(tasks),meta:{page:1,total:1,totalPages:1}}));
  app.get('/tasks/:id', async c => c.json({success:true,data:(await db.select().from(tasks).where(eq(tasks.id,c.req.param('id'))))[0]}));
  app.get('*', c => c.json({success:true,data:[],meta:{total:0,page:1,totalPages:0}}));
  const server = serve({fetch:app.fetch, port:3001, hostname:'127.0.0.1'});
  console.log('Calendar preview API ready');
  await new Promise(resolve => setTimeout(resolve, 1200000));
  server.close();
}, 1250000);
