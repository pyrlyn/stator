/* jsrt_date.c — `Date`, slice A: the TZ-INDEPENDENT core (plan.md §7 Task 4.2).
 *
 * A Date is one double: milliseconds since 1970-01-01T00:00:00Z, or NaN for an Invalid Date. Every
 * operation here is a pure function of that double, which is exactly what makes this slice
 * testable by ordinary golden tests — no clock is read, no timezone database is consulted, and the
 * output on any machine is the output on the pinned Node. The local-time half (`getHours` and its
 * siblings, `getTimezoneOffset`) is slice B, and `Date.now`/`new Date()` read a clock and land
 * under the determinism carve-out. `toString`/`toLocale*` need CLDR names and belong to the intl
 * feature build (Task 4.4).
 *
 * The calendar arithmetic is Howard Hinnant's `days_from_civil`/`civil_from_days` (the algorithms
 * behind C++20's <chrono>), which are exact over the proleptic Gregorian calendar for every year a
 * time value can reach. ECMA-262 §21.4.1 defines the same calendar, so this is a translation
 * rather than an approximation: 1900 is not a leap year here, 2000 is, and year 0 exists.
 */

/* Linux builds request strict POSIX declarations globally. That exposes `localtime_r` but hides
 * the BSD/GNU `tm_gmtoff` alias below in both glibc and musl unless GNU extensions are requested
 * before the first system header. Keep that broader feature set local to the one runtime source
 * that needs it. */
#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include "jsrt_value.h"

#include "jsrt.h"

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

const JSRTClass jsrt_class_date = {"Date", 0, NULL, NULL, 0, NULL, NULL, NULL, NULL};

#define MS_PER_SECOND 1000.0
#define MS_PER_MINUTE 60000.0
#define MS_PER_HOUR 3600000.0
#define MS_PER_DAY 86400000.0

/* §21.4.1.1: the largest time value is 100,000,000 days either side of the epoch. A value outside
 * it is not a clamped date, it is an Invalid Date -- `new Date(8.64e15 + 1).getTime()` is NaN. */
#define MAX_TIME_VALUE 8.64e15

/* TimeClip (§21.4.1.31): a time value is an INTEGER number of milliseconds in range, or NaN.
 * `trunc` rather than `floor` because the spec truncates toward zero, which differs for a
 * fractional negative time. */
static double time_clip(double t) {
  if (!isfinite(t) || fabs(t) > MAX_TIME_VALUE) {
    return NAN;
  }
  /* `+0.0` normalizes a -0 result: the spec's ToIntegerOrInfinity gives +0, and -0 would print as
   * "-0" through the number formatter. */
  return trunc(t) + 0.0;
}

/* Floored division and modulo -- C's `/` and `fmod` truncate toward zero, which puts a pre-epoch
 * time in the wrong day. `floor(-1 / 86400000)` is the day BEFORE the epoch, which is what a
 * negative time value means. */
static double floor_div(double a, double b) { return floor(a / b); }

static double floor_mod(double a, double b) { return a - floor_div(a, b) * b; }

/* Days since 1970-01-01 from a proleptic Gregorian y/m/d (Hinnant). `m` is 1..12 and `d` is 1..31;
 * out-of-range values are the CALLER's to normalize, which is what MakeDay does. */
static double days_from_civil(double y, double m, double d) {
  y -= m <= 2 ? 1 : 0;
  const double era = floor_div(y, 400);
  const double yoe = y - era * 400;                                          /* [0, 399] */
  const double doy = floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;  /* [0, 365] */
  const double doe = yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy;    /* [0, 146096] */
  return era * 146097 + doe - 719468;
}

typedef struct {
  double year;
  double month; /* 1..12 */
  double day;   /* 1..31 */
} Civil;

static Civil civil_from_days(double z) {
  z += 719468;
  const double era = floor_div(z, 146097);
  const double doe = z - era * 146097;                                               /* [0, 146096] */
  const double yoe = floor((doe - floor(doe / 1460) + floor(doe / 36524) - floor(doe / 146096)) / 365);
  const double y = yoe + era * 400;
  const double doy = doe - (365 * yoe + floor(yoe / 4) - floor(yoe / 100));          /* [0, 365] */
  const double mp = floor((5 * doy + 2) / 153);                                      /* [0, 11] */
  const double d = doy - floor((153 * mp + 2) / 5) + 1;                              /* [1, 31] */
  const double m = mp + (mp < 10 ? 3 : -9);                                          /* [1, 12] */
  Civil out = {y + (m <= 2 ? 1 : 0), m, d};
  return out;
}

/* ============================================================================
 * Construction and the time value
 * ============================================================================ */

static JSRTDate *as_date(jsrt_value v) {
  if (!jsrt_is_date(v)) {
    jsrt_panic("STA4093: a Date operation on a value that is not a Date");
  }
  return (JSRTDate *)jsrt_ptr(v);
}

jsrt_value jsrt_date_new(double time) {
  JSRTDate *d = (JSRTDate *)jsrt_gc_alloc(sizeof(JSRTDate), "date");
  d->cls = &jsrt_class_date;
  d->time = time_clip(time);
  return JSRT_BOX(JSRT_TAG_OBJECT, (uintptr_t)d);
}

