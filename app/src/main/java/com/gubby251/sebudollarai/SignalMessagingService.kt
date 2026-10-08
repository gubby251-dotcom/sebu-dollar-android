package com.gubby251.sebudollarai

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class SignalMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TOPIC = "sebu_signal_users"
        private const val CHANNEL_ID = "sebu_signal_channel_v2"
    }

    override fun onMessageReceived(message: RemoteMessage) {

        val title = message.data["title"]
            ?: message.notification?.title
            ?: "SEBU DOLLAR AI"

        val body = message.data["body"]
            ?: message.notification?.body
            ?: "Signal baru diterima"

        /*
         * KIRIM SIGNAL SCANNER KE MAIN ACTIVITY
         *
         * Tidak mengubah logika scanner.
         * Tidak menghitung ulang Entry / SL / TP.
         * Data yang dikirim adalah data asli dari reliable scanner.
         */
        if (message.data.isNotEmpty()) {
            MainActivity.receiveNativeSignal(
                message.data
            )
        }

        /*
         * NOTIFIKASI TETAP SAMA
         */
        showNotification(
            title,
            body,
            message.data
        )
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)

        FirebaseMessaging
            .getInstance()
            .subscribeToTopic(TOPIC)
    }

    private fun showNotification(
        title: String,
        body: String,
        data: Map<String, String> = emptyMap()
    ) {

        if (
            Build.VERSION.SDK_INT >=
            Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        createNotificationChannel()

        val intent = Intent(
            this,
            MainActivity::class.java
        ).apply {

            flags =
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP

            /*
             * Simpan seluruh data scanner ke Intent.
             *
             * Ini penting ketika aplikasi berada
             * di background / notification ditekan.
             */
            for ((key, value) in data) {
                putExtra(key, value)
            }
        }

        val pendingIntent =
            PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or
                PendingIntent.FLAG_IMMUTABLE
            )

        val notification =
            NotificationCompat.Builder(
                this,
                CHANNEL_ID
            )
                .setSmallIcon(
                    android.R.drawable.ic_dialog_info
                )
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(
                    NotificationCompat.BigTextStyle()
                        .bigText(body)
                )
                .setPriority(
                    NotificationCompat.PRIORITY_HIGH
                )
                .setCategory(
                    NotificationCompat.CATEGORY_ALARM
                )
                .setAutoCancel(true)
                .setVibrate(
                    longArrayOf(
                        0,
                        300,
                        150,
                        300
                    )
                )
                .setContentIntent(
                    pendingIntent
                )
                .build()

        if (
            NotificationManagerCompat
                .from(this)
                .areNotificationsEnabled()
        ) {

            NotificationManagerCompat
                .from(this)
                .notify(
                    (
                        System.currentTimeMillis()
                        and 0x7FFFFFFF
                    ).toInt(),
                    notification
                )
        }
    }

    private fun createNotificationChannel() {

        if (
            Build.VERSION.SDK_INT <
            Build.VERSION_CODES.O
        ) {
            return
        }

        val manager =
            getSystemService(
                Context.NOTIFICATION_SERVICE
            ) as NotificationManager

        if (
            manager.getNotificationChannel(
                CHANNEL_ID
            ) != null
        ) {
            return
        }

        val channel =
            NotificationChannel(
                CHANNEL_ID,
                "Notifikasi Signal",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {

                description =
                    "Notifikasi signal SEBU DOLLAR AI"

                enableVibration(true)

                vibrationPattern =
                    longArrayOf(
                        0,
                        300,
                        150,
                        300
                    )

                setSound(
                    android.provider.Settings
                        .System
                        .DEFAULT_NOTIFICATION_URI,
                    AudioAttributes.Builder()
                        .setUsage(
                            AudioAttributes
                                .USAGE_NOTIFICATION
                        )
                        .build()
                )
            }

        manager.createNotificationChannel(
            channel
        )
    }
}
