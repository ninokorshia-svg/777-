# სისტემის ადმინისტრირებისა და Cloudflare D1 განთავსების სახელმძღვანელო

ეს დოკუმენტი შეიცავს დეტალურ ინსტრუქციებს აპლიკაციის **"ფიზიკის ინტერაქტიული ქვიზი და მასწავლებლის პანელი"** უსაფრთხო ადმინისტრირების, Cloudflare Workers & D1-ზე განთავსების, სარეზერვო ასლების (Backup) და მიგრაციის შესახებ.

---

## 1. მასწავლებელთა რეგისტრაციის უსაფრთხოება (Enrollment Security)

### პრობლემა და გადაჭრის მექანიზმი
აპლიკაციაში წინასწარ განსაზღვრულია მასწავლებელთა იდენტიფიკატორები `Teachers1`–`Teachers100`. ანგარიშების არაავტორიზებული მიტაცების (Account Takeover) თავიდან ასაცილებლად:
- პირველადი რეგისტრაციისას სისტემა მოითხოვს **ადმინისტრატორის საიდუმლო გასაღებს** (`TEACHER_ENROLLMENT_SECRET`).
- თუ გარემოს ცვლადებში გასაღები დაკონფიგურირებული არ არის, `/api/teacher/setup-password` ენდპოინტი **უარყოფს რეგისტრაციას (HTTP 503 Service Unavailable)**.
- რეგისტრაციის გასაღების შედარება ხდება მუდმივი დროის შედარებით (`constantTimeCompare`), რათა გამოირიცხოს დროითი შეტევები (Timing Attacks).
- რეგისტრაციაზე დაწესებულია IP და ანგარიშის ბრუტფორს-ლიმიტირება (Rate Limiting).
- პაროლის ჩაწერა ხდება ატომური შემოწმებით (`UPDATE ... WHERE is_initialized = 0`), რაც გამორიცხავს Race Condition-ს პარალელური მოთხოვნებისას.

### კონფიგურაცია
ადმინისტრატორმა უნდა დააყენოს გარემოს ცვლადი:
```bash
# Cloudflare Workers Secret-ის დამატება:
wrangler secret put TEACHER_ENROLLMENT_SECRET
# შეიყვანეთ მინიმუმ 16-სიმბოლოიანი რთული გასაღები, მაგ.:
# GeoPhysicsSecureAdminKey2026!#
```

ადმინისტრატორი პირადად გადასცემს ამ გასაღებს მასწავლებელს, რომელიც პირველად რეგისტრირდება თავის ანგარიშში (`Teachers1`–`Teachers100`).

---

## 2. სესიების უსაფრთხოება და CSRF დაცვა

- **HttpOnly Cookies**: ავტორიზაციის ტოკენები არასდროს ინახება JavaScript-ის მეხსიერებაში (`localStorage`/`sessionStorage`). ტოკენი გაიცემა ბრაუზერის `HttpOnly; SameSite=Lax; Secure` ქუქიში (`teacher_session`).
- **CSRF დაცვა**: ყველა მოდიფიცირებად მოთხოვნაზე (`POST /api/teacher/*`) მოწმდება `Origin` და `Referer` სათაურები, ასევე გამოიყენება Double-Submit CSRF Cookie (`csrf_token`).
- **სესიის ხანგრძლივობა**: ნაგულისხმევად 72 საათი (`SESSION_EXPIRATION_HOURS=72`). გასვლისას (`POST /api/teacher/logout`) ტოკენი დაუყოვნებლივ უქმდება ბაზაში.

---

## 3. ტესტის კითხვების, პასუხების და მოსწავლეთა მონაცემების დაცვა

- **კითხვების გასაღების იზოლაცია**: სწორი პასუხები არასდროს ჩნდება კლიენტის JS ბანდლში (`dist/assets/*.js`) ან საჯარო API-ში.
- **Server-Managed Attempt Flow**:
  - მოსწავლე იწყებს ტესტირებას `POST /api/student/start-attempt`-ით, იღებს სერვერულ `attemptToken`-ს.
  - კითხვაზე პასუხის გაცემისას (`POST /api/student/verify-answer`) სერვერი ატომურად იწერს პასუხს ბაზაში. კითხვაზე პასუხის შეცვლა ან სხვადასხვა ვარიანტების გამოცნობა (Brute-force Enumeration) დაბლოკილია (HTTP 409).
  - არასწორი პასუხისას სწორი პასუხი მოსწავლეს არ უბრუნდება მთლიანი ტესტის ჩაბარებამდე.
- **მოსწავლეთა პირადი ინფორმაციის დაცვა**:
  - `POST /api/student/check-status` არ აბრუნებს სხვა მოსწავლეთა ქულებს, ნიშნებს ან ნაშრომებს.
  - თუ მოსწავლეს უკვე შევსებული აქვს ტესტი, ეკრანზე ჩნდება მხოლოდ დაბლოკვის სტანდარტული შეტყობინება სხვების ქულების გაუმჟღავნებლად.

---

## 4. მონაცემთა ექსპორტი, სარეზერვო ასლები (Backup) და მიგრაცია

### ლოკალური ფაილების იზოლაცია
- `.gitignore` კონფიგურირებულია ისე, რომ `data/*.sqlite*`, `*.sqlite-wal`, `*.sqlite-shm`, და `*.db` არასდროს მოხვდეს Git-ში ან პროდუქციულ არქივში.

### Cloudflare D1 მონაცემთა ბაზის ინიციალიზაცია
```bash
# 1. D1 ბაზის შექმნა Cloudflare-ზე:
npx wrangler d1 create physics-quiz-db

# 2. Schema მიგრაციის გაშვება Cloudflare D1-ზე:
npx wrangler d1 execute physics-quiz-db --remote --file=./migrations/0001_initial_schema.sql

# 3. მასწავლებელთა საწყისი ანგარიშების (Teachers1-100) ჩაწერა:
npx wrangler d1 execute physics-quiz-db --remote --file=./migrations/0002_seed_teachers.sql
```

### სარეზერვო ასლის შექმნა (Backup) D1-დან
```bash
# D1 მონაცემთა ბაზის სრული ექსპორტი SQL ფაილში:
npx wrangler d1 export physics-quiz-db --remote --output=./backup_$(date +%Y%m%d).sql
```

### მასწავლებლის მიერ შედეგების ექსპორტი
მასწავლებლის სამართავ პანელში ხელმისაწვდომია:
- **CSV ექსპორტი** (`/api/teacher/export/:teacherCode?format=csv`): UTF-8 BOM კოდირებით, თავსებადია Microsoft Excel-თან და ქართულ ფონტებთან.
- **JSON ექსპორტი** (`/api/teacher/export/:teacherCode?format=json`).

---

## 5. Cloudflare Workers-ზე განთავსება (Deployment)

1. შეამოწმეთ `wrangler.jsonc` ფაილში `database_id`:
```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "physics-quiz-db",
    "database_id": "<თქვენი-d1-database-id>"
  }
]
```
2. პროექტის აწყობა და განთავსება:
```bash
npm run build
npx wrangler deploy
```