/* The one member of this file that is not a pure function of its input, and the reason `Date.now`
 * and zero-argument `new Date()` prove through the determinism carve-out rather than a golden
 * test. CLOCK_REALTIME, not CLOCK_MONOTONIC: §21.4.3.1 asks for the time since the epoch, which is
 * the wall clock -- a monotonic clock's origin is unspecified. The spec's answer is a whole number
 * of milliseconds, so the sub-millisecond remainder is truncated rather than rounded. */
double jsrt_date_now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
    return NAN;
  }
  return trunc((double)ts.tv_sec * MS_PER_SECOND + (double)ts.tv_nsec / 1000000.0);
}

jsrt_value jsrt_date_now(void) { return jsrt_number(jsrt_date_now_ms()); }

double jsrt_date_value(jsrt_value v) { return as_date(v)->time; }

jsrt_value jsrt_date_get_time(jsrt_value v) { return jsrt_number(as_date(v)->time); }

jsrt_value jsrt_date_set_time(jsrt_value v, jsrt_value ms) {
  JSRTDate *d = as_date(v);
  d->time = time_clip(jsrt_to_number(ms));
  return jsrt_number(d->time);
}

/* ============================================================================
 * The UTC field getters (§21.4.4.x)
 * ============================================================================
 *
 * Every one answers NaN for an Invalid Date -- the spec's "If t is NaN, return NaN" -- which is
 * why the NaN check is here once rather than in eight places. */

typedef enum {
  F_FULL_YEAR,
  F_MONTH,
  F_DATE,
  F_DAY,
  F_HOURS,
  F_MINUTES,
  F_SECONDS,
  F_MILLISECONDS
} DateField;

static double field_of(double t, DateField which) {
  if (isnan(t)) {
    return NAN;
  }
  const double day = floor_div(t, MS_PER_DAY);
  switch (which) {
    case F_FULL_YEAR:
      return civil_from_days(day).year;
    case F_MONTH:
      /* Zero-based, as the language exposes it: `getUTCMonth()` of a January date is 0. */
      return civil_from_days(day).month - 1;
    case F_DATE:
      return civil_from_days(day).day;
    case F_DAY:
      /* 1970-01-01 was a Thursday, so the epoch day is weekday 4. */
      return floor_mod(day + 4, 7);
    case F_HOURS:
      return floor_mod(floor_div(t, MS_PER_HOUR), 24);
    case F_MINUTES:
      return floor_mod(floor_div(t, MS_PER_MINUTE), 60);
    case F_SECONDS:
      return floor_mod(floor_div(t, MS_PER_SECOND), 60);
    case F_MILLISECONDS:
      return floor_mod(t, MS_PER_SECOND);
  }
  jsrt_panic("STA4093: a Date field the runtime does not know");
}

/* ============================================================================
 * Local time (§21.4.1.7, §21.4.1.25-26) -- slice B
 * ============================================================================
 *
 * The ONLY part of Date that consults the outside world. libc owns the tz database, so the offset
 * comes from `localtime_r`'s `tm_gmtoff` rather than from rules this file would have to keep in
 * step with tzdata; everything above this comment stays a pure function of the stored double,
 * which is what keeps the UTC slice golden-testable.
 *
 * `tm_gmtoff` is a BSD/GNU field rather than a C11 one. It is present on every platform this
 * runtime targets (macOS and glibc/musl Linux), and the alternative -- `mktime` round-tripping a
 * `struct tm` -- cannot answer the offset for a time outside `time_t`'s comfortable range without
 * the same extrapolation, so it buys nothing and costs the DST disambiguation below. */

/* The offset EAST of UTC, in milliseconds, in effect at the instant `t` (a UTC time value).
 * Answers 0 for a time libc cannot place: the tz database has a finite range and a date 8000 years
 * out is past the end of every rule, where the spec's own answer is implementation-defined and 0
 * is the honest one rather than whatever a failed conversion left in the struct. */
static double offset_at(double t) {
  if (!isfinite(t)) {
    return 0;
  }
  const double secs = floor_div(t, MS_PER_SECOND);
  /* Outside time_t's 64-bit range the conversion is meaningless; inside it, libc extrapolates the
   * last rule, which is what §21.4.1.7 asks implementations to do. */
  if (secs < -9.2e18 || secs > 9.2e18) {
    return 0;
  }
  const time_t as_time = (time_t)secs;
  struct tm parts;
  if (localtime_r(&as_time, &parts) == NULL) {
    return 0;
  }
  return (double)parts.tm_gmtoff * MS_PER_SECOND;
}

/* LocalTime(t) (§21.4.1.7): the wall-clock reading of a UTC instant, as a time value. Every local
 * getter is its UTC twin applied to this. */
static double local_time(double t) { return isnan(t) ? NAN : t + offset_at(t); }

/* UTC(t) (§21.4.1.26): the inverse, and the half that is not a bijection. A local reading during a
 * spring-forward gap names no instant, and one during a fall-back overlap names two.
 *
 * Two passes, which is what every engine does: guess with the offset that applies when the local
 * reading is READ as a UTC instant, then re-ask at the instant that guess names. If the two agree
 * the answer is exact; if they disagree the local reading sat within one offset-change of a
 * transition, and the second answer is used -- deterministic, and on the correct side for every
 * reading outside the transition's own width. The remaining ambiguity is inherent to the operation
 * rather than to this implementation, which is why the plan proves DST behaviour with runtime unit
 * tests on dates whose rules are stable rather than with golden fixtures (plan §7, Date step 8). */
