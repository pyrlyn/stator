/* print_dates.c — the Date calendar arithmetic and its printing, checked against Node.
 *
 * Ground truth is Node, not a table written here: runtime/tests/print_dates.ts builds the SAME
 * dates in the same order and prints the same answers with console.log; `just runtime-test`
 * diffs the two byte-for-byte. Keep the two corpora in the same order or the diff means nothing.
 *
 * What is under test is the ARITHMETIC, which is the part of Date that can be wrong in ways a
 * casual fixture never notices: the proleptic Gregorian leap rule (1900 is not a leap year, 2000
 * is), pre-epoch times, where FLOORED division differs from C's truncating division, the expanded
 * six-digit year form at the edges of the representable range, TimeClip, and the component
 * ROLLING that makes `setUTCMonth(13)` February of the next year.
 *
 * Nothing here reads a clock. Every value is a pure function of a literal, which is what makes
 * slice A of Date (plan.md §7 Task 4.2) provable this way at all.
 */

#include "corpus.h"

#include <stdio.h>

static void show(jsrt_value v) { jsrt_print(v); }

static jsrt_value at(double ms) { return jsrt_date_new(ms); }

/* Every UTC getter of one date, in one line per date -- the fastest way to make a calendar bug
 * visible, because a wrong day-of-week or a wrong month shows up beside a right year. */
static void fields(jsrt_value d) {
  show(jsrt_date_get_utc_full_year(d));
  show(jsrt_date_get_utc_month(d));
  show(jsrt_date_get_utc_date(d));
  show(jsrt_date_get_utc_day(d));
  show(jsrt_date_get_utc_hours(d));
  show(jsrt_date_get_utc_minutes(d));
  show(jsrt_date_get_utc_seconds(d));
  show(jsrt_date_get_utc_milliseconds(d));
}

