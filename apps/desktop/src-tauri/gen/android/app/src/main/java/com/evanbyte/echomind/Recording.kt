package com.evanbyte.echomind

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * One meeting recorded from the phone's microphone into [out], the way the desktop's capture
 * sidecar writes it (native/macos-capture): 16 kHz mono 16-bit WAV, a file per segment of up to
 * 60 s (`mic-0001.wav`…), and manifest.json rewritten on every change, so the transcriber and the
 * player read both alike. The timeline is milliseconds from the start; a pause ends the segment
 * and leaves a gap. Events are the sidecar's too (`started`, `level`, `segment`, `mark`,
 * `paused`, `resumed`, `error`, `stopped`).
 *
 * All the work happens on the recording thread; [command] only queues.
 */
class Recording(private val context: Context, val out: File, private val emit: (JSObject) -> Unit) {
    companion object {
        const val SAMPLE_RATE = 16_000
        const val SEGMENT_SECONDS = 60
        private const val SEGMENT_FRAMES = SEGMENT_SECONDS.toLong() * SAMPLE_RATE
        /** A level event and a look at the command queue every 100 ms. */
        private const val CHUNK = SAMPLE_RATE / 10
        private const val FLOOR_DB = -90.0
    }

    private val startedAt = Date()
    private val t0 = SystemClock.elapsedRealtime()
    private val commands = ConcurrentLinkedQueue<String>()

    /** Frames on the timeline, written or skipped over by a pause. */
    private var cursor = 0L
    private var nextIndex = 1
    private var current: Segment? = null
    private val segments = mutableListOf<Segment>()
    private val marks = java.util.concurrent.CopyOnWriteArrayList<Long>()
    private val paused = mutableListOf<LongArray>() // [fromMs, toMs or -1]
    /** Paused by the person, or by the system taking the microphone for a call. */
    private var pausedByUser = false
    private var pausedBySystem = false
    private var stopped = false
    private var durationMs: Long? = null

    @Volatile var finished = false
        private set

    val isPaused get() = pausedByUser || pausedBySystem
    val startedAtIso: String get() = iso(startedAt)
    fun elapsedMs() = SystemClock.elapsedRealtime() - t0
    /** The marks so far, in ms on the recording's timeline (read from another thread). */
    val markTimes: List<Long> get() = marks.toList()
    /** Whether any audio was saved, once [run] has returned. */
    val hasAudio get() = segments.isNotEmpty()

    fun command(command: String) {
        commands.add(command)
    }