static double utc_from_local(double local) {
  if (isnan(local)) {
    return NAN;
  }
  /* §21.4.1.26. Turning a wall-clock reading back into an instant is NOT a bijection: across a
   * negative transition (DST ending) the reading happens twice, and across a positive one (DST
   * starting) it never happens at all. The spec resolves both the same way -- with the offset in
   * effect BEFORE the transition, which is the earliest instant when there are two and the only
   * sensible answer when there are none. The one-day probes either side are the spec's own window
   * (its `before` is t - 1 day) and are wider than any real zone's offset. */
  const double pre = offset_at(local - MS_PER_DAY);
  const double post = offset_at(local + MS_PER_DAY);
  const double from_pre = local - pre;
  const double from_post = local - post;
  if (offset_at(from_pre) == pre) {
    return from_pre;
  }
  if (offset_at(from_post) == post) {
    return from_post;
  }
  /* The gap: no instant maps to this reading, so the pre-transition offset settles it. */
  return from_pre;
}

/* The time value a field read should be taken over: the stored one for a UTC member, its local
 * reading for a local one. One place, so the two families cannot drift. */
static double reading(jsrt_value v, bool local) {
  const double t = as_date(v)->time;
  return local ? local_time(t) : t;
}

/* getTimezoneOffset (§21.4.4.7) is defined as (t - LocalTime(t)) / msPerMinute, which is MINUTES
 * WEST of UTC -- the opposite sign from `tm_gmtoff`, and the reason this is not simply the offset
 * divided by 60000 with the sign left alone. */
jsrt_value jsrt_date_get_timezone_offset(jsrt_value v) {
  const double t = as_date(v)->time;
  return jsrt_number(isnan(t) ? NAN : (t - local_time(t)) / MS_PER_MINUTE);
}

/* The two getter families differ in ONE bit -- which time value the field is read over -- so they
 * are generated from one macro rather than written twice. `reading()` (below, with the local-time
 * machinery) is where that bit is spent; a local getter is otherwise its UTC twin exactly. */
#define DATE_GETTER(name, field, local)                                                            \
  jsrt_value jsrt_date_get_##name(jsrt_value v) { return jsrt_number(field_of(reading(v, local), field)); }

#define DATE_GETTER_FIELDS(X)                                                                      \
  X(utc_full_year, F_FULL_YEAR, false)                                                             \
  X(utc_month, F_MONTH, false)                                                                     \
  X(utc_date, F_DATE, false)                                                                       \
  X(utc_day, F_DAY, false)                                                                         \
  X(utc_hours, F_HOURS, false)                                                                     \
  X(utc_minutes, F_MINUTES, false)                                                                 \
  X(utc_seconds, F_SECONDS, false)                                                                 \
  X(utc_milliseconds, F_MILLISECONDS, false)                                                       \
  X(full_year, F_FULL_YEAR, true)                                                                  \
  X(month, F_MONTH, true)                                                                          \
  X(date, F_DATE, true)                                                                            \
  X(day, F_DAY, true)                                                                              \
  X(hours, F_HOURS, true)                                                                          \
  X(minutes, F_MINUTES, true)                                                                      \
  X(seconds, F_SECONDS, true)                                                                      \
  X(milliseconds, F_MILLISECONDS, true)

DATE_GETTER_FIELDS(DATE_GETTER)

/* ============================================================================
 * MakeDay / MakeTime / MakeDate (§21.4.1.27-29), which the setters and Date.UTC share
 * ============================================================================ */

/* The spec normalizes out-of-range components rather than rejecting them: month 12 is January of
 * the next year, day 0 is the last day of the previous month, hour 25 is 1am tomorrow. That falls
 * out of the arithmetic here for free, which is why `Date.UTC(2024, 12, 0)` is a date and not an
 * error. */
static double make_day(double year, double month, double day) {
  if (!isfinite(year) || !isfinite(month) || !isfinite(day)) {
    return NAN;
  }
  year = trunc(year);
  month = trunc(month);
  day = trunc(day);
  const double ym = year + floor_div(month, 12);
  const double mn = floor_mod(month, 12);
  return days_from_civil(ym, mn + 1, 1) + day - 1;
}

static double make_time(double h, double m, double s, double ms) {
  if (!isfinite(h) || !isfinite(m) || !isfinite(s) || !isfinite(ms)) {
    return NAN;
  }
  return trunc(h) * MS_PER_HOUR + trunc(m) * MS_PER_MINUTE + trunc(s) * MS_PER_SECOND + trunc(ms);
}

static double make_date(double day, double time) {
  if (!isfinite(day) || !isfinite(time)) {
    return NAN;
  }
  return day * MS_PER_DAY + time;
}

/* Date.UTC (§21.4.3.4). The spec's defaults are month 0, day 1, and zero for the rest; a missing
 * YEAR makes the result NaN, which is what `jsrt_to_number(JSRT_UNDEFINED)` already answers. */
