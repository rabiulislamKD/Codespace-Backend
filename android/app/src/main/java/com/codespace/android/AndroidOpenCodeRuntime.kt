package com.codespace.android

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Genuine Android-local OpenCode CLI runtime via Termux RUN_COMMAND.
 *
 * Fixed in v39 (root causes of COMMAND_ERROR):
 *  - Termux delivers results inside a nested Bundle "result" with keys exitCode/stdout/stderr
 *    (NOT top-level com.termux.RUN_COMMAND_RESULT_* keys). We read the official shape and support
 *    the flat shape as a fallback. A missing bundle is reported as MISSING_RESULT, never success.
 *  - The result PendingIntent must be MUTABLE so Termux can fill in the result intent; with
 *    FLAG_IMMUTABLE the fill-in is ignored and exit code stays -1.
 *  - EXTRA_SESSION_ACTION is a String ("0") per TermuxConstants, not an Int.
 *  - Each request uses its own nonce + callback so concurrent probes cannot cross-correlate.
 *  - The probe runs through a Termux login shell (bash -lc) with the explicit opencode path so
 *    PATH / LD_LIBRARY_PATH / runtime dependencies of `/.../lib/opencode-termux` are initialized.
 *  - Service start failures, no-result/timeout and non-zero exit are distinct states.
 */
internal object AndroidOpenCodeRuntime {
    private const val TAG = "AndroidOpenCode"

    const val TERMUX_PACKAGE = "com.termux"
    const val TERMUX_PERMISSION = "com.termux.permission.RUN_COMMAND"
    const val TERMUX_SERVICE_CLASS = "com.termux.app.RunCommandService"
    const val ACTION_RUN_COMMAND = "com.termux.RUN_COMMAND"
    const val TERMUX_OPCODE_PATH = "/data/data/com.termux/files/usr/bin/opencode"
    const val TERMUX_BASH_PATH = "/data/data/com.termux/files/usr/bin/bash"
    const val TERMUX_HOME = "/data/data/com.termux/files/home"
    const val ACTION_RESULT = "com.codespace.android.OPENCODE_TERMUX_RESULT"
    /** v44: one exported receiver action for every run result, dispatched by the session extra. */
    const val ACTION_RESULT_GLOBAL = "com.codespace.android.OPENCODE_TERMUX_RESULT_V44"

    // Official Termux RUN_COMMAND request extras
    private const val EXTRA_PATH = "com.termux.RUN_COMMAND_PATH"
    private const val EXTRA_ARGS = "com.termux.RUN_COMMAND_ARGUMENTS"
    private const val EXTRA_WORKDIR = "com.termux.RUN_COMMAND_WORKDIR"
    private const val EXTRA_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND"
    private const val EXTRA_PENDING_INTENT = "com.termux.RUN_COMMAND_PENDING_INTENT"
    private const val EXTRA_SESSION_ACTION = "com.termux.RUN_COMMAND_SESSION_ACTION"

    // Official Termux result shape: Bundle "result" { exitCode, stdout, stderr, err, errmsg }
    private const val RESULT_BUNDLE = "result"
    private const val RESULT_EXIT_CODE = "exitCode"
    private const val RESULT_STDOUT = "stdout"
    private const val RESULT_STDERR = "stderr"
    private const val RESULT_ERR = "err"
    private const val RESULT_ERRMSG = "errmsg"
    private const val RESULT_NONCE = "cs_nonce"
    private const val RESULT_SESSION = "cs_session"

    const val REQ_TERMUX_PERMISSION = 8821
    private const val PROBE_TIMEOUT_MS = 25000

    // v44 execution lifecycle. Every terminal run writes the exit file, so the frontend can never
    // be left polling forever at STARTING (the v43 bug).
    const val EXIT_LAUNCH_FAILED = 70         // Termux never started the shell (cwd/service/validation abort)
    const val EXIT_WORKSPACE_UNREACHABLE = 78 // shell started, but the workspace `cd` failed
    const val EXIT_TIMEOUT = 124              // run exceeded the execution timeout
    const val EXIT_CANCELLED = 130            // user pressed Stop
    const val EXIT_STUCK = 125                           // v47: sustained zero output + dead/blocked process
    private const val LAUNCH_GRACE_MS = 45_000L          // STARTING → FAILED if no shell start marker
    private const val DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000L
    private const val NO_OUTPUT_DIAG_MS = 20_000L        // v46/v47: log real process/output state while a run is silent
    private const val DEFAULT_NO_OUTPUT_WATCHDOG_MS = 5 * 60 * 1000L // v47: configurable stuck threshold
    private const val RETENTION_MS = 120_000L            // v46: drop a terminal session after the frontend has consumed it
    private const val DIAG_PREFIX = "[OPENCODE_EXEC_V44]"
    private const val DIAG_FILE = "opencode-exec-v44.log"

    const val STATE_QUEUED = "QUEUED"
    const val STATE_STARTING = "STARTING"
    const val STATE_RUNNING = "RUNNING"
    const val STATE_COMPLETED = "COMPLETED"
    const val STATE_FAILED = "FAILED"
    const val STATE_CANCELLED = "CANCELLED"
    const val STATE_TIMED_OUT = "TIMED_OUT"

    enum class Kind { TERMUX, BUNDLED, NONE }

    /** Distinct detection/execution states — never conflated. */
    enum class TermuxState {
        OK,                                  // command executed, exit 0
        NOT_INSTALLED,                       // package not found via PackageManager
        PERMISSION_NOT_GRANTED,              // package present, permission missing
        SERVICE_UNAVAILABLE,                 // explicit service start failed
        EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE, // started, no result (setting off / timeout)
        MISSING_RESULT,                      // result delivered but no result bundle (bad fill-in)
        COMMAND_ERROR,                       // result delivered, non-zero exit (with diagnostics)
        NOT_SUPPORTED                        // non-Termux / bundled path
    }

    data class Probe(
        val kind: Kind,
        val available: Boolean,
        val version: String?,
        val command: String?,
        val error: String?,
        val state: TermuxState = TermuxState.NOT_SUPPORTED
    )

