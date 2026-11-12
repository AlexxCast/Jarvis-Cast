# How to Install and Run JarvisFit (Android & iOS)

This guide provides step-by-step instructions in English on how to download, install, and run **JarvisFit** on both **Android** and **Apple iPhone (iOS)** devices.

---

## 📱 PART 1: Installing on Android (Ready-to-Use APK)

You do **not** need Android Studio or any developer tools to install JarvisFit on your Android phone. A pre-compiled installer package (`APK`) is already built and ready.

### Step 1: Download the APK
- Download the installer file:
  👉 **[`app-debug.apk`](file:///d:/Esame%20magistrale/JarvisFit/app/build/outputs/apk/debug/app-debug.apk)** (located at `d:\Esame magistrale\JarvisFit\app\build\outputs\apk\debug\app-debug.apk`).
- Transfer or send this file to your Android phone (via USB cable, Google Drive, WhatsApp, Telegram, or email).

### Step 2: Allow Unknown Sources
When opening the `.apk` file on your Android phone for the first time:
1. Tap the downloaded file.
2. If Android prompts *"For your security, your phone is not allowed to install unknown apps from this source"*, tap **Settings**.
3. Toggle on **"Allow from this source"** (this is standard for installing applications outside the Google Play Store).
4. Go back and tap **Install**.

### Step 3: Grant Permissions on First Launch
When you open **JarvisFit**:
1. **Microphone**: Allow permission so Jarvis can listen to your voice.
2. **Camera & Photos**: Allow permission to photograph meals and your pantry/fridge.
3. **Battery Optimization**: Tap *"Allow"* when asked to exclude JarvisFit from battery optimization (this keeps Jarvis listening in the background when the phone screen is off).
4. Go to **Profile**, enter your free **Google Gemini API Key** (from [Google AI Studio](https://aistudio.google.com/)), and tap **Salva Profilo**.

---

## 🍏 PART 2: Installing on iPhone / iOS (Apple)

Due to Apple's security policies, native iOS apps outside the App Store must be installed via **Xcode** (free with an Apple ID) or via **AltStore / Sideloadly**.

### Method A: Install via Xcode (Recommended, Official Apple Way)

#### What You Need:
- A Mac computer (or a virtual macOS machine/cloud Mac) with **Xcode** installed (free from the Mac App Store).
- A Lightning / USB-C cable to connect your iPhone.
- Your free personal Apple ID.

#### Step-by-Step Instructions:
1. **Copy the iOS Project Folder**:
   - Copy the folder **[`apple/`](file:///d:/Esame%20magistrale/JarvisFit/apple)** to your Mac.
2. **Open the Project in Xcode**:
   - Launch Xcode on your Mac.
   - Click **File > Open...** and select the `apple` folder (or open `JarvisFit.swift` / `Package.swift`).
3. **Connect Your iPhone**:
   - Connect your iPhone to your Mac via USB cable.
   - Unlock your iPhone and tap **"Trust This Computer"** if prompted.
   - In Xcode's top toolbar, click the device selector and choose your connected iPhone instead of a simulator.
4. **Configure Code Signing (Free Apple Developer)**:
   - In the left sidebar, click the top **JarvisFit** project icon.
   - Select the **Signing & Capabilities** tab.
   - Under **Team**, select your personal Apple ID (e.g., *"Your Name (Personal Team)"*). If not listed, click *"Add an Account..."* and sign in with your standard Apple ID.
   - Xcode will automatically generate a free developer certificate.
5. **Install on iPhone**:
   - Press the **Play (Run)** button or press `Cmd + R`.
   - Xcode will build the project and install **JarvisFit** directly onto your iPhone home screen!
6. **Trust the Developer Profile on iPhone**:
   - On your iPhone, go to **Settings > General > VPN & Device Management**.
   - Tap your Apple ID under *Developer App* and tap **"Trust [Your Apple ID]"**.
   - Open **JarvisFit** from your home screen and enjoy!

---

### Method B: Install via AltStore or Sideloadly (Without a Mac)

If you do not have a Mac, you can install the app directly from a Windows PC:
1. Download and install **Sideloadly** or **AltStore** on your Windows PC (both are free).
2. Connect your iPhone to your Windows PC with iTunes or Apple Devices installed.
3. Package or export the `JarvisFit` iOS app into an `.ipa` file using Xcode or a free CI/CD service (like GitHub Actions).
4. Drag and drop the `.ipa` into Sideloadly, enter your Apple ID, and click **Start**. The app will be installed on your iPhone.

---

## ⚙️ Initial Setup & Language Selection

1. **Google Gemini API Key**:
   - Get a free key in 30 seconds at [Google AI Studio](https://aistudio.google.com/app/apikey).
   - In JarvisFit, open the **Profile** tab, paste the key into the API Key field, and save.
2. **English Language on iPhone**:
   - In the **Profile** tab, scroll to **App Language** and select **English 🇬🇧**.
   - All tabs, displays, units, speech synthesis (deep British voice), and speech recognition will immediately switch to English!
