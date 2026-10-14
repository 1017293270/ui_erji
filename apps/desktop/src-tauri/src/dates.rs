//! The little calendar arithmetic the app needs, without a date crate.

/// Times without an offset are read as Beijing time: the people using this are in mainland China.
const BEIJING_OFFSET_SECS: i64 = 8 * 3600;

/// Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's days_from_civil).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month as i64 + 9) % 12) + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn number(s: &str) -> Option<u32> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// `YYYY-MM-DD`, checked: 2026-02-30 is not a date.
pub fn parse_date(s: &str) -> Option<(i64, u32, u32)> {
    let (year, rest) = s.split_once('-')?;
    let (month, day) = rest.split_once('-')?;
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let (year, month, day) = (number(year)? as i64, number(month)?, number(day)?);
    ((1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day)).then_some((year, month, day))
}

/// Seconds since the epoch for an ISO 8601 date-time such as `2026-10-13T01:30:00.000Z`,
/// `2026-10-13T09:30:00+08:00` or `2026-10-13 09:30`. No offset means Beijing time.
pub fn parse_iso_secs(s: &str) -> Option<i64> {
    let s = s.trim();
    let (year, month, day) = parse_date(s.get(..10)?)?;
    let mut rest = &s[10..];
    let mut secs = days_from_civil(year, month, day) * 86_400;
    if let Some(time) = rest.strip_prefix(['T', 't', ' ']) {
        let end = time.find(|c: char| !(c.is_ascii_digit() || c == ':' || c == '.' || c == ',')).unwrap_or(time.len());
        let (clock, zone) = time.split_at(end);
        let clock = clock.split(['.', ',']).next()?;
        let mut parts = clock.split(':');
        let hour = number(parts.next()?)?;
        let minute = number(parts.next()?)?;
        let second = parts.next().map(number).unwrap_or(Some(0))?;
        if parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
            return None;
        }
        secs += (hour * 3600 + minute * 60 + second) as i64;
        rest = zone;
    }
    let offset = match rest {
        "" => BEIJING_OFFSET_SECS,
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits = rest[1..].replace(':', "");
            if digits.len() != 2 && digits.len() != 4 {
                return None;
            }
            let hours = number(digits.get(..2)?)? as i64;
            let minutes = number(digits.get(2..).filter(|m| !m.is_empty()).unwrap_or("00"))? as i64;
            sign * (hours * 3600 + minutes * 60)
        }
    };
    Some(secs - offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2023, 5, 1) * 86_400_000, 1_682_899_200_000);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
    }

    #[test]
    fn dates_are_checked() {
        assert_eq!(parse_date("2026-10-13"), Some((2026, 10, 13)));
        assert_eq!(parse_date("2028-02-29"), Some((2028, 2, 29)));
        assert_eq!(parse_date("2026-02-29"), None);
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date("2026-1-01"), None);
        assert_eq!(parse_date("2026-10-13T00"), None);
        assert_eq!(parse_date("+026-10-13"), None);
    }

    #[test]
    fn iso_date_times() {
        // 2026-10-13 09:30 in Beijing is 01:30 UTC.
        let expected = days_from_civil(2026, 10, 13) * 86_400 + 3600 + 1800;
        for s in [
            "2026-10-13T01:30:00Z",
            "2026-10-13T01:30:00.123Z",
            "2026-10-13T09:30:00+08:00",
            "2026-10-13T09:30:00+0800",
            "2026-10-13T09:30+08",
            "2026-10-13 09:30",
            "2026-10-12T20:30:00-05:00",
        ] {
            assert_eq!(parse_iso_secs(s), Some(expected), "{s}");
        }
        assert_eq!(parse_iso_secs("2026-10-13"), Some(days_from_civil(2026, 10, 13) * 86_400 - 8 * 3600));
        for bad in ["", "2026-10-13T25:00:00Z", "2026-10-13T09:30:00+8", "2026-10-13T09:30:00 UTC", "yesterday"] {
            assert_eq!(parse_iso_secs(bad), None, "{bad}");
        }
    }
}