jsrt_value jsrt_date_utc(jsrt_value year, jsrt_value month, jsrt_value day, jsrt_value hours,
                        jsrt_value minutes, jsrt_value seconds, jsrt_value ms) {
  const double y = jsrt_to_number(year);
  const double mo = month == JSRT_UNDEFINED ? 0 : jsrt_to_number(month);
  const double d = day == JSRT_UNDEFINED ? 1 : jsrt_to_number(day);
  const double h = hours == JSRT_UNDEFINED ? 0 : jsrt_to_number(hours);
  const double mi = minutes == JSRT_UNDEFINED ? 0 : jsrt_to_number(minutes);
  const double s = seconds == JSRT_UNDEFINED ? 0 : jsrt_to_number(seconds);
  const double milli = ms == JSRT_UNDEFINED ? 0 : jsrt_to_number(ms);
  /* §21.4.3.4 step 8: a two-digit year means 19xx, and ONLY here and in the local constructor --
   * `new Date(95, 0)` is 1995, `new Date(Date.UTC(95, 0))` is too, but `setUTCFullYear(95)` is 95. */
  const double yr = !isnan(y) && trunc(y) >= 0 && trunc(y) <= 99 ? 1900 + trunc(y) : y;
  return jsrt_number(time_clip(make_date(make_day(yr, mo, d), make_time(h, mi, s, milli))));
}

/* ============================================================================
 * The UTC field setters (§21.4.4.2x)
 * ============================================================================ */

/* Every setter rebuilds the time value from the fields it is NOT changing, which is what makes
 * `setUTCMonth(13)` roll into the next year rather than clamping. A setter on an Invalid Date
 * stays invalid except `setTime`, the only one that does not read the old value. */
static jsrt_value set_fields(jsrt_value v, DateField first, const double *values, size_t count,
                             uint32_t supplied, bool local) {
  JSRTDate *d = as_date(v);
  const double t = reading(v, local);
  double part[8];
  for (size_t i = 0; i < 8; i++) {
    part[i] = field_of(t, (DateField)i);
  }
  for (size_t i = 0; i < count; i++) {
    part[(size_t)first + i] = values[i];
  }
  /* Setting the year on an Invalid Date is the one case that RECOVERS: §21.4.4.21 substitutes +0
   * for the time value rather than propagating the NaN, so `new Date(NaN).setUTCFullYear(2024)` is
   * a date. Substituting the FIELDS of +0 is the same thing said componentwise. */
  if (isnan(t)) {
    if (first != F_FULL_YEAR) {
      return jsrt_number(NAN);
    }
    for (size_t i = 0; i < 8; i++) {
      /* Only the fields the CALLER did not supply come from +0 -- and "did not supply" has to be
       * passed in, because by the time this runs an omitted argument and an explicit `undefined`
       * have both become NaN through `or_current` (the spec reads an absent component and an
       * undefined one the same way, so the two really are the same thing). What is NOT the same is
       * an explicit NaN argument: ToNumber(NaN) is NaN and the result must be NaN. Without the
       * mask, `new Date(NaN).setUTCFullYear(NaN)` recovered into year 0 and answered
       * -62167219200000 where Node answers NaN, and `setUTCFullYear(2024)` on an Invalid Date
       * could not recover at all, because every padded component looked supplied (plan-notes 222). */
      const bool given = (supplied & (1u << i)) != 0;
      if (!given && isnan(part[i])) {
        part[i] = i == F_DATE ? 1 : 0;
      }
    }
  }
  const double day = make_day(part[F_FULL_YEAR], part[F_MONTH], part[F_DATE]);
  const double time =
      make_time(part[F_HOURS], part[F_MINUTES], part[F_SECONDS], part[F_MILLISECONDS]);
  const double built = make_date(day, time);
  /* The one asymmetry between the families: a local setter has just built a WALL-CLOCK reading,
   * which has to be turned back into an instant before it can be stored. */
  d->time = time_clip(local ? utc_from_local(built) : built);
  return jsrt_number(d->time);
}

/* The setters take their optional trailing components as `undefined`, which reads as "keep the
 * current value" -- the spec's own wording, since each step is conditional on the argument being
 * present. `jsrt_to_number(undefined)` is NaN, so absence is checked rather than converted. */
static double or_current(jsrt_value given, double current) {
  return given == JSRT_UNDEFINED ? current : jsrt_to_number(given);
}

/* Fourteen setters over four shapes, generated rather than written out: the UTC family and the
 * local family differ in exactly the bit `set_fields` takes, and the four shapes differ only in
 * how many trailing components they keep. Written twice by hand this is ~120 lines in which the
 * two halves could silently drift; the macro makes drift unspellable.
 *
 * Every setter's fields are CONTIGUOUS in `DateField` order, which is what lets `first` plus a
 * count name them. `F_DAY` (the weekday) sits inside that order and is never a setter target --
 * no shape reaches it, because a weekday is derived and not stored. */
/* The first component of every shape is REQUIRED, so its bit is always set; each later one is
 * supplied exactly when it is not `undefined`. The mask is what lets `set_fields` tell an omitted
 * component from an explicit NaN. */
#define DATE_SUPPLIED_1(f0) (1u << (f0))
#define DATE_SUPPLIED_2(f0, f1, b) (DATE_SUPPLIED_1(f0) | ((b) != JSRT_UNDEFINED ? 1u << (f1) : 0u))
#define DATE_SUPPLIED_3(f0, f1, f2, b, c)   (DATE_SUPPLIED_2(f0, f1, b) | ((c) != JSRT_UNDEFINED ? 1u << (f2) : 0u))
#define DATE_SUPPLIED_4(f0, f1, f2, f3, b, c, d)   (DATE_SUPPLIED_3(f0, f1, f2, b, c) | ((d) != JSRT_UNDEFINED ? 1u << (f3) : 0u))

