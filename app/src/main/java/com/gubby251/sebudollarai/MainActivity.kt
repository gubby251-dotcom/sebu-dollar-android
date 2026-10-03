package com.gubby251.sebudollarai

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.auth.ActionCodeSettings
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    private val prefs by lazy {
        getSharedPreferences("sebu_auth", MODE_PRIVATE)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        auth = FirebaseAuth.getInstance()
        firestore = FirebaseFirestore.getInstance()

        if (handleEmailLink(intent)) return

        continueWithCurrentUser()
    }

    private fun continueWithCurrentUser() {
        val user = auth.currentUser

        if (user == null) {
            showLoginScreen()
        } else {
            checkMemberAccess(user.uid)
        }
    }

    private fun showLoginScreen(message: String? = null) {

        val scroll = ScrollView(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(40, 70, 40, 40)
            setBackgroundColor(Color.rgb(18, 18, 18))
        }

        val title = TextView(this).apply {
            text = "SEBU DOLLAR AI"
            textSize = 26f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }

        root.addView(
            title,
            LinearLayout.LayoutParams(-1, -2)
        )

        val subtitle = TextView(this).apply {
            text = "Member Access"
            textSize = 18f
            setTextColor(Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(0, 10, 0, 35)
        }

        root.addView(
            subtitle,
            LinearLayout.LayoutParams(-1, -2)
        )

        val email = EditText(this).apply {
            hint = "Email member"
            textSize = 16f
            setSingleLine(true)

            inputType =
                InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS

            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setPadding(25, 0, 25, 0)
        }

        root.addView(
            email,
            LinearLayout.LayoutParams(-1, 58.dp()).apply {
                bottomMargin = 18.dp()
            }
        )

        val button = Button(this).apply {
            text = "KIRIM LINK LOGIN"
            textSize = 15f
            isAllCaps = false
        }

        root.addView(
            button,
            LinearLayout.LayoutParams(-1, 58.dp()).apply {
                bottomMargin = 18.dp()
            }
        )

        val info = TextView(this).apply {
            text =
                message
                    ?: "Masukkan email yang sudah diberikan akses oleh admin.\n" +
                       "Link login akan dikirim ke email tanpa password."

            textSize = 14f
            setTextColor(Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(10, 10, 10, 10)
        }

        root.addView(
            info,
            LinearLayout.LayoutParams(-1, -2)
        )

        button.setOnClickListener {

            val address = email.text.toString().trim()

            if (
                address.isEmpty() ||
                !android.util.Patterns.EMAIL_ADDRESS.matcher(address).matches()
            ) {
                email.error = "Masukkan email yang valid"
                return@setOnClickListener
            }

            button.isEnabled = false

            sendLoginLink(
                address,
                button,
                info
            )
        }

        scroll.addView(root)

        setContentView(scroll)
    }

    private fun sendLoginLink(
        email: String,
        button: Button,
        info: TextView
    ) {

        val actionCodeSettings =
            ActionCodeSettings.newBuilder()
                .setUrl(
                    "https://sebu-dollar-ai.firebaseapp.com/finishSignUp"
                )
                .setHandleCodeInApp(true)
                .setAndroidPackageName(
                    packageName,
                    true,
                    "1"
                )
                .build()

        auth.sendSignInLinkToEmail(
            email,
            actionCodeSettings
        ).addOnCompleteListener { task ->

            button.isEnabled = true

            if (task.isSuccessful) {

                prefs.edit()
                    .putString("pending_email", email)
                    .apply()

                info.text =
                    "Link login sudah dikirim ke:\n" +
                    "$email\n\n" +
                    "Buka email tersebut dan tekan link login."

                Toast.makeText(
                    this,
                    "Link login terkirim",
                    Toast.LENGTH_LONG
                ).show()

            } else {

                info.text =
                    "Gagal mengirim link login.\n" +
                    (
                        task.exception?.localizedMessage
                            ?: "Periksa koneksi dan konfigurasi Firebase."
                    )
            }
        }
    }

    private fun handleEmailLink(intent: Intent?): Boolean {

        val link =
            intent?.data?.toString()
                ?: return false

        if (!auth.isSignInWithEmailLink(link)) {
            return false
        }

        val savedEmail =
            prefs.getString(
                "pending_email",
                null
            )

        if (savedEmail.isNullOrBlank()) {

            showEmailForLinkDialog(link)

        } else {

            completeEmailLinkSignIn(
                savedEmail,
                link
            )
        }

        return true
    }

    private fun showEmailForLinkDialog(link: String) {

        val input = EditText(this).apply {

            hint = "Email yang menerima link"

            inputType =
                InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        }

        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Konfirmasi Email")
            .setMessage(
                "Masukkan email yang menerima link login ini."
            )
            .setView(input)
            .setPositiveButton("LOGIN") { _, _ ->

                val email =
                    input.text.toString().trim()

                if (email.isBlank()) {

                    Toast.makeText(
                        this,
                        "Email wajib diisi",
                        Toast.LENGTH_LONG
                    ).show()

                } else {

                    prefs.edit()
                        .putString(
                            "pending_email",
                            email
                        )
                        .apply()

                    completeEmailLinkSignIn(
                        email,
                        link
                    )
                }
            }
            .setNegativeButton(
                "BATAL",
                null
            )
            .show()
    }

    private fun completeEmailLinkSignIn(
        email: String,
        link: String
    ) {

        auth.signInWithEmailLink(
            email,
            link
        ).addOnCompleteListener { task ->

            if (task.isSuccessful) {

                prefs.edit()
                    .remove("pending_email")
                    .apply()

                auth.currentUser?.let {
                    checkMemberAccess(it.uid)
                }

            } else {

                auth.signOut()

                showLoginScreen(
                    "Link login tidak valid atau sudah kedaluwarsa. " +
                    "Silakan minta link baru."
                )
            }
        }
    }

    private fun checkMemberAccess(uid: String) {

        firestore
            .collection("members")
            .document(uid)
            .get()
            .addOnSuccessListener { doc ->

                val active =
                    doc.exists() &&
                    doc.getString("status")
                        ?.uppercase() == "ACTIVE"

                if (active) {

                    enterAi()

                } else {

                    FirebaseMessaging
                        .getInstance()
                        .unsubscribeFromTopic(
                            "sebu_signal_users"
                        )

                    auth.signOut()

                    showLoginScreen(
                        "Akun ini belum mendapat akses ACTIVE dari admin."
                    )
                }
            }
            .addOnFailureListener { error ->

                FirebaseMessaging
                    .getInstance()
                    .unsubscribeFromTopic(
                        "sebu_signal_users"
                    )

                auth.signOut()

                showLoginScreen(
                    "Tidak dapat memeriksa akses member.\n" +
                    (
                        error.localizedMessage
                            ?: "Periksa koneksi dan Firestore Rules."
                    )
                )
            }
    }

    private fun enterAi() {

        FirebaseMessaging
            .getInstance()
            .subscribeToTopic(
                "sebu_signal_users"
            )

        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {

            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.POST_NOTIFICATIONS
                ),
                100
            )
        }

        webView = WebView(this)

        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.loadsImagesAutomatically = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = true
        webView.settings.mediaPlaybackRequiresUserGesture = false

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()

        webView.loadUrl(
            "file:///android_asset/index.html"
        )
    }

    override fun onNewIntent(intent: Intent?) {

        super.onNewIntent(intent)

        setIntent(intent)

        if (handleEmailLink(intent)) {
            return
        }
    }

    override fun onSaveInstanceState(
        outState: Bundle
    ) {

        if (::webView.isInitialized) {
            webView.saveState(outState)
        }

        super.onSaveInstanceState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {

        if (
            ::webView.isInitialized &&
            webView.canGoBack()
        ) {

            webView.goBack()

        } else {

            super.onBackPressed()
        }
    }

    private fun Int.dp(): Int {

        return (
            this *
            resources.displayMetrics.density
        ).toInt()
    }
}