int main(void) {
  /* The epoch, and the printed form at both nesting levels. */
  jsrt_value epoch = at(0);
  show(epoch);
  show(jsrt_date_to_iso_string(epoch));
  show(jsrt_date_to_utc_string(epoch));
  show(jsrt_date_get_time(epoch));
  fields(epoch);

  /* A leap day, with every component non-zero. */
  jsrt_value leap = at(1709214306789.0);
  show(leap);
  show(jsrt_date_to_iso_string(leap));
  show(jsrt_date_to_utc_string(leap));
  fields(leap);

  /* PRE-EPOCH, the case truncating division gets wrong: one day before the epoch is the last day
   * of 1969, not the first day of 1970 with a negative hour. */
  jsrt_value before = at(-86400000.0);
  show(before);
  fields(before);
  show(at(-1.0));
  fields(at(-1.0));

  /* The Gregorian leap rule at both exceptions: 1900 is NOT a leap year, 2000 is. Feb 29 of a
   * non-leap year rolls to March 1, which is the arithmetic proving it rather than a table. */
  show(at(-2208988800000.0)); /* 1900-01-01 */
  show(jsrt_date_utc(jsrt_number(1900), jsrt_number(1), jsrt_number(29), JSRT_UNDEFINED,
                     JSRT_UNDEFINED, JSRT_UNDEFINED, JSRT_UNDEFINED));
  show(jsrt_date_utc(jsrt_number(2000), jsrt_number(1), jsrt_number(29), JSRT_UNDEFINED,
                     JSRT_UNDEFINED, JSRT_UNDEFINED, JSRT_UNDEFINED));

  /* The expanded year form, at both ends of the representable range, and TimeClip past it. */
  show(at(8.64e15));
  show(jsrt_date_to_iso_string(at(8.64e15)));
  show(at(-8.64e15));
  show(jsrt_date_to_iso_string(at(-8.64e15)));
  show(jsrt_date_get_time(at(8.64e15 + 1.0)));
  show(at(8.64e15 + 1.0));
  show(at(-62198755200000.0)); /* year -1, the signed six-digit form */

  /* An Invalid Date: every getter is NaN, toJSON is null, and the printed form is a name. */
  jsrt_value bad = at(0.0 / 0.0);
  show(bad);
  show(jsrt_date_get_time(bad));
  fields(bad);
  show(jsrt_date_to_json(bad));
  show(jsrt_date_to_utc_string(bad));

  /* Date.UTC: the defaults (month 0, day 1, zeros), and the two-digit-year rule. */
  show(jsrt_date_utc(jsrt_number(2024), JSRT_UNDEFINED, JSRT_UNDEFINED, JSRT_UNDEFINED,
                     JSRT_UNDEFINED, JSRT_UNDEFINED, JSRT_UNDEFINED));
  show(jsrt_date_utc(jsrt_number(2024), jsrt_number(1), jsrt_number(29), jsrt_number(13),
                     jsrt_number(45), jsrt_number(6), jsrt_number(789)));
  show(jsrt_date_utc(jsrt_number(95), jsrt_number(0), JSRT_UNDEFINED, JSRT_UNDEFINED,
                     JSRT_UNDEFINED, JSRT_UNDEFINED, JSRT_UNDEFINED));
  /* Out-of-range components ROLL rather than clamp: month 12 is January of the next year, day 0
   * is the last day of the previous month. */
  show(jsrt_date_utc(jsrt_number(2024), jsrt_number(12), jsrt_number(0), JSRT_UNDEFINED,
                     JSRT_UNDEFINED, JSRT_UNDEFINED, JSRT_UNDEFINED));

  /* Date.parse, ISO only. A date-only form is UTC; a date-time WITHOUT an offset is local time,
   * which slice A does not resolve, so it is honestly NaN rather than a guess. */
  show(jsrt_date_parse(str("2024-02-29T13:45:06.789Z")));
  show(jsrt_date_parse(str("2024-02-29")));
  show(jsrt_date_parse(str("2024-02")));
  show(jsrt_date_parse(str("2024")));
  show(jsrt_date_parse(str("2024-02-29T13:45:06+02:00")));
  show(jsrt_date_parse(str("2024-02-29T13:45Z")));
  show(jsrt_date_parse(str("not a date")));
  show(jsrt_date_parse(str("")));

  /* The setters, each rebuilding the time value from the fields it does not touch. */
  jsrt_value m = at(1709214306789.0);
  show(jsrt_date_set_utc_milliseconds(m, jsrt_number(1)));
  show(m);
  show(jsrt_date_set_utc_seconds(m, jsrt_number(9), JSRT_UNDEFINED));
  show(m);
  show(jsrt_date_set_utc_minutes(m, jsrt_number(0), jsrt_number(0), jsrt_number(0)));
  show(m);
  show(jsrt_date_set_utc_hours(m, jsrt_number(23), JSRT_UNDEFINED, JSRT_UNDEFINED,
                               JSRT_UNDEFINED));
  show(m);
  show(jsrt_date_set_utc_date(m, jsrt_number(1)));
  show(m);
  /* Month 13 rolls into the next year -- the setters normalize the same way MakeDay does. */
  show(jsrt_date_set_utc_month(m, jsrt_number(13), JSRT_UNDEFINED));
  show(m);
  show(jsrt_date_set_utc_full_year(m, jsrt_number(1999), JSRT_UNDEFINED, JSRT_UNDEFINED));
  show(m);
  show(jsrt_date_set_time(m, jsrt_number(0)));
  show(m);

  /* Setting the YEAR on an Invalid Date recovers (§21.4.4.21 substitutes +0 for the NaN fields);
   * setting any other field does not. */
  jsrt_value revive = at(0.0 / 0.0);
  show(jsrt_date_set_utc_full_year(revive, jsrt_number(2024), JSRT_UNDEFINED, JSRT_UNDEFINED));
  show(revive);
  jsrt_value stays = at(0.0 / 0.0);
  show(jsrt_date_set_utc_date(stays, jsrt_number(5)));
  show(stays);

  /* Nesting, and JSON -- a Date serializes through toJSON, so an Invalid one is "null". */
  jsrt_value pair[2] = {at(0), at(1709214306789.0)};
  show(jsrt_array_new(2, pair));
  show(jsrt_json_stringify(jsrt_array_new(2, pair)));
  show(jsrt_json_stringify(at(0.0 / 0.0)));
  show(jsrt_json_stringify(at(1709214306789.0)));

  /* new Date(x) for a non-number x. */
  show(jsrt_date_from_value(str("2024-02-29T13:45:06.789Z")));
  show(jsrt_date_from_value(str("nope")));
  show(jsrt_date_from_value(jsrt_number(1000)));
  show(jsrt_date_from_value(at(0)));
  return 0;
}
