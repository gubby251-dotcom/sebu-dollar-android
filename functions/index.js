const { onCall, HttpsError } =
  require("firebase-functions/v2/https");

const { initializeApp } =
  require("firebase-admin/app");

const { getAuth } =
  require("firebase-admin/auth");

const {
  getFirestore,
  FieldValue
} = require("firebase-admin/firestore");

initializeApp();

const ADMIN_UID =
  "ilhY96UDI3W9n4Qir4v78nu8G9x2";

exports.createMember = onCall(
  {
    region: "asia-southeast2"
  },

  async (request) => {

    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Admin login diperlukan."
      );
    }

    if (request.auth.uid !== ADMIN_UID) {
      throw new HttpsError(
        "permission-denied",
        "Hanya admin yang dapat membuat member."
      );
    }

    const email =
      String(request.data?.email || "")
        .trim()
        .toLowerCase();

    const password =
      String(request.data?.password || "");

    if (!email || !email.includes("@")) {
      throw new HttpsError(
        "invalid-argument",
        "Email member tidak valid."
      );
    }

    if (password.length < 6) {
      throw new HttpsError(
        "invalid-argument",
        "Password minimal 6 karakter."
      );
    }

    try {

      const user =
        await getAuth().createUser({
          email: email,
          password: password,
          emailVerified: false,
          disabled: false
        });

      await getFirestore()
        .collection("members")
        .doc(user.uid)
        .set({
          email: email,
          status: "ACTIVE",
          createdAt:
            FieldValue.serverTimestamp(),
          createdBy: ADMIN_UID
        });

      return {
        success: true,
        uid: user.uid,
        email: email,
        status: "ACTIVE"
      };

    } catch (error) {

      if (
        error?.code ===
        "auth/email-already-exists"
      ) {
        throw new HttpsError(
          "already-exists",
          "Email tersebut sudah terdaftar."
        );
      }

      console.error(
        "createMember error:",
        error
      );

      throw new HttpsError(
        "internal",
        "Gagal membuat member."
      );
    }
  }
);