    /** Runs until stopped. Returns after manifest.json says `stopped`. */
    @SuppressLint("MissingPermission")
    fun run() {
        out.mkdirs()
        val record = try {
            val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, SAMPLE_RATE))
        } catch (e: Exception) {
            null
        }
        if (record == null || record.state != AudioRecord.STATE_INITIALIZED) {
            record?.release()
            fail("mic_unavailable", "打不开麦克风，没有开始记录。检查 EchoMind 的麦克风权限，或者关掉正在用麦克风的其他 App 再试。")
            return
        }
        val watcher = SilenceWatcher(record)
        try {
            writeManifest()
            emit(event("started").put("startedAt", startedAtIso).put("sampleRate", SAMPLE_RATE)
                .put("segmentSeconds", SEGMENT_SECONDS).put("out", out.path)
                .put("mic", JSObject().put("device", "手机麦克风")).put("system", JSONObject.NULL))
            record.startRecording()
            val buffer = ShortArray(CHUNK)
            while (!stopped) {
                val n = record.read(buffer, 0, buffer.size)
                if (n < 0) {
                    fail("mic_failed", "麦克风读不出声音了（错误 $n），录音已经结束，之前的部分都保存了。")
                    break
                }
                handleCommands(watcher.silenced)
                if (stopped) break
                val level = if (isPaused || n == 0) FLOOR_DB else write(buffer, n)
                emit(event("level").put("t", elapsedMs()).put("mic", Math.round(level * 10) / 10.0).put("system", JSONObject.NULL))
            }
        } catch (e: Exception) {
            fail("write_failed", "写入录音文件失败：${e.message}。之前的部分都保存了。")
        } finally {
            watcher.close()
            try { record.stop() } catch (_: Exception) {}
            record.release()
            if (!stopped) stop()
            finished = true
        }
    }

    private fun handleCommands(silenced: Boolean) {
        if (silenced && !pausedBySystem) {
            pausedBySystem = true
            if (!pausedByUser) pauseAt()
            emit(event("error").put("code", "interrupted").put("message", "电话占用了麦克风，录音先暂停了；通话结束后会自动继续。"))
        } else if (!silenced && pausedBySystem) {
            pausedBySystem = false
            if (!pausedByUser) resumeAt()
        }
        while (true) {
            when (commands.poll() ?: return) {
                "pause" -> if (!pausedByUser) { pausedByUser = true; if (!pausedBySystem) pauseAt() }
                "resume" -> if (pausedByUser) { pausedByUser = false; if (!pausedBySystem) resumeAt() }
                "mark" -> {
                    val at = ms(cursor)
                    marks.add(at)
                    writeManifest()
                    emit(event("mark").put("atMs", at))
                }
                "stop" -> stop()
            }
        }
    }

    /** Writes the chunk across segments; returns its level in dBFS. */
    private fun write(samples: ShortArray, n: Int): Double {
        var offset = 0
        while (offset < n) {
            val segment = current ?: openSegment()
            val take = min((n - offset).toLong(), segment.start + SEGMENT_FRAMES - cursor).toInt()
            segment.wav.append(samples, offset, take)
            cursor += take
            offset += take
            if (cursor == segment.start + SEGMENT_FRAMES) closeSegment()
        }
        var sum = 0.0
        for (i in 0 until n) sum += samples[i].toDouble() * samples[i]
        val rms = sqrt(sum / n) / 32768.0
        return if (rms > 0) max(FLOOR_DB, 20 * log10(rms)) else FLOOR_DB
    }

    private fun openSegment(): Segment {
        val index = nextIndex++
        val name = "mic-%04d.wav".format(index)
        return Segment(index, cursor, name, WavWriter(File(out, name))).also { current = it }
    }

    private fun closeSegment() {
        val segment = current ?: return
        current = null
        segment.wav.close()
        segment.end = cursor
        segments.add(segment)
        writeManifest()
        emit(event("segment").put("index", segment.index).put("startMs", ms(segment.start)).put("endMs", ms(segment.end))
            .put("mic", File(out, segment.file).path).put("system", JSONObject.NULL))
    }

    private fun pauseAt() {
        closeSegment()
        val at = ms(cursor)
        paused.add(longArrayOf(at, -1))
        writeManifest()
        emit(event("paused").put("atMs", at))
    }

    private fun resumeAt() {
        cursor = max(cursor, wallFrame())
        val at = ms(cursor)
        paused.last()[1] = at
        writeManifest()
        emit(event("resumed").put("atMs", at))
    }

    private fun stop() {
        if (stopped) return
        stopped = true
        if (isPaused) {
            cursor = max(cursor, wallFrame())
            paused.last()[1] = ms(cursor)
        }
        try { closeSegment() } catch (_: Exception) {}
        durationMs = ms(cursor)
        // Called when writing failed too (a full disk): the last manifest on disk then stands.
        try { writeManifest() } catch (_: Exception) {}
        emit(event("stopped").put("durationMs", ms(cursor)).put("segments", segments.size))
    }

    private fun fail(code: String, message: String) {
        emit(event("error").put("code", code).put("message", message))
        stop()
    }

    private fun wallFrame() = elapsedMs() * SAMPLE_RATE / 1000
    private fun ms(frames: Long) = frames * 1000 / SAMPLE_RATE

    /** Atomically, like the sidecar: a crash leaves the previous version, never half a file. */
    private fun writeManifest() {
        val json = JSONObject()
            .put("version", 1)
            .put("startedAt", startedAtIso)
            .put("sampleRate", SAMPLE_RATE)
            .put("segmentSeconds", SEGMENT_SECONDS)
            .put("tracks", JSONArray().put("mic"))
            .put("status", if (stopped) "stopped" else "recording")
            .put("durationMs", durationMs ?: JSONObject.NULL)
            .put("segments", JSONArray(segments.map {
                JSONObject().put("index", it.index).put("startMs", ms(it.start)).put("endMs", ms(it.end))
                    .put("mic", it.file).put("system", JSONObject.NULL)
            }))
            .put("marks", JSONArray(marks.map { JSONObject().put("atMs", it) }))
            .put("paused", JSONArray(paused.map { JSONObject().put("fromMs", it[0]).put("toMs", if (it[1] < 0) JSONObject.NULL else it[1]) }))
        val tmp = File(out, "manifest.json.tmp")
        tmp.writeText(json.toString() + "\n")
        if (!tmp.renameTo(File(out, "manifest.json"))) throw java.io.IOException("写入 manifest.json 失败")
    }

    private fun event(type: String) = JSObject().put("type", type)

    private fun iso(date: Date) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.ROOT).format(date)

    private class Segment(val index: Int, val start: Long, val file: String, val wav: WavWriter) {
        var end = start
    }

    /**
     * On Android 10+ the system says when it silences this recording, which is what a phone
     * call does to it: the microphone goes to the call and the recording reads zeros.
     */
    private inner class SilenceWatcher(private val record: AudioRecord) {
        @Volatile var silenced = false
            private set
        private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        private val callback = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    configs.firstOrNull { it.clientAudioSessionId == record.audioSessionId }?.let { silenced = it.isClientSilenced }
                }
            }.also { manager.registerAudioRecordingCallback(it, Handler(Looper.getMainLooper())) }
        } else null

        fun close() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && callback != null) manager.unregisterAudioRecordingCallback(callback)
        }
    }
}

/**
 * Mono 16-bit PCM WAV. The sizes in the header are patched every second, so a file cut short by
 * a crash or a killed app still plays up to the last second written.
 */
private class WavWriter(file: File) {
    private val raf = RandomAccessFile(file, "rw").apply { setLength(0) }
    private val pending = ByteBuffer.allocate(Recording.SAMPLE_RATE * 2).order(ByteOrder.LITTLE_ENDIAN)
    private var frames = 0L

    init {
        raf.write(header())
    }

    fun append(samples: ShortArray, offset: Int, count: Int) {
        for (i in offset until offset + count) {
            if (!pending.hasRemaining()) flush()
            pending.putShort(samples[i])
        }
        frames += count
    }

    fun close() {
        flush()
        raf.close()
    }

    private fun flush() {
        raf.write(pending.array(), 0, pending.position())
        pending.clear()
        raf.seek(0)
        raf.write(header())
        raf.seek(raf.length())
    }

    private fun header(): ByteArray {
        val data = (frames * 2).coerceAtMost(0xFFFF_FFFFL - 36).toInt()
        return ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + data); put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1)
            putInt(Recording.SAMPLE_RATE); putInt(Recording.SAMPLE_RATE * 2); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(data)
        }.array()
    }
}
