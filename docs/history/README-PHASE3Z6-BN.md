# My Chat Agent v3 — Phase 3Z6

## নতুন কী
- Send চাপার সঙ্গে সঙ্গে সরু, monochrome activity line দেখা যাবে।
- Project memory বা attachment প্রস্তুত হওয়ার সময়ও line দেখা যাবে।
- আসল user message যোগ হলে line-টি ওই message-এর নিচে চলে যাবে।
- খুব দ্রুত উত্তর এলেও spinner অন্তত 650 ms চলবে, যাতে বোঝা যায় AI কাজ করছে। Final answer দেরি করা হয় না।
- status-এ শুধু ছোট শব্দ থাকবে: `Thinking`, `Working`, `Reviewing`, `Done`, `Failed`, `Stopped`।
- প্রস্তুতির সময় একই message একাধিকবার পাঠানো বন্ধ থাকবে।

## Setup
1. বর্তমান project-এর backup নিন।
2. এই ZIP-এর সব ফাইল একসঙ্গে extract/replace করুন; শুধু HTML বদলাবেন না।
3. `agent-server.js` restart করুন এবং browser reload করুন।
4. PWA install করা থাকলে নতুন service-worker version activate হওয়ার জন্য page একবার reload করুন।

## পরীক্ষা
- Project regression: 89/89 checks passed.
- OpenCode bridge mock test: 4/4 passed.
- বাস্তব provider/browser end-to-end test চালানো হয়নি।
