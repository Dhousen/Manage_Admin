# Admin Performance Management System

Aplikasi web internal untuk mencatat jobdesk, kinerja harian, audit, dan ringkasan KPI karyawan.

## Riwayat pembaruan

### 2026-11-10

- Menggabungkan penilaian KPI harian, mingguan, dan bulanan dengan riwayat audit yang hanya-baca pada halaman Penilaian Kinerja Admin.
- Mengubah dashboard dan laporan agar menggunakan data aktual, termasuk pencatatan omset per admin dan unit serta ekspor PDF dan Excel.
- Menambahkan pengelolaan KPI dengan versioning agar perubahan tidak mengubah penilaian historis.
- Memperluas akses operasional untuk owner dan admin, serta menambahkan migrasi skema aditif untuk penilaian, riwayat, unit, dan omset.
- Memigrasikan database aktif setelah membuat cadangan; pemeriksaan integritas SQLite dan foreign key berhasil.

## Status kesiapan produksi

Aplikasi ini sekarang memiliki baseline keamanan untuk deployment internal **satu server/satu proses**. Aplikasi belum dirancang untuk beberapa instance atau penggunaan dengan trafik tinggi: database masih memakai `sql.js` yang dimuat ke memori dan ditulis ulang ke disk setiap perubahan. Gunakan disk persisten lokal, jangan jalankan beberapa proses terhadap file database yang sama, dan rencanakan migrasi ke server database terkelola sebelum scale-out.

Sebelum menerima data nyata:

1. Gunakan Node.js LTS yang masih didukung (Node.js 22 atau lebih baru).
2. Set `NODE_ENV=production`, rahasia sesi acak minimal 32 karakter, username unik, dan password unik minimal 12 karakter untuk kedua akun. Jangan gunakan nilai contoh.
3. Layani aplikasi hanya melalui HTTPS di reverse proxy tepercaya. Jika memakai tepat satu reverse proxy, set `TRUST_PROXY=1`; sesuaikan nilainya dengan jumlah hop tepercaya jika topologinya berbeda.
4. Pasang `data`, `UPLOADS_DIR`, dan database pada penyimpanan persisten dengan akses filesystem terbatas. File bukti hanya tersedia setelah login; jenisnya dibatasi JPEG/PNG/WebP/PDF dan ukuran maksimal 5 MB.
5. Siapkan backup terenkripsi terjadwal untuk database dan file bukti, simpan terpisah dari server, dan uji pemulihannya sebelum go-live. Jangan menyalin database yang sedang aktif menggunakan sinkronisasi folder seperti OneDrive.
6. Jalankan `npm ci --omit=dev`, `npm test`, dan `npm audit --omit=dev` saat proses rilis.
7. Ganti sandi kedua akun melalui **Pengaturan Akun** sebelum go-live. Kredensial dalam `.env` hanya digunakan saat seed/migrasi pertama dan tidak menimpa sandi yang kemudian diubah melalui aplikasi.

Header keamanan, token CSRF untuk perubahan data, rate limit login, cookie sesi `HttpOnly`/`SameSite`, penyimpanan sesi persisten, validasi unggahan, dan batas ukuran request telah dikonfigurasi. Aturan CSP mengizinkan skrip inline agar kompatibel dengan halaman saat ini; hapus inline script sebelum memperketat CSP. Perlindungan rate limit menggunakan penyimpanan proses tunggal, bukan lintas instance.

## Konsep data

- **Karyawan** adalah orang yang performanya dikelola. Tambahkan mereka secara manual melalui menu **Data Karyawan → Tambah Karyawan** sebelum membuat jobdesk, catatan kinerja, atau audit untuk mereka.
- Role akun aplikasi hanya ada dua: **owner** dan **admin/controller**. Keduanya memiliki akses operasional yang sama untuk mengelola karyawan, KPI/jobdesk, penilaian, audit, omset, laporan, ekspor, dan melihat riwayat perubahan. Role tidak menunjukkan jabatan atau daftar karyawan.
- Pengaturan khusus akun tetap dibatasi: Owner dapat mereset sandi akun admin; setiap akun dapat mengganti sandinya sendiri. Sandi baru minimal 12 karakter.
- **Penilaian Kinerja Admin** menggabungkan checklist KPI harian/mingguan/bulanan dan History Audit. History bersifat read-only; setiap perubahan penilaian dan data penting dicatat otomatis.
- **Laporan Bulanan** menampilkan kewajiban KPI, penyelesaian, persentase, audit, dan omset yang dicatat terpisah dari KPI. Catatan omset dapat ditambah, diubah, dihapus, serta direkap berdasarkan karyawan dan HP/unit. Laporan dapat diunduh sebagai PDF atau Excel sesuai filter periode/admin/unit.
- Setiap akun dapat mengganti sandinya di **Pengaturan Akun** dengan mengisi sandi saat ini. Owner juga dapat mereset sandi admin. Sandi baru minimal 12 karakter.
- Menonaktifkan karyawan tidak menghapus catatan jobdesk, kinerja, atau audit historisnya.

