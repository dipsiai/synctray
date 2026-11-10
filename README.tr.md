# SyncTray

Aynı yerel ağdaki bilgisayarlar arasında metin ve dosya paylaşan sistem tepsisi uygulaması. macOS ve Windows, istediğin birleşimde.

Bir bilgisayarda metni yapıştır ya da dosyayı bırak, diğerinde tepsiyi aç: metne tıklayınca kopyalanır, dosyaya sağ tıklayınca masaüstüne iner. Hesap yok, sunucu yok, hiçbir şey ağından dışarı çıkmaz.

[English README](README.md)

## Özellikler

- Sistem tepsisinde (Windows) ya da menü çubuğunda (macOS) durur
- Aynı ağdaki cihazlar birbirini kendiliğinden bulur
- Metin ve her boyutta dosya paylaşır; iki tarafta da ilerleme çubuğu var
- Ağdan geçen her şey, eşleşme kodundan türetilen anahtarla şifrelenir (AES-256-GCM)
- Dosyalar hemen karşı cihaza kopyalanır; gönderen uykuya geçse de indirilebilir
- Son 50 öğeyi 7 gün saklar; "tümünü temizle" bütün cihazlarda siler
- Telefon ve tabletler QR kod okutarak tarayıcıdan katılır, uygulama kurmak gerekmez
- Genel kısayollar: her uygulamadan pencereyi aç ya da panoyu gönder
- Arayüz sistem diline göre Türkçe ya da İngilizce açılır
- Electron dışında iki küçük bağımlılık (`@noble/ciphers`, `qrcode-generator`)

## Kurulum

