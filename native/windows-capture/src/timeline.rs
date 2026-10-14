#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason { Nominal, Pause, Stop }

#[derive(Clone, Debug)]
pub struct Segment {
    pub index: usize,
    pub start: i64,
    pub end: i64,
    pub end_reason: EndReason,
    pub finalized: bool,
}

impl Segment {
    fn new(index: usize, start: i64, end: i64) -> Self {
        Self { index, start, end, end_reason: EndReason::Nominal, finalized: false }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Location { Segment(usize), Gap(Option<i64>) }

pub struct Timeline {
    segment_frames: i64,
    pub segments: Vec<Segment>,
    pub paused_from: Option<i64>,
    stopped: bool,
}

impl Timeline {
    pub fn new(segment_frames: i64) -> Self {
        Self { segment_frames, segments: vec![Segment::new(1, 0, segment_frames)], paused_from: None, stopped: false }
    }

    pub fn locate(&mut self, p: i64) -> Location {
        let Some(i) = self.segments.iter().rposition(|s| s.start <= p) else {
            return Location::Gap(self.segments.first().map(|s| s.start));
        };
        if p < self.segments[i].end { return Location::Segment(i); }
        if i == self.segments.len() - 1 {
            if self.segments[i].end_reason != EndReason::Nominal { return Location::Gap(None); }
            self.roll(p);
            return Location::Segment(self.segments.len() - 1);
        }
        Location::Gap(Some(self.segments[i + 1].start))
    }

    pub fn first_open_index(&self) -> Option<usize> {
        self.segments.iter().position(|s| !s.finalized)
    }

    pub fn pause(&mut self, p: i64) -> bool {
        if self.paused_from.is_some() || self.stopped { return false; }
        self.cut(p, EndReason::Pause);
        self.paused_from = Some(p);
        true
    }

    pub fn resume(&mut self, r: i64) -> Option<i64> {
        if self.stopped { return None; }
        let from = self.paused_from?;
        let index = self.segments.last().map_or(1, |s| s.index + 1);
        let start = r.max(from);
        self.segments.push(Segment::new(index, start, start + self.segment_frames));
        self.paused_from = None;
        Some(from)
    }

    pub fn stop(&mut self, s: i64) {
        if self.stopped { return; }
        if self.paused_from.is_none() { self.cut(s, EndReason::Stop); }
        self.stopped = true;
    }

    fn roll(&mut self, p: i64) {
        while let Some(last) = self.segments.last() {
            if last.end_reason != EndReason::Nominal || last.end > p { break; }
            self.segments.push(Segment::new(last.index + 1, last.end, last.end + self.segment_frames));
        }
    }

    fn cut(&mut self, p: i64, reason: EndReason) {
        self.roll(p);
        let Some(i) = self.segments.iter().rposition(|s| s.start <= p && p < s.end) else { return; };
        if self.segments[i].start == p {
            self.segments.remove(i);
            if i > 0 { self.segments[i - 1].end_reason = reason; }
        } else {
            self.segments[i].end = p;
            self.segments[i].end_reason = reason;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_and_stop_cut_the_shared_schedule() {
        let mut t = Timeline::new(2000);
        assert_eq!(t.locate(-1), Location::Gap(Some(0)));
        assert_eq!(t.locate(2000), Location::Segment(1));
        assert!(t.pause(2500));
        assert!(!t.pause(2600));
        assert_eq!(t.locate(3000), Location::Gap(None));
        assert_eq!(t.resume(3500), Some(2500));
        assert_eq!(t.locate(3000), Location::Gap(Some(3500)));
        t.stop(5000);
        assert_eq!(t.segments.iter().map(|s| (s.index, s.start, s.end)).collect::<Vec<_>>(),
            vec![(1, 0, 2000), (2, 2000, 2500), (3, 3500, 5000)]);
        assert_eq!(t.locate(5000), Location::Gap(None));
        assert_eq!(t.resume(6000), None);
    }

    #[test]
    fn cuts_on_boundaries_do_not_create_empty_files() {
        let mut t = Timeline::new(1000);
        assert!(t.pause(0));
        assert!(t.segments.is_empty());
        assert_eq!(t.resume(500), Some(0));
        assert!(t.pause(1500));
        assert_eq!(t.segments.len(), 1);
        assert_eq!(t.segments[0].end_reason, EndReason::Pause);
        t.stop(2000);
        assert_eq!(t.segments[0].end, 1500);
    }
}
