#[derive(Default)]
pub struct LevelMeter {
    sum_squares: f64,
    count: usize,
}

impl LevelMeter {
    pub const FLOOR_DB: f64 = -90.0;

    pub fn add(&mut self, samples: &[f32]) {
        let sum: f32 = samples.iter().map(|&s| s * s).sum();
        self.sum_squares += f64::from(sum);
        self.count += samples.len();
    }

    pub fn take(&mut self) -> f64 {
        let mean = if self.count > 0 { self.sum_squares / self.count as f64 } else { 0.0 };
        self.sum_squares = 0.0;
        self.count = 0;
        if mean > 0.0 { (10.0 * mean.log10()).clamp(Self::FLOOR_DB, 0.0) } else { Self::FLOOR_DB }
    }
}
