# Turning on accounts & friends (owner setup, ~10 minutes)

Cadence's accounts, friends and profile pictures run on a free Firebase project that **you** own. Nothing is switched on until you create it and paste five values into the app. Users never see any of this — they just get a **Continue with Google** button.

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with your Google account.
2. **Create a project** → name it `cadence` (any name works) → you can turn Google Analytics off → **Create**.

## 2. Turn on Google sign-in

1. In the left menu: **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Google** → toggle **Enable** → pick a support email → **Save**.
   (Firebase creates the Google OAuth client for you. Nothing to do in Google Cloud.)
3. **Settings** tab → **Authorized domains** → **Add domain** → `mowke.github.io`.
   That's where Cadence's sign-in page lives.

## 3. Turn on the database (and, optionally, storage for uploaded pictures)

1. **Build → Firestore Database → Create database** → keep the default location → start in **production mode** → **Create**.
2. **Rules** tab → delete everything → paste the whole contents of [`cloud/firestore.rules`](cloud/firestore.rules) → **Publish**.
3. *Optional — uploaded profile pictures.* Firebase now requires the **Blaze** (pay-as-you-go, still free at this scale) plan before Storage can be created on a new project. Skip this and people simply keep their Google photo. If you do enable it: **Build → Storage → Get started** → defaults → **Done**, then its **Rules** tab → paste [`cloud/storage.rules`](cloud/storage.rules) → **Publish**, and fill `storageBucket` in the config. Leave `storageBucket` empty otherwise.

## 4. Copy the config into Cadence

1. Click the **gear next to Project Overview → Project settings**.
2. Scroll to **Your apps** → click the **`</>`** (Web) icon → nickname `cadence` → **Register app** (skip Hosting).
3. You'll see a `firebaseConfig` block. Copy these values into `src/cloud-config.json`:

```json
{
  "apiKey":        "…copy apiKey…",
  "authDomain":    "…copy authDomain…",
  "projectId":     "…copy projectId…",
  "storageBucket": "…copy storageBucket…",
  "authPage":      "https://mowke.github.io/cadence/auth.html"
}
```

(The apiKey is fine to ship — it identifies the project; the rules you pasted are what protect the data.)

4. Commit, push, tag a release. From that build on, **Continue with Google** works.

## Seeing who signed up

Firebase console → **Authentication → Users** lists every account with sign-up date and last sign-in. **Firestore → users** has their display names and handles. Both are free-tier for a long, long time at this scale.

## Testing without a real project

`firebase.json` and the rules in `cloud/` let the Firebase emulators run locally:

```
npx firebase-tools@14 emulators:start --only auth,firestore,storage --project demo-cadence
CADENCE_CLOUD_EMULATOR=1 CADENCE_CLOUD_CONFIG=/path/to/test-config.json npm start
```
