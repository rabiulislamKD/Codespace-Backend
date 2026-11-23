package com.codespace.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * v47.5: an active AI turn owns this foreground service. It keeps the CodeSpace process resident
 * and holds a partial wake lock so the WebView-hosted agent, its native callbacks and any browser
 * tool it is driving are not frozen when the screen is off or the user leaves the app.
 *
 * This does not replace Termux/OpenCode CLI. External CLI runs are still owned by their own
 * process; this service only prevents Android from suspending the app-side orchestration.
 */
class AiRuntimeService : Service() {
    companion object {
        const val ACTION_START = "com.codespace.android.AI_RUNTIME_START"
        const val ACTION_STOP = "com.codespace.android.AI_RUNTIME_STOP"
        const val EXTRA_LABEL = "ai_runtime_label"
        private const val CHANNEL_ID = "codespace_ai_runtime"
        private const val NOTIFICATION_ID = 31855
        private const val WAKE_LOCK_TAG = "codespace:ai_runtime"

        fun start(context: Context, label: String) {
            val intent = Intent(context, AiRuntimeService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_LABEL, label.take(120))
            }
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, AiRuntimeService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "CodeSpace AI agent", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                startForeground(NOTIFICATION_ID, buildNotification(intent.getStringExtra(EXTRA_LABEL).orEmpty()))
                acquireWakeLock()
            }
            ACTION_STOP -> {
                releaseWakeLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> stopSelf(startId)
        }
        return START_STICKY
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
            setReferenceCounted(false)
            acquire(6 * 60 * 60 * 1000L) // 6h ceiling; renewed by the next turn start
        }
    }

    private fun releaseWakeLock() {
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        wakeLock = null
    }

    private fun buildNotification(label: String): Notification {
        val text = if (label.isBlank()) "An AI task is running; CodeSpace will keep working in the background."
                   else "Working: ${label.take(100)}"
        return if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("CodeSpace AI agent")
                .setContentText(text)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("CodeSpace AI agent")
                .setContentText(text)
                .setOngoing(true)
                .build()
        }
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }
}
