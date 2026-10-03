import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Link2, Loader2, ExternalLink } from 'lucide-react';
import type { TimeBlock } from '@open-sunsama/types';
import { getApi } from '@/lib/api';
import { calendarKeys, timeBlockKeys } from '@/lib/query-keys';
import { useCalendars, useCalendarAccounts } from '@/hooks/useCalendars';
import { toast } from '@/hooks/use-toast';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';

export function TimeBlockCalendarAction({ timeBlock }: { timeBlock: TimeBlock }) {
  const [open, setOpen] = useState(false);
  const [calendarId, setCalendarId] = useState('');
  const queryClient = useQueryClient();
  const link = timeBlock.calendarLink;
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: timeBlockKeys.all }),
      queryClient.invalidateQueries({ queryKey: calendarKeys.all }),
    ]);
  };
  const mutation = useMutation({
    mutationFn: async (action: 'link' | 'unlink' | 'retry') => {
      if (action === 'unlink') {
        await getApi().timeBlocks.unlinkCalendar(timeBlock.id);
        return null;
      }
      return getApi().timeBlocks.linkCalendar(timeBlock.id, action === 'retry' ? link!.calendarId : calendarId,
        link?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    },
    onSuccess: async (block, action) => {
      await refresh();
      if (block?.calendarLink?.syncError) {
        toast({ variant: 'destructive', title: 'Calendar sync needs attention', description: block.calendarLink.syncError });
      } else if (action !== 'unlink' && !block?.calendarLink) {
        toast({ variant: 'destructive', title: 'Could not link this block', description: 'The event or calendar was removed. Choose a calendar and try again.' });
      } else {
        setOpen(false);
        toast({ title: action === 'unlink' ? 'Calendar unlinked' : 'Calendar linked',
          description: action === 'unlink' ? 'Both copies were kept. Future time changes stay separate.' : 'Time changes will sync in both directions.' });
      }
    },
    onError: (error) => toast({ variant: 'destructive', title: 'Could not update calendar link', description: error.message }),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 max-w-full gap-1.5 px-2 text-xs" aria-label={link ? `Calendar link: ${link.calendarName}` : 'Add to calendar'}>
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : link ? <Link2 className="h-3.5 w-3.5" /> : <CalendarPlus className="h-3.5 w-3.5" />}
          <span className="truncate">{link ? link.status === 'error' ? 'Sync needs attention' : link.status === 'pending' ? 'Sync pending' : 'Linked to calendar' : 'Add to calendar'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3 text-xs">
        {link ? (
          <>
            <div>
              <p className="font-medium">{link.calendarName}</p>
              <p className="break-all text-muted-foreground">{link.accountEmail}</p>
            </div>
            <p className="text-muted-foreground">Time changes sync both ways in {link.timezone}. Deleting this block also removes its calendar event.</p>
            {link.syncError && <p role="alert" className="text-destructive">{link.syncError}</p>}
            {link.htmlLink && <a href={link.htmlLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-primary hover:underline">Open in Google Calendar <ExternalLink className="h-3 w-3" /></a>}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate('retry')}>Sync now</Button>
              <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate('unlink')}>Unlink</Button>
            </div>
            <p className="text-muted-foreground">Unlinking keeps both copies and stops syncing.</p>
          </>
        ) : (
          <CalendarPicker calendarId={calendarId} onChange={setCalendarId} pending={mutation.isPending} onSubmit={() => mutation.mutate('link')} />
        )}
      </PopoverContent>
    </Popover>
  );
}

// Fetch destinations only when the user opens the picker.
function CalendarPicker({ calendarId, onChange, pending, onSubmit }: {
  calendarId: string; onChange: (id: string) => void; pending: boolean; onSubmit: () => void;
}) {
  const calendars = useCalendars();
  const accounts = useCalendarAccounts();
  const writable = (calendars.data ?? []).filter(calendar => !calendar.isReadOnly &&
    accounts.data?.some(account => account.id === calendar.accountId && account.provider === 'google' && account.isActive));
  if (calendars.isPending || accounts.isPending) return <p role="status">Loading calendars…</p>;
  if (calendars.isError || accounts.isError) return <div className="space-y-2"><p role="alert">Could not load calendars.</p><Button size="sm" onClick={() => { void calendars.refetch(); void accounts.refetch(); }}>Retry</Button></div>;
  return (
    <>
      <p className="font-medium">Add this block to Google Calendar</p>
      <p className="text-muted-foreground">Shares the task title and this block’s time. Later time changes sync both ways. Other blocks stay private.</p>
      {writable.length ? (
        <>
          <label className="block space-y-1">
            <span>Calendar</span>
            <select aria-label="Calendar for time block" value={calendarId} onChange={event => onChange(event.target.value)} disabled={pending}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring">
              <option value="">Choose a calendar</option>
              {writable.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name} · {accounts.data?.find(account => account.id === calendar.accountId)?.email}</option>)}
            </select>
          </label>
          <Button size="sm" className="w-full" disabled={pending || !writable.some(calendar => calendar.id === calendarId)} onClick={onSubmit}>
            {pending ? 'Adding…' : 'Add to calendar'}
          </Button>
        </>
      ) : <p className="text-muted-foreground">Connect a Google account with a writable calendar in <a href="/app/settings" className="text-primary hover:underline">Settings</a> to link this block.</p>}
    </>
  );
}
