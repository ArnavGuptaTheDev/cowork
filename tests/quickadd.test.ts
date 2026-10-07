import { describe, expect, it } from 'vitest';
import { parseQuickAdd, parseTime } from '../shared/quickadd';

const TODAY = '2026-10-07'; // a Wednesday
const q = (s: string) => parseQuickAdd(s, TODAY);

describe('parseTime', () => {
  it.each([
    ['7am', '07:00'],
    ['7 am', '07:00'],
    ['7:30pm', '19:30'],
    ['7.30 p.m.', '19:30'],
    ['12am', '00:00'],
    ['12pm', '12:00'],
    ['19:05', '19:05'],
    ['noon', '12:00'],
    ['midnight', '00:00'],
  ])('%s -> %s', (input, out) => expect(parseTime(input)).toBe(out));

  it.each(['13pm', '25:00', '7:75pm', '20', 'abc'])('rejects %s', (input) => expect(parseTime(input)).toBeNull());
});

describe('parseQuickAdd: plain titles', () => {
  it('keeps a title with no hints untouched', () => {
    const r = q('Read 20 pages');
    expect(r).toMatchObject({ title: 'Read 20 pages', startDate: null, dueTime: null, recurrence: { type: 'none' }, category: null });
    expect(r.tokens).toEqual([]);
  });

  it('does not treat numbers in titles as times', () => {
    expect(q('Buy 2 litres of milk').dueTime).toBeNull();
    expect(q('Ship v2 at last').title).toBe('Ship v2 at last');
  });
});

describe('parseQuickAdd: dates', () => {
  it.each([
    ['call mum today', '2026-10-07'],
    ['call mum tonight', '2026-10-07'],
    ['call mum tomorrow', '2026-10-08'],
    ['call mum tmrw', '2026-10-08'],
    ['call mum day after tomorrow', '2026-10-09'],
    ['call mum fri', '2026-10-09'],
    ['call mum on friday', '2026-10-09'],
    ['call mum wed', '2026-10-14'], // a weekday name means the next one, not today
    ['call mum next fri', '2026-10-16'],
    ['call mum next week', '2026-10-12'],
    ['call mum in 3 days', '2026-10-10'],
    ['call mum in 2 weeks', '2026-10-21'],
    ['call mum 12 oct', '2026-10-12'],
    ['call mum 12th October', '2026-10-12'],
    ['call mum oct 12', '2026-10-12'],
    ['call mum on october 12th, 2027', '2027-10-12'],
    ['call mum 12/10', '2026-10-12'],
    ['call mum 1/2/2027', '2027-02-01'],
    ['call mum 2026-11-30', '2026-11-30'],
  ])('%s', (input, date) => {
    const r = q(input);
    expect(r.startDate).toBe(date);
    expect(r.title).toBe('call mum');
  });

  it('rolls past dates without a year into next year', () => {
    expect(q('renew passport 3 jan').startDate).toBe('2027-01-03');
    expect(q('renew passport 1 oct').startDate).toBe('2027-10-01');
  });

  it('ignores impossible dates', () => {
    const r = q('meet 31 feb 2026');
    expect(r.startDate).toBeNull();
  });
});

describe('parseQuickAdd: times', () => {
  it('parses due times with "at"', () => {
    expect(q('standup at 10am')).toMatchObject({ title: 'standup', dueTime: '10:00' });
    expect(q('gym 7am tomorrow')).toMatchObject({ title: 'gym', dueTime: '07:00', startDate: '2026-10-08' });
    expect(q('dinner at 19:30')).toMatchObject({ title: 'dinner', dueTime: '19:30' });
  });

  it('guesses am/pm for "at N"', () => {
    expect(q('call at 4').dueTime).toBe('16:00');
    expect(q('call at 9').dueTime).toBe('09:00');
  });

  it('separates a reminder from the due time', () => {
    expect(q('pay rent at 6pm remind me at 5pm')).toMatchObject({ title: 'pay rent', dueTime: '18:00', reminderTime: '17:00' });
    expect(q('pay rent remind 9am')).toMatchObject({ title: 'pay rent', reminderTime: '09:00', dueTime: null });
  });
});

describe('parseQuickAdd: recurrence', () => {
  it.each([
    ['meditate every day', { type: 'daily' }],
    ['meditate daily', { type: 'daily' }],
    ['standup every weekday', { type: 'weekly', weekdays: [1, 2, 3, 4, 5] }],
    ['long run every weekend', { type: 'weekly', weekdays: [0, 6] }],
    ['gym every mon wed fri', { type: 'weekly', weekdays: [1, 3, 5] }],
    ['gym every mon, wed and fri', { type: 'weekly', weekdays: [1, 3, 5] }],
    ['gym every monday', { type: 'weekly', weekdays: [1] }],
    ['gym every tuesdays', { type: 'weekly', weekdays: [2] }],
    ['pay rent monthly on the 5th', { type: 'monthly', monthDay: 5 }],
    ['pay rent every month on 5th', { type: 'monthly', monthDay: 5 }],
    ['pay rent every 1st', { type: 'monthly', monthDay: 1 }],
    ['water plants weekly', { type: 'weekly', weekdays: [3] }],
    ['review budget monthly', { type: 'monthly', monthDay: 7 }],
  ])('%s', (input, rule) => {
    expect(q(input).recurrence).toEqual(rule);
  });

  it('defaults recurring quick-adds to the habit category and strips the phrase', () => {
    const r = q('gym every mon wed fri 7am');
    expect(r).toMatchObject({ title: 'gym', category: 'habit', dueTime: '07:00' });
  });

  it('starts a weekly rule on the next matching day when today does not match', () => {
    expect(q('gym every mon').startDate).toBe('2026-10-12');
    expect(q('gym every wed').startDate).toBeNull(); // today matches
  });

  it('keeps an explicit start date alongside a rule', () => {
    expect(q('yoga every day from 12 oct')).toMatchObject({ title: 'yoga', startDate: '2026-10-12', recurrence: { type: 'daily' } });
  });
});

describe('parseQuickAdd: projects, categories, partner', () => {
  it('pulls out #project, @category and "for partner"', () => {
    const r = q('Post project on LinkedIn fri 6pm #side-project @work');
    expect(r).toMatchObject({
      title: 'Post project on LinkedIn',
      startDate: '2026-10-09',
      dueTime: '18:00',
      projectName: 'side project',
      category: 'work',
    });
  });

  it('turns "for partner" into a suggestion flag', () => {
    const r = q('book the dentist for partner tomorrow');
    expect(r).toMatchObject({ title: 'book the dentist', forPartner: true, startDate: '2026-10-08' });
  });

  it('maps @home to personal', () => {
    expect(q('laundry @home').category).toBe('personal');
  });

  it('reports understood tokens in input order', () => {
    expect(q('gym tomorrow 7am #health').tokens.map((t) => t.kind)).toEqual(['date', 'time', 'project']);
  });

  it('cleans dangling prepositions from the title', () => {
    expect(q('call the bank on').title).toBe('call the bank');
    expect(q('submit report by fri').title).toBe('submit report');
  });
});
