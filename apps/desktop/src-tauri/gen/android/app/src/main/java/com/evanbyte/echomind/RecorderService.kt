package com.evanbyte.echomind

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import app.tauri.plugin.JSObject
import java.io.File

/**
 * Keeps EchoMind going with the screen off or the app in the background.
 *
 * While recording: a foreground service of the microphone type, with the notification Android
 * requires and a stop button in it, and a partial wake lock so the CPU keeps reading the
 * microphone. The recording outlives the window; the app asks [current] where it stands when it
 * comes back.
 *
 * After recording, while the meeting is transcribed and summarised: the same service stays in the
 * foreground (data sync type) with the wake lock, since Android freezes an app in the background
 * and cuts off its network. The app holds it there ([ACTION_WORK]) while it has work and lets it
 * go ([ACTION_IDLE]) once nothing is left; after [WORK_LIMIT_MS] it lets itself go anyway. Right
 * after a recording it stays [CLAIM_MS] for the app to start on it, so a closed app or a
 * recording that never got going does not keep the phone awake.
 */
class RecorderService : Service() {
    companion object {
        const val EXTRA_OUT = "out"
        const val ACTION_STOP = "com.evanbyte.echomind.action.STOP"
        /** Stay in the foreground for work the app has started (from the app, while it is open). */
        const val ACTION_WORK = "com.evanbyte.echomind.action.WORK"
        /** Nothing left to do: leave the foreground unless a meeting is being recorded. */
        const val ACTION_IDLE = "com.evanbyte.echomind.action.IDLE"
        private const val CHANNEL = "recording"
        private const val NOTIFICATION_ID = 1
        private const val WORK_LIMIT_MS = 30 * 60 * 1000L
        private const val CLAIM_MS = 2 * 60 * 1000L

        @Volatile var current: Recording? = null
            private set

        /** Whether the service is up at all, recording or working. */
        @Volatile var running = false
            private set

        /** Where events go: the app while it is open. Without it the recording carries on unheard. */
        @Volatile var sink: ((JSObject) -> Unit)? = null
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private val main = Handler(Looper.getMainLooper())
    private val giveUp = Runnable { idle() }
    /** What the app last asked for, also while recording: whether it has work going. */
    private var wanted = false
    private var destroyed = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> current?.command("stop")
            ACTION_WORK -> {
                wanted = true
                if (current == null) work(WORK_LIMIT_MS)
            }
            ACTION_IDLE -> {
                wanted = false
                if (current == null) idle()
            }
            else -> intent?.getStringExtra(EXTRA_OUT)?.let { if (current == null) record(File(it)) }
        }
        // Not sticky: restarted by the system after being killed, it would start a new meeting.
        return START_NOT_STICKY
    }

    private fun record(out: File) {
        main.removeCallbacks(giveUp)
        // Within five seconds of starting, or Android stops the app.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, recordingNotification(), type)
        holdCpu(8 * 60 * 60 * 1000L)

        val recording = Recording(this, out) { event -> sink?.invoke(event) }
        current = recording
        Thread({
            try {
                recording.run()
            } catch (e: Exception) {
                Log.e("EchoMind", "recording stopped unexpectedly", e)
            }
            // The app transcribes and summarises the meeting next, and lets the service go after.
            main.post {
                if (current === recording) current = null
                if (destroyed) return@post
                when {
                    wanted -> work(WORK_LIMIT_MS)
                    recording.hasAudio -> work(CLAIM_MS)
                    else -> idle()
                }
            }
        }, "EchoMind recording").start()
    }

    private fun work(ms: Long) {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, workingNotification(), type)
        holdCpu(ms)
        main.removeCallbacks(giveUp)
        main.postDelayed(giveUp, ms)
    }

    private fun idle() {
        main.removeCallbacks(giveUp)
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun holdCpu(ms: Long) {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EchoMind:working")
            .apply { acquire(ms) }
    }

    /** Android 15 caps data sync work at six hours a day; past that, stop working. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        if (current == null) idle()
    }

    override fun onDestroy() {
        destroyed = true
        current?.command("stop")
        main.removeCallbacks(giveUp)
        wakeLock?.let { if (it.isHeld) it.release() }
        running = false
        super.onDestroy()
    }

    private fun recordingNotification(): Notification {
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RecorderService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return builder()
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("EchoMind 正在记录")
            .setContentText("录音只保存在这台手机上")
            .addAction(0, "结束记录", stop)
            .build()
    }

    private fun workingNotification(): Notification =
        builder()
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("EchoMind 正在整理会议")
            .setContentText("转写在这台手机上进行，整理好后打开 EchoMind 查看")
            .build()

    private fun builder(): NotificationCompat.Builder {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "会议记录", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentIntent(open)
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    }
}
