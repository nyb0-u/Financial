# Autocatat

Asisten pencatatan keuangan pribadi dengan dashboard web, akun multi-user, bot Telegram, kategorisasi transaksi, dan sinkronisasi opsional Google Sheets.

## Deploy ke Cloudflare Workers

Worker ini menyajikan dashboard dari Cloudflare Assets, menjalankan backend Node melalui kompatibilitas HTTP Cloudflare, dan menyimpan data persisten di Firebase Realtime Database. Penyimpanan lokal `data/store.json` hanya untuk mode Node lokal dan tidak dipakai di Worker.

1. Pastikan Firebase Realtime Database aktif. Buat Service Account dengan izin **Firebase Realtime Database Admin**, lalu simpan JSON key-nya sementara di komputer. Worker memakai JSON ini sebagai secret; jangan commit atau unggah file key ke folder `public/`.
2. Dari folder proyek, jalankan:
   ```powershell
   npm install
   npx wrangler login
   npm run cloudflare:deploy
   ```
3. Di Cloudflare Dashboard → **Workers & Pages** → Worker `autocatat` → **Settings → Variables and Secrets**, isi:
   - Variable `FIREBASE_DATABASE_URL`: URL Realtime Database dari Firebase Console.
   - Secret `FIREBASE_SERVICE_ACCOUNT_JSON`: seluruh isi JSON key Service Account Firebase.
   - Secret `ADMIN_SETUP_KEY`: kunci acak baru untuk membuat admin pertama.
   - Opsional: secret `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, dan `GOOGLE_SERVICE_ACCOUNT_JSON`; variables `TELEGRAM_BOT_USERNAME`, `GOOGLE_SHEETS_ID`, dan `GOOGLE_SHEETS_TAB`.
4. Deploy ulang (`npm run cloudflare:deploy`), lalu buka URL `workers.dev` yang ditampilkan Wrangler dan buat akun admin pertama. Setelah admin dibuat, hapus secret `ADMIN_SETUP_KEY` dari Worker dan deploy ulang.

Firebase adalah penyimpanan utama di Cloudflare; konfigurasi URL dan kredensial yang sudah ada di `.env` lokal tidak ikut terunggah. Worker tidak memakai `data/store.json`, dan data lokal tidak otomatis dimigrasikan. Jika ingin meneruskan data lama, migrasikan dulu ke database Firebase tujuan; jika database kosong, aplikasi mulai sebagai instalasi baru dan admin pertama dibuat dengan `ADMIN_SETUP_KEY`. Untuk mencoba Worker lokal, salin `.dev.vars.example` menjadi `.dev.vars`, isi konfigurasi Firebase dan secret, lalu jalankan `npm run cloudflare:dev`.

### Deploy otomatis dari GitHub

Workflow `.github/workflows/deploy-cloudflare.yml` menjalankan `npm test` lalu deploy ke Cloudflare setiap ada push ke branch `main`. Tambahkan repository secrets `CLOUDFLARE_API_TOKEN` dan `CLOUDFLARE_ACCOUNT_ID` agar workflow bisa deploy. Variabel dan secrets runtime Worker (Firebase, admin setup, Google Sheets, dan Telegram) tetap harus diatur di Cloudflare Dashboard; `.env` dan file key lokal tidak diunggah.

### Telegram di Cloudflare

Workers tidak menjalankan proses polling latar-belakang. Atur secret `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_WEBHOOK_SECRET`, lalu daftarkan webhook Telegram ke `https://<nama-worker>.<subdomain>.workers.dev/api/telegram/webhook` dengan `secret_token` yang sama. Endpoint memvalidasi header secret Telegram. Polling tetap digunakan saat menjalankan server Node lokal.

### Google Sheets

Untuk memakai Sheets di Worker, set secret `GOOGLE_SERVICE_ACCOUNT_JSON` dengan JSON Service Account yang punya akses Editor ke spreadsheet, serta variable `GOOGLE_SHEETS_ID`. File credential lokal dan variabel email/private key terpisah tidak diperlukan di Cloudflare.

## Setup admin pertama (server lokal)

Persyaratan: Node.js 20 atau lebih baru.

1. Salin `.env.example` menjadi `.env` lalu buka:
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
2. Buat kunci admin setup:
   ```powershell
   npm run generate-admin-key
   ```
   Salin hasilnya ke `ADMIN_SETUP_KEY` dalam `.env`. Jangan kirimkan atau commit `.env`.
3. Jalankan aplikasi dan buka <http://localhost:3000>:
   ```powershell
   npm start
   ```
4. Buat akun admin pertama dengan kunci setup dan kata sandi minimal 12 karakter. Email admin pertama ditetapkan ke `amjadamrullah911@gmail.com`. Setelah akun dibuat, hapus `ADMIN_SETUP_KEY` dari `.env` lalu mulai ulang server.