Pada database baru, lima nama karyawan contoh tidak dibuat otomatis. Data karyawan demo hanya dibuat jika `SEED_DEMO_EMPLOYEES=true` saat database pertama kali dibuat. Akun demo pengelola tetap dibuat dengan kredensial dari file `.env`.

## Menjalankan aplikasi

Persyaratan: Node.js dan npm.

1. Pasang dependensi:

   ```powershell
   npm install
   ```

2. Salin `.env.example` menjadi `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Isi semua nilai kredensial pada `.env`; aplikasi tidak berjalan dengan kredensial bawaan. Buat rahasia sesi acak dengan `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Jangan membagikan atau meng-commit file `.env`.
4. Jalankan aplikasi:

   ```powershell
   npm start
   ```

5. Buka `http://localhost:3000`.

Akun awal mengikuti nilai `DEMO_ADMIN_USERNAME`, `DEMO_ADMIN_PASSWORD`, `DEMO_OWNER_USERNAME`, dan `DEMO_OWNER_PASSWORD` pada `.env`. Gunakan password acak yang unik; konfigurasi production menolak password contoh dan password yang lebih pendek dari 12 karakter.

## Konfigurasi

| Variabel | Fungsi | Nilai contoh |
| --- | --- | --- |
| `PORT` | Port server | `3000` |
| `APP_NAME` | Nama aplikasi | `Admin Performance Management System` |
| `SESSION_SECRET` | Kunci sesi login | Ganti dengan nilai acak yang kuat |
| `DEMO_ADMIN_USERNAME` / `DEMO_ADMIN_PASSWORD` | Akun admin pertama pada database baru | Isi dengan kredensial unik |
| `DEMO_OWNER_USERNAME` / `DEMO_OWNER_PASSWORD` | Akun owner pertama pada database baru | Isi dengan kredensial unik |
| `DB_PATH` | Lokasi file database SQLite | `./data/management_admin.db` |
| `UPLOADS_DIR` | Lokasi bukti pekerjaan yang diunggah | `./uploads` |
| `SEED_DEMO_EMPLOYEES` | Membuat data karyawan dan contoh performa pada database baru | `false` |
| `NODE_ENV` | Aktifkan konfigurasi production (cookie HTTPS dan validasi konfigurasi ketat) | `production` |
| `TRUST_PROXY` | Jumlah/lokasi reverse proxy yang benar-benar dipercaya | Kosong kecuali berada di belakang proxy |

Seed hanya dijalankan ketika file database belum ada atau kosong. Mengubah nilai kredensial seed tidak mengganti akun yang sudah tersimpan di database.

## Alur pengelolaan karyawan

1. Masuk dengan akun pengelola.
2. Buka **Data Karyawan**, pilih **Tambah Karyawan**, lalu isi nama dan detail posisi/departemen bila tersedia.
3. Tambahkan jobdesk untuk karyawan tersebut di **Manajemen Jobdesk**.
4. Nilai KPI dan catat audit melalui **Penilaian Kinerja Admin**. Masukkan omset harian dan lihat laporan melalui **Laporan Bulanan**.
5. Edit atau nonaktifkan karyawan melalui tabel Data Karyawan. Penonaktifan mempertahankan data historis.

Penambahan, pengeditan, dan perubahan status data karyawan dapat dilakukan oleh kedua role operasional. Karyawan yang belum memiliki penilaian, audit, omset, atau transaksi terkait dapat dihapus; data yang sudah memiliki riwayat perlu dinonaktifkan agar relasi historis tetap terjaga. KPI yang sudah pernah dinilai juga dinonaktifkan atau dibuatkan versi baru, sehingga penilaian lama tidak ikut berubah. Saat aplikasi berjalan setelah pembaruan, satu akun `owner` dan satu akun admin lama dipertahankan sesuai username pada `.env`. Akun login lain dihapus agar hanya tersisa dua akun; data karyawan, jobdesk, performa, audit, dan riwayat tetap dipertahankan. Pada migrasi akun pertama, username dan sandi akun owner/admin diselaraskan sekali dengan konfigurasi `.env`; setelah itu, perubahan sandi melalui aplikasi tidak ditimpa saat restart.

## Data dan backup

Database disimpan pada lokasi `DB_PATH` dan bukti pekerjaan pada `UPLOADS_DIR`. Cadangkan kedua lokasi tersebut secara berkala. Akses bukti dibatasi ke pengguna yang login. Unggahan baru divalidasi berdasarkan tanda tangan file; file bukti lama hanya dapat dibuka jika namanya aman dan ekstensinya JPEG/PNG/WebP/PDF. Perubahan aplikasi tidak menghapus atau mengubah otomatis database yang sudah ada; database lama dapat tetap berisi data karyawan contoh yang dibuat oleh versi sebelumnya.

Untuk memulai dengan database kosong tanpa menghapus database lama, hentikan aplikasi dan ubah `DB_PATH` di `.env` ke nama file baru, misalnya `./data/management_admin_baru.db`, lalu jalankan kembali aplikasi.
