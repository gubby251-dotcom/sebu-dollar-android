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

        private const val TOPIC =
            "sebu_signal_users"

        private const val CHANNEL_ID =
            "sebu_signal_channel_v2"
    }


    override fun onMessageReceived(
        message: RemoteMessage
    ) {

        /*
         * Ambil data signal dari reliable scanner.
         */
        val title =
            message.data["title"]
                ?: message.notification?.title
                ?: "SEBU DOLLAR AI"


        val body =
            message.data["body"]
                ?: message.notification?.body
                ?: "Signal baru diterima"


        /*
         * =====================================================
         * RELIABLE SCANNER → MAIN ACTIVITY
         * =====================================================
         *
         * Data Entry / SL / TP / Setup / Timeframe
         * dikirim langsung ke MainActivity.
         *
         * Tidak ada validasi ulang di sini.
         */
        if (message.data.isNotEmpty()) {

            MainActivity.receiveNativeSignal(
                message.data
            )
        }


        /*
         * =====================================================
         * NOTIFICATION
         * =====================================================
         *
         * Sistem notifikasi dan suara tetap digunakan.
         */
        showNotification(
            title,
            body,
            message.data
        )
    }


    override fun onNewToken(
        token: String
    ) {

        super.onNewToken(token)

        /*
         * Tetap subscribe ke topic signal.
         */
        FirebaseMessaging
            .getInstance()
            .subscribeToTopic(
                TOPIC
            )
    }


    private fun showNotification(
        title: String,
        body: String,
        data: Map<String, String> = emptyMap()
    ) {

        /*
         * Android 8+
         */
        createNotificationChannel()


        /*
         * Intent menuju MainActivity.
         *
         * Data signal ikut dibawa supaya ketika
         * user menekan notification, MainActivity
         * tetap bisa menerima signal tersebut.
         */
        val intent =
            Intent(
                this,
                MainActivity::class.java
            ).apply {

                flags =
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP


                for (
                    (key, value)
                    in data
                ) {

                    putExtra(
                        key,
                        value
                    )
                }
            }


        val pendingIntent =
            PendingIntent.getActivity(
                this,
                1001,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or
                PendingIntent.FLAG_IMMUTABLE
            )


        /*
         * Notification.
         */
        val builder =
            NotificationCompat
                .Builder(
                    this,
                    CHANNEL_ID
                )
                .setSmallIcon(
                    applicationInfo.icon
                )
                .setContentTitle(
                    title
                )
                .setContentText(
                    body
                )
                .setStyle(
                    NotificationCompat
                        .BigTextStyle()
                        .bigText(body)
                )
                .setPriority(
                    NotificationCompat
                        .PRIORITY_HIGH
                )
                .setCategory(
                    NotificationCompat
                        .CATEGORY_ALARM
                )
                .setAutoCancel(
                    true
                )
                .setContentIntent(
                    pendingIntent
                )
                .setVibrate(
                    longArrayOf(
                        0,
                        500,
                        250,
                        500
                    )
                )


        /*
         * Android lama:
         * gunakan default notification sound.
         *
         * Android 8+:
         * sound dikontrol oleh Notification Channel.
         */
        if (Build.VERSION.SDK_INT < 26) {

            builder.setDefaults(
                android.app.Notification.DEFAULT_SOUND
            )
        }


        /*
         * Tampilkan notification.
         */
        if (
            Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        ) {

            NotificationManagerCompat
                .from(this)
                .notify(
                    System.currentTimeMillis()
                        .toInt(),
                    builder.build()
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


        /*
         * Jangan membuat channel baru.
         * Tetap gunakan channel v2 yang sekarang.
         */
        val existing =
            manager.getNotificationChannel(
                CHANNEL_ID
            )


        if (existing != null) {

            return
        }


        val soundUri =
            android.media.RingtoneManager
                .getDefaultUri(
                    android.media.RingtoneManager
                        .TYPE_NOTIFICATION
                )


        val audioAttributes =
            AudioAttributes.Builder()
                .setUsage(
                    AudioAttributes
                        .USAGE_NOTIFICATION
                )
                .setContentType(
                    AudioAttributes
                        .CONTENT_TYPE_SONIFICATION
                )
                .build()


        val channel =
            NotificationChannel(
                CHANNEL_ID,
                "SEBU DOLLAR AI Signal",
                NotificationManager
                    .IMPORTANCE_HIGH
            ).apply {

                description =
                    "Notifikasi signal SEBU DOLLAR AI"

                enableVibration(
                    true
                )

                vibrationPattern =
                    longArrayOf(
                        0,
                        500,
                        250,
                        500
                    )

                setSound(
                    soundUri,
                    audioAttributes
                )
            }


        manager.createNotificationChannel(
            channel
        )
    }
}