## Akun dan akses bersama

- Dashboard meminta login. Kata sandi di-hash dengan scrypt; sesi menggunakan cookie `HttpOnly`, `SameSite=Strict`, dan perlindungan CSRF.
- Pengguna dapat mendaftar dengan email dan kata sandi tanpa kode undangan admin. Admin pertama tetap dibuat menggunakan `ADMIN_SETUP_KEY`.
- Setiap akun punya anggaran, transaksi, ringkasan, riwayat, dan laporan sendiri. Admin dapat melihat daftar akun dan menonaktifkan akses tanpa menghapus data.
- Menu **Password vault** menyimpan kredensial website dan media sosial dalam payload AES-GCM yang dienkripsi di browser; derivasi kunci memakai PBKDF2-SHA-256. Server hanya menerima ciphertext. Buat passphrase vault tersendiri minimal 12 karakter atau gunakan generator untuk membuat key acak; key hasil generator dapat disalin atau diunduh sebagai file teks. File tersebut berisi key tanpa enkripsi: simpan di tempat aman dan jangan sampai hilang—tidak ada reset atau pemulihan karena server tidak menyimpan kuncinya. Vault otomatis terkunci saat tab disembunyikan atau setelah 5 menit tanpa aktivitas. Gunakan browser modern melalui HTTPS atau localhost.
- Pengguna menautkan Telegram dari **Pengaturan → Buat kode tautan**, lalu mengirim `/link KODE` ke bot. Kode berlaku 10 menit.
- Spreadsheet yang dikonfigurasi server adalah spreadsheet bersama. Setiap baris menyimpan ID akun di kolom G. Pemilik spreadsheet dan service account dapat melihat data seluruh akun di Sheet.
- Secara default data disimpan dalam `data/store.json`. Backend file ditujukan untuk satu instance server. Firebase Realtime Database dapat dipilih sebagai backend bersama untuk beberapa instance; semua data tetap diakses melalui server dan dipisahkan menurut akun.

Secara default server hanya mendengarkan `127.0.0.1`. Untuk akses jaringan lokal set `HOST=0.0.0.0`. **Jangan kirim kata sandi lewat HTTP di internet.** Untuk deployment online, gunakan HTTPS reverse proxy, set `COOKIE_SECURE=true` dan `TRUST_PROXY=true` hanya bila proxy tepercaya menimpa header `X-Forwarded-For`, siapkan backup dan pemantauan; jangan buka port aplikasi ke internet tanpa HTTPS.

Transaksi mendukung IDR (default jika mata uang tidak disebut), USD, dan PHP (Peso Filipina). Contoh pesan Telegram: `makan siang Rp35.000`, `lunch $12.50`, atau `makan ₱10`. Pilih mata uang ringkasan pada dashboard; angka dari mata uang berbeda tidak dijumlahkan. Anggaran bulanan saat ini khusus IDR.

## Telegram