#define DATE_SETTER_1(name, f0, local)                                                             \
  jsrt_value jsrt_date_set_##name(jsrt_value v, jsrt_value a) {                                    \
    const double values[1] = {jsrt_to_number(a)};                                                  \
    return set_fields(v, f0, values, 1, DATE_SUPPLIED_1(f0), local);                               \
  }

#define DATE_SETTER_2(name, f0, f1, local)                                                         \
  jsrt_value jsrt_date_set_##name(jsrt_value v, jsrt_value a, jsrt_value b) {                      \
    const double t = reading(v, local);                                                            \
    const double values[2] = {jsrt_to_number(a), or_current(b, field_of(t, f1))};                   \
    return set_fields(v, f0, values, 2, DATE_SUPPLIED_2(f0, f1, b), local);                        \
  }

#define DATE_SETTER_3(name, f0, f1, f2, local)                                                     \
  jsrt_value jsrt_date_set_##name(jsrt_value v, jsrt_value a, jsrt_value b, jsrt_value c) {        \
    const double t = reading(v, local);                                                            \
    const double values[3] = {jsrt_to_number(a), or_current(b, field_of(t, f1)),                    \
                              or_current(c, field_of(t, f2))};                                      \
    return set_fields(v, f0, values, 3, DATE_SUPPLIED_3(f0, f1, f2, b, c), local);                 \
  }

#define DATE_SETTER_4(name, f0, f1, f2, f3, local)                                                 \
  jsrt_value jsrt_date_set_##name(jsrt_value v, jsrt_value a, jsrt_value b, jsrt_value c,          \
                                  jsrt_value d) {                                                  \
    const double t = reading(v, local);                                                            \
    const double values[4] = {jsrt_to_number(a), or_current(b, field_of(t, f1)),                    \
                              or_current(c, field_of(t, f2)), or_current(d, field_of(t, f3))};      \
    return set_fields(v, f0, values, 4, DATE_SUPPLIED_4(f0, f1, f2, f3, b, c, d), local);          \
  }

DATE_SETTER_1(utc_milliseconds, F_MILLISECONDS, false)
DATE_SETTER_2(utc_seconds, F_SECONDS, F_MILLISECONDS, false)
DATE_SETTER_3(utc_minutes, F_MINUTES, F_SECONDS, F_MILLISECONDS, false)
DATE_SETTER_4(utc_hours, F_HOURS, F_MINUTES, F_SECONDS, F_MILLISECONDS, false)
DATE_SETTER_1(utc_date, F_DATE, false)
DATE_SETTER_2(utc_month, F_MONTH, F_DATE, false)
DATE_SETTER_3(utc_full_year, F_FULL_YEAR, F_MONTH, F_DATE, false)

DATE_SETTER_1(milliseconds, F_MILLISECONDS, true)
DATE_SETTER_2(seconds, F_SECONDS, F_MILLISECONDS, true)
DATE_SETTER_3(minutes, F_MINUTES, F_SECONDS, F_MILLISECONDS, true)
DATE_SETTER_4(hours, F_HOURS, F_MINUTES, F_SECONDS, F_MILLISECONDS, true)
DATE_SETTER_1(date, F_DATE, true)
DATE_SETTER_2(month, F_MONTH, F_DATE, true)
DATE_SETTER_3(full_year, F_FULL_YEAR, F_MONTH, F_DATE, true)

/* The COMPONENT constructor, §21.4.2.1 steps 4-11: local-time semantics, which is what separates it
 * from `Date.UTC` -- the same arithmetic, then `UTC()` rather than nothing. Month is required in
 * this form (the one-argument form is a time value and never reaches here), and the two-digit-year
 * rule applies exactly as it does to `Date.UTC`. */
jsrt_value jsrt_date_from_components(jsrt_value year, jsrt_value month, jsrt_value day,
                                     jsrt_value hours, jsrt_value minutes, jsrt_value seconds,
                                     jsrt_value ms) {
  const double y = jsrt_to_number(year);
  const double mo = jsrt_to_number(month);
  const double d = day == JSRT_UNDEFINED ? 1 : jsrt_to_number(day);
  const double h = hours == JSRT_UNDEFINED ? 0 : jsrt_to_number(hours);
  const double mi = minutes == JSRT_UNDEFINED ? 0 : jsrt_to_number(minutes);
  const double sec = seconds == JSRT_UNDEFINED ? 0 : jsrt_to_number(seconds);
  const double milli = ms == JSRT_UNDEFINED ? 0 : jsrt_to_number(ms);
  const double yr = !isnan(y) && trunc(y) >= 0 && trunc(y) <= 99 ? 1900 + trunc(y) : y;
  const double wall = make_date(make_day(yr, mo, d), make_time(h, mi, sec, milli));
  return jsrt_date_new(utc_from_local(wall));
}

/* ============================================================================
 * The string forms that do not need a locale
 * ============================================================================ */

/* §21.4.1.33's expanded year: four digits inside [0, 9999], and a SIGNED six-digit form outside it
 * -- `+275760-09-13T00:00:00.000Z` and `-000001-01-01T00:00:00.000Z`, both of which Node prints. */
