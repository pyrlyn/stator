// print_dates.ts — the ground truth for print_dates.c. Same dates, same order, console.log.
// If these two files drift apart the diff is meaningless, so edit them together.

const show = (v: unknown): void => {
  console.log(v);
};
const at = (ms: number): Date => new Date(ms);
const fields = (d: Date): void => {
  show(d.getUTCFullYear());
  show(d.getUTCMonth());
  show(d.getUTCDate());
  show(d.getUTCDay());
  show(d.getUTCHours());
  show(d.getUTCMinutes());
  show(d.getUTCSeconds());
  show(d.getUTCMilliseconds());
};

const epoch = at(0);
show(epoch);
show(epoch.toISOString());
show(epoch.toUTCString());
show(epoch.getTime());
fields(epoch);

const leap = at(1709214306789);
show(leap);
show(leap.toISOString());
show(leap.toUTCString());
fields(leap);

const before = at(-86400000);
show(before);
fields(before);
show(at(-1));
fields(at(-1));

show(at(-2208988800000));
show(Date.UTC(1900, 1, 29));
show(Date.UTC(2000, 1, 29));

show(at(8.64e15));
show(at(8.64e15).toISOString());
show(at(-8.64e15));
show(at(-8.64e15).toISOString());
show(at(8.64e15 + 1).getTime());
show(at(8.64e15 + 1));
show(at(-62198755200000));

const bad = at(NaN);
show(bad);
show(bad.getTime());
fields(bad);
show(bad.toJSON());
show(bad.toUTCString());

show(Date.UTC(2024));
show(Date.UTC(2024, 1, 29, 13, 45, 6, 789));
show(Date.UTC(95, 0));
show(Date.UTC(2024, 12, 0));

show(Date.parse('2024-02-29T13:45:06.789Z'));
show(Date.parse('2024-02-29'));
show(Date.parse('2024-02'));
show(Date.parse('2024'));
show(Date.parse('2024-02-29T13:45:06+02:00'));
show(Date.parse('2024-02-29T13:45Z'));
show(Date.parse('not a date'));
show(Date.parse(''));

const m = at(1709214306789);
show(m.setUTCMilliseconds(1));
show(m);
show(m.setUTCSeconds(9));
show(m);
show(m.setUTCMinutes(0, 0, 0));
show(m);
show(m.setUTCHours(23));
show(m);
show(m.setUTCDate(1));
show(m);
show(m.setUTCMonth(13));
show(m);
show(m.setUTCFullYear(1999));
show(m);
show(m.setTime(0));
show(m);

const revive = at(NaN);
show(revive.setUTCFullYear(2024));
show(revive);
const stays = at(NaN);
show(stays.setUTCDate(5));
show(stays);

const pair = [at(0), at(1709214306789)];
show(pair);
show(JSON.stringify(pair));
show(JSON.stringify(at(NaN)));
show(JSON.stringify(at(1709214306789)));

show(new Date('2024-02-29T13:45:06.789Z'));
show(new Date('nope'));
show(new Date(1000));
show(new Date(at(0)));
