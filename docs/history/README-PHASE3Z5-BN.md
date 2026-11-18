# My Chat Agent v3 — Phase 3Z5 বাংলা নির্দেশিকা

## কী পরিবর্তন হয়েছে

- AI কাজ করার সময় নতুন reply, tool update, এবং activity line-এর অবস্থান স্বয়ংক্রিয়ভাবে সাম্প্রতিক message-এর সঙ্গে থাকবে।
- সর্বশেষ reply নিচের edge/composer-এর সঙ্গে লেগে না থেকে একটু উপরে থাকবে; এর জন্য chat-এর নিচে responsive ফাঁকা জায়গা রাখা হয়েছে।
- Single Agent, Multi-agent এবং OpenCode CLI—সব mode-এ একই আচরণ প্রযোজ্য।
- আপনি পুরনো message পড়তে wheel/touch/keyboard দিয়ে উপরে scroll করলে auto-follow বন্ধ হবে। চলমান turn-এর সময় আবার নিচে ফিরলে follow আবার চালু হবে।
- কাজ শেষ হলে auto-follow lifecycle বন্ধ হবে, কিন্তু final reply দৃশ্যমান থাকবে।
- PWA cache version বদলানো হয়েছে, যাতে browser পুরনো chat UI cache করে না রাখে।

## ব্যবহার

1. আগের project-এর backup রাখুন।
2. ZIP extract করে project-এর সব ফাইল একসঙ্গে ব্যবহার করুন। শুধু HTML বদলালে server/PWA-এর আগের ফাইলের সঙ্গে version mismatch হতে পারে।
3. Server restart করুন এবং browser-এ reload করুন। PWA ব্যবহার করলে নতুন service-worker cache version চালু হতে দিন।
4. একটি দীর্ঘ request দিন এবং দেখুন নতুন output আসার সঙ্গে chat নিজে latest activity অনুসরণ করছে কি না। পুরনো message পড়তে উপরে scroll করে behavior-টিও পরীক্ষা করুন।

## Test result

- Project regression checks: **85/85 passed**
- OpenCode bridge mock tests: **4/4 passed**
- Inline JavaScript syntax: **passed**
- Live browser/provider end-to-end test চালানো হয়নি।