static void write_iso(char *out, size_t n, double t) {
  const double day = floor_div(t, MS_PER_DAY);
  const Civil c = civil_from_days(day);
  char year[10];
  if (c.year >= 0 && c.year <= 9999) {
    snprintf(year, sizeof year, "%04d", (int)c.year);
  } else {
    snprintf(year, sizeof year, "%c%06d", c.year < 0 ? '-' : '+', (int)fabs(c.year));
  }
  snprintf(out, n, "%s-%02d-%02dT%02d:%02d:%02d.%03dZ", year, (int)c.month, (int)c.day,
           (int)floor_mod(floor_div(t, MS_PER_HOUR), 24),
           (int)floor_mod(floor_div(t, MS_PER_MINUTE), 60),
           (int)floor_mod(floor_div(t, MS_PER_SECOND), 60), (int)floor_mod(t, MS_PER_SECOND));
}

jsrt_value jsrt_date_to_iso_string(jsrt_value v) {
  const double t = as_date(v)->time;
  /* §21.4.4.36 throws a RangeError. Generated C checks jsrt_pending() after this op.
   *
   * A RangeError OBJECT, not a bare string: `jsrt_throw_str` pends the message alone, so
   * `e instanceof RangeError` was false and `e.name` was undefined for the one throw in the
   * runtime a program was most likely to catch (plan-notes 222). Node's message is exactly
   * "Invalid time value". */
  if (isnan(t)) {
    jsrt_throw_error(&jsrt_class_range_error, "Invalid time value");
    return JSRT_UNDEFINED;
  }
  char text[40];
  write_iso(text, sizeof text, t);
  return jsrt_string_from_utf8(text, strlen(text));
}

/* toJSON (§21.4.4.37) is NOT toISOString: it answers `null` for a non-finite time value rather than
 * throwing, which is what makes `JSON.stringify(new Date(NaN))` the string "null". */
jsrt_value jsrt_date_to_json(jsrt_value v) {
  const double t = as_date(v)->time;
  if (isnan(t)) {
    return JSRT_NULL;
  }
  char text[40];
  write_iso(text, sizeof text, t);
  return jsrt_string_from_utf8(text, strlen(text));
}

/* toUTCString (§21.4.4.43): `Thu, 29 Feb 2024 13:45:06 GMT`. The day and month names are the
 * spec's own ASCII abbreviations, not locale data -- which is exactly why this one is in slice A
 * while `toString` and `toLocaleDateString` are the intl feature build's. */
/* The English abbreviations §21.4.4.35 and §21.4.4.43 spell out. They are not locale data: the
 * spec fixes these exact strings, which is why they can live here rather than behind ICU. */
