import { describe, expect, it } from 'vitest';
import { scheduleInstants, scheduleFromEvent, sameSchedule } from './linked-block-schedule.js';

describe('linked calendar schedule conversion', () => {
  it('converts the example in New York without using the server timezone', () => {
    const schedule = { date: '2026-10-02', startTime: '19:30', endTime: '21:30' };
    const instants = scheduleInstants(schedule, 'America/New_York');
    expect(instants.startTime.toISOString()).toBe('2026-10-02T23:30:00.000Z');
    expect(instants.endTime.toISOString()).toBe('2026-10-03T01:30:00.000Z');
    expect(scheduleFromEvent({ ...instants, isAllDay: false }, 'America/New_York')).toEqual(schedule);
  });
  it.each(['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'])('round trips overnight blocks in %s', timezone => {
    const schedule = { date: '2026-10-02', startTime: '23:30', endTime: '01:00' };
    expect(scheduleFromEvent({ ...scheduleInstants(schedule, timezone), isAllDay: false }, timezone)).toEqual(schedule);
  });
  it('handles the DST boundary and rejects nonexistent local times', () => {
    const instants = scheduleInstants({ date: '2026-03-08', startTime: '01:30', endTime: '03:30' }, 'America/New_York');
    expect(instants.endTime.getTime() - instants.startTime.getTime()).toBe(3_600_000);
    expect(() => scheduleInstants({ date: '2026-03-08', startTime: '02:30', endTime: '03:30' }, 'America/New_York')).toThrow('does not exist');
  });
  it('rejects unsupported all-day and multi-day changes without truncating them', () => {
    const event = { startTime: new Date('2026-10-02T00:00Z'), endTime: new Date('2026-10-04T00:00Z'), isAllDay: false };
    expect(() => scheduleFromEvent(event, 'UTC')).toThrow('at most 24 hours');
    expect(() => scheduleFromEvent({ ...event, isAllDay: true }, 'UTC')).toThrow('timed event');
  });
  it('detects local rescheduling but ignores unrelated block metadata', () => {
    const schedule = { date: '2026-10-02', startTime: '19:30', endTime: '21:30' };
    expect(sameSchedule(schedule, null)).toBe(false);
    expect(sameSchedule(schedule, { ...schedule })).toBe(true);
    expect(sameSchedule(schedule, { ...schedule, date: '2026-10-03' })).toBe(false);
  });
});