    data class Session(
        val id: String,
        val runId: String,
        val kind: Kind,
        val workDir: String,
        val outFile: File,
        val errFile: File,
        val exitFile: File,
        val startFile: File,
        val launchedAt: Long,
        @Volatile var started: Boolean = false,
        @Volatile var pid: String = "",
        @Volatile var childPid: String = "",
        @Volatile var children: String = "",
        @Volatile var exited: Boolean = false,
        @Volatile var exitCode: Int? = null,
        @Volatile var state: String = STATE_STARTING,
        @Volatile var cancelled: Boolean = false,
        @Volatile var timedOut: Boolean = false,
        // v47: initialize to launch time so `sinceOutputMs` is correct for a run that has
        // never produced a byte. A zero here made every silent run look like an output stall.
        @Volatile var lastOutputAt: Long = launchedAt,
        @Volatile var exitedAt: Long = 0L,
        @Volatile var lastDiagAt: Long = 0L,
        @Volatile var diagnosis: String = ""
    )

    private data class CommandResult(
        val state: TermuxState,
        val exitCode: Int,
        val stdout: String,
        val stderr: String
    )

    private val sessions = ConcurrentHashMap<String, Session>()
    private val pendingResults = ConcurrentHashMap<String, CommandResult>()

    @Volatile private var runTimeoutMs: Long = DEFAULT_RUN_TIMEOUT_MS
    @Volatile private var appContext: Context? = null
    @Volatile private var globalReceiverRegistered = false
    private val workspaceAccessCache = ConcurrentHashMap<String, Pair<Long, Boolean>>()

    /** Configurable execution timeout (ms). Defaults to 30 minutes. */
    fun setRunTimeoutMs(ms: Long) {
        if (ms in 5_000L..(6 * 60 * 60 * 1000L)) runTimeoutMs = ms
    }

    /**
     * v47: configurable sustained-zero-output watchdog threshold. A run is only terminated when
     * this threshold is exceeded AND a real /proc probe says the process is dead, a zombie,
     * suspended or in uninterruptible sleep. A sleeping process waiting on a provider is never
     * killed just because it has not emitted text yet.
     */
    @Volatile private var noOutputWatchdogMs: Long = DEFAULT_NO_OUTPUT_WATCHDOG_MS
    fun setNoOutputWatchdogMs(ms: Long) {
        if (ms in 30_000L..(6 * 60 * 60 * 1000L)) noOutputWatchdogMs = ms
    }
    fun noOutputWatchdogMs(): Long = noOutputWatchdogMs

    fun runTimeoutMs(): Long = runTimeoutMs

    /** POSIX single-quote escaping — every interpolated path/prompt is made literal. */
    private fun shQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    private fun now(): Long = System.currentTimeMillis()

    /** Append one [OPENCODE_EXEC_V44] diagnostic line to logcat and the shared staging log. */
    private fun diag(context: Context?, message: String) {
        try { Log.i(TAG, "$DIAG_PREFIX $message") } catch (_: Throwable) {}
        val ctx = context ?: appContext ?: return
        try {
            val f = File(stagingDir(ctx), DIAG_FILE)
            if (f.isFile && f.length() > 512 * 1024) f.writeText("")
            val ts = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
            f.appendText("[$ts] $message\n")
        } catch (_: Throwable) {}
    }

    /** Public diagnostics hook for the activity — same [OPENCODE_EXEC_V44] sink. */
    fun logDiag(context: Context, message: String) = diag(context, message)