static const char *const DAYS[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *const MONTHS[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

/* Four digits, behind a sign below zero -- `Fri Jan 01 -0001`, `Fri, 01 Jan -0001 00:00:00 GMT`.
 * Both human string forms use this width. `toISOString` does NOT: its expanded-year form pads to
 * six (`-000001-01-01T00:00:00.000Z`), which is why it formats its own year rather than calling
 * here. Slice A's comment claimed six for `toUTCString` and no fixture had a negative year to
 * contradict it; tests/golden/ts/date_local.ts now does (plan-notes 133). */
static void write_year(char *out, size_t size, double year) {
  if (year >= 0) {
    snprintf(out, size, "%04d", (int)year);
  } else {
    snprintf(out, size, "-%04d", (int)fabs(year));
  }
}

/* `toDateString` (§21.4.4.35): the LOCAL calendar date with no time and no zone in it. That last
 * part is what makes it landable while `toString` and `toTimeString` are not -- those two append
 * the zone's long display name (`(Central European Summer Time)`), which Node reads from ICU and
 * libc cannot produce; `%Z` gives the abbreviation `CEST` instead. */
jsrt_value jsrt_date_to_date_string(jsrt_value v) {
  const double t = local_time(as_date(v)->time);
  if (isnan(t)) {
    return jsrt_string_from_utf8("Invalid Date", 12);
  }
  const Civil c = civil_from_days(floor_div(t, MS_PER_DAY));
  char year[10];
  write_year(year, sizeof year, c.year);
  char text[48];
  snprintf(text, sizeof text, "%s %s %02d %s", DAYS[(size_t)field_of(t, F_DAY)],
           MONTHS[(size_t)c.month - 1], (int)c.day, year);
  return jsrt_string_from_utf8(text, strlen(text));
}

/* The short zone name libc reports for the instant `t` (`UTC`, `EST`, ...), for the one string
 * form that prints it. Empty when libc cannot place the instant -- the same range where
 * `offset_at` answers 0, so the two fallbacks agree with each other. */
static void zone_abbrev(double t, char *out, size_t n) {
  out[0] = '\0';
  if (!isfinite(t)) {
    return;
  }
  const double secs = floor_div(t, MS_PER_SECOND);
  if (secs < -9.2e18 || secs > 9.2e18) {
    return;
  }
  const time_t as_time = (time_t)secs;
  struct tm parts;
  if (localtime_r(&as_time, &parts) == NULL || parts.tm_zone == NULL) {
    return;
  }
  snprintf(out, n, "%s", parts.tm_zone);
}

/* The IMPLICIT Date string (§21.4.4.41 `Date.prototype.toString` form) for `"" + date` and
 * `` `${date}` `` (plan.md §8 step 29): `Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated
 * Universal Time)` under TZ=UTC, `Invalid Date` for a non-finite time value.
 *
 * KNOWN CEILING, recorded not hidden: the parenthesized long display name comes from ICU,
 * which the default build does not have -- the explicit `.toString()`/`toTimeString()` methods
 * stay STA1210 for exactly this reason. What libc reports is the ABBREVIATION (`UTC`, `EST`),
 * so this special-cases exactly `UTC` (the golden pin's whole world) to Node's
 * `Coordinated Universal Time` and prints the abbreviation elsewhere -- a documented divergence
 * outside UTC, and strictly closer than the `[object Object]` it replaces. */
jsrt_value jsrt_date_to_string(jsrt_value v) {
  const double t = as_date(v)->time;
  if (isnan(t)) {
    return jsrt_string_from_utf8("Invalid Date", 12);
  }
  const double local = local_time(t);
  const double day = floor_div(local, MS_PER_DAY);
  const Civil c = civil_from_days(day);
  char year[10];
  write_year(year, sizeof year, c.year);
  const double off = offset_at(t);
  const char sign = off < 0 ? '-' : '+';
  const long mins = (long)(fabs(off) / MS_PER_MINUTE);
  char zone[32];
  zone_abbrev(t, zone, sizeof zone);
  const char *name = zone[0] == '\0' ? "UTC" : zone;
  if (strcmp(name, "UTC") == 0) {
    name = "Coordinated Universal Time";
  }
  char text[128];
  snprintf(text, sizeof text, "%s %s %02d %s %02d:%02d:%02d GMT%c%02ld%02ld (%s)",
           DAYS[(size_t)floor_mod(day + 4, 7)], MONTHS[(size_t)c.month - 1], (int)c.day, year,
           (int)floor_mod(floor_div(local, MS_PER_HOUR), 24),
           (int)floor_mod(floor_div(local, MS_PER_MINUTE), 60),
           (int)floor_mod(floor_div(local, MS_PER_SECOND), 60), sign, mins / 60, mins % 60, name);
  return jsrt_string_from_utf8(text, strlen(text));
}

jsrt_value jsrt_date_to_utc_string(jsrt_value v) {
  const double t = as_date(v)->time;
  if (isnan(t)) {
    return jsrt_string_from_utf8("Invalid Date", 12);
  }
  const double day = floor_div(t, MS_PER_DAY);
  const Civil c = civil_from_days(day);
  char text[64];
  char year[10];
  write_year(year, sizeof year, c.year);
  snprintf(text, sizeof text, "%s, %02d %s %s %02d:%02d:%02d GMT",
           DAYS[(size_t)floor_mod(day + 4, 7)], (int)c.day, MONTHS[(size_t)c.month - 1], year,
           (int)floor_mod(floor_div(t, MS_PER_HOUR), 24),
           (int)floor_mod(floor_div(t, MS_PER_MINUTE), 60),
           (int)floor_mod(floor_div(t, MS_PER_SECOND), 60));
  return jsrt_string_from_utf8(text, strlen(text));
}

/* ============================================================================
 * Date.parse, ISO 8601 only
 * ============================================================================ */

/* §21.4.3.2 lets an implementation accept other formats; this accepts exactly the Date Time String
 * Format of §21.4.1.32 and answers NaN for everything else. Guessing at Node's fallback parser
 * (which is V8's, and is not specified anywhere) would produce dates that differ from Node for
 * inputs no test could enumerate -- so an unparseable string is honestly Invalid.
 *
 * A DATE-ONLY form is UTC; a date-time form without an offset is LOCAL by the spec, but slice A is
 * the TZ-independent core, so a missing offset is refused here rather than read against a timezone
 * this slice does not have. Slice B lifts that. */
static bool digits(const char *s, size_t n, double *out) {
  double value = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] < '0' || s[i] > '9') {
      return false;
    }
    value = value * 10 + (s[i] - '0');
  }
  *out = value;
  return true;
}