Son sürümü [Releases](https://github.com/dipsiai/synctray/releases) sayfasından indir.

**Windows:** zip'i bir klasöre aç ve `SyncTray.exe`'yi çalıştır. Uygulama imzasız olduğu için ilk açılışta SmartScreen uyarır: **Ek bilgi → Yine de çalıştır**. Güvenlik duvarı sorarsa **özel ağlar** için izin ver.

**macOS:** dmg'yi aç (Apple Silicon için `arm64`, Intel için `x64`) ve SyncTray'i Uygulamalar'a sürükle. Uygulama Apple tarafından onaylanmadığı için ilk açılış engellenir: **Sistem Ayarları → Gizlilik ve Güvenlik** bölümünde **Yine de Aç**'ı seç.

## İki cihazı eşleştirme

Her cihaz ilk açılışta rastgele bir eşleşme kodu üretir. Bir cihazda **Ayarlar**'ı aç, oradaki kodu diğerine yaz. Aynı kodu taşıyan cihazlar birbirini bulur; üstte yeşil nokta ve diğer cihazın adı görünür.

Bulamazlarsa (bazı modemler ve misafir ağları yayını engeller) Ayarlar'da görünen adresi diğer cihazdaki "Cihaz otomatik bulunmazsa" kutusuna yaz. Tek tarafta yapmak yeterli.

## Kullanım

1. Tepsi ikonuna tıkla.
2. Metni yapıştır ve **Gönder**'e bas (⌘↵ / Ctrl+Enter). Dosya için: pencereye sürükle, **Dosya seç**'e bas ya da dosyayı panodan yapıştır.
3. Diğer bilgisayarda tepsi ikonuna tıkla:
   - metne tıkla, kopyalanır
   - dosyaya sağ tıkla: **Masaüstüne indir** ya da **Farklı kaydet…**

**Kısayollar.** `Alt+Shift+V` pencereyi açar, `Alt+Shift+C` panoda ne varsa (metin, kopyalanmış dosya ya da görsel) her uygulamadan gönderir. Ayarlar'dan değiştirebilir ya da kapatabilirsin.

**Telefon ya da tablet.** **Ayarlar → Telefon ve tablet → QR kodu göster**'i aç ve aynı Wi-Fi'daki telefonun kamerasıyla okut. Açılan sayfada aynı liste görünür: metne dokunup kopyala, dosyayı kaydet ya da geri metin ve dosya gönder. Eşleşme kodunu değiştirene kadar yer iminden de çalışır. Tarayıcıdan gönderilen dosyalar 300 MB ile sınırlıdır.

Pencere başka yere tıklayınca kapanır; Finder ya da Explorer'dan dosya sürükleyeceksen önce **Sabitle**'ye bas. macOS'ta dosyayı doğrudan menü çubuğundaki ikona da bırakabilirsin.

## Güvenlik

- Cihazlar arasındaki tüm trafik şifrelenir ve doğrulanır: metinler, dosyalar, dosya adları, cihaz adları ve keşif paketleri. Anahtar eşleşme kodundan scrypt ile türetilir. Aynı ağda olup kodu bilmeyen biri hiçbir şeyi okuyamaz, ekleyemez, silemez, değiştiremez. Ayrıntı: [`src/crypto.js`](src/crypto.js).
- Güvenlik eşleşme koduna dayanır; kodu kimseyle paylaşma. Yeni kurulumlar 12 karakterlik kod üretir; Ayarlar'dan daha uzununu yazabilirsin.
- Gelen dosyalar rastgele bir kimlikle, uzantısız saklanır. Gerçek adlarını ancak sen kaydedince alırlar; çalıştırılabilir türlerde önce onay istenir.
- Telefon sayfası da aynı güçte şifrelenir; anahtar QR kodun içindedir (adresin `#` sonrasındaki kısmında kalır, tarayıcılar bu kısmı ağa göndermez). Bir sınırı var: sayfanın kendisi düz HTTP ile yüklenir, çünkü tarayıcılar yerel adresler için sertifika kabul etmez. Ağındaki trafiği değiştirebilecek durumda olan biri, sayfa yüklenirken onu kurcalayabilir. Sadece dinleyen biri hiçbir şey göremez.
- Kapsam dışı: diskteki veriler şifrelenmez ve kod bağımsız bir güvenlik denetiminden geçmemiştir. Güvendiğin ağlar (ev, ofis) için yapılmıştır. İnternet üzerinden kullanmak için cihazları Tailscale gibi bir VPN'e al ve diğer cihazın VPN adresini elle ekle.

## Kaynaktan çalıştırma

Node.js 20 ya da üstü gerekir.

```bash
npm install
npm start
```

Aynı bilgisayarda ikinci bir sahte cihazla denemek için: `SYNC_PROFILE=second npm start`. Dili zorlamak için `SYNC_LANG=en` ya da `SYNC_LANG=tr`.

## Paket üretme

```bash
npm run dist:mac   # dist/ altında dmg dosyaları
npm run dist:win   # dist/ altında zip
```

## Nasıl çalışır

- [`src/store.js`](src/store.js): öğe listesi ve dosyalar, uygulamanın veri klasöründe tutulur. Sınırlar (öğe sayısı, süre, metin boyutu) dosyanın başındaki sabitlerdir.
- [`src/net.js`](src/net.js): UDP yayınıyla keşif (port 47801) ve HTTP üzerinden iki yönlü eşitleme (port 47800).
- [`src/crypto.js`](src/crypto.js): anahtar türetme, mühürlü mesajlar ve parçalı dosya akışı.
- [`src/main.js`](src/main.js): tepsi ikonu, pencere, pano, dosya kaydetme.
- [`src/ui/`](src/ui): pencerenin arayüzü.
- [`src/web/`](src/web): telefon ve tabletlerin açtığı sayfa ve şifrelemenin tarayıcı tarafı.
- [`src/i18n.js`](src/i18n.js): arayüz metinleri.

## Testler

```bash
npm test
npm run test:stress
```

`npm test` tek makinede sanal cihazlar açıp metin, dosya, silme, geç katılma ve yetkisiz erişimi dener; ardından telefon sayfasının arayüzünü, tarayıcının çalıştırdığı şifreleme koduyla sınar. Zorlama testleri: art arda yüzlerce metin, iki cihazın aynı anda göndermesi, 300 MB dosya, aktarım ortasında cihazın kapanması ya da donması, aktarım sırasında silme, sahte istekler ve ağdan geçen verinin okunamaması.

## Lisans

[MIT](LICENSE)
