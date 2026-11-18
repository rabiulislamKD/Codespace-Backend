# CodeSpace 3.8.3 — Embedded Browser Fix (বাংলা)

## Build
1. ZIP extract করো, পুরোনো CodeSpace বন্ধ করো।
2. Windows-এ Node.js 22+ থাকতে হবে। `BUILD-PORTABLE-EXE.bat` চালাও।
3. `release` folder-এ `CodeSpace-Portable-3.8.3.exe` তৈরি হবে।

## কী ঠিক হয়েছে
- Embedded browser চালু হওয়ার আগেই navigation/AI tool চালানোর সমস্যা (`dom-ready` অপেক্ষা) ঠিক করা হয়েছে।
- Website-এর link, নতুন tab ও sign-in popup এখন CodeSpace-এর ভেতরেই খোলে; আলাদা Chrome বা default browser খোলে না।
- Address bar-এ URL না লিখে search লিখলে search হয়; Ctrl+L, F5, Alt+←/→, F12 কাজ করে; right-click menu আছে।
- User agent থেকে শুধু `Electron/…` ও app-নামের অংশ সরানো হয়েছে।
- AI এখন real mouse click ব্যবহার করে।

## নতুন: Element chat-এ attach
Browser panel-এ যেকোনো element-এ **right-click → Attach element to chat** দাও। Composer-এ chip আসবে। Send করলে AI পাবে page URL, CSS selector, text, HTML (password সংগ্রহ হয় না), style, অবস্থান, আর vision model হলে element-এর screenshot। Website-এর লেখা "untrusted" হিসেবে চিহ্নিত থাকে।

## সীমাবদ্ধতা
- Cloudflare/CAPTCHA bypass করা হয় না। Challenge এলে panel-এ নিজে complete করো। User agent পরিষ্কার করলে কিছু block কমে, কিন্তু Cloudflare সব ক্ষেত্রে ছেড়ে দেবে—এমন নিশ্চয়তা নেই।
- Windows Electron-এ বাস্তব build/test এই পরিবেশে চালানো যায়নি; build করে test করতে হবে।
- শুধু HTML browser-এ খুললে (EXE ছাড়া) Agent Chrome আলাদা Chrome-ই খুলবে। Embedded browser পেতে desktop app ব্যবহার করো।
