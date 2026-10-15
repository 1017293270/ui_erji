package com.evanbyte.echomind

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import org.json.JSONArray

@InvokeArg
class RecordArgs {
    lateinit var out: String
    lateinit var events: Channel
}

@InvokeArg
class ControlArgs {
    lateinit var command: String
}

@InvokeArg
class StatusArgs {
    lateinit var events: Channel
}

@InvokeArg
class InstallArgs {
    lateinit var dest: String
    lateinit var progress: Channel
}

@InvokeArg
class WorkArgs {
    var active: Boolean = false
}

@InvokeArg
class OpenArgs {
    lateinit var url: String
}

/**
 * What the Rust side (src/mobile) asks of Android: recording in [RecorderService], the speech
 * models unpacked from the package, and links opened in the browser. Called from Rust only;
 * the page talks to Rust.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = ["android.permission.RECORD_AUDIO"], alias = "microphone"),
        // Android 13+: without it the recording notification is hidden, the recording still runs.
        Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notifications"),
    ]
)
class EchoMindPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        /** One model install at a time, also across a recreated activity: they share `<model>.tmp`. */
        private val installing = Any()

        private var created = false
        /** Rust waiting in [nextActivity], or an activity that came before it asked. */
        private var waiting: Invoke? = null
        private var pending = false

        /** From MainActivity.onCreate, on the main thread, as [nextActivity] runs. */
        fun activityCreated() {
            if (!created) {
                created = true
                return
            }
            waiting?.resolve() ?: run { pending = true }
            waiting = null
        }
    }

    /**
     * The activity this plugin was made with goes away when the app is swiped off the screen,
     * while a recording keeps the app running; so the app's own context, which stays.
     */
    private val context get() = activity.applicationContext

    /** Asks for the microphone (and, on Android 13+, notifications) unless already granted. */
    @Command
    fun recordingPermissions(invoke: Invoke) {
        val aliases = if (Build.VERSION.SDK_INT >= 33) arrayOf("microphone", "notifications") else arrayOf("microphone")
        if (aliases.all { getPermissionState(it) == PermissionState.GRANTED }) {
            answerPermissions(invoke)
        } else {
            requestPermissionForAliases(aliases, invoke, "answerPermissions")
        }
    }

    @PermissionCallback
    private fun answerPermissions(invoke: Invoke) {
        invoke.resolve(JSObject().put("microphone", getPermissionState("microphone").toString()))
    }

    @Command
    fun record(invoke: Invoke) {
        val args = invoke.parseArgs(RecordArgs::class.java)
        if (RecorderService.current != null) {
            invoke.reject("已经在记录了")
            return
        }
        RecorderService.sink = { args.events.send(it) }
        val intent = Intent(context, RecorderService::class.java).putExtra(RecorderService.EXTRA_OUT, args.out)
        ContextCompat.startForegroundService(context, intent)
        invoke.resolve()
    }

    @Command
    fun control(invoke: Invoke) {
        val args = invoke.parseArgs(ControlArgs::class.java)
        val recording = RecorderService.current
        if (recording == null) {
            invoke.reject("现在没有在记录")
            return
        }
        recording.command(args.command)
        invoke.resolve()
    }

    /** Where a recording stands, for a page that opened while it was running; events go to [StatusArgs.events] from now on. */
    /**
     * The app is transcribing or summarising a meeting (`active`), or has nothing left to do.
     * While it works, the recording service stays in the foreground so Android neither freezes
     * the app nor cuts off its network (see [RecorderService]).
     */
    @Command
    fun keepWorking(invoke: Invoke) {
        val args = invoke.parseArgs(WorkArgs::class.java)
        val intent = Intent(context, RecorderService::class.java)
            .setAction(if (args.active) RecorderService.ACTION_WORK else RecorderService.ACTION_IDLE)
        try {
            // A running foreground service counts as the app being in use, so the service can be
            // told from the background; starting it anew is only allowed while the app is open.
            if (RecorderService.running) context.startService(intent)
            else if (args.active) ContextCompat.startForegroundService(context, intent)
        } catch (e: IllegalStateException) {
            // Opened from the background after all: the work goes on as long as Android lets it.
        }
        invoke.resolve()
    }

    @Command
    fun status(invoke: Invoke) {
        val args = invoke.parseArgs(StatusArgs::class.java)
        val recording = RecorderService.current
        if (recording == null || recording.finished) {
            invoke.resolve(JSObject().put("recording", false))
            return
        }
        RecorderService.sink = { args.events.send(it) }
        invoke.resolve(
            JSObject().put("recording", true).put("startedAt", recording.startedAtIso).put("out", recording.out.path)
                .put("elapsedMs", recording.elapsedMs()).put("paused", recording.isPaused)
                .put("marks", JSONArray(recording.markTimes))
        )
    }

    /**
     * Copies `assets/models/<model>/…` into [InstallArgs.dest], each model through `<model>.tmp`
     * so a half-copied one is never taken for whole. Models whose `.ready` already matches, with
     * every file there at its packaged size, are skipped. Progress is `{received, total}` in bytes.
     */
    @Command
    fun installModels(invoke: Invoke) {
        val args = invoke.parseArgs(InstallArgs::class.java)
        Thread {
            try {
                synchronized(installing) { install(args) }
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject("安装语音模型失败：${e.message}")
            }
        }.start()
    }

    private fun install(args: InstallArgs) {
        val assets = context.assets
        val models = assets.list("models").orEmpty().filter { assets.list("models/$it").orEmpty().isNotEmpty() }
        if (models.isEmpty()) throw IllegalStateException("安装包里没有语音模型")
        val dest = File(args.dest).apply { mkdirs() }
        fun size(path: String) = try { assets.openFd(path).use { it.length } } catch (_: Exception) { 0L }
        val todo = models.filter { model ->
            val packaged = assets.open("models/$model/.ready").bufferedReader().use { it.readText() }
            val whole = assets.list("models/$model").orEmpty().all { name ->
                val file = File(dest, "$model/$name")
                file.isFile && size("models/$model/$name").let { it == 0L || it == file.length() }
            }
            File(dest, "$model/.ready").let { !whole || !it.isFile || it.readText() != packaged }
        }
        val files = todo.flatMap { model -> assets.list("models/$model").orEmpty().map { model to it } }
        val total = files.sumOf { (model, name) -> size("models/$model/$name") }
        var received = 0L
        var lastSent = 0L
        args.progress.send(JSObject().put("received", 0).put("total", total))
        for (model in todo) {
            val tmp = File(dest, "$model.tmp").apply { deleteRecursively(); mkdirs() }
            for ((_, name) in files.filter { it.first == model }) {
                assets.open("models/$model/$name").use { input ->
                    File(tmp, name).outputStream().use { output ->
                        val buffer = ByteArray(1 shl 20)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            output.write(buffer, 0, n)
                            received += n
                            if (received - lastSent >= 4 shl 20) {
                                lastSent = received
                                args.progress.send(JSObject().put("received", received).put("total", total))
                            }
                        }
                    }
                }
            }
            val target = File(dest, model)
            target.deleteRecursively()
            if (!tmp.renameTo(target)) throw IllegalStateException("安装 $model 失败")
        }
        args.progress.send(JSObject().put("received", total).put("total", total))
    }

    /**
     * Resolves when an activity is created after the first: the app was swiped away while it
     * kept running, and opened again. Rust then opens the page in it (mobile/mod.rs).
     */
    @Command
    fun nextActivity(invoke: Invoke) {
        if (pending) {
            pending = false
            invoke.resolve()
        } else {
            waiting = invoke
        }
    }

    /** The app's page in the phone's settings, where its permissions are switched on. */
    @Command
    fun openSettings(invoke: Invoke) {
        val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        invoke.resolve()
    }

    @Command
    fun openUrl(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(args.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("没有可以打开链接的浏览器：${e.message}")
        }
    }
}
