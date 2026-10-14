use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, Resampler as RubatoResampler, SincInterpolationParameters,
    SincInterpolationType, WindowFunction};

pub struct Resampler {
    pub input_rate: u32,
    output_rate: u32,
    converter: Option<Async<f32>>,
    pending: Vec<f32>,
    delay_left: usize,
    received: u64,
    emitted: i64,
}

impl Resampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Result<Self, String> {
        if input_rate == 0 { return Err("采集采样率不能为 0。".into()); }
        let converter = if input_rate == output_rate { None } else {
            let params = SincInterpolationParameters::new(128, WindowFunction::Blackman2)
                .oversampling_factor(256).interpolation(SincInterpolationType::Cubic);
            Some(Async::new_sinc(f64::from(output_rate) / f64::from(input_rate), 1.0,
                &params, 256, 1, FixedAsync::Input)
                .map_err(|e| format!("无法创建 {input_rate} Hz → {output_rate} Hz 的重采样器：{e}"))?)
        };
        let delay_left = converter.as_ref().map_or(0, RubatoResampler::output_delay);
        Ok(Self { input_rate, output_rate, converter, pending: Vec::new(), delay_left, received: 0, emitted: 0 })
    }

    pub fn emitted_frames(&self) -> i64 { self.emitted }

    // Input duration, rather than produced frames, includes audio still held by the filter.
    pub fn expected_frames(&self) -> i64 {
        (self.received as f64 * f64::from(self.output_rate) / f64::from(self.input_rate)).round() as i64
    }

    pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>, String> {
        self.received += input.len() as u64;
        if self.converter.is_none() {
            self.emitted += input.len() as i64;
            return Ok(input.to_vec());
        }
        self.pending.extend_from_slice(input);
        let mut output = Vec::new();
        while self.pending.len() >= self.converter.as_ref().unwrap().input_frames_next() {
            output.extend(self.convert(None)?);
        }
        self.emitted += output.len() as i64;
        Ok(output)
    }

    // Flush only on discontinuity or stop; zero padding must not leak onto the timeline.
    pub fn finish(&mut self) -> Result<Vec<f32>, String> {
        let remaining = (self.expected_frames() - self.emitted).max(0) as usize;
        if remaining == 0 { return Ok(Vec::new()); }
        let mut output = Vec::new();
        if !self.pending.is_empty() { output.extend(self.convert(Some(self.pending.len()))?); }
        while output.len() < remaining { output.extend(self.convert(Some(0))?); }
        output.truncate(remaining);
        self.emitted += output.len() as i64;
        Ok(output)
    }

    fn convert(&mut self, partial: Option<usize>) -> Result<Vec<f32>, String> {
        let converter = self.converter.as_mut().unwrap();
        let consumed = partial.unwrap_or_else(|| converter.input_frames_next());
        let input = InterleavedSlice::new(&self.pending[..consumed], 1, consumed).unwrap();
        let indexing = partial.map(|n| Indexing::new().partial_len(n));
        let output = converter.process(&input, indexing.as_ref())
            .map_err(|e| format!("重采样失败：{e}"))?.take_data();
        self.pending.drain(..consumed);
        let skip = self.delay_left.min(output.len());
        self.delay_left -= skip;
        Ok(output[skip..].to_vec())
    }
}