    /** A single exported receiver for all run results; Termux fills in the result extras (MUTABLE PI). */
    private fun ensureResultReceiver(context: Context) {
        if (globalReceiverRegistered) return
        synchronized(this) {
            if (globalReceiverRegistered) return
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    val sid = intent.getStringExtra(RESULT_SESSION) ?: return
                    val s = sessions[sid] ?: return
                    val bundle = intent.getBundleExtra(RESULT_BUNDLE)
                    val exit = bundle?.getInt(RESULT_EXIT_CODE, -999)
                        ?: intent.getIntExtra(RESULT_EXIT_CODE, -999)
                    val err = bundle?.getString(RESULT_STDERR)
                        ?: intent.getStringExtra(RESULT_STDERR) ?: ""
                    val errmsg = bundle?.getString(RESULT_ERRMSG)
                        ?: intent.getStringExtra(RESULT_ERRMSG) ?: ""
                    diag(c, "termux-result session=$sid exit=$exit errmsg=${errmsg.take(200)}")
                    // Termux aborted before running the shell (working-dir validation, policy, etc.).
                    // Record it so the frontend fails fast instead of hanging at STARTING.
                    if (!s.exited && exit != 0 && s.startFile.length() == 0L) {
                        val why = (listOf(errmsg, err).firstOrNull { it.isNotBlank() }
                            ?: "Termux did not start the OpenCode CLI process.").take(600)
                        try {
                            s.errFile.appendText("\nCODESPACE_TERMUX_ABORTED: $why")
                            s.exitFile.writeText(EXIT_LAUNCH_FAILED.toString())
                        } catch (_: Throwable) {}
                        s.exited = true; s.exitCode = EXIT_LAUNCH_FAILED; s.state = STATE_FAILED
                    }
                }
            }
            try {
                val filter = IntentFilter(ACTION_RESULT_GLOBAL)
                if (Build.VERSION.SDK_INT >= 33) {
                    context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
                } else {
                    @Suppress("UnspecifiedRegisterReceiverFlag")
                    context.registerReceiver(receiver, filter)
                }
                globalReceiverRegistered = true
            } catch (t: Throwable) {
                Log.w(TAG, "result receiver registration failed: ${t.message}")
            }
        }
    }

    fun isArm64(): Boolean = Build.SUPPORTED_ABIS.any { it.equals("arm64-v8a", true) }

    /** Detect the Termux package via PackageManager. Requires <queries> in the manifest. */
    fun termuxInstalled(context: Context): Boolean = try {
        @Suppress("DEPRECATION")
        context.packageManager.getApplicationInfo(TERMUX_PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        try {
            val resolve = Intent(ACTION_RUN_COMMAND).setPackage(TERMUX_PACKAGE)
            @Suppress("DEPRECATION")
            context.packageManager.queryIntentServices(resolve, 0).isNotEmpty() ||
                context.packageManager.queryIntentActivities(resolve, 0).isNotEmpty()
        } catch (_: Throwable) {
            false
        }
    } catch (_: Throwable) {
        false
    }

    /** True when this app holds the Termux RUN_COMMAND permission. */
    fun termuxPermissionGranted(context: Context): Boolean =
        context.checkSelfPermission(TERMUX_PERMISSION) == PackageManager.PERMISSION_GRANTED

    fun requestTermuxPermission(activity: Activity) {
        if (!termuxInstalled(activity) || termuxPermissionGranted(activity)) return
        activity.requestPermissions(arrayOf(TERMUX_PERMISSION), REQ_TERMUX_PERMISSION)
    }

    fun stateMessage(state: TermuxState, raw: String = ""): String = when (state) {
        TermuxState.OK -> raw.ifBlank { "OpenCode CLI responded." }
        TermuxState.NOT_INSTALLED -> "Termux is not installed. Install Termux (F-Droid) and OpenCode inside it."
        TermuxState.PERMISSION_NOT_GRANTED -> "Termux is installed, but the 'Run commands in Termux environment' permission is not granted. Grant it in Android Settings → Apps → CodeSpace → Permissions."
        TermuxState.SERVICE_UNAVAILABLE -> "Termux is installed but its RunCommandService could not be started. Update Termux and enable Termux → External apps → Allow external apps to run commands."
        TermuxState.EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE -> "Termux did not return a result within $PROBE_TIMEOUT_MS ms. Enable Termux → External apps → 'Allow external apps to run commands', then press Recheck."
        TermuxState.MISSING_RESULT -> "Termux returned no result bundle. Update Termux (RUN_COMMAND result format) and press Recheck. Details: " + raw.take(160)
        TermuxState.COMMAND_ERROR -> "OpenCode CLI failed inside Termux (exit code reported). " + (raw.ifBlank { "No diagnostic output was returned." }).take(300)
        TermuxState.NOT_SUPPORTED -> raw.ifBlank { "No Android-local CLI runtime." }
    }

    fun status(context: Context, workspace: String, savedKeys: JSONArray): JSONObject {
        val installed = termuxInstalled(context)
        val granted = termuxPermissionGranted(context)
        val probe = probe(context)
        return JSONObject()
            .put("installed", probe.available)
            .put("canInstall", true)
            .put("installing", false)
            .put("androidLocal", probe.available)
            .put("runtimeKind", probe.kind.name)
            .put("version", probe.version ?: JSONObject.NULL)
            .put("command", probe.command ?: JSONObject.NULL)
            .put("authenticated", JSONObject.NULL)
            .put("workspace", workspace)
            .put("savedKeys", savedKeys)
            .put("localUnsupported", false)
            .put("arm64", isArm64())
            .put("termuxInstalled", installed)
            .put("termuxPermissionGranted", granted)
            .put("termuxState", probe.state.name)
            .put("message", if (probe.available) "OpenCode CLI ${probe.version} is available via Termux."
                else stateMessage(probe.state, probe.error ?: ""))
    }

    private fun bundledBinary(context: Context): File? = listOf(
        File(context.filesDir, "opencode/bin/opencode"),
        File(context.applicationInfo.nativeLibraryDir, "libopencode_android.so"),
        File(context.filesDir, "opencode/opencode")
    ).firstOrNull { it.isFile && it.canExecute() }

    private fun probeBundled(context: Context, binary: File): Probe = try {
        val pb = ProcessBuilder(binary.absolutePath, "--version")
        pb.redirectErrorStream(true)
        pb.environment()["HOME"] = context.filesDir.absolutePath
        val p = pb.start()
        val out = p.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }.trim()
        if (p.waitFor(20, TimeUnit.SECONDS) && p.exitValue() == 0 && out.isNotBlank()) {
            Probe(Kind.BUNDLED, true, out.take(200), binary.absolutePath, null, TermuxState.OK)
        } else {
            Probe(Kind.BUNDLED, false, null, binary.absolutePath, "CLI --version failed: ${out.take(160)}", TermuxState.COMMAND_ERROR)
        }
    } catch (t: Throwable) {
        Probe(Kind.BUNDLED, false, null, binary.absolutePath, "CLI execution failed: ${t.message}".take(240), TermuxState.COMMAND_ERROR)
    }

    /**
     * Run one command through Termux RUN_COMMAND and await its result via the official
     * result Bundle delivered to a per-request PendingIntent.
     */
    private fun runTermuxCommand(
        context: Context,
        path: String,
        args: Array<String>,
        workDir: String,
        timeoutMs: Int = PROBE_TIMEOUT_MS
    ): CommandResult {
        val nonce = "req_" + System.currentTimeMillis() + "_" + (Math.random() * 1e9).toLong()
        val action = "$ACTION_RESULT.$nonce"
        val latch = CountDownLatch(1)

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                val n = intent.getStringExtra(RESULT_NONCE) ?: ""
                if (n != nonce) return
                // Official Termux result: Bundle "result" with exitCode/stdout/stderr.
                val bundle = intent.getBundleExtra(RESULT_BUNDLE)
                val exit = bundle?.getInt(RESULT_EXIT_CODE, -999)
                    ?: intent.getIntExtra(RESULT_EXIT_CODE, -999)
                var out = bundle?.getString(RESULT_STDOUT)
                    ?: intent.getStringExtra(RESULT_STDOUT) ?: ""
                var err = bundle?.getString(RESULT_STDERR)
                    ?: intent.getStringExtra(RESULT_STDERR) ?: ""
                if (out.isBlank()) out = bundle?.getString(RESULT_ERR) ?: intent.getStringExtra(RESULT_ERR) ?: ""
                if (err.isBlank()) err = bundle?.getString(RESULT_ERRMSG) ?: intent.getStringExtra(RESULT_ERRMSG) ?: ""
                val state = when {
                    bundle == null && exit == -999 && out.isBlank() && err.isBlank() -> TermuxState.MISSING_RESULT
                    exit == -999 -> TermuxState.MISSING_RESULT
                    exit == 0 -> TermuxState.OK
                    else -> TermuxState.COMMAND_ERROR
                }
                pendingResults[nonce] = CommandResult(state, exit, out, err)
                latch.countDown()
            }
        }

        var registered = false
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                context.registerReceiver(receiver, IntentFilter(action))
            }
            registered = true

            // MUTABLE is required so Termux can fill in the result intent. Explicit package keeps
            // it safe under target SDK 35 implicit-intent restrictions.
            val pi = PendingIntent.getBroadcast(
                context, nonce.hashCode(),
                Intent(action).setPackage(context.packageName).putExtra(RESULT_NONCE, nonce),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            val intent = buildRunCommandIntent(path, args, workDir, true, pi)
            if (!startRunCommandService(context, intent)) {
                return CommandResult(TermuxState.SERVICE_UNAVAILABLE, -1, "", "")
            }
            val got = latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            if (!got) return CommandResult(TermuxState.EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE, -1, "", "")
            return pendingResults.remove(nonce)
                ?: CommandResult(TermuxState.MISSING_RESULT, -1, "", "")
        } catch (t: Throwable) {
            Log.w(TAG, "runTermuxCommand failed: ${t.message}")
            return CommandResult(TermuxState.SERVICE_UNAVAILABLE, -1, "", t.message ?: "")
        } finally {
            pendingResults.remove(nonce)
            if (registered) try { context.unregisterReceiver(receiver) } catch (_: Throwable) {}
        }
    }

    private fun probeTermux(context: Context): Probe {
        if (!termuxInstalled(context)) {
            return Probe(Kind.TERMUX, false, null, null, stateMessage(TermuxState.NOT_INSTALLED), TermuxState.NOT_INSTALLED)
        }
        if (!termuxPermissionGranted(context)) {
            return Probe(Kind.TERMUX, false, null, "termux:opencode",
                stateMessage(TermuxState.PERMISSION_NOT_GRANTED), TermuxState.PERMISSION_NOT_GRANTED)
        }
        // Environment initialization: run via Termux login shell with the explicit binary path so
        // PATH/LD_LIBRARY_PATH and the opencode-termux runtime are available.
        val shell = "'$TERMUX_OPCODE_PATH' --version 2>&1"
        val r = runTermuxCommand(context, TERMUX_BASH_PATH, arrayOf("-lc", shell), TERMUX_HOME)
        val detail = listOf(r.stderr, r.stdout).filter { it.isNotBlank() }.joinToString(" · ").take(200)
        return when (r.state) {
            TermuxState.OK -> {
                val version = r.stdout.ifBlank { r.stderr }.trim().take(200)
                if (version.isBlank()) {
                    Probe(Kind.TERMUX, false, null, "termux:$TERMUX_OPCODE_PATH",
                        "CLI exited 0 but produced no version output.", TermuxState.MISSING_RESULT)
                } else {
                    Probe(Kind.TERMUX, true, version, "termux:$TERMUX_OPCODE_PATH", null, TermuxState.OK)
                }
            }
            TermuxState.MISSING_RESULT -> Probe(Kind.TERMUX, false, null, "termux:$TERMUX_OPCODE_PATH",
                stateMessage(TermuxState.MISSING_RESULT, detail), TermuxState.MISSING_RESULT)
            TermuxState.EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE -> Probe(Kind.TERMUX, false, null,
                "termux:$TERMUX_OPCODE_PATH", stateMessage(r.state), r.state)
            TermuxState.SERVICE_UNAVAILABLE -> Probe(Kind.TERMUX, false, null,
                "termux:$TERMUX_OPCODE_PATH", stateMessage(r.state, detail), r.state)
            else -> Probe(Kind.TERMUX, false, null, "termux:$TERMUX_OPCODE_PATH",
                stateMessage(TermuxState.COMMAND_ERROR, detail), TermuxState.COMMAND_ERROR)
        }
    }

    /** Build the official explicit Termux RUN_COMMAND Intent. */
    private fun buildRunCommandIntent(
        path: String,
        args: Array<String>,
        workDir: String,
        background: Boolean,
        pendingIntent: PendingIntent
    ): Intent = Intent(ACTION_RUN_COMMAND).apply {
        component = ComponentName(TERMUX_PACKAGE, TERMUX_SERVICE_CLASS)
        putExtra(EXTRA_PATH, path)
        putExtra(EXTRA_ARGS, args)
        putExtra(EXTRA_WORKDIR, workDir)
        putExtra(EXTRA_BACKGROUND, background)
        putExtra(EXTRA_SESSION_ACTION, "0") // Termux reads getStringExtra
        putExtra(EXTRA_PENDING_INTENT, pendingIntent)
    }

    private fun startRunCommandService(context: Context, intent: Intent): Boolean = try {
        context.startService(intent)
        true
    } catch (e: IllegalStateException) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Termux RunCommandService start failed: ${t.message}")
            false
        }
    } catch (t: Throwable) {
        Log.w(TAG, "Termux RunCommandService start failed: ${t.message}")
        false
    }

    fun probe(context: Context): Probe {
        bundledBinary(context)?.let {
            val p = probeBundled(context, it)
            if (p.available) return p
        }
        return probeTermux(context)
    }

    /** Start a real OpenCode CLI run through Termux; output is polled by byte offset. */
    fun startRun(context: Context, kind: Kind, command: String, workDir: String, sessionId: String): Session {
        appContext = context.applicationContext
        val dir = stagingDir(context)
        // v46: each run gets its OWN file namespace so a stale/orphaned run can never overwrite the
        // current session's output. The map key stays the OpenCode session id (the frontend polls it).
        val runId = sessionId + "-" + System.currentTimeMillis().toString(36) + "-" + (Math.random() * 1e9).toLong().toString(36)
        cleanupStaleRuns(dir, keep = runId)
        val out = File(dir, "$runId.out").apply { writeText("") }
        val err = File(dir, "$runId.err").apply { writeText("") }
        val exit = File(dir, "$runId.exit").apply { writeText("") }
        val start = File(dir, "$runId.start").apply { writeText("") }

        // The Termux process working directory MUST be one Termux can validate: RunCommandService
        // calls validateDirectoryFileExistenceAndPermissions() and `return stopService()`s (running
        // NOTHING, silently) when the working dir is missing or not writable. Termux home is always
        // writable, so the shell is guaranteed to start. The selected workspace is entered by an
        // explicit `cd` whose failure is reported with a distinct exit code instead of hanging.
        val processDir = TERMUX_HOME
        val startTmp = File(dir, "$runId.start.tmp")
        val shellScript = buildString {
            // v47: The CLI is a TRACKED BACKGROUND CHILD, not a foreground command. The subshell
            // `exec`s the OpenCode command, so `$!` IS the actual CLI PID (not a wrapper shell).
            // Both the launcher shell PID (`$$`) and the CLI PID (`$cli`) are written to a temp
            // file first and then atomically renamed into the start marker, so a poller can never
            // observe a half-written marker. The parent shell `wait`s for the child and records the
            // child's REAL exit code in the exit file.
            append("( cd ").append(shQuote(workDir)).append(" || { echo CODESPACE_WORKSPACE_UNREACHABLE >&2; exit ")
                .append(EXIT_WORKSPACE_UNREACHABLE).append("; } ; exec ")
            append(command)
            append(" ) > '").append(out.absolutePath).append("' 2> '").append(err.absolutePath).append("' & ")
            append("cli=\$!; ")
            append("printf '%s\\n%s\\n' \"\$\$\" \"\$cli\" > '").append(startTmp.absolutePath).append("' && ")
            append("mv -f '").append(startTmp.absolutePath).append("' '").append(start.absolutePath).append("'; ")
            append("wait \"\$cli\"; ")
            append("printf '%s' \"\$?\" > '").append(exit.absolutePath).append("'")
        }
        val pi = PendingIntent.getBroadcast(
            context, sessionId.hashCode(),
            Intent(ACTION_RESULT_GLOBAL).setPackage(context.packageName).putExtra(RESULT_SESSION, sessionId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        ensureResultReceiver(context)
        val intent = buildRunCommandIntent(TERMUX_BASH_PATH, arrayOf("-lc", shellScript), processDir, true, pi)
        val serviceStarted = startRunCommandService(context, intent)
        // Diagnostics: never log the prompt or any key. The prompt follows the ` -- ` separator.
        val redacted = command.replace(Regex("(?s)\\s--\\s.*$"), " -- <prompt hidden>")
        diag(context, "launch session=$sessionId run=$runId engine=android-local cwd=$processDir workspace=$workDir " +
            "exe=$TERMUX_OPCODE_PATH serviceStarted=$serviceStarted cmd=$redacted")
        if (!serviceStarted) {
            err.writeText("Termux RunCommandService could not be started. Check Termux installation and external-command setting.")
            exit.writeText(EXIT_LAUNCH_FAILED.toString())
        }
        val session = Session(sessionId, runId, kind, workDir, out, err, exit, start, now())
        if (!serviceStarted) {
            session.exited = true; session.exitCode = EXIT_LAUNCH_FAILED; session.state = STATE_FAILED; session.exitedAt = now()
        }
        sessions[sessionId] = session
        return session
    }

    /** v46/v47: delete a finished run's files. */
    private fun cleanupRunFiles(s: Session) {
        val tmp = File(s.startFile.parentFile, s.startFile.name + ".tmp")
        listOf(s.outFile, s.errFile, s.exitFile, s.startFile, tmp).forEach { f -> try { if (f.isFile) f.delete() } catch (_: Throwable) {} }
    }

    /** v46: delete stale run files so an old/orphaned run can never overwrite a new session. */
    private fun cleanupStaleRuns(dir: File, keep: String) {
        try {
            val cutoff = now() - 60 * 60 * 1000L
            dir.listFiles()?.forEach { f ->
                val n = f.name
                val isRunFile = n.endsWith(".out") || n.endsWith(".err") || n.endsWith(".exit") || n.endsWith(".start") || n.endsWith(".start.tmp")
                if (isRunFile && !n.startsWith(keep) && f.lastModified() < cutoff) {
                    try { f.delete() } catch (_: Throwable) {}
                }
            }
        } catch (_: Throwable) {}
    }

    /** Termux-readable shared staging dir (Downloads/.codespace-opencode). */
    fun stagingDir(context: Context): File {
        val base = try {
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        } catch (_: Throwable) {
            File(context.cacheDir, "downloads")
        }
        return File(base, ".codespace-opencode").apply { mkdirs() }
    }

    fun readSession(sessionId: String, since: Long): JSONObject {
        val s = sessions[sessionId] ?: return JSONObject()
            .put("error", "Unknown session")
            .put("exited", true)
            .put("state", STATE_FAILED)
            .put("code", JSONObject.NULL)
        val t = now()
        // v47: Launch confirmation is the ATOMIC two-line start marker written after the CLI child
        // has been launched. Line 1 = launcher shell PID ($$), line 2 = actual OpenCode CLI PID ($!).
        // The file is created by `mv` (rename), so a non-empty file is always a complete marker.
        // Only after this does the task become RUNNING — never from "we sent the intent".
        if (!s.started && s.startFile.isFile && s.startFile.length() > 0L) {
            val raw = try { s.startFile.readText().trim() } catch (_: Throwable) { "" }
            val lines = raw.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
            val shellPid = lines.getOrNull(0).orEmpty()
            val cliPid = lines.getOrNull(1).orEmpty()
            // A single-line marker is accepted for backwards compatibility with a shell that
            // died between the two writes; in that case the recorded PID is still usable as the
            // kill root, but we never fabricate a child PID.
            if (shellPid.matches(Regex("\\d+"))) {
                s.started = true
                s.pid = shellPid
                s.childPid = if (cliPid.matches(Regex("\\d+"))) cliPid else ""
                if (!s.exited) s.state = STATE_RUNNING
                diag(appContext, "started session=$sessionId run=${s.runId} shellPid=${s.pid} cliPid=${s.childPid}")
            }
        }
        val bytes = try {
            RandomAccessFile(s.outFile, "r").use { f ->
                f.seek(since.coerceAtMost(f.length()))
                val buf = ByteArray((f.length() - f.filePointer).coerceAtMost(262144L).toInt())
                val n = f.read(buf)
                if (n <= 0) "" else String(buf, 0, n, Charsets.UTF_8)
            }
        } catch (_: Throwable) { "" }
        if (bytes.isNotEmpty()) s.lastOutputAt = t
        val until = s.outFile.length().coerceAtLeast(since)
        val exitCode = if (s.exitFile.isFile) s.exitFile.readText().trim().toIntOrNull() else null
        if (exitCode != null && !s.exited) {
            s.exited = true; s.exitCode = exitCode; s.exitedAt = t
            s.state = when {
                s.cancelled -> STATE_CANCELLED
                s.timedOut -> STATE_TIMED_OUT
                exitCode == 0 -> STATE_COMPLETED
                else -> STATE_FAILED
            }
            diag(appContext, "exit session=$sessionId run=${s.runId} code=$exitCode state=${s.state} elapsedMs=${t - s.launchedAt} outSize=${s.outFile.length()}")
        }
        val elapsed = t - s.launchedAt
        if (!s.exited) {
            if (!s.started && elapsed > LAUNCH_GRACE_MS) {
                // Termux never launched the shell in the grace window → fail fast, never hang.
                try {
                    s.errFile.appendText("\nCODESPACE_LAUNCH_TIMEOUT: the OpenCode CLI process did not start within ${LAUNCH_GRACE_MS / 1000}s. Check that Termux is installed, that Termux → External apps allows commands, and that Termux can write to the selected folder.")
                    s.exitFile.writeText(EXIT_LAUNCH_FAILED.toString())
                } catch (_: Throwable) {}
                s.exited = true; s.exitCode = EXIT_LAUNCH_FAILED; s.state = STATE_FAILED; s.exitedAt = t
                diag(appContext, "launch-timeout session=$sessionId run=${s.runId} workspace=${s.workDir}")
            } else if (s.started && elapsed > runTimeoutMs) {
                s.timedOut = true; s.state = STATE_TIMED_OUT
                killRun(appContext, s.pid, s.childPid)
                try {
                    s.errFile.appendText("\nCODESPACE_TIMEOUT: OpenCode CLI exceeded the ${runTimeoutMs / 1000}s execution limit and was stopped.")
                    s.exitFile.writeText(EXIT_TIMEOUT.toString())
                } catch (_: Throwable) {}
                s.exited = true; s.exitCode = EXIT_TIMEOUT; s.exitedAt = t
                diag(appContext, "timeout session=$sessionId run=${s.runId} pid=${s.pid}")
            } else if (s.started && t - s.lastOutputAt > NO_OUTPUT_DIAG_MS && t - s.lastDiagAt > NO_OUTPUT_DIAG_MS) {
                // v47: a live but silent run. Probe the REAL CLI process (not just the launcher shell)
                // before deciding anything. Absence of text is never, by itself, proof of a hang, a
                // quota error, or a Termux failure.
                s.lastDiagAt = t
                val cliPid = s.childPid.ifBlank { s.pid }
                val ctx = appContext
                val proc = if (ctx != null) probeProcess(ctx, cliPid)
                           else ProcInfo(false, false, false, "", "", "", "")
                val cls = classifyProcess(proc)
                val reason = waitReason(proc.wchan)
                val tree = if (ctx != null) probeTree(ctx, cliPid) else ""
                if (tree.isNotBlank()) s.children = tree
                val silenceMs = t - s.lastOutputAt
                diag(appContext, "no-output session=$sessionId run=${s.runId} shellPid=${s.pid} cliPid=$cliPid " +
                    "alive=${proc.alive} accessible=${proc.accessible} known=${proc.known} state='${proc.state}' " +
                    "class=$cls wait=$reason ppid=${proc.parentPid} children='$tree' " +
                    "elapsedMs=$elapsed sinceOutputMs=$silenceMs outSize=${s.outFile.length()} errSize=${s.errFile.length()}")

                // Only a genuinely stuck process is terminated. A sleeping process waiting on a
                // provider/network request is left alone until the overall execution timeout.
                if (silenceMs > noOutputWatchdogMs && isStuck(cls)) {
                    s.diagnosis = "No output for ${silenceMs / 1000}s. OpenCode CLI process $cliPid is $cls" +
                        (if (proc.state.isNotBlank()) " (state=${proc.state}" else " (state=?") +
                        (if (proc.wchan.isNotBlank()) ", wait=$reason, wchan=${proc.wchan}" else "") + ")."
                    killRun(appContext, s.pid, s.childPid)
                    try {
                        s.errFile.appendText("\nCODESPACE_STUCK: ${s.diagnosis}")
                        s.exitFile.writeText(EXIT_STUCK.toString())
                    } catch (_: Throwable) {}
                    s.exited = true; s.exitCode = EXIT_STUCK; s.state = STATE_FAILED; s.exitedAt = t
                    diag(appContext, "stuck session=$sessionId run=${s.runId} diagnosis=${s.diagnosis}")
                }
            }
        } else if (s.exitedAt > 0L && t - s.exitedAt > RETENTION_MS) {
            // Terminal run already consumed by the frontend: release its files and map entry.
            sessions.remove(sessionId, s)
            cleanupRunFiles(s)
        }
        return JSONObject()
            .put("data", bytes)
            .put("next", until)
            .put("exited", s.exited)
            .put("code", s.exitCode ?: JSONObject.NULL)
            .put("state", s.state)
            .put("started", s.started)
            .put("pid", s.pid)
            .put("childPid", s.childPid)
            .put("children", s.children)
            .put("diagnosis", s.diagnosis)
            .put("elapsedMs", elapsed)
            .put("timeoutMs", runTimeoutMs)
            .put("outSize", s.outFile.length())
            .put("errSize", s.errFile.length())
            .put("outMtimeMs", s.outFile.lastModified())
            .put("errMtimeMs", s.errFile.lastModified())
            .put("sinceOutputMs", t - s.lastOutputAt)
            .put("stderr", if (s.exited) s.errFile.readText().take(4000) else "")
    }

    /**
     * v47: Stop the exact recorded process tree — launcher shell PID, actual OpenCode CLI PID and
     * every descendant of both — with TERM then KILL. Roots are enumerated from /proc at kill time.
     * Unrelated OpenCode processes and other sessions are never signalled.
     */
    private fun killRun(context: Context?, vararg pids: String) {
        val ctx = context ?: return
        val roots = pids.map { it.trim().toIntOrNull() }.filterNotNull().distinct()
        if (roots.isEmpty()) return
        try {
            val rootList = roots.joinToString(" ")
            val shell =
                "kill_tree(){ for c in \$(cat /proc/\$1/task/\$1/children 2>/dev/null); do kill_tree \$c \$2; done; kill -\$2 \$1 2>/dev/null; }; " +
                "for r in $rootList; do kill_tree \$r TERM; kill -TERM \$r 2>/dev/null; done; " +
                "sleep 1; " +
                "for r in $rootList; do kill_tree \$r KILL; kill -KILL \$r 2>/dev/null; done; true"
            val pi = PendingIntent.getBroadcast(
                ctx, ("cs_kill_" + roots.joinToString("_")).hashCode(),
                Intent(ACTION_RESULT_GLOBAL).setPackage(ctx.packageName),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            startRunCommandService(ctx, buildRunCommandIntent(TERMUX_BASH_PATH, arrayOf("-lc", shell), TERMUX_HOME, true, pi))
            diag(ctx, "kill roots=$rootList tree=1 term=1 kill=1")
        } catch (_: Throwable) {}
    }

    /**
     * v47: Cancel a run and VERIFY termination before reporting success. The whole recorded tree
     * (shell + CLI child + descendants) is signalled; the parent shell's exit file (written after
     * `wait $cli`) and the CLI /proc entry are then polled. The session stays in the map until the
     * normal retention window so the frontend can read back the final terminal state.
     */
    fun cancel(context: Context, sessionId: String): JSONObject {
        val s = sessions[sessionId] ?: return JSONObject()
            .put("ok", false).put("verified", false).put("error", "Unknown session")
        s.cancelled = true
        val cliPid = s.childPid.ifBlank { s.pid }
        killRun(context.applicationContext, s.pid, s.childPid)
        var verified = false
        var observedExit: Int? = null
        var lastProcCheck = 0L
        val deadline = now() + 8000L
        while (now() < deadline) {
            observedExit = try { s.exitFile.readText().trim().toIntOrNull() } catch (_: Throwable) { null }
            if (observedExit != null) { verified = true; break }
            if (now() - lastProcCheck > 1000L) {
                lastProcCheck = now()
                val proc = probeProcess(context.applicationContext, cliPid)
                if (proc.known && !proc.alive) { verified = true; break }
            }
            try { Thread.sleep(200) } catch (_: InterruptedException) { break }
        }
        if (!s.exited) {
            s.state = STATE_CANCELLED
            s.exitCode = EXIT_CANCELLED
            s.exited = true
            s.exitedAt = now()
            s.diagnosis = if (verified) "Cancelled: OpenCode CLI process tree terminated."
                          else "Cancellation requested; termination could not be fully verified."
            try { s.errFile.appendText("\nCODESPACE_CANCELLED: stopped by the user.") } catch (_: Throwable) {}
            // Only write 130 when the shell did not already record the real reaped exit code.
            if (observedExit == null) {
                try { s.exitFile.writeText(EXIT_CANCELLED.toString()) } catch (_: Throwable) {}
            }
        }
        diag(context, "cancel session=$sessionId run=${s.runId} shellPid=${s.pid} cliPid=$cliPid " +
            "verified=$verified observedExit=$observedExit state=${s.state}")
        return JSONObject()
            .put("ok", verified)
            .put("verified", verified)
            .put("sessionId", sessionId)
            .put("pid", s.pid)
            .put("childPid", s.childPid)
            .put("observedExitCode", observedExit ?: JSONObject.NULL)
            .put("state", s.state)
    }

    /**
     * v47: safe, on-demand diagnostics for a live run. Probes the ACTUAL OpenCode CLI PID and its
     * descendants (not just the launcher shell) and classifies the wait state. Never returns or logs
     * prompts, API keys or authorization headers. An unreadable /proc entry is UNKNOWN, never DEAD.
     */
    fun probeSession(context: Context, sessionId: String): JSONObject {
        val s = sessions[sessionId] ?: return JSONObject().put("ok", false).put("error", "Unknown session")
        val t = now()
        val cliPid = s.childPid.ifBlank { s.pid }
        val cli = probeProcess(context.applicationContext, cliPid)
        val shell = if (s.childPid.isNotBlank() && s.pid != s.childPid)
            probeProcess(context.applicationContext, s.pid) else cli
        val tree = probeTree(context.applicationContext, cliPid)
        if (tree.isNotBlank()) s.children = tree
        return JSONObject()
            .put("ok", true)
            .put("sessionId", sessionId)
            .put("runId", s.runId)
            .put("pid", s.pid)
            .put("childPid", s.childPid)
            .put("probePid", cliPid)
            .put("alive", cli.alive)
            .put("accessible", cli.accessible)
            .put("known", cli.known)
            .put("procState", cli.state)
            .put("procClass", classifyProcess(cli))
            .put("waitReason", waitReason(cli.wchan))
            .put("ppid", cli.parentPid)
            .put("wchan", cli.wchan)
            .put("children", tree)
            .put("shellAlive", shell.alive)
            .put("shellState", shell.state)
            .put("outSize", s.outFile.length())
            .put("errSize", s.errFile.length())
            .put("outMtimeMs", s.outFile.lastModified())
            .put("errMtimeMs", s.errFile.lastModified())
            .put("elapsedMs", t - s.launchedAt)
            .put("sinceOutputMs", t - s.lastOutputAt)
            .put("started", s.started)
            .put("exited", s.exited)
            .put("state", s.state)
            .put("diagnosis", s.diagnosis)
    }

    private data class ProcInfo(
        val alive: Boolean,
        val accessible: Boolean,
        val known: Boolean,
        val state: String,
        val wchan: String,
        val parentPid: String,
        val children: String
    )

    /**
     * Probe one PID through Termux. `known` distinguishes a real /proc observation (including a
     * definitively absent process) from a failed/unreadable probe — the latter is NEVER reported as
     * a dead process. `state` comes from the comm-safe `...) X ppid` field of /proc/<pid>/stat.
     */
    private fun probeProcess(context: Context, pid: String): ProcInfo {
        val p = pid.trim().toIntOrNull() ?: return ProcInfo(false, false, false, "", "", "", "")
        val shell = "if [ -d /proc/$p ]; then " +
            "st=\$(sed -n 's/.*) \\([A-Za-z]\\) .*/\\1/p' /proc/$p/stat 2>/dev/null); " +
            "pp=\$(sed -n 's/.*) [A-Za-z] \\([0-9]*\\) .*/\\1/p' /proc/$p/stat 2>/dev/null); " +
            "wc=\$(cat /proc/$p/wchan 2>/dev/null); " +
            "ch=\$(cat /proc/$p/task/$p/children 2>/dev/null); " +
            "if [ -n \"\$st\" ]; then " +
            "echo \"CS_PROC alive=1 accessible=1 known=1 state=\$st ppid=\$pp wchan=\$wc children=\$ch\"; " +
            "else echo \"CS_PROC alive=1 accessible=0 known=1 state=unknown wchan=unknown ppid= children=\"; fi; " +
            "else echo CS_PROC alive=0 accessible=0 known=1 state=dead wchan=none ppid= children=; fi"
        val r = try { runTermuxCommand(context, TERMUX_BASH_PATH, arrayOf("-lc", shell), TERMUX_HOME, 15000) } catch (_: Throwable) { null }
        val line = r?.stdout?.lineSequence()?.firstOrNull { it.trim().startsWith("CS_PROC") }?.trim().orEmpty()
        if (line.isBlank()) return ProcInfo(false, false, false, "", "", "", "")
        fun field(k: String): String =
            Regex("(?:^|\\s)" + Regex.escape(k) + "=([^\\s]*)").find(line)?.groupValues?.get(1)?.trim().orEmpty()
        return ProcInfo(
            alive = field("alive") == "1",
            accessible = field("accessible") == "1",
            known = field("known") == "1",
            state = field("state"),
            wchan = field("wchan"),
            parentPid = field("ppid"),
            children = field("children")
        )
    }

    /** v47: comma-separated list of every descendant of the CLI PID, walked live from /proc. */
    private fun probeTree(context: Context, pid: String): String {
        val p = pid.trim().toIntOrNull() ?: return ""
        val shell = "walk(){ [ -d /proc/\$1 ] || return; printf '%s,' \"\$1\"; " +
            "for c in \$(cat /proc/\$1/task/\$1/children 2>/dev/null); do walk \$c; done; }; walk $p"
        val r = try { runTermuxCommand(context, TERMUX_BASH_PATH, arrayOf("-lc", shell), TERMUX_HOME, 15000) } catch (_: Throwable) { return "" }
        return r.stdout.lineSequence().firstOrNull { it.trim().isNotEmpty() }?.trim()?.trim(',') ?: ""
    }

    /** v47: DEAD / BLOCKED / SLEEPING / ACTIVE / UNKNOWN. Inaccessible /proc is UNKNOWN, not DEAD. */
    private fun classifyProcess(p: ProcInfo): String {
        if (!p.known) return "UNKNOWN"
        if (!p.alive) return "DEAD"
        return when (p.state.trim()) {
            "Z", "z", "X", "x" -> "DEAD"
            "D", "T", "t" -> "BLOCKED"
            "R" -> "ACTIVE"
            "S", "I", "" -> "SLEEPING"
            else -> "UNKNOWN"
        }
    }

    /** Only a dead, zombie, suspended or uninterruptibly-blocked process is "genuinely stuck". */
    private fun isStuck(cls: String): Boolean = cls == "DEAD" || cls == "BLOCKED"

    /** Heuristic wait reason from the raw wchan; the raw value is always reported alongside it. */
    private fun waitReason(wchan: String): String {
        val w = wchan.trim().lowercase()
        if (w.isEmpty() || w == "unknown" || w == "none" || w == "0") return "unknown"
        return when {
            Regex("tty|n_tty|terminal|pipe_read|pipe_wait").containsMatchIn(w) -> "terminal-input"
            Regex("ep_poll|sock|inet|tcp|udp|net|select|poll|wait_woken|sk_wait").containsMatchIn(w) -> "network-or-provider"
            Regex("futex|mutex|rwsem|sem_").containsMatchIn(w) -> "lock-wait"
            Regex("do_exit|exit|reaper|do_wait").containsMatchIn(w) -> "exiting"
            else -> "other"
        }
    }

    /** v46: run a read-only command through Termux and capture its output (used for `opencode models`). */
    fun execCapture(context: Context, command: String, timeoutMs: Int = 60_000): JSONObject {
        val r = try {
            runTermuxCommand(context.applicationContext, TERMUX_BASH_PATH, arrayOf("-lc", command), TERMUX_HOME, timeoutMs)
        } catch (t: Throwable) {
            return JSONObject().put("ok", false).put("state", TermuxState.COMMAND_ERROR.name)
                .put("exitCode", -1).put("stdout", "").put("stderr", (t.message ?: "command failed").take(240))
        }
        return JSONObject()
            .put("ok", r.state == TermuxState.OK)
            .put("exitCode", r.exitCode)
            .put("stdout", r.stdout)
            .put("stderr", r.stderr)
            .put("state", r.state.name)
    }

    /**
     * Verify from Termux's own process that the selected workspace exists and is readable/writable/
     * executable. Termux aborts a RUN_COMMAND whose working directory fails its validation, so this
     * is what decides whether the direct path can be used or the SAF mirror must be used instead.
     * Results are cached briefly to avoid a round-trip before every run.
     */
    fun workspaceAccessible(context: Context, path: String): Boolean {
        if (path.isBlank()) return false
        val cached = workspaceAccessCache[path]
        if (cached != null && now() - cached.first < 60_000L) return cached.second
        val shell = "if [ -d ${shQuote(path)} ] && [ -r ${shQuote(path)} ] && [ -w ${shQuote(path)} ] && [ -x ${shQuote(path)} ]; " +
            "then echo CS_WS_OK; else echo CS_WS_NO; fi"
        val r = try { runTermuxCommand(context, TERMUX_BASH_PATH, arrayOf("-lc", shell), TERMUX_HOME, 20000) } catch (_: Throwable) { null }
        val ok = r != null && r.stdout.contains("CS_WS_OK")
        workspaceAccessCache[path] = now() to ok
        diag(context, "workspace-access path=$path ok=$ok termuxState=${r?.state}")
        return ok
    }
}