1. Buat bot lewat [@BotFather](https://t.me/BotFather) dan isi `TELEGRAM_BOT_TOKEN` di `.env`. Jika token pernah terekspos, cabut/regenerate sebelum dipakai.
2. Setelah bot aktif, setiap pengguna membuat akun dari halaman login tanpa kode undangan, lalu menautkan akun Telegram dari Pengaturan.
3. Kirim teks seperti `makan siang 35rb`, foto struk, atau voice note. Setelah transaksi dicatat, bot membalas dengan ringkasan transaksi serta tombol **Edit**, **Hapus**, dan **Dashboard**. Edit meminta rincian baru sebagai balasan ke prompt bot; hapus menghapus transaksi di penyimpanan dan mengosongkan baris Sheets terkait. Tombol Dashboard mengirim ringkasan bulan berjalan ke chat.
4. Jika server baru dinyalakan setelah perubahan fitur tombol, mulai ulang proses Node.js agar menu perintah Telegram diperbarui. Perintah `/dashboard` juga menampilkan ringkasan akun yang tertaut.

Bot hanya menerima chat pribadi dari akun Telegram yang sudah ditautkan. Parser lokal mendukung teks dasar; isi `GEMINI_API_KEY` untuk pemrosesan AI, foto struk, dan voice note.

## Google Sheets (opsional)

### Siapkan tab

File [`scripts/setup-google-sheet.gs`](./scripts/setup-google-sheet.gs) membuat tab `Transaksi` dan header:
`Tanggal | Jenis | Deskripsi | Kategori | Sumber Dana | Jumlah | Akun ID | Mata Uang`.

1. Buka [script.google.com](https://script.google.com) dengan akun yang memiliki akses Editor ke spreadsheet.
2. Buat proyek Apps Script, ganti kode contoh dengan isi file `.gs` di atas.
3. Pilih `setupAutocatatSheet`, klik **Run/Jalankan**, dan setujui izin yang diminta.

### Hubungkan server

1. Aktifkan Google Sheets API di Google Cloud, buat Service Account, lalu bagikan spreadsheet kepada email Service Account sebagai **Editor**.
2. Unduh JSON key Service Account, simpan sebagai `credentials/google-service-account.json` di folder proyek, dan atur `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=credentials/google-service-account.json` di `.env`. Folder `credentials/` diabaikan Git. Jangan unggah atau kirim file key tersebut.
3. Atur `GOOGLE_SHEETS_ID` dan `GOOGLE_SHEETS_TAB=Transaksi` pada `.env`. Server membaca `client_email` dan `private_key` langsung dari file JSON. Kredensial lama melalui `GOOGLE_SERVICE_ACCOUNT_EMAIL` dan `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` tetap didukung bila file JSON tidak digunakan; jika path file tidak ditemukan, server memakai pasangan variabel tersebut bila keduanya tersedia dan mencatat peringatan.
4. Mulai ulang server. Transaksi baru, edit, dan hapus akan disinkronkan. Transaksi tetap disimpan lokal jika Sheets sedang gagal; sinkronkan perubahan itu secara manual setelah memperbaiki koneksi.

Server hanya menampilkan status ketersediaan konfigurasi, bukan memeriksa koneksi live.

## Firebase Realtime Database (opsional)

Firebase menjadi backend penyimpanan utama saat diaktifkan; data tidak lagi ditulis ke file lokal. Gunakan database dan kredensial Service Account dari proyek Firebase yang sama.

1. Di Firebase Console, buka proyek database tujuan, aktifkan Realtime Database, lalu buat atau pilih Service Account dengan izin IAM **Firebase Realtime Database Admin**.
2. Buat key JSON baru untuk Service Account tersebut. Simpan sebagai `credentials/firebase-service-account.json`. Jangan gunakan key Google Sheets dari proyek lain, jangan unggah key ini, dan cabut key lama yang pernah dibagikan.
3. Atur `.env`:
   ```dotenv
   AUTOCATAT_STORE_BACKEND=firebase
   FIREBASE_DATABASE_URL=https://PROJECT-ID-default-rtdb.firebaseio.com
   FIREBASE_SERVICE_ACCOUNT_KEY_FILE=credentials/firebase-service-account.json
   ```
   Pakai URL persis dari halaman Realtime Database di Firebase Console. Server menggunakan OAuth Service Account dan ETag untuk melindungi perubahan bersamaan.
   Jika `FIREBASE_SERVICE_ACCOUNT_JSON` tidak diisi, server mencoba path `FIREBASE_SERVICE_ACCOUNT_KEY_FILE` terlebih dahulu, lalu mencari `firebase-service-account.json` di root proyek dan folder `credentials/`. Kredensial JSON inline memiliki prioritas atas file.
4. Untuk menginisialisasi database kosong secara manual, pilih menu titik tiga di Firebase Realtime Database → **Import JSON**, lalu pilih `firebase-import.json` dari folder proyek. File ini membuat node `/autocatat` yang dipakai aplikasi. Jangan impor file tersebut ke database yang sudah berisi data karena impor dapat mengganti data.
5. Mulai ulang server. Pastikan indikator Firebase pada dashboard menunjukkan **Realtime aktif**. Dashboard memuat ulang data akun yang sedang masuk ketika ada perubahan di Firebase. Jangan letakkan key Service Account di browser atau Firebase client SDK.

Jika ada data lokal yang perlu dimigrasikan, jangan impor template kosong; biarkan database tetap `null` dan jalankan aplikasi, yang akan menyalin data lokal saat pertama kali menyimpan perubahan. Cadangkan `data/store.json` sebelum beralih. Jika Firebase sudah berisi data, server menggunakannya dan tidak menggabungkannya dengan data lokal secara otomatis. Untuk kembali ke backend lokal, hentikan server lalu set `AUTOCATAT_STORE_BACKEND=local`.

Catatan: file kredensial yang sebelumnya tersedia di folder proyek berasal dari proyek `asisstant-nyb0`, sedangkan URL database yang diberikan berada di proyek `nyb0-asisstant-65616`. Karena berbeda proyek, belum dipastikan key tersebut memiliki izin ke database tujuan. Koneksi live belum dijalankan; gunakan key dari proyek database tujuan atau minta admin Firebase memberi Service Account izin yang sesuai.

## Pengembangan

```powershell
npm test
npm run dev
```

`MONTHLY_BUDGET` menetapkan anggaran awal untuk pengguna baru (default Rp5.000.000); tiap pengguna bisa mengubah anggarannya di Pengaturan. Tanggal laporan mengikuti zona waktu Makati, Manila (`Asia/Manila`, UTC+8).
