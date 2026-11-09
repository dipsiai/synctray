# SyncTray

Aynı ağdaki bilgisayarlar arasında metin ve dosya paylaşan sistem tepsisi uygulaması (macOS + Windows).

> **English:** A tray app that shares text snippets and files between computers on the same local network (macOS + Windows). Paste text or drop a file on one machine, open the tray on the other, click to copy or right-click to save to the desktop. Devices find each other automatically, no server or account needed, and everything on the wire is encrypted with a key derived from a shared pairing code. Built with Electron, zero runtime dependencies. The UI and the rest of this README are in Turkish.

## Nasıl kullanılır

1. Tepsideki (macOS'ta menü çubuğundaki) ok ikonuna tıkla.
2. Kutuya metni yapıştır ve **Gönder**'e bas (⌘↵ / Ctrl+Enter). Dosya için kutuya sürükle, **Dosya seç**'e bas ya da dosyayı panodan yapıştır.
3. Diğer bilgisayarda ikona tıkla: son paylaşılanlar listede durur.
   - Metne tıkla → panoya kopyalanır.
   - Dosyaya sağ tıkla → **Masaüstüne indir** ya da **Farklı kaydet…**

Pencere başka yere tıklayınca kapanır; Finder/Explorer'dan dosya sürükleyeceksen önce **Sabitle**'ye bas. macOS'ta dosyayı doğrudan menü çubuğundaki ikona da bırakabilirsin.

## İlk kurulum (iki cihazı eşleştirme)

Her cihaz ilk açılışta rastgele bir eşleşme kodu üretir. **Ayarlar**'ı aç, bir cihazdaki kodu diğerine yaz. Aynı kodu taşıyan cihazlar birbirini otomatik bulur; üstte "… bağlı" yazısı ve yeşil nokta görünür.

Otomatik bulunmazsa (bazı modemler ve misafir ağları yayını engeller) Ayarlar'da görünen IP adresini diğer cihazdaki "Cihaz otomatik bulunmazsa" kutusuna yaz. Tek tarafta girmek yeterli.

Windows ilk açılışta güvenlik duvarı izni sorar: **Özel ağlar** için izin ver.

## Çalıştırma

Node.js 20+ gerekir.

```bash
npm install
npm start
```

Aynı bilgisayarda ikinci bir sahte cihaz açıp denemek için: `SYNC_PROFILE=ikinci npm start`

## Kurulum paketi üretme

```bash
npm run dist:mac   # dist/ altında .dmg
npm run dist:win   # dist/ altında SyncTray-0.1.0-win.zip
```

Windows'ta zip'i bir klasöre aç (ör. `C:\SyncTray`) ve `SyncTray.exe`'yi çalıştır; Node kurmak gerekmez. İmzasız olduğu için ilk açılışta SmartScreen uyarısı çıkar: **Ek bilgi → Yine de çalıştır**.

Paketlenmiş sürümde tepsi ikonuna sağ tıklayıp **Bilgisayar açılınca başlat**'ı işaretleyebilirsin.

## Nasıl çalışır

- `src/store.js`: öğe listesi ve dosyalar, uygulama veri klasöründe tutulur. Son 50 öğe saklanır, 7 günden eskiler kendiliğinden silinir, 100.000 karakterden uzun metinler `.txt` dosyası olarak gönderilir (sabitler dosyanın başında).
- `src/net.js`: cihazlar birbirini UDP yayınıyla (port 47801) bulur, öğeleri HTTP ile (port 47800) eşitler. Dosyalar hemen karşı cihaza kopyalanır, yani gönderen bilgisayar sonradan kapansa da dosya indirilebilir.
- `src/main.js`: tepsi ikonu, pencere, pano ve masaüstüne kaydetme.
- `src/ui/`: pencerenin arayüzü.

## Güvenlik

- **Ağdaki her şey şifrelidir** (AES-256-GCM): metinler, dosyalar, dosya adları, cihaz adı. Anahtar eşleşme kodundan scrypt ile türetilir; kodu bilmeyen biri trafiği dinlese de okuyamaz, içerik ekleyemez, silemez, değiştiremez. Ayrıntı: `src/crypto.js`.
- Güvenlik eşleşme koduna dayanır: kodu kimseyle paylaşma. Yeni kurulumlar 12 karakterlik kod üretir; eski 8 karakterlik kodun varsa Ayarlar'dan daha uzun bir kod yazıp iki cihazda da güncelleyebilirsin.
- Gelen dosyalar uygulama klasöründe rastgele bir kimlikle, uzantısız saklanır; gerçek adını ancak sen kaydedince alır. Çalıştırılabilir türlerde kaydetmeden önce onay istenir.
- Kapsam dışı: diskteki veriler şifrelenmez (bilgisayarına erişen biri uygulama klasörünü okuyabilir) ve bağımsız bir güvenlik denetiminden geçmemiştir.

İnternet üzerinden eşitleme henüz yok; eklendiğinde değişecek yer `src/net.js`.

## Test

```bash
npm test
```

İki sanal cihaz açıp metin, dosya, silme, geç katılma ve yetkisiz erişimi dener.

```bash
npm run test:stress
```

Zorlama testleri: art arda yüzlerce metin, iki yönden aynı anda gönderme, 300 MB dosya, aktarım ortasında cihazın kapanması ya da donması, aktarım sırasında silme, sahte istek, ağdan geçen verinin okunamaması, bozulmuş ya da kesilmiş şifreli akış.
