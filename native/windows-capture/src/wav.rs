use std::fs::{self, File};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;

pub struct WavWriter {
    file: Option<File>,
    sample_rate: u32,
    frames: u64,
    pending: Vec<u8>,
}

impl WavWriter {
    pub fn new(path: &Path, sample_rate: u32) -> io::Result<Self> {
        let mut file = File::create(path)?;
        file.write_all(&header(sample_rate, 0))?;
        Ok(Self { file: Some(file), sample_rate, frames: 0, pending: Vec::with_capacity(sample_rate as usize * 2) })
    }

    pub fn append(&mut self, samples: &[f32]) -> io::Result<()> {
        for &sample in samples {
            let pcm = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            self.pending.extend_from_slice(&pcm.to_le_bytes());
        }
        self.frames += samples.len() as u64;
        self.flush_if_ready()
    }

    pub fn append_silence(&mut self, count: usize) -> io::Result<()> {
        self.pending.resize(self.pending.len() + count * 2, 0);
        self.frames += count as u64;
        self.flush_if_ready()
    }

    pub fn close(&mut self) -> io::Result<()> {
        if self.file.is_some() {
            self.flush()?;
            self.file = None;
        }
        Ok(())
    }

    fn flush_if_ready(&mut self) -> io::Result<()> {
        if self.pending.len() >= self.sample_rate as usize * 2 { self.flush()?; }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        let file = self.file.as_mut().ok_or_else(|| io::Error::other("文件已关闭"))?;
        file.write_all(&self.pending)?;
        self.pending.clear();
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&header(self.sample_rate, (self.frames * 2) as u32))?;
        file.seek(SeekFrom::End(0))?;
        file.flush()
    }
}

pub fn header(sample_rate: u32, data_bytes: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16_u32.to_le_bytes());
    h.extend_from_slice(&1_u16.to_le_bytes());
    h.extend_from_slice(&1_u16.to_le_bytes());
    h.extend_from_slice(&sample_rate.to_le_bytes());
    h.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    h.extend_from_slice(&2_u16.to_le_bytes());
    h.extend_from_slice(&16_u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_bytes.to_le_bytes());
    h
}

pub struct Contents {
    pub format_tag: u16,
    pub channels: u16,
    pub sample_rate: u32,
    pub byte_rate: u32,
    pub block_align: u16,
    pub bits_per_sample: u16,
    pub riff_size_matches: bool,
    pub samples: Vec<i16>,
}

pub fn read(path: &Path) -> io::Result<Contents> {
    let data = fs::read(path)?;
    let invalid = |message| io::Error::new(io::ErrorKind::InvalidData, message);
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(invalid("不是 RIFF/WAVE 文件"));
    }
    let u32_at = |o| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
    let u16_at = |o| u16::from_le_bytes(data[o..o + 2].try_into().unwrap());
    let mut offset = 12;
    let mut fmt = None;
    let mut samples = None;
    while offset + 8 <= data.len() {
        let size = u32_at(offset + 4) as usize;
        let body = offset + 8;
        if body + size > data.len() { return Err(invalid("WAV 块越界")); }
        match &data[offset..offset + 4] {
            b"fmt " => {
                if size < 16 { return Err(invalid("WAV 格式块不完整")); }
                fmt = Some((u16_at(body), u16_at(body + 2), u32_at(body + 4), u32_at(body + 8),
                    u16_at(body + 12), u16_at(body + 14)));
            }
            b"data" => samples = Some(data[body..body + size].as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect()),
            _ => {},
        }
        offset = body + size + (size & 1);
    }
    let (tag, channels, rate, byte_rate, align, bits) = fmt.ok_or_else(|| invalid("WAV 缺少 fmt 块"))?;
    Ok(Contents { format_tag: tag, channels, sample_rate: rate, byte_rate, block_align: align,
        bits_per_sample: bits, riff_size_matches: u32_at(4) as usize + 8 == data.len(),
        samples: samples.ok_or_else(|| invalid("WAV 缺少 data 块"))? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_refreshed_each_second_and_on_close() {
        let dir = crate::selftest::test_dir("wav");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mic.wav");
        let mut writer = WavWriter::new(&path, 8000).unwrap();
        writer.append(&vec![0.5; 8000]).unwrap();
        let live = read(&path).unwrap();
        assert!(live.riff_size_matches);
        assert_eq!(live.samples.len(), 8000);
        assert_eq!((live.format_tag, live.channels, live.sample_rate, live.byte_rate, live.block_align, live.bits_per_sample),
            (1, 1, 8000, 16000, 2, 16));
        writer.append(&[-2.0, 0.0, 0.5, 2.0]).unwrap();
        writer.append_silence(2).unwrap();
        writer.close().unwrap();
        writer.close().unwrap();
        let closed = read(&path).unwrap();
        assert!(closed.riff_size_matches);
        assert_eq!(&closed.samples[8000..], &[-32767, 0, 16384, 32767, 0, 0]);
        assert_eq!(fs::read(path).unwrap()[..44], header(8000, 16012));
        fs::remove_dir_all(dir).unwrap();
    }
}
