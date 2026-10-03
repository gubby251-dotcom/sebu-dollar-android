import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

initializeApp({
  credential: applicationDefault(),
});

const auth = getAuth();

const result =
  await auth.projectConfigManager().updateProjectConfig({
    mobileLinksConfig: {
      domain: "HOSTING_DOMAIN",
    },
  });

console.log("======================================");
console.log("Firebase Mobile Links berhasil diatur");
console.log("Domain:", result.mobileLinksConfig?.domain);
console.log("======================================");
