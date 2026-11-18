# CodeSpace Browser Session Update — বাংলা

এই আপডেটে Agent Chrome-এর launch configuration স্বাভাবিক করা হয়েছে।

- `--disable-extensions` এবং `--disable-background-networking` সরানো হয়েছে।
- User-agent বা timezone override করা হয় না; browser identity নকল করার চেষ্টা নেই।
- Settings-এ persistent profile চালু থাকলে profile `CodeSpaceData`/configured app data directory-তে রাখা হয়, তাই একই CodeSpace install-এ cookies পুনরায় ব্যবহার করা সম্ভব।
- Cloudflare verification এলে দৃশ্যমান browser-এ ব্যবহারকারীকে নিজে challenge সম্পন্ন করতে হবে। CAPTCHA bypass করা হয় না।

## ব্যবহার

1. বর্তমান CodeSpace folder backup করুন।
2. নতুন ZIP-এর ফাইলগুলো একসঙ্গে replace করুন।
3. CodeSpace ও Chrome/Edge সম্পূর্ণ বন্ধ করে পুনরায় চালু করুন।
4. Settings-এ `Show a real browser window` এবং `Remember cookies and logins` চালু আছে কি না দেখুন।
5. একই persistent CodeSpace browser profile ব্যবহার করুন; profile folder মুছে ফেলবেন না।

## সীমাবদ্ধতা

এই পরিবর্তনগুলো অপ্রয়োজনীয় browser flags ও spoofing সরায়, কিন্তু Cloudflare challenge আর কখনো আসবে না—এমন নিশ্চয়তা দেয় না। Cloudflare সিদ্ধান্ত IP reputation, site policy, account state, browser signals এবং অন্যান্য server-side কারণের ওপরও নির্ভর করে। VS Code-এর Integrated Browser-এর implementation CodeSpace-এর Chrome/CDP browser থেকে আলাদা হতে পারে।
