# SubAI — גרסה אישית וחינמית (v5)

**הזרימה החדשה:**
```
Premiere (פלאגין) ──▶ subai-relay ב-Modal ──▶ subai-whisper (ה-Worker הקיים שלך, בלי שינוי)
        ▲                                              │
        └──────────── התמלול חוזר כמו שהוא ◀───────────┘
```

* **בלי** AWS S3, Vercel, Supabase, Firebase, Stripe, וגם **בלי** תיקון AI.
* האודיו נשמר זמנית ב-Modal (במקום אמזון) ונמחק מיד כשהתמלול מסתיים.
  התוצאה נמחקת אחרי שהכתוביות הוצבו בטיימליין.
* ה-Relay רץ על CPU בלבד, כך שהעלות שלו זניחה. העלות העיקרית היא GPU של Whisper,
  בדיוק כמו היום, והכול נכנס בקרדיט החודשי החינמי ($30) של Modal.

---

## התקנה (פעם אחת, כ-5 דקות)

### 1. Modal: יצירת סיסמה ופריסת ה-Relay
פתח CMD בתיקייה שבה שמרת את `subai_relay.py` (למשל שולחן העבודה, ליד `whisper_modal.py`):

```cmd
python -m modal secret create subai-relay SUBAI_TOKEN=<הסיסמה-שלך> WHISPER_URL=<כתובת-ה-Worker>
python -m modal deploy subai_relay.py
```

* `<כתובת-ה-Worker>` היא הכתובת של ה-Worker הקיים, אותה כתובת שהייתה ב-Vercel תחת `MODAL_ENDPOINT_URL`
  (נראית כמו `https://...--subai-whisper-whispertranscriber-transcribe.modal.run`).
* בסוף ה-deploy תופיע כתובת כזו: `https://yehudasnow--subai-relay-web.us-east.modal.run`.

### 2. הפלאגין, עם המתקין (`installer/install_SubAI_v5.bat`)
1. שים את הקבצים במבנה הזה: `install_SubAI_v5.bat`, ולידו תיקיית `files\` שמכילה את `index.html`, `jsx\host.jsx` ו-`CSXS\manifest.xml`
   (מ-`public/plugin-update/` ומ-`installer/CSXS/`).
2. סגור את Premiere והרץ את ה-bat. הוא ישאל את הסיסמה (SUBAI_TOKEN), יגבה את הגרסה הישנה ל-`backup_v4`,
   יעתיק את הגרסה החדשה ל-`%APPDATA%\Adobe\CEP\extensions\com.subai.cloud.panel\`
   ויכתוב `subai_config.json`, כך שהפלאגין נפתח כשהוא כבר מחובר.
3. פתח את Premiere > Window > Extensions > SubAI. מסמנים In/Out ולוחצים 🎙 תמלל.

התקנה ידנית בלי מתקין: מחליפים את `index.html` ואת `jsx\host.jsx` בתיקייה שלמעלה, ומכניסים את הסיסמה בלשונית **⚙️ הגדרות**.

> מגרסה 5 הפלאגין בודק עדכונים ישירות מ-GitHub (`public/plugin-update/version.json`), בלי צורך באתר.
> `host.jsx` הוא גרסה 4.4.0, עם תיקון ה-In/Out לפרמייר 2026. המנגנון לא יאפשר לעדכון להחזיר אותו לגרסה ישנה.

---

## שווה לדעת
* **קטעים ארוכים:** ב-`whisper_modal.py` מוגדר `timeout=300`, כלומר 5 דקות עיבוד, שזה בערך 25–30 דקות אודיו.
  לקטעים ארוכים יותר שנה ל-`timeout=1800` והרץ `python -m modal deploy whisper_modal.py`.
  ה-Relay עצמו מחכה עד שעה, כך שמגבלת 300 השניות של Vercel כבר לא קיימת.
* **אם הפאנל נסגר באמצע תמלול,** בפתיחה הבאה תופיע הצעה "♻️ תמלול קודם → הצב בטיימליין".
* **ביטחון:** בלי הסיסמה אי אפשר להעלות קבצים ל-Relay. כל קישור אודיו הוא חד-פעמי (מזהה אקראי של 192 ביט) ומת מיד בסוף המשימה.
* **כדי לא לשלם אף פעם:** ב-Modal, תחת Usage & Billing, הגדר Spend limit של 0, וכך לא ייגבה כלום מעבר לקרדיט החינמי.

## מה אפשר לסגור עכשיו
* **Supabase:** הפלאגין כבר לא משתמש בו, אפשר להשהות או למחוק את הפרויקט.
* **מפתח Anthropic:** אפשר למחוק את ה-API key ב-console.anthropic.com.
* **Vercel / הדומיין:** הפלאגין כבר לא תלוי באתר. Vercel Hobby חינמי, אז אפשר להשאיר אותו או למחוק.

## פקודות שימושיות
לוגים של ה-Relay:
```cmd
python -m modal app logs subai-relay
```
בדיקה שה-secret קיים:
```cmd
python -m modal secret list
```
