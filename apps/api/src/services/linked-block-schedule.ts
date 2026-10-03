import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { LinkedBlockSchedule } from '@open-sunsama/database';
import { addDaysToDate } from '../lib/calendar-day-window.js';

export function sameSchedule(a: LinkedBlockSchedule, b: LinkedBlockSchedule | null): boolean {
  return !!b && a.date === b.date && a.startTime === b.startTime && a.endTime === b.endTime;
}

export function scheduleInstants(schedule: LinkedBlockSchedule, timezone: string) {
  const endDate = schedule.endTime <= schedule.startTime
    ? addDaysToDate(schedule.date, 1) : schedule.date;
  const startTime = fromZonedTime(`${schedule.date}T${schedule.startTime}:00`, timezone);
  const endTime = fromZonedTime(`${endDate}T${schedule.endTime}:00`, timezone);
  // Do not silently shift a nonexistent spring-forward wall time.
  if (formatInTimeZone(startTime, timezone, 'yyyy-MM-dd HH:mm') !== `${schedule.date} ${schedule.startTime}` ||
      formatInTimeZone(endTime, timezone, 'yyyy-MM-dd HH:mm') !== `${endDate} ${schedule.endTime}` ||
      endTime <= startTime) {
    throw new Error('This time does not exist in the linked timezone. Choose another time.');
  }
  return { startTime, endTime };
}

export function scheduleFromEvent(event: { startTime: Date; endTime: Date; isAllDay: boolean }, timezone: string): LinkedBlockSchedule {
  const date = formatInTimeZone(event.startTime, timezone, 'yyyy-MM-dd');
  const endDate = formatInTimeZone(event.endTime, timezone, 'yyyy-MM-dd');
  const startTime = formatInTimeZone(event.startTime, timezone, 'HH:mm');
  const endTime = formatInTimeZone(event.endTime, timezone, 'HH:mm');
  if (event.isAllDay || event.endTime <= event.startTime ||
      !(endDate === date && endTime > startTime || endDate === addDaysToDate(date, 1) && endTime <= startTime)) {
    throw new Error('Use a timed event of at most 24 hours to sync this block, or unlink it.');
  }
  return { date, startTime, endTime };
}
