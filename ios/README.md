# Yun's Reader · iOS (native SwiftUI)

A native iOS rewrite — **no Python backend**. Translation calls Gemini directly
from the device (your key, nothing bundled); read-aloud uses the OS speech
engine (offline). This is an early **MVP**: open a PDF, select text → bilingual
translation, read a selection aloud, set your API key.

> ⚠️ Built and committed without Xcode on the build machine, so it has **not been
> compiled yet**. Once Xcode is installed, the next step is a compile-fix + run
> in the iOS Simulator.

## Prerequisites
1. **Install Xcode** from the Mac App Store (~10 GB).
2. (Recommended) `brew install xcodegen` to generate the project from `project.yml`.

## Build & run
```bash
cd ios
xcodegen generate          # creates YunsReader.xcodeproj from project.yml
open YunsReader.xcodeproj   # then ⌘R to run in the Simulator
```
No XcodeGen? In Xcode: **File → New → Project → iOS → App** (SwiftUI, name
`YunsReader`), delete the template `ContentView`/`App` files, then drag in
everything under `ios/YunsReader/` (including `Assets.xcassets` and `Info.plist`),
and set the app icon to `AppIcon`.

### Run on your iPhone
In Xcode → target **Signing & Capabilities** → check *Automatically manage
signing* and pick your Apple ID team (free works; 7-day re-sign). Plug in the
iPhone, select it as the run destination, ⌘R.

## Files
- `YunsReaderApp.swift` — app entry.
- `ContentView.swift` — reader screen, toolbar, translate/read action bar.
- `PDFReader.swift` — PDFKit viewer + text selection (`PDFController`).
- `GeminiService.swift` — direct Gemini REST (translate / summarize).
- `SpeechService.swift` — offline read-aloud (AVSpeechSynthesizer).
- `TranslationView.swift` — bilingual result sheet.
- `SettingsView.swift` — Gemini API key entry.
- `Theme.swift` — 昀氏閱讀 concrete + vermilion palette.

## Not yet ported (desktop-only / later phases)
- Notes + shareable cards (next: SwiftData + native ShareLink/ImageRenderer).
- Whole-book audiobook export (use AVSpeech offline; native).
- Zotero (desktop reads the local DB; iOS would use the **Zotero Web API** + key).