static double parse_iso(const char *s, size_t len) {
  size_t i = 0;
  double sign = 1;
  double year = 0;
  if (len >= 7 && (s[0] == '+' || s[0] == '-')) {
    sign = s[0] == '-' ? -1 : 1;
    if (!digits(s + 1, 6, &year)) {
      return NAN;
    }
    i = 7;
  } else if (len >= 4 && digits(s, 4, &year)) {
    i = 4;
  } else {
    return NAN;
  }
  year *= sign;
  double month = 1;
  double day = 1;
  if (i + 3 <= len && s[i] == '-') {
    if (!digits(s + i + 1, 2, &month)) {
      return NAN;
    }
    i += 3;
    if (i + 3 <= len && s[i] == '-') {
      if (!digits(s + i + 1, 2, &day)) {
        return NAN;
      }
      i += 3;
    }
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return NAN;
  }
  double hour = 0;
  double minute = 0;
  double second = 0;
  double milli = 0;
  /* Any nonzero digit anywhere in the fractional-seconds run, at full precision rather than
   * truncated to milliseconds: `24:00:00.0001` is NaN in Node although its first three digits
   * are zero (plan.md §8 step 32). */
  bool frac_nonzero = false;
  bool has_time = false;
  if (i < len && (s[i] == 'T' || s[i] == 't')) {
    has_time = true;
    i++;
    if (i + 5 > len || !digits(s + i, 2, &hour) || s[i + 2] != ':' ||
        !digits(s + i + 3, 2, &minute)) {
      return NAN;
    }
    i += 5;
    if (i + 3 <= len && s[i] == ':') {
      if (!digits(s + i + 1, 2, &second)) {
        return NAN;
      }
      i += 3;
      /* Fractional seconds: §21.4.1.32 spells exactly three digits, but V8 accepts one or more
       * (plan.md §8 step 32). At least one digit is required; the first three set the
       * milliseconds (one digit is tenths, so ×100; two digits ×10) and further digits are
       * consumed and truncated, so `…00.5Z` and `…00.123456Z` are timestamps while `…00.Z` is
       * NaN. */
      if (i + 2 <= len && s[i] == '.') {
        size_t j = i + 1;
        size_t ndig = 0;
        double frac = 0;
        while (j < len && s[j] >= '0' && s[j] <= '9') {
          if (s[j] != '0') {
            frac_nonzero = true;
          }
          if (ndig < 3) {
            frac = frac * 10 + (double)(s[j] - '0');
            ndig++;
          }
          j++;
        }
        if (ndig == 0) {
          return NAN;
        }
        if (ndig == 1) {
          frac *= 100;
        } else if (ndig == 2) {
          frac *= 10;
        }
        milli = frac;
        i = j;
      }
    }
  }
  double offset = 0;
  if (i < len && (s[i] == 'Z' || s[i] == 'z')) {
    i++;
  } else if (i < len && (s[i] == '+' || s[i] == '-')) {
    const double osign = s[i] == '-' ? -1 : 1;
    double oh = 0;
    double om = 0;
    /* `+HH:MM` and the colon-less `+HHMM` V8 accepts alongside it (plan.md §8 step 32); a bare
     * `+HH` is NaN in both spellings. Hours past 23 and minutes past 59 are NaN — the parser
     * used to answer an offset no clock keeps. */
    if (i + 6 <= len && digits(s + i + 1, 2, &oh) && s[i + 3] == ':' &&
        digits(s + i + 4, 2, &om)) {
      i += 6;
    } else if (i + 5 <= len && digits(s + i + 1, 2, &oh) && digits(s + i + 3, 2, &om)) {
      i += 5;
    } else {
      return NAN;
    }
    if (oh > 23 || om > 59) {
      return NAN;
    }
    offset = osign * (oh * MS_PER_HOUR + om * MS_PER_MINUTE);
  } else if (has_time) {
    /* A date-time with no offset is LOCAL time by §21.4.3.2, which slice A cannot resolve. */
    return NAN;
  }
  /* Hour 24 is midnight at the END of the day (§21.4.1.32): valid only with zero
   * minutes, seconds and fractional seconds, rolling into the next day through make_time's own
   * arithmetic. The fraction is judged at full precision — `24:00:00.0001` is NaN in Node
   * although its truncated milliseconds are zero (plan.md §8 step 32). Anything past it
   * (`24:00:01`, `24:00:00.001`) is NaN, which is what makes
   * `Date.parse("2024-01-01T24:00:01Z")` NaN while `24:00:00` answers midnight (plan.md §8
   * step 21d). */
  if (
    i != len || hour > 24 || minute > 59 || second > 59 ||
    (hour == 24 && (minute != 0 || second != 0 || frac_nonzero))
  ) {
    return NAN;
  }
  const double t = make_date(make_day(year, month - 1, day), make_time(hour, minute, second, milli));
  return time_clip(t - offset);
}

/* The ISO grammar is entirely ASCII, so a string is copied down to bytes and anything wider than
 * one is unparseable by construction -- which saves the parser from thinking about UTF-16 at all.
 * `ASCII_MAX` is well past the longest legal form (`+275760-09-13T00:00:00.000+00:00` is 32). */
#define ASCII_MAX 64

static bool to_ascii(jsrt_value text, char *out, size_t *len) {
  const uint32_t n = jsrt_string_length(text);
  if (n >= ASCII_MAX) {
    return false;
  }
  for (uint32_t i = 0; i < n; i++) {
    const uint16_t unit = jsrt_string_char(text, i);
    if (unit > 127) {
      return false;
    }
    out[i] = (char)unit;
  }
  *len = n;
  return true;
}

jsrt_value jsrt_date_parse(jsrt_value text) {
  char ascii[ASCII_MAX];
  size_t len = 0;
  if (!jsrt_is(text, JSRT_TAG_STRING) || !to_ascii(text, ascii, &len)) {
    return jsrt_number(NAN);
  }
  return jsrt_number(parse_iso(ascii, len));
}

/* `new Date(x)` where x is not a number: the spec converts a string through Date.parse and
 * anything else through ToNumber. A Date argument copies its time value. */
jsrt_value jsrt_date_from_value(jsrt_value v) {
  if (jsrt_is_date(v)) {
    return jsrt_date_new(as_date(v)->time);
  }
  if (jsrt_is(v, JSRT_TAG_STRING)) {
    char ascii[ASCII_MAX];
    size_t len = 0;
    return jsrt_date_new(to_ascii(v, ascii, &len) ? parse_iso(ascii, len) : NAN);
  }
  return jsrt_date_new(jsrt_to_number(v));
}
